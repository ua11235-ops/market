/* Daily fetcher for the Moutai wholesale reference price.
 *
 * The source (jujindata.com) encrypts its JSON with AES-CBC and protects the
 * site with Tencent EdgeOne, which rejects plain Node requests.  So this runs a
 * real Chrome window, lets the page make its own (correctly signed) request,
 * and reads the plaintext back through the page's own decryptAES().
 *
 * Output: js/moutai-data.js  (window.AurumMoutaiData, same shape as before)
 *
 *   node fetch-moutai.js <repo-root> [--dry-run]
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* Optional first positional argument is the repo root; flags are never roots. */
const ARGS = process.argv.slice(2);
const POSITIONAL = ARGS.filter((arg) => !arg.startsWith("--"));
const ROOT = path.resolve(POSITIONAL[0] || path.join(__dirname, ".."));
const DRY_RUN = ARGS.includes("--dry-run");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9466);
const PAGE = "https://www.jujindata.com/commodity/detail/maotai-cn";
const OUT_FILE = path.join(ROOT, "js", "moutai-data.js");
const TMP = path.join(ROOT, ".tmp", "moutai-raw");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  console.log(`[${new Date().toISOString().slice(0, 19).replace("T", " ")}] ${message}`);
}

async function launchChrome() {
  const profile = path.join(TMP, "chrome-profile");
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    // Not --headless: EdgeOne blocks headless Chrome on this host.
    "--no-first-run", "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-notifications",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "--window-position=-2000,0", // keep it off-screen but not headless
    "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 120; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch (error) {
      await sleep(250);
    }
  }
  if (!version) {
    chrome.kill();
    throw new Error("Chrome 调试端口没起来");
  }
  return { chrome, version };
}

async function connect(version) {
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  let sessionId = null;

  const send = (method, params, useSession) => {
    const id = ++seq;
    const payload = { id, method, params: params || {} };
    if (useSession && sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify(payload));
    });
  };

  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));

  const evaluate = async (expression, timeoutMs) => {
    const work = send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, true)
      .then((r) => (r.exceptionDetails
        ? { __error: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "") }
        : r.result.value));
    if (!timeoutMs) return work;
    return Promise.race([work, sleep(timeoutMs).then(() => ({ __error: "evaluate timeout" }))]);
  };

  return { ws, send, evaluate, targetId, close: () => { try { ws.close(); } catch (e) {} } };
}

/* Wrap XHR/fetch before any page script runs, so every response body is kept. */
const HOOK = `
  window.__jj_capture = [];
  (function () {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__jj_url = u; return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener("load", function () {
        try { window.__jj_capture.push({ url: xhr.__jj_url, body: xhr.responseText }); } catch (e) {}
      });
      return send.apply(this, arguments);
    };
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url);
      return origFetch.apply(this, arguments).then(function (res) {
        res.clone().text().then(function (t) { window.__jj_capture.push({ url: url, body: t }); }).catch(function () {});
        return res;
      });
    };
  })();
`;

async function fetchSeries() {
  const { chrome, version } = await launchChrome();
  const client = await connect(version);
  try {
    await client.send("Page.enable", {}, true);
    await client.send("Runtime.enable", {}, true);
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, true);
    log("打开聚金数据页面…");
    await client.send("Page.navigate", { url: PAGE }, true);

    /* Poll until the getlist response shows up and decrypts. */
    const deadline = Date.now() + 60000;
    let rows = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      const result = await client.evaluate(`(() => {
        if (typeof decryptAES !== "function") return { state: "no-decrypt" };
        var caps = window.__jj_capture || [];
        for (var i = 0; i < caps.length; i++) {
          var c = caps[i];
          if (!c.url || c.url.indexOf("getlist") === -1) continue;
          var plain = null;
          try { plain = decryptAES(c.body); } catch (e) { return { state: "decrypt-error", detail: e.message }; }
          if (!plain) return { state: "empty-plain" };
          var parsed = null;
          try { parsed = JSON.parse(plain); } catch (e) { return { state: "bad-json", head: plain.slice(0, 120) }; }
          if (Array.isArray(parsed) && parsed.length) {
            return { state: "ok", rows: parsed };
          }
        }
        return { state: "pending", captured: caps.length };
      })()`, 20000);

      if (result && result.state === "ok") {
        rows = result.rows;
        break;
      }
      log(`等待数据… (${JSON.stringify(result).slice(0, 120)})`);
    }

    if (!rows) throw new Error("超时：没能从页面拿到解密的序列");
    return rows;
  } finally {
    await client.send("Target.closeTarget", { targetId: client.targetId }).catch(() => {});
    client.close();
    chrome.kill();
  }
}

function normalise(rows) {
  const points = [];
  const seen = new Set();
  for (const row of rows) {
    const date = row && row.inddate;
    const value = Number(row && row.indvalue);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    points.push({ date, price: value });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

function buildFile(points) {
  const first = points[0];
  const last = points[points.length - 1];
  const weekend = points.filter((p) => {
    const day = new Date(`${p.date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }).length;
  const bundle = {
    product: "飞天茅台 500ml",
    spec: "53%vol · 散瓶批价",
    unit: "元/瓶",
    source: "聚金数据",
    source_url: "https://www.jujindata.com/commodity/detail/maotai-cn",
    updated: last.date,
    note: "日频批发参考价，来自公开数据平台，非实时报价",
    daily: points,
  };
  const header =
    "/* 飞天茅台 53度 500ml · 元/瓶 · 日频批发参考价。\n" +
    ` * 数据来源：聚金数据 ${bundle.source_url}\n` +
    ` * 区间 ${first.date} ~ ${last.date}，共 ${points.length} 个自然日（含周末，非交易日序列，其中 ${weekend} 天是周末）。\n` +
    " * 该数据为公开平台整理的参考价，非交易所行情，不构成投资建议。\n" +
    " * 本文件由 scripts/fetch-moutai.js 定时生成，请勿手工编辑。 */\n";
  const body = `(function () {\n  "use strict";\n  window.AurumMoutaiData = ${JSON.stringify(bundle)};\n})();\n`;
  return { content: header + body, weekend, first, last };
}

/* Upstream /getlist returns a rolling window (currently ~1 year), so a plain
 * overwrite would silently drop older history once a year has passed.  Merge
 * instead: keep every point already in the snapshot, let fresh data win on
 * dates present in both. */
function mergePoints(previous, incoming) {
  const map = new Map();
  for (const point of previous || []) {
    if (point && typeof point.date === "string") map.set(point.date, Number(point.price));
  }
  for (const point of incoming) map.set(point.date, point.price);
  const merged = [...map.entries()]
    .filter(([date, price]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(price) && price > 0)
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

/* Read the daily array back out of an existing moutai-data.js without regex:
 * evaluate the IIFE against a fake window, exactly like the page would. */
function readBundledPoints(source) {
  try {
    const sandbox = {};
    const runner = new Function("window", source);
    runner(sandbox);
    const bundle = sandbox.AurumMoutaiData;
    if (!bundle || !Array.isArray(bundle.daily)) return null;
    return bundle.daily;
  } catch (error) {
    log(`读不出旧快照（${error.message}），将直接覆盖`);
    return null;
  }
}

/* New data only reaches visitors if index.html's ?v= changes, so bump every
 * asset query string by one.  Returns the new version, or null if unchanged. */
function bumpAssetVersion() {
  const indexPath = path.join(ROOT, "index.html");
  if (!fs.existsSync(indexPath)) {
    log("找不到 index.html，跳过版本号");
    return null;
  }
  const html = fs.readFileSync(indexPath, "utf8");
  const versions = [...html.matchAll(/\?v=(\d+)/g)].map((m) => Number(m[1]));
  if (!versions.length) {
    log("index.html 里没有 ?v= 版本号，跳过");
    return null;
  }
  const current = Math.max(...versions);
  const next = current + 1;
  const updatedHtml = html.replace(/\?v=\d+/g, `?v=${next}`);
  fs.writeFileSync(indexPath, updatedHtml, "utf8");
  log(`index.html 版本号 ?v=${current} → ?v=${next}（${versions.length} 处）`);
  return next;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  log(`目标仓库：${ROOT}`);

  const raw = await fetchSeries();
  log(`页面返回 ${raw.length} 条原始记录`);
  fs.writeFileSync(path.join(TMP, `raw-${Date.now()}.json`), JSON.stringify(raw));

  const incoming = normalise(raw);
  if (incoming.length < 2) throw new Error(`清洗后只有 ${incoming.length} 条，放弃写入`);
  log(`本次抓到 ${incoming.length} 条：${incoming[0].date} ~ ${incoming[incoming.length - 1].date}`);

  /* Guard against a truncated upstream response silently shrinking history,
   * then merge so the local archive keeps growing past upstream's window. */
  let points = incoming;
  if (fs.existsSync(OUT_FILE)) {
    const previousPoints = readBundledPoints(fs.readFileSync(OUT_FILE, "utf8"));
    if (previousPoints && previousPoints.length) {
      const previousLast = previousPoints[previousPoints.length - 1];
      log(`现有快照 ${previousPoints.length} 条，最新 ${previousLast.date} ${previousLast.price}`);
      if (incoming.length < previousPoints.length * 0.9) {
        throw new Error(`新数据 ${incoming.length} 条明显少于现有 ${previousPoints.length} 条，疑似抓取不全，拒绝覆盖`);
      }
      const incomingLast = incoming[incoming.length - 1];
      if (incomingLast.date < previousLast.date) {
        throw new Error(`新数据最新日期 ${incomingLast.date} 早于现有 ${previousLast.date}，拒绝覆盖`);
      }
      points = mergePoints(previousPoints, incoming);
      if (points.length > incoming.length) {
        log(`合并历史后 ${points.length} 条（上游窗口外补回 ${points.length - incoming.length} 条）`);
      }
      const mergedLast = points[points.length - 1];
      if (
        mergedLast.date === previousLast.date &&
        mergedLast.price === previousLast.price &&
        points.length === previousPoints.length
      ) {
        log("数据无变化，不写入文件");
        return 0;
      }
    }
  }

  const { content, weekend, first, last } = buildFile(points);

  if (DRY_RUN) {
    log(`--dry-run：不写文件。区间 ${first.date} ~ ${last.date}，${points.length} 条，周末 ${weekend} 天，最新 ${last.price}`);
    return 0;
  }

  fs.writeFileSync(OUT_FILE, content, "utf8");
  log(`已写入 ${OUT_FILE}`);
  log(`区间 ${first.date} ~ ${last.date}，${points.length} 条，周末 ${weekend} 天，最新 ${last.price} 元/瓶`);
  bumpAssetVersion();
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((error) => {
    console.error(`抓取失败：${error.message}`);
    process.exit(1);
  });

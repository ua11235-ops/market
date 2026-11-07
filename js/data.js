/* Browser-side market data layer.
 *
 * The page is a static site, so every request runs from the visitor's browser
 * and must satisfy the same-origin policy.  Eastmoney exposes JSONP endpoints
 * that work from any origin, which is what this module uses:
 *
 *   push2.eastmoney.com      quotes (indices, gold, FX)
 *   push2his.eastmoney.com   candles and intraday trends
 *
 * Nothing here needs a build step or a server.
 */
(function (global) {
  "use strict";

  const QUOTE_HOST = "https://push2.eastmoney.com/api/qt";
  const HISTORY_HOST = "https://push2his.eastmoney.com/api/qt";
  const CANDLE_FIELDS =
    "fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
  const TROY_OUNCE_GRAMS = 31.1034768;
  const CACHE_TTL = 20000;
  const REQUEST_TIMEOUT = 12000;

  const memory = new Map();

  function round(value, digits) {
    if (!Number.isFinite(value)) return null;
    const factor = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(value * factor) / factor;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function scaled(value) {
    return toNumber(value);
  }

  let callbackSeq = 0;

  /* Eastmoney drops connections when several requests land at once (the
   * browser reports ERR_EMPTY_RESPONSE).  Every JSONP call therefore goes
   * through one serial queue with a small gap between requests. */
  const QUEUE_GAP = 120;
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(() => task());
    const settle = () =>
      new Promise((resolve) => window.setTimeout(resolve, QUEUE_GAP));
    queue = run.then(settle, settle);
    return run;
  }

  function jsonpOnce(url) {
    return new Promise((resolve, reject) => {
      const name = `__aurum_cb_${Date.now()}_${callbackSeq++}`;
      const script = document.createElement("script");
      let settled = false;
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("行情请求超时"));
      }, REQUEST_TIMEOUT);

      function cleanup() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          delete window[name];
        } catch (error) {
          window[name] = undefined;
        }
        script.remove();
      }

      window[name] = (payload) => {
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("行情接口不可用"));
      };
      script.src = `${url}${url.includes("?") ? "&" : "?"}cb=${name}`;
      document.head.appendChild(script);
    });
  }

  function jsonp(url, attempts) {
    const tries = attempts || 4;
    let chain = enqueue(() => jsonpOnce(url));
    for (let index = 1; index < tries; index += 1) {
      chain = chain.catch(
        () =>
          new Promise((resolve) => window.setTimeout(resolve, 500 * index)).then(
            () => enqueue(() => jsonpOnce(url))
          )
      );
    }
    return chain;
  }

  function cached(key, ttl, loader) {
    const hit = memory.get(key);
    const now = Date.now();
    if (hit && now - hit.time < (ttl || CACHE_TTL) && hit.value) {
      return Promise.resolve(hit.value);
    }
    if (hit && hit.pending) return hit.pending;
    const pending = loader()
      .then((value) => {
        memory.set(key, { time: Date.now(), value });
        return value;
      })
      .catch((error) => {
        memory.delete(key);
        throw error;
      });
    memory.set(key, { time: now, value: hit ? hit.value : null, pending });
    return pending;
  }

  function invalidate(prefix) {
    if (!prefix) {
      memory.clear();
      return;
    }
    Array.from(memory.keys()).forEach((key) => {
      if (key.startsWith(prefix)) memory.delete(key);
    });
  }

  // ------------------------------------------------------------------ quotes

  const QUOTE_FIELDS = "f2,f3,f4,f12,f14,f15,f16,f17,f18";
  /* One request for every symbol: Eastmoney throttles bursts, so fewer, larger
   * requests are far more reliable than many small ones. */
  const QUOTE_BATCH = 30;

  function fetchQuotes(secids) {
    const batches = [];
    for (let index = 0; index < secids.length; index += QUOTE_BATCH) {
      batches.push(secids.slice(index, index + QUOTE_BATCH));
    }
    const map = new Map();
    return batches
      .reduce(
        (chain, batch) =>
          chain.then(() =>
            jsonp(
              `${QUOTE_HOST}/ulist.np/get?fltt=2&invt=2&secids=${batch.join(",")}` +
                `&fields=${QUOTE_FIELDS}`
            ).then((payload) => {
              const rows = (payload && payload.data && payload.data.diff) || [];
              rows.forEach((row) => map.set(String(row.f12), row));
              return null;
            })
          ),
        Promise.resolve()
      )
      .then(() => map);
  }

  function singleQuote(secid) {
    return fetchQuotes([secid]).then((map) => {
      const code = secid.split(".").pop();
      return map.get(code) || null;
    });
  }

  function quoteToMarket(row, meta) {
    if (!row) {
      return {
        id: meta.id,
        name: meta.name,
        en: meta.en,
        code: meta.code,
        price: null,
        change: null,
        pct: null,
        updated: "",
        url: meta.url,
      };
    }
    return {
      id: meta.id,
      name: meta.name,
      en: meta.en,
      code: meta.code,
      price: scaled(row.f2),
      change: scaled(row.f4),
      pct: scaled(row.f3),
      previous: scaled(row.f18),
      open: scaled(row.f17),
      high: scaled(row.f15),
      low: scaled(row.f16),
      updated: "",
      url: meta.url,
    };
  }

  // ----------------------------------------------------------------- regions

  const REGIONS = [
    {
      id: "asia",
      name: "亚洲",
      en: "ASIA-PACIFIC",
      markets: [
        { id: "sse", name: "上证指数", en: "SSE COMPOSITE", code: "000001", secid: "1.000001", url: "https://quote.eastmoney.com/zs000001.html" },
        { id: "szse", name: "深证成指", en: "SZSE COMPONENT", code: "399001", secid: "0.399001", url: "https://quote.eastmoney.com/zs399001.html" },
        { id: "chinext", name: "创业板指", en: "CHINEXT", code: "399006", secid: "0.399006", url: "https://quote.eastmoney.com/zs399006.html" },
        { id: "hsi", name: "恒生指数", en: "HANG SENG", code: "HSI", secid: "100.HSI", url: "https://quote.eastmoney.com/gb/zsHSI.html" },
        { id: "n225", name: "日经225", en: "NIKKEI 225", code: "N225", secid: "100.N225", url: "https://quote.eastmoney.com/gb/zsN225.html" },
        { id: "kospi", name: "韩国KOSPI", en: "KOSPI", code: "KS11", secid: "100.KS11", url: "https://quote.eastmoney.com/gb/zsKS11.html" },
        { id: "twse", name: "台湾加权", en: "TAIEX", code: "TWII", secid: "100.TWII", url: "https://quote.eastmoney.com/gb/zsTWII.html" },
        { id: "sensex", name: "印度SENSEX", en: "BSE SENSEX", code: "SENSEX", secid: "100.SENSEX", url: "https://quote.eastmoney.com/gb/zsSENSEX.html" },
        { id: "sti", name: "新加坡STI", en: "STRAITS TIMES", code: "STI", secid: "100.STI", url: "https://quote.eastmoney.com/gb/zsSTI.html" },
        { id: "as51", name: "澳洲ASX200", en: "S&P/ASX 200", code: "AS51", secid: "100.AS51", url: "https://quote.eastmoney.com/gb/zsAS51.html" },
      ],
    },
    {
      id: "europe",
      name: "欧洲",
      en: "EUROPE",
      markets: [
        { id: "ftse", name: "英国富时100", en: "FTSE 100", code: "FTSE", secid: "100.FTSE", url: "https://quote.eastmoney.com/gb/zsFTSE.html" },
        { id: "dax", name: "德国DAX", en: "DAX 40", code: "GDAXI", secid: "100.GDAXI", url: "https://quote.eastmoney.com/gb/zsGDAXI.html" },
        { id: "cac", name: "法国CAC40", en: "CAC 40", code: "FCHI", secid: "100.FCHI", url: "https://quote.eastmoney.com/gb/zsFCHI.html" },
        { id: "sx5e", name: "欧洲斯托克50", en: "EURO STOXX 50", code: "SX5E", secid: "100.SX5E", url: "https://quote.eastmoney.com/gb/zsSX5E.html" },
        { id: "smi", name: "瑞士SMI", en: "SWISS MARKET", code: "SSMI", secid: "100.SSMI", url: "https://quote.eastmoney.com/gb/zsSSMI.html" },
      ],
    },
    {
      id: "americas",
      name: "美洲",
      en: "AMERICAS",
      markets: [
        { id: "dji", name: "道琼斯", en: "DOW JONES", code: "DJIA", secid: "100.DJIA", url: "https://quote.eastmoney.com/gb/zsDJIA.html" },
        { id: "ixic", name: "纳斯达克", en: "NASDAQ", code: "NDX", secid: "100.NDX", url: "https://quote.eastmoney.com/gb/zsNDX.html" },
        { id: "spx", name: "标普500", en: "S&P 500", code: "SPX", secid: "100.SPX", url: "https://quote.eastmoney.com/gb/zsSPX.html" },
        { id: "tsx", name: "加拿大TSX", en: "S&P/TSX", code: "TSX", secid: "100.TSX", url: "https://quote.eastmoney.com/gb/zsTSX.html" },
        { id: "ibov", name: "巴西IBOVESPA", en: "BOVESPA", code: "BVSP", secid: "100.BVSP", url: "https://quote.eastmoney.com/gb/zsBVSP.html" },
      ],
    },
  ];

  function allMarkets() {
    return REGIONS.flatMap((region) => region.markets);
  }

  // -------------------------------------------------------------------- gold

  const GOLD_SECID = "101.GC00Y";
  const SHANGHAI_GOLD_SECID = "118.AU9999";
  const FX_SECID = "133.USDCNH";

  function fetchUsdCny() {
    return cached("fx", 60000, () =>
      singleQuote(FX_SECID).then((row) => {
        const rate = row ? scaled(row.f2) : null;
        if (rate && rate > 4 && rate < 12) return rate;
        return 7.1;
      })
    );
  }

  // ---------------------------------------------------------------- candles

  const PERIOD_KLT = { day: 101, week: 102, month: 103 };
  const PERIOD_LIMIT = { day: 260, week: 220, month: 180 };

  function fetchCandles(secid, period, limit) {
    const klt = PERIOD_KLT[period] || 101;
    const count = limit || PERIOD_LIMIT[period] || 260;
    const url =
      `${HISTORY_HOST}/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1` +
      `&lmt=${count}&end=20500101&${CANDLE_FIELDS}`;
    return jsonp(url).then((payload) => {
      const data = payload && payload.data;
      const rows = (data && data.klines) || [];
      if (!rows.length) throw new Error("暂无K线数据");
      const points = [];
      rows.forEach((line) => {
        const fields = String(line).split(",");
        if (fields.length < 6) return;
        const moment = new Date(`${fields[0].slice(0, 10)}T00:00:00+08:00`);
        if (Number.isNaN(moment.getTime())) return;
        points.push({
          t: moment.getTime(),
          o: Number(fields[1]),
          c: Number(fields[2]),
          h: Number(fields[3]),
          l: Number(fields[4]),
          v: Number(fields[5]) || 0,
        });
      });
      points.sort((a, b) => a.t - b.t);
      return points;
    });
  }

  function withMovingAverages(points) {
    const closes = [];
    points.forEach((point) => {
      closes.push(point.c);
      [5, 10, 20].forEach((window) => {
        if (closes.length >= window) {
          let sum = 0;
          for (let index = closes.length - window; index < closes.length; index += 1) {
            sum += closes[index];
          }
          point[`ma${window}`] = round(sum / window, 3);
        } else {
          point[`ma${window}`] = null;
        }
      });
    });
    return points;
  }

  function fetchTrends(secid, days) {
    const url =
      `${HISTORY_HOST}/stock/trends2/get?secid=${secid}&ndays=${days || 2}&iscr=0` +
      "&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58";
    return jsonp(url).then((payload) => {
      const data = payload && payload.data;
      const rows = (data && data.trends) || [];
      if (!rows.length) throw new Error("暂无分时数据");
      const points = [];
      rows.forEach((line) => {
        const fields = String(line).split(",");
        if (fields.length < 8) return;
        const moment = new Date(`${fields[0].replace(" ", "T")}+08:00`);
        if (Number.isNaN(moment.getTime())) return;
        points.push({
          t: moment.getTime(),
          o: Number(fields[1]),
          c: Number(fields[2]),
          h: Number(fields[3]),
          l: Number(fields[4]),
          v: Number(fields[5]) || 0,
          avg: Number(fields[7]) || null,
        });
      });
      if (!points.length) throw new Error("暂无分时数据");
      const lastDay = new Date(points[points.length - 1].t + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const session = points.filter(
        (point) =>
          new Date(point.t + 8 * 3600 * 1000).toISOString().slice(0, 10) === lastDay
      );
      return {
        prev_close: scaled(data.preClose),
        points: session.length > 20 ? session : points,
      };
    });
  }

  // ------------------------------------------------------------- dashboard

  function buildDashboard() {
    const markets = allMarkets();
    const secids = markets.map((market) => market.secid);
    return fetchUsdCny().then((fx) =>
      fetchQuotes(secids.concat([GOLD_SECID, SHANGHAI_GOLD_SECID, "1.000688"])).then(
        (quotes) => {
          const regions = REGIONS.map((region) => ({
            id: region.id,
            name: region.name,
            en: region.en,
            markets: region.markets.map((market) =>
              quoteToMarket(quotes.get(market.code), market)
            ),
          }));

          const goldRow = quotes.get("GC00Y");
          const shanghaiRow = quotes.get("AU9999");
          const starRow = quotes.get("000688");

          let gold = null;
          if (goldRow) {
            const factor = fx / TROY_OUNCE_GRAMS;
            const usdPrice = scaled(goldRow.f2);
            const usdPrevious = scaled(goldRow.f18);
            const usdChange = usdPrevious === null ? null : usdPrice - usdPrevious;
            gold = {
              price: round(usdPrice * factor, 2),
              change: usdChange === null ? null : round(usdChange * factor, 2),
              pct: scaled(goldRow.f3),
              previous: usdPrevious === null ? null : round(usdPrevious * factor, 2),
              open: round(scaled(goldRow.f17) * factor, 2),
              high: round(scaled(goldRow.f15) * factor, 2),
              low: round(scaled(goldRow.f16) * factor, 2),
              usd_price: round(usdPrice, 2),
              fx: round(fx, 4),
              unit: "CNY/g",
              unit_label: "元/克",
              updated: "",
            };
          }

          let shanghaiGold = null;
          if (shanghaiRow) {
            const price = scaled(shanghaiRow.f2);
            const previous = scaled(shanghaiRow.f18);
            const change = previous === null ? null : price - previous;
            shanghaiGold = {
              price: round(price, 2),
              change: round(change, 2),
              pct: scaled(shanghaiRow.f3),
              previous: previous === null ? null : round(previous, 2),
              open: round(scaled(shanghaiRow.f17), 2),
              high: round(scaled(shanghaiRow.f15), 2),
              low: round(scaled(shanghaiRow.f16), 2),
              unit: "CNY/g",
              unit_label: "元/克",
              symbol: "Au99.99",
              name: "上海金 Au99.99",
              updated: "",
            };
            if (gold && shanghaiGold.price) {
              const premium = gold.price - shanghaiGold.price;
              shanghaiGold.premium = round(premium, 2);
              shanghaiGold.premium_pct = round((premium / shanghaiGold.price) * 100, 2);
            }
          }

          let star50 = null;
          if (starRow) {
            star50 = {
              price: round(scaled(starRow.f2), 3),
              change: round(scaled(starRow.f4), 3),
              pct: scaled(starRow.f3),
              previous: round(scaled(starRow.f18), 3),
              open: round(scaled(starRow.f17), 3),
              high: round(scaled(starRow.f15), 3),
              low: round(scaled(starRow.f16), 3),
              updated: "",
            };
          }

          return {
            ok: true,
            stale: false,
            as_of: new Date().toISOString(),
            source: "东方财富公开行情",
            regions,
            assets: { gold, shanghai_gold: shanghaiGold, star50 },
          };
        }
      )
    );
  }

  // ----------------------------------------------------------------- charts

  function buildGoldChart(period) {
    return fetchUsdCny().then((fx) => {
      const factor = fx / TROY_OUNCE_GRAMS;
      const primary =
        period === "intraday"
          ? fetchTrends(GOLD_SECID, 2).then((series) => ({
              prev_close:
                series.prev_close === null ? null : round(series.prev_close * factor, 3),
              points: series.points.map((point) => ({
                ...point,
                o: round(point.o * factor, 3),
                h: round(point.h * factor, 3),
                l: round(point.l * factor, 3),
                c: round(point.c * factor, 3),
                avg: point.avg === null ? null : round(point.avg * factor, 3),
              })),
            }))
          : fetchCandles(GOLD_SECID, period).then((points) => ({
              prev_close: null,
              points: points.map((point) => ({
                ...point,
                o: round(point.o * factor, 3),
                h: round(point.h * factor, 3),
                l: round(point.l * factor, 3),
                c: round(point.c * factor, 3),
              })),
            }));

      const overlay =
        period === "intraday"
          ? fetchTrends(SHANGHAI_GOLD_SECID, 2)
          : fetchCandles(SHANGHAI_GOLD_SECID, period).then((points) => ({
              prev_close: null,
              points,
            }));

      return Promise.all([primary, overlay.catch(() => null)]).then(([main, shanghai]) => {
        const points =
          period === "intraday" ? main.points : withMovingAverages(main.points);
        const chart = {
          ok: true,
          stale: false,
          symbol: "gold",
          period,
          precision: 2,
          source: "东方财富 · 伦敦金现（折算）",
          as_of: new Date().toISOString(),
          currency: "CNY",
          unit: "CNY/g",
          unit_label: "元/克",
          fx: round(fx, 4),
          prev_close: main.prev_close,
          points,
        };
        if (shanghai && shanghai.points && shanghai.points.length > 1) {
          let overlayPoints = shanghai.points;
          if (period !== "intraday" && points.length) {
            const start = points[0].t;
            const end = points[points.length - 1].t + 86400000;
            overlayPoints = overlayPoints.filter(
              (point) => point.t >= start && point.t <= end
            );
          }
          chart.shanghai = {
            symbol: "Au99.99",
            name: "上海金 Au99.99",
            unit_label: "元/克",
            prev_close: shanghai.prev_close,
            points: overlayPoints,
          };
          if (overlayPoints.length && points.length) {
            const latestShanghai = overlayPoints[overlayPoints.length - 1].c;
            const latestLondon = points[points.length - 1].c;
            const premium = latestLondon - latestShanghai;
            chart.premium = round(premium, 2);
            chart.premium_pct = round((premium / latestShanghai) * 100, 2);
          }
        }
        return chart;
      });
    });
  }

  function buildStarChart(period) {
    if (period === "intraday") {
      return fetchTrends("1.000688", 2).then((series) => ({
        ok: true,
        stale: false,
        symbol: "star50",
        period,
        precision: 2,
        source: "东方财富",
        as_of: new Date().toISOString(),
        prev_close: series.prev_close,
        points: series.points,
      }));
    }
    return fetchCandles("1.000688", period).then((points) => ({
      ok: true,
      stale: false,
      symbol: "star50",
      period,
      precision: 2,
      source: "东方财富",
      as_of: new Date().toISOString(),
      points: withMovingAverages(points),
    }));
  }

  function getChart(symbol, period) {
    const key = `chart:${symbol}:${period}`;
    const ttl = period === "intraday" ? 30000 : 120000;
    return cached(key, ttl, () =>
      symbol === "gold" ? buildGoldChart(period) : buildStarChart(period)
    );
  }

  global.AurumData = {
    REGIONS,
    getDashboard: () => cached("dashboard", CACHE_TTL, buildDashboard),
    getChart,
    fetchUsdCny,
    invalidate,
    TROY_OUNCE_GRAMS,
  };
})(window);

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
  /* Eastmoney throttles bursts, so quotes travel in as few requests as
   * possible.  Shanghai gold is fetched separately because the batch endpoint
   * omits its previous close (f18), which made the change and premium read 0. */
  const QUOTE_BATCH = 30;

  /* Single-instrument endpoint: it always carries the previous close. */
  function fetchStockQuote(secid) {
    const url =
      `${QUOTE_HOST}/stock/get?fltt=2&invt=2&secid=${secid}` +
      "&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170";
    return jsonp(url).then((payload) => {
      const data = payload && payload.data;
      if (!data || !Number.isFinite(Number(data.f43))) return null;
      const price = Number(data.f43);
      const previous = Number(data.f60);
      const change = Number.isFinite(previous) ? price - previous : null;
      return {
        code: String(data.f57 || ""),
        name: String(data.f58 || ""),
        price,
        previous: Number.isFinite(previous) ? previous : null,
        change,
        pct: Number.isFinite(Number(data.f170))
          ? Number(data.f170)
          : change !== null && previous
            ? (change / previous) * 100
            : null,
        high: Number(data.f44),
        low: Number(data.f45),
        open: Number(data.f46),
      };
    });
  }

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

  /* Local (Beijing) hour at which each venue opens its trading day.  The
   * intraday feed returns the last two sessions glued together, so the chart
   * needs to know where one session ends and the next begins.  Measured from
   * the trends2 feed: COMEX gold 07:00 with a 06:00-07:00 break, Shanghai gold
   * night leg 20:00.  A股-style venues (09:30) never straddle midnight and are
   * left out on purpose: their last calendar day is already one session. */
  const SESSION_OPEN_HOUR = {
    "101.GC00Y": 7,
    "118.AU9999": 20,
  };

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
      /* A session does not start at midnight, and where it starts depends on
       * the venue.  COMEX gold trades 07:00 -> 06:00 (next day) while the
       * Shanghai gold night leg opens at 20:00, so no single hard-coded hour
       * works: 18:00 truncates the London curve, and the last calendar date
       * glues two sessions together.  Walk back from the newest tick to the
       * most recent opening of *this* instrument and keep everything after it.
       * Venues whose session never crosses midnight (A股 09:30-15:00) simply
       * fall back to the last calendar day, which is already one session. */
      const last = points[points.length - 1].t;
      const lastLocal = new Date(last + 8 * 3600 * 1000);
      const openHour = SESSION_OPEN_HOUR[secid];
      let session = points;
      if (Number.isFinite(openHour)) {
        const boundary = new Date(lastLocal.getTime());
        boundary.setUTCHours(Math.floor(openHour), (openHour % 1) * 60, 0, 0);
        while (boundary.getTime() > lastLocal.getTime()) {
          boundary.setUTCDate(boundary.getUTCDate() - 1);
        }
        const startMs = boundary.getTime() - 8 * 3600 * 1000;
        session = points.filter((point) => point.t >= startMs);
      } else {
        const lastDay = new Date(last + 8 * 3600 * 1000).toISOString().slice(0, 10);
        session = points.filter(
          (point) =>
            new Date(point.t + 8 * 3600 * 1000).toISOString().slice(0, 10) === lastDay
        );
      }
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
    // Shanghai gold prefers the single-instrument endpoint because it always
    // carries the previous close; the batch quote is the fallback.
    const shanghaiQuote = cached("sge-quote", 15000, () =>
      fetchStockQuote(SHANGHAI_GOLD_SECID).catch(() => null)
    );
    return fetchUsdCny().then((fx) =>
      Promise.all([
        fetchQuotes(secids.concat([GOLD_SECID, SHANGHAI_GOLD_SECID, "1.000688"])),
        shanghaiQuote,
      ]).then(([quotes, shanghaiStock]) => {
          const regions = REGIONS.map((region) => ({
            id: region.id,
            name: region.name,
            en: region.en,
            markets: region.markets.map((market) =>
              quoteToMarket(quotes.get(market.code), market)
            ),
          }));

          const goldRow = quotes.get("GC00Y");
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
          const batchRow = quotes.get("AU9999");
          if (shanghaiStock && Number.isFinite(shanghaiStock.price)) {
            shanghaiGold = {
              price: round(shanghaiStock.price, 2),
              change:
                shanghaiStock.change === null ? null : round(shanghaiStock.change, 2),
              pct: round(shanghaiStock.pct, 2),
              previous:
                shanghaiStock.previous === null ? null : round(shanghaiStock.previous, 2),
              open: round(shanghaiStock.open, 2),
              high: round(shanghaiStock.high, 2),
              low: round(shanghaiStock.low, 2),
              unit: "CNY/g",
              unit_label: "元/克",
              symbol: "Au99.99",
              name: "上海金 Au99.99",
              updated: "",
            };
          } else if (batchRow && Number.isFinite(scaled(batchRow.f2))) {
            // Fallback when the single-instrument endpoint is unavailable.
            const price = scaled(batchRow.f2);
            const previous = scaled(batchRow.f18);
            shanghaiGold = {
              price: round(price, 2),
              change: previous === null ? null : round(price - previous, 2),
              pct: scaled(batchRow.f3),
              previous: previous === null ? null : round(previous, 2),
              open: round(scaled(batchRow.f17), 2),
              high: round(scaled(batchRow.f15), 2),
              low: round(scaled(batchRow.f16), 2),
              unit: "CNY/g",
              unit_label: "元/克",
              symbol: "Au99.99",
              name: "上海金 Au99.99",
              updated: "",
            };
          }
          if (shanghaiGold && gold && shanghaiGold.price) {
            const premium = gold.price - shanghaiGold.price;
            shanghaiGold.premium = round(premium, 2);
            shanghaiGold.premium_pct = round((premium / shanghaiGold.price) * 100, 2);
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

  /* ---- historical USD/CNH for candle conversion ---------------------------
   * Converting a 2011 gold bar with today's rate is wrong: USD/CNH was 6.34
   * then and is ~6.66 now, and measured against the real series the error
   * reaches 10.4% at the extremes (and flips sign around 2019, where the
   * rate was above today's).  So candles are converted with the rate that
   * was actually in force on that bar, and only intraday keeps a single
   * current rate -- a session lasts hours, not years. */

  function fetchFxHistory(period) {
    const klt = PERIOD_KLT[period] || 101;
    /* Enough bars to cover the matching gold range, which starts further
     * back (gold month reaches 2011-12, FX month reaches 2010-08). */
    const limit = period === "month" ? 220 : period === "week" ? 300 : 420;
    const url =
      `${HISTORY_HOST}/stock/kline/get?secid=${FX_SECID}&klt=${klt}&fqt=1` +
      `&lmt=${limit}&end=20500101&${CANDLE_FIELDS}`;
    return jsonp(url).then((payload) => {
      const data = payload && payload.data;
      const rows = (data && data.klines) || [];
      const points = [];
      rows.forEach((line) => {
        const fields = String(line).split(",");
        if (fields.length < 3) return;
        const moment = new Date(`${fields[0].slice(0, 10)}T00:00:00+08:00`);
        const close = Number(fields[2]);
        if (Number.isNaN(moment.getTime())) return;
        if (!Number.isFinite(close) || close <= 0) return;
        points.push({ t: moment.getTime(), c: close });
      });
      points.sort((a, b) => a.t - b.t);
      if (!points.length) throw new Error("暂无汇率数据");
      return points;
    });
  }

  function ymd(timestamp) {
    return new Date(timestamp + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /* Month bars do not share a timestamp between the two feeds (gold closes
   * 2011-12-30, FX 2011-12-31), so months are matched by YYYY-MM.  Day and
   * week bars match by date, falling back to the newest rate at or before
   * the bar so a holiday gap never leaves a bar unconverted. */
  function makeFxResolver(fxPoints, period) {
    if (period === "month") {
      const byMonth = new Map();
      fxPoints.forEach((point) => byMonth.set(ymd(point.t).slice(0, 7), point.c));
      return (timestamp) => byMonth.get(ymd(timestamp).slice(0, 7)) || null;
    }
    const byDate = new Map();
    fxPoints.forEach((point) => byDate.set(ymd(point.t), point.c));
    return (timestamp) => {
      const exact = byDate.get(ymd(timestamp));
      if (exact) return exact;
      let low = 0;
      let high = fxPoints.length - 1;
      let best = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (fxPoints[mid].t <= timestamp) {
          best = fxPoints[mid].c;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best;
    };
  }

  // ----------------------------------------------------------------- charts

  function buildGoldChart(period) {
    return fetchUsdCny().then((liveFx) => {
      const flatFactor = liveFx / TROY_OUNCE_GRAMS;
      const convert = (value, factor) => round(value * factor, 3);

      const overlay =
        period === "intraday"
          ? fetchTrends(SHANGHAI_GOLD_SECID, 2)
          : fetchCandles(SHANGHAI_GOLD_SECID, period).then((points) => ({
              prev_close: null,
              points,
            }));

      if (period === "intraday") {
        const primary = fetchTrends(GOLD_SECID, 2).then((series) => ({
          prev_close:
            series.prev_close === null ? null : convert(series.prev_close, flatFactor),
          points: series.points.map((point) => ({
            ...point,
            o: convert(point.o, flatFactor),
            h: convert(point.h, flatFactor),
            l: convert(point.l, flatFactor),
            c: convert(point.c, flatFactor),
            avg: point.avg === null ? null : convert(point.avg, flatFactor),
          })),
        }));
        return Promise.all([primary, overlay.catch(() => null)]).then(([main, shanghai]) =>
          assembleGoldChart(period, main, shanghai, {
            fx: liveFx,
            fxMode: "live",
          })
        );
      }

      /* Candles need the rate series; if it is unavailable the chart still
       * renders with the current rate, but says so instead of pretending. */
      const fxHistory = fetchFxHistory(period).catch(() => null);
      return fxHistory.then((history) => {
        const resolver = history && history.length > 1 ? makeFxResolver(history, period) : null;
        const fxMode = resolver ? "historical" : "flat-fallback";
        const primary = fetchCandles(GOLD_SECID, period).then((points) => ({
          prev_close: null,
          points: points.map((point) => {
            const rate = (resolver && resolver(point.t)) || liveFx;
            const factor = rate / TROY_OUNCE_GRAMS;
            return {
              ...point,
              o: convert(point.o, factor),
              h: convert(point.h, factor),
              l: convert(point.l, factor),
              c: convert(point.c, factor),
            };
          }),
        }));
        return Promise.all([primary, overlay.catch(() => null)]).then(([main, shanghai]) =>
          assembleGoldChart(period, main, shanghai, {
            fx: liveFx,
            fxMode,
          })
        );
      });
    });
  }

  function assembleGoldChart(period, main, shanghai, meta) {
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
      fx: round(meta.fx, 4),
      fx_mode: meta.fxMode,
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

  /* ---- 飞天茅台 500ml -----------------------------------------------------
   * 聚金数据 publishes the wholesale reference price for a 53%vol / 500ml
   * loose bottle, but their endpoint is AES-encrypted behind a bot challenge,
   * so the series is snapshotted into js/moutai-data.js instead of being
   * fetched at runtime.  Everything below is real data, not an estimate.
   * ---------------------------------------------------------------------- */

  const MOUTAI_PERIODS = ["daily-line", "week-line", "month-line"];

  function moutaiPayload() {
    return global.AurumMoutaiData || null;
  }

  /* Bucket the daily rows into weeks (Monday-based) or calendar months and
   * keep the last price of each bucket. */
  function moutaiBucketed(rows, period) {
    if (period === "daily-line") {
      return rows.map((row) => ({
        key: row.date,
        t: Date.parse(`${row.date}T00:00:00Z`),
        c: row.price,
      }));
    }

    const buckets = new Map();
    for (const row of rows) {
      const date = new Date(`${row.date}T00:00:00Z`);
      let key;
      let stamp;
      if (period === "week-line") {
        // ISO-ish week start (Monday).
        const day = (date.getUTCDay() + 6) % 7;
        const monday = new Date(date.getTime() - day * 86400000);
        stamp = monday.getTime();
        key = monday.toISOString().slice(0, 10);
      } else {
        stamp = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        key = row.date.slice(0, 7);
      }
      buckets.set(key, { key, t: stamp, c: row.price });
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }

  function buildMoutaiChart(period) {
    const bundle = moutaiPayload();
    if (!bundle || !Array.isArray(bundle.daily) || bundle.daily.length < 2) {
      return Promise.reject(new Error("茅台数据缺失"));
    }

    const rows = bundle.daily.slice().sort((a, b) => a.date.localeCompare(b.date));
    const points = moutaiBucketed(rows, period);

    const latest = rows[rows.length - 1];
    const first = rows[0];
    const prices = rows.map((row) => row.price);
    const yearStr = latest.date.slice(0, 4);
    const yearRows = rows.filter((row) => row.date.startsWith(yearStr));
    const yearStart = yearRows.length ? yearRows[0].price : first.price;
    const change = latest.price - yearStart;
    const changePct = yearStart ? (change / yearStart) * 100 : 0;
    /* The series is a calendar-daily price feed, not a trading calendar: it
     * carries weekend rows and skips nothing but public holidays.  Calling
     * rows.length "trading days" elsewhere would overstate it by ~27%. */
    const weekendRows = rows.filter((row) => {
      const day = new Date(`${row.date}T00:00:00Z`).getUTCDay();
      return day === 0 || day === 6;
    }).length;

    return Promise.resolve({
      ok: true,
      stale: false,
      symbol: "moutai",
      period,
      precision: 0,
      line: true,
      source: "聚金数据",
      as_of: latest.date,
      unit: "元/瓶",
      unit_label: "元/瓶",
      prev_close: yearStart,
      latest: {
        price: latest.price,
        date: latest.date,
        change,
        change_pct: round(changePct, 2),
        year_start: yearStart,
        high: Math.max(...prices),
        low: Math.min(...prices),
        span: `${first.date} ~ ${latest.date}`,
        days: rows.length,
        weekend_days: weekendRows,
      },
      points,
    });
  }

  function getChart(symbol, period) {
    if (symbol === "moutai") {
      // Snapshotted data, so it needs no network round trip or cache entry.
      return buildMoutaiChart(period);
    }
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
    MOUTAI_PERIODS,
  };
})(window);

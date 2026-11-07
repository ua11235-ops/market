/* Aurum Market dashboard controller. */
(function () {
  "use strict";

  const REFRESH_MS = 30000;
  const FETCH_TIMEOUT_MS = 26000;
  const charts = {};
  const state = {
    region: "asia",
    dashboard: null,
    dashboardLoading: false,
    dashboardController: null,
    charts: {
      gold: {
        period: "intraday",
        dataPeriod: null,
        controller: null,
        loading: false,
        lastLoadedAt: 0,
        stale: false,
      },
      star50: {
        period: "intraday",
        dataPeriod: null,
        controller: null,
        loading: false,
        lastLoadedAt: 0,
        stale: false,
      },
    },
    lastWarning: "",
    toastTimer: 0,
  };

  const numberFormat = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function $(id) {
    return document.getElementById(id);
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits === undefined ? 2 : digits,
      maximumFractionDigits: digits === undefined ? 2 : digits,
    }).format(Number(value));
  }

  function signedNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${formatNumber(number, digits)}`;
  }

  function trendClass(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return "is-flat";
    return number > 0 ? "is-up" : "is-down";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatChartDate(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    const text = shortDateFormatter.format(new Date(timestamp));
    return text.replace("/", "-").replace(" ", " ");
  }

  function setText(element, text, flash) {
    if (!element) return;
    if (element.textContent === text) return;
    element.textContent = text;
    if (flash) {
      element.classList.remove("is-flashing");
      void element.offsetWidth;
      element.classList.add("is-flashing");
    }
  }

  function setLoading(element, visible) {
    if (!element) return;
    window.clearTimeout(element._hideTimer);
    if (visible) {
      element.hidden = false;
      element.classList.remove("is-hiding");
    } else {
      element.classList.add("is-hiding");
      element._hideTimer = window.setTimeout(() => {
        element.hidden = true;
        element.classList.remove("is-hiding");
      }, 220);
    }
  }

  function toast(message, duration) {
    const element = $("toast");
    if (!element) return;
    if (!message) {
      element.classList.remove("is-visible");
      return;
    }
    element.textContent = message;
    element.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      element.classList.remove("is-visible");
    }, duration || 5200);
  }

  /* Runs a data request with a timeout and abort support.  The browser data
   * layer (js/data.js) does the actual fetching; there is no local server. */
  async function withTimeout(task, signal) {
    let aborted = false;
    const timer = window.setTimeout(() => {
      aborted = true;
    }, FETCH_TIMEOUT_MS);
    const onAbort = () => {
      aborted = true;
    };
    if (signal) {
      if (signal.aborted) aborted = true;
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const payload = await Promise.race([
        task,
        new Promise((_, reject) => {
          const poll = window.setInterval(() => {
            if (aborted) {
              window.clearInterval(poll);
              reject(new Error("行情请求超时，请稍后重试"));
            }
          }, 120);
          window.setTimeout(() => window.clearInterval(poll), FETCH_TIMEOUT_MS + 500);
        }),
      ]);
      if (!payload || payload.ok === false) {
        throw new Error((payload && payload.error) || "行情数据不可用");
      }
      return payload;
    } finally {
      window.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  function updateClock() {
    const now = new Date();
    const element = $("clock");
    if (element) element.textContent = clockFormatter.format(now);
  }

  function setConnection(mode, detail) {
    const pill = $("connection-pill");
    const label = $("connection-text");
    if (!pill || !label) return;
    pill.classList.remove("is-offline", "is-stale");
    if (mode === "live") {
      label.textContent = "实时行情";
      pill.title = detail || "行情每 30 秒自动刷新";
    } else if (mode === "stale") {
      label.textContent = "缓存行情";
      pill.classList.add("is-stale");
      pill.title = detail || "当前显示最近一次缓存数据";
    } else if (mode === "offline") {
      label.textContent = "连接中断";
      pill.classList.add("is-offline");
      pill.title = detail || "无法连接行情服务";
    } else {
      label.textContent = "正在连接行情";
      pill.title = detail || "正在连接行情服务";
    }
  }

  function regionName(regionId) {
    const names = { asia: "亚洲", europe: "欧洲", americas: "美洲" };
    return names[regionId] || regionId;
  }

  function renderRegionTabs() {
    document.querySelectorAll(".region-tab").forEach((button) => {
      const active = button.dataset.region === state.region;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function createMarketCard(market, index) {
    const card = document.createElement("a");
    card.className = "market-card";
    card.href = market.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.dataset.external = "true";
    card.style.setProperty("--i", String(index));
    const pct = Number(market.pct);
    const trend = Number.isFinite(pct) && pct !== 0 ? (pct > 0 ? "up" : "down") : "flat";
    card.style.setProperty("--trend-color", `var(--${trend})`);
    const priceText = market.price === null || market.price === undefined ? "—" : formatNumber(market.price, 2);
    const pctText = market.pct === null || market.pct === undefined ? "暂无" : `${signedNumber(market.pct, 2)}%`;
    card.setAttribute(
      "aria-label",
      `${market.name} ${priceText}，${pctText}，打开外部行情详情`
    );

    const top = document.createElement("div");
    top.className = "market-card-top";
    const name = document.createElement("span");
    name.className = "market-name";
    name.textContent = market.name;
    const code = document.createElement("span");
    code.className = "market-code";
    code.textContent = market.code;
    top.append(name, code);

    const bottom = document.createElement("div");
    bottom.className = "market-card-bottom";
    const price = document.createElement("span");
    price.className = `market-price${market.price === null || market.price === undefined ? " is-empty" : ""}`;
    price.textContent = priceText;
    const change = document.createElement("span");
    change.className = `market-change ${trendClass(market.pct)}`;
    change.textContent = pctText;
    bottom.append(price, change);

    card.append(top, bottom);
    return card;
  }

  function renderMarkets() {
    const grid = $("market-grid");
    if (!grid) return;
    if (!state.dashboard) return;
    const region = (state.dashboard.regions || []).find((item) => item.id === state.region);
    grid.replaceChildren();
    if (!region || !region.markets || !region.markets.length) {
      const empty = document.createElement("div");
      empty.className = "market-empty";
      empty.textContent = "该区域暂无行情数据";
      grid.append(empty);
      return;
    }
    region.markets.forEach((market, index) => {
      grid.append(createMarketCard(market, index));
    });
    grid.classList.remove("is-switching");
    void grid.offsetWidth;
    grid.classList.add("is-switching");
    renderRegionTabs();

    const tab = document.querySelector(`.region-tab[data-region="${state.region}"] small`);
    if (tab && !tab.dataset.counted) {
      tab.textContent = `${tab.textContent} · ${String(region.markets.length).padStart(2, "0")}`;
      tab.dataset.counted = "true";
    }
  }

  function updateTabsCounts() {
    if (!state.dashboard) return;
    document.querySelectorAll(".region-tab").forEach((button) => {
      const region = (state.dashboard.regions || []).find((item) => item.id === button.dataset.region);
      const count = region && region.markets ? region.markets.length : 0;
      const small = button.querySelector("small");
      if (small) {
        const code = { asia: "ASIA", europe: "EUROPE", americas: "AMERICAS" }[button.dataset.region] || "";
        small.textContent = `${code} · ${String(count).padStart(2, "0")}`;
      }
    });
  }

  function updateAsset(symbol, asset) {
    if (!asset) return;
    const priceElement = $(`${symbol}-price`);
    const changeElement = $(`${symbol}-change`);
    const stats = $(`${symbol}-stats`);
    const pct = Number(asset.pct);
    const direction = trendClass(pct);
    const isGold = symbol === "gold";
    const priceText = isGold
      ? `¥ ${formatNumber(asset.price, 2)}`
      : formatNumber(asset.price, 2);
    setText(priceElement, priceText, true);
    if (priceElement) {
      priceElement.classList.remove("is-up", "is-down");
      if (pct > 0) priceElement.classList.add("is-up");
      if (pct < 0) priceElement.classList.add("is-down");
    }
    if (changeElement) {
      changeElement.className = `asset-change ${direction}`;
      const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
      const changeText = asset.change === null || asset.change === undefined ? "—" : signedNumber(asset.change, 2);
      const pctText = asset.pct === null || asset.pct === undefined ? "—" : `${signedNumber(asset.pct, 2)}%`;
      changeElement.innerHTML =
        `<span class="delta"><span class="arrow">${arrow}</span>${escapeHtml(changeText)}</span>` +
        '<span class="change-separator">·</span>' +
        `<span>${escapeHtml(pctText)}</span>`;
    }
    if (stats) {
      const fields = ["previous", "open", "high", "low"];
      fields.forEach((field) => {
        const target = stats.querySelector(`[data-field="${field}"]`);
        if (!target) return;
        const value = asset[field];
        target.textContent = value === null || value === undefined ? "—" : formatNumber(value, 2);
      });
    }
    if (isGold) {
      const subtitle = $("gold-subtitle");
      if (subtitle && asset.usd_price !== null && asset.usd_price !== undefined) {
        const fx = Number(asset.fx);
        subtitle.textContent =
          `人民币折算 · USD/oz $${formatNumber(asset.usd_price, 2)}` +
          (Number.isFinite(fx) ? ` · USD/CNY ${formatNumber(fx, 4)}` : "");
      }
    }
    const footer = $(`${symbol}-updated`);
    if (footer && asset.updated) {
      footer.textContent = `报价 ${asset.updated}`;
    }
  }

  function updateShanghaiGold(asset) {
    const priceElement = $("sge-price");
    const changeElement = $("sge-change");
    const gapElement = $("gold-gap");
    if (!priceElement) return;
    if (!asset || asset.price === null || asset.price === undefined) {
      priceElement.textContent = "—";
      if (changeElement) {
        changeElement.className = "asset-change is-flat";
        changeElement.textContent = "暂不可用";
      }
      if (gapElement) gapElement.hidden = true;
      return;
    }
    const pct = Number(asset.pct);
    priceElement.textContent = `¥ ${formatNumber(asset.price, 2)}`;
    priceElement.classList.remove("is-up", "is-down");
    if (pct > 0) priceElement.classList.add("is-up");
    if (pct < 0) priceElement.classList.add("is-down");
    if (changeElement) {
      changeElement.className = `asset-change ${trendClass(pct)}`;
      const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
      const changeText =
        asset.change === null || asset.change === undefined ? "—" : signedNumber(asset.change, 2);
      const pctText =
        asset.pct === null || asset.pct === undefined ? "—" : `${signedNumber(asset.pct, 2)}%`;
      changeElement.innerHTML =
        `<span class="delta"><span class="arrow">${arrow}</span>${escapeHtml(changeText)}</span>` +
        '<span class="change-separator">·</span>' +
        `<span>${escapeHtml(pctText)}</span>`;
    }
    if (gapElement) {
      const premium = Number(asset.premium);
      if (Number.isFinite(premium)) {
        const pctGap = Number(asset.premium_pct);
        gapElement.hidden = false;
        gapElement.textContent =
          `伦敦 − 上海 ${premium > 0 ? "+" : ""}${formatNumber(premium, 2)} 元/克` +
          (Number.isFinite(pctGap) ? ` (${pctGap > 0 ? "+" : ""}${formatNumber(pctGap, 2)}%)` : "");
        gapElement.title = "伦敦金现折算价 − 上海金 Au99.99 价格";
      } else {
        gapElement.hidden = true;
      }
    }
  }

  function updateDashboard(payload) {
    state.dashboard = payload;
    renderMarkets();
    updateTabsCounts();
    if (payload.assets) {
      updateAsset("gold", payload.assets.gold);
      updateShanghaiGold(payload.assets.shanghai_gold);
      updateAsset("star50", payload.assets.star50);
      if (charts.gold && payload.assets.gold) {
        charts.gold.syncLatestPrice(Number(payload.assets.gold.price));
      }
      if (charts.gold && payload.assets.shanghai_gold) {
        charts.gold.syncShanghaiPrice(Number(payload.assets.shanghai_gold.price));
      }
      if (charts.star50 && payload.assets.star50) {
        charts.star50.syncLatestPrice(Number(payload.assets.star50.price));
      }
    }
    if (payload.stale) {
      setConnection("stale", payload.warning);
      if (payload.warning && payload.warning !== state.lastWarning) {
        state.lastWarning = payload.warning;
        toast(`${payload.warning}。请检查网络连接。`, 6200);
      }
    } else {
      setConnection("live", payload.source);
      const pill = $("connection-pill");
      if (pill) pill.title = `${payload.source} · 更新于 ${payload.as_of}`;
      state.lastWarning = "";
    }
    if (payload.as_of) {
      const updated = document.querySelector(".market-footnote > span:first-child");
      if (updated) {
        const time = String(payload.as_of).slice(11, 19);
        updated.innerHTML = `<i class="status-dot"></i>行情更新 ${escapeHtml(time)} · 公开数据可能存在延迟`;
      }
    }
  }

  async function loadDashboard(force, silent) {
    if (state.dashboardLoading && !force) return;
    if (state.dashboardController) state.dashboardController.abort();
    const controller = new AbortController();
    state.dashboardController = controller;
    state.dashboardLoading = true;
    const button = $("refresh-button");
    if (button && force) button.classList.add("is-spinning");
    try {
      // A forced refresh must bypass the short-lived browser cache, including
      // the separately cached Shanghai gold quote.
      if (force && window.AurumData.invalidate) {
        window.AurumData.invalidate("dashboard");
        window.AurumData.invalidate("sge-quote");
        window.AurumData.invalidate("chart:");
      }
      const payload = await withTimeout(window.AurumData.getDashboard(), controller.signal);
      if (controller.signal.aborted) return;
      updateDashboard(payload);
      state.dashboardFailures = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      state.dashboardFailures = (state.dashboardFailures || 0) + 1;
      // The JSONP endpoints occasionally drop a request; retry a couple of
      // times before telling the visitor the feed is down.
      if (state.dashboardFailures <= 2) {
        window.setTimeout(() => {
          if (!state.dashboard) loadDashboard(false, true);
        }, 700 * state.dashboardFailures);
        return;
      }
      setConnection("offline", error.message);
      if (!state.dashboard) {
        const grid = $("market-grid");
        if (grid) {
          grid.innerHTML = '<div class="market-empty">行情接口暂时不可用，正在自动重试…</div>';
        }
      }
      if (!silent || !state.dashboard) {
        toast(error.message || "全球行情加载失败", 6000);
      }
    } finally {
      if (state.dashboardController === controller) {
        state.dashboardLoading = false;
        state.dashboardController = null;
      }
      if (button) window.setTimeout(() => button.classList.remove("is-spinning"), force ? 520 : 0);
    }
  }

  function updateGoldNote(payload) {
    const note = $("gold-note");
    if (!note) return;
    const shanghai = payload.shanghai;
    const hasShanghai = shanghai && Array.isArray(shanghai.points) && shanghai.points.length > 1;
    if (!hasShanghai) {
      note.hidden = true;
      return;
    }
    const first = shanghai.points[0];
    const last = shanghai.points[shanghai.points.length - 1];
    const span = `${formatChartDate(first.t)} → ${formatChartDate(last.t)}`;
    if (payload.period === "intraday") {
      note.hidden = false;
      note.textContent =
        `上海金取交易时段 ${span}（夜盘 20:00 起，含次日日盘）；` +
        "两条分时按各自盘口对齐，仅比较形态，横轴时间以伦敦金现为准。";
      return;
    }
    note.hidden = false;
    note.textContent = `上海金 Au99.99 同期区间 ${span}，与伦敦金现按日期对齐后叠加。`;
  }

  function updateLegend(symbol, payload) {
    const legend = $(`${symbol}-legend`);
    if (!legend) return;
    if (symbol === "gold") {
      const hasShanghai =
        payload.shanghai && Array.isArray(payload.shanghai.points) && payload.shanghai.points.length > 1;
      const items = ['<span class="legend-item legend-london"><i></i>伦敦金现</span>'];
      if (hasShanghai) {
        items.push('<span class="legend-item legend-sge"><i></i>上海金 Au99.99</span>');
      }
      if (payload.period === "intraday") {
        items.push('<span class="legend-item legend-avg"><i></i>均价</span>');
      } else {
        items.push('<span class="legend-item legend-ma5"><i></i>MA5</span>');
        items.push('<span class="legend-item legend-ma10"><i></i>MA10</span>');
        items.push('<span class="legend-item legend-ma20"><i></i>MA20</span>');
      }
      legend.innerHTML = items.join("");
      return;
    }
    if (payload.period === "intraday") {
      const hasAverage = payload.points.some((point) => Number.isFinite(point.avg));
      legend.innerHTML = hasAverage
        ? '<span class="legend-item legend-avg"><i></i>均价</span>'
        : '<span class="legend-item"><i style="--legend-color:#7f8b9b"></i>价格走势</span>';
    } else {
      legend.innerHTML =
        '<span class="legend-item legend-ma5"><i></i>MA5</span>' +
        '<span class="legend-item legend-ma10"><i></i>MA10</span>' +
        '<span class="legend-item legend-ma20"><i></i>MA20</span>';
    }
  }

  function updateChartMeta(symbol, payload) {
    const stateElement = $(`${symbol}-state`);
    if (stateElement) {
      stateElement.textContent = payload.stale ? "缓存" : "实时";
      stateElement.classList.toggle("is-stale", Boolean(payload.stale));
    }
    const source = $(`${symbol}-source`);
    if (source && payload.source) source.textContent = payload.source;
    const updated = $(`${symbol}-updated`);
    if (updated && payload.points.length) {
      let text = `截至 ${formatChartDate(payload.points[payload.points.length - 1].t)}`;
      if (symbol === "gold" && Number.isFinite(Number(payload.fx))) {
        text += ` · 汇率 ${formatNumber(payload.fx, 4)}`;
      }
      updated.textContent = text;
    }
    const timeframe = document.querySelector(
      `.timeframe-group button[data-symbol="${symbol}"][data-period="${payload.period}"]`
    );
    if (timeframe) {
      document
        .querySelectorAll(`.timeframe-group button[data-symbol="${symbol}"]`)
        .forEach((button) => {
          const active = button.dataset.period === payload.period;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }
  }

  function clearChart(symbol, message) {
    const chart = charts[symbol];
    if (chart) {
      chart.setData({ points: [], period: state.charts[symbol].period });
    }
    const empty = $(`${symbol}-empty`);
    if (empty) {
      empty.textContent = message || "暂无可用走势数据";
      empty.hidden = false;
    }
  }

  async function loadChart(symbol, period, options) {
    const settings = options || {};
    const chart = charts[symbol];
    if (!chart) return;
    const chartState = state.charts[symbol];
    const samePeriod = chartState.dataPeriod === period;
    if (chartState.loading && chartState.requestedPeriod === period && !settings.force) return;
    if (chartState.controller) chartState.controller.abort();
    const controller = new AbortController();
    chartState.controller = controller;
    chartState.loading = true;
    chartState.requestedPeriod = period;

    const loading = $(`${symbol}-loading`);
    const empty = $(`${symbol}-empty`);
    if (!settings.silent || !samePeriod) {
      if (empty) empty.hidden = true;
      setLoading(loading, true);
    }

    document
      .querySelectorAll(`.timeframe-group button[data-symbol="${symbol}"]`)
      .forEach((button) => {
        const active = button.dataset.period === period;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });

    try {
      const payload = await withTimeout(
        window.AurumData.getChart(symbol, period),
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (!payload.points || payload.points.length < 2) {
        throw new Error("该周期暂无可用走势数据");
      }
      chartState.period = period;
      chartState.dataPeriod = period;
      chartState.lastLoadedAt = Date.now();
      chartState.stale = Boolean(payload.stale);
      // Auto-refreshes of the same period keep the user's zoom window.
      chart.setData(payload, { keepView: Boolean(settings.keepView) });
      if (state.dashboard && state.dashboard.assets) {
        const asset = state.dashboard.assets[symbol];
        if (asset && Number.isFinite(Number(asset.price))) {
          chart.syncLatestPrice(Number(asset.price));
        }
        if (symbol === "gold") {
          const shanghai = state.dashboard.assets.shanghai_gold;
          if (shanghai && Number.isFinite(Number(shanghai.price))) {
            chart.syncShanghaiPrice(Number(shanghai.price));
          }
        }
      }
      updateChartMeta(symbol, payload);
      updateLegend(symbol, payload);
      if (symbol === "gold") updateGoldNote(payload);
      if (empty) empty.hidden = true;
      if (payload.stale && payload.warning) {
        toast(`${symbol === "gold" ? "黄金" : "科创50"}：${payload.warning}`, 5600);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (samePeriod && chartState.dataPeriod === period) {
        toast(error.message || "走势加载失败", 5600);
      } else {
        clearChart(symbol, error.message || "暂无可用走势数据");
        const stateElement = $(`${symbol}-state`);
        if (stateElement) {
          stateElement.textContent = "不可用";
          stateElement.classList.add("is-stale");
        }
        toast(error.message || "走势加载失败", 5600);
      }
    } finally {
      if (chartState.controller === controller) {
        chartState.loading = false;
        chartState.controller = null;
        setLoading(loading, false);
      }
    }
  }

  function bindEvents() {
    document.querySelectorAll(".region-tab").forEach((button) => {
      button.addEventListener("click", () => {
        const region = button.dataset.region;
        if (!region || region === state.region) return;
        state.region = region;
        renderRegionTabs();
        try {
          localStorage.setItem("aurum.region", region);
        } catch (error) {
          /* localStorage is optional */
        }
        if (state.dashboard) {
          const grid = $("market-grid");
          if (grid) {
            grid.classList.remove("is-switching");
            void grid.offsetWidth;
          }
          renderMarkets();
        }
      });
    });

    document.querySelectorAll(".timeframe-group button").forEach((button) => {
      button.addEventListener("click", () => {
        const symbol = button.dataset.symbol;
        const period = button.dataset.period;
        if (!symbol || !period) return;
        if (state.charts[symbol].period === period && state.charts[symbol].dataPeriod === period) return;
        state.charts[symbol].period = period;
        loadChart(symbol, period);
      });
    });

    const refresh = $("refresh-button");
    if (refresh) {
      refresh.addEventListener("click", () => {
        loadDashboard(true, false);
        loadChart("gold", state.charts.gold.period, { force: true, silent: true });
        loadChart("star50", state.charts.star50.period, { force: true, silent: true });
      });
    }

    document.addEventListener("click", (event) => {
      const anchor = event.target.closest("a[data-external]");
      if (!anchor) return;
      // A static site cannot ask the OS to open a browser, so let the anchor
      // behave natively; target="_blank" is already set in the markup.
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        Object.values(charts).forEach((chart) => chart.clearHover());
        toast("");
      }
    });
  }

  function setupCharts() {
    charts.gold = new MarketChart($("gold-chart"), $("gold-tooltip"), {
      symbol: "gold",
      accent: "#e9ba68",
    });
    charts.star50 = new MarketChart($("star50-chart"), $("star50-tooltip"), {
      symbol: "star50",
      accent: "#65aaff",
    });
  }

  function startTimers() {
    window.setInterval(() => {
      if (document.hidden) return;
      loadDashboard(false, true);
      const active = [
        ["gold", state.charts.gold.period],
        ["star50", state.charts.star50.period],
      ];
      active.forEach(([symbol, period]) => {
        if (period === "intraday") {
          const last = state.charts[symbol].lastLoadedAt || 0;
          if (Date.now() - last > 55000) {
            // keepView preserves whatever zoom range the visitor selected.
            loadChart(symbol, period, { silent: true, keepView: true });
          }
        }
      });
    }, REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadDashboard(false, true);
        ["gold", "star50"].forEach((symbol) => {
          if (state.charts[symbol].period === "intraday") {
            loadChart(symbol, "intraday", { silent: true, keepView: true });
          }
        });
      }
    });
  }

  function init() {
    updateClock();
    window.setInterval(updateClock, 1000);
    try {
      const saved = localStorage.getItem("aurum.region");
      if (saved && ["asia", "europe", "americas"].includes(saved)) state.region = saved;
    } catch (error) {
      /* optional */
    }
    renderRegionTabs();
    setupCharts();
    bindEvents();
    setConnection("connecting");
    // Load in sequence: the quote feed first, then each chart, so the public
    // endpoints never see a burst of simultaneous requests.
    (async () => {
      await loadDashboard(false, false);
      await loadChart("gold", "intraday", { silent: false });
      await loadChart("star50", "intraday", { silent: false });
    })();
    startTimers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

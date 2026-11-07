/* Lightweight Canvas chart engine — no external chart library required. */
(function () {
  "use strict";

  const COLORS = {
    grid: "rgba(255, 255, 255, 0.055)",
    gridStrong: "rgba(255, 255, 255, 0.09)",
    axis: "rgba(132, 146, 164, 0.68)",
    axisDim: "rgba(111, 125, 142, 0.56)",
    up: "#ff5c6c",
    down: "#0fc48c",
    flat: "#8a96a6",
    ma5: "#e9ba68",
    ma10: "#5b9dff",
    ma20: "#b98cff",
    sge: "#7fd8c8",
    average: "rgba(151, 169, 189, 0.6)",
  };

  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  });
  const monthFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  });
  const fullFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function padded(value) {
    return String(value).padStart(2, "0");
  }

  function partsFor(timestamp, options) {
    const parts = options.formatToParts(new Date(timestamp));
    const result = {};
    for (const part of parts) {
      if (part.type !== "literal") result[part.type] = part.value;
    }
    return result;
  }

  function formatAxisTime(timestamp, period) {
    if (period === "intraday") return timeFormatter.format(new Date(timestamp));
    if (period === "month") return monthFormatter.format(new Date(timestamp)).replace("/", "/");
    const parts = partsFor(timestamp, dateFormatter);
    return `${parts.month}/${parts.day}`;
  }

  function formatFullTime(timestamp, period) {
    const parts = partsFor(timestamp, fullFormatter);
    if (period === "intraday") {
      return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    }
    return `${parts.year}年${parts.month}月${parts.day}日`;
  }

  function formatTooltipDate(timestamp, period) {
    if (period === "intraday") return formatFullTime(timestamp, period);
    const parts = partsFor(timestamp, fullFormatter);
    const suffix = { day: "日K", week: "周K", month: "月K" }[period] || "K线";
    return `${parts.year}年${parts.month}月${parts.day}日 · ${suffix}`;
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  }

  function niceStep(rawStep) {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(rawStep));
    const fraction = rawStep / Math.pow(10, exponent);
    let nice;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
    return nice * Math.pow(10, exponent);
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace("#", "");
    const value = parseInt(clean, 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function trendOf(value, reference) {
    if (!Number.isFinite(value) || !Number.isFinite(reference)) return "flat";
    if (value > reference) return "up";
    if (value < reference) return "down";
    return "flat";
  }

  class MarketChart {
    constructor(canvas, tooltip, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.tooltip = tooltip;
      this.wrap = canvas.parentElement;
      this.symbol = (options && options.symbol) || "gold";
      this.accent = (options && options.accent) || COLORS.ma5;
      this.data = null;
      this.period = "intraday";
      this.hoverIndex = -1;
      this.pointer = { x: 0, y: 0 };
      this.geometry = null;
      this.frame = 0;
      this.width = 0;
      this.height = 0;
      this.resizeObserver = new ResizeObserver(() => this.scheduleDraw());
      this.resizeObserver.observe(this.wrap);
      this.bindPointer();
    }

    bindPointer() {
      this.canvas.addEventListener("pointermove", (event) => {
        if (!this.geometry || !this.data || !this.data.points.length) return;
        const rect = this.canvas.getBoundingClientRect();
        this.pointer.x = event.clientX - rect.left;
        this.pointer.y = event.clientY - rect.top;
        const plot = this.geometry.plot;
        if (this.pointer.x < plot.left - 4 || this.pointer.x > plot.left + plot.width + 4) {
          this.clearHover();
          return;
        }
        const ratio = clamp((this.pointer.x - plot.left) / plot.width, 0, 1);
        const count = this.data.points.length;
        this.hoverIndex = clamp(Math.round(ratio * (count - 1)), 0, count - 1);
        this.scheduleDraw();
      });
      this.canvas.addEventListener("pointerleave", () => this.clearHover());
      this.canvas.addEventListener("pointercancel", () => this.clearHover());
    }

    clearHover() {
      if (this.hoverIndex === -1) return;
      this.hoverIndex = -1;
      this.tooltip.classList.remove("is-visible");
      this.scheduleDraw();
    }

    setData(payload) {
      this.data = payload;
      this.period = payload.period || "intraday";
      this.hoverIndex = -1;
      this.tooltip.classList.remove("is-visible");
      this.scheduleDraw();
    }

    syncLatestPrice(price) {
      if (!this.data || this.period !== "intraday" || !Number.isFinite(price)) return;
      const points = this.data.points;
      if (!points || !points.length) return;
      const last = points[points.length - 1];
      if (Math.abs(last.c - price) < 0.0001) return;
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      this.scheduleDraw();
    }

    syncShanghaiPrice(price) {
      if (!this.data || this.period !== "intraday" || !Number.isFinite(price)) return;
      const overlay = this.data.shanghai;
      if (!overlay || !Array.isArray(overlay.points) || !overlay.points.length) return;
      const last = overlay.points[overlay.points.length - 1];
      if (Math.abs(last.c - price) < 0.0001) return;
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      this.scheduleDraw();
    }

    overlayPoints() {
      const overlay = this.data && this.data.shanghai;
      if (!overlay || !Array.isArray(overlay.points) || overlay.points.length < 2) return [];
      return overlay.points;
    }

    /* Time span that the x-axis must cover, including the overlay series. */
    timeSpan() {
      const points = this.data && this.data.points ? this.data.points : [];
      const overlay = this.overlayPoints();
      let start = points.length ? points[0].t : null;
      let end = points.length ? points[points.length - 1].t : null;
      if (overlay.length) {
        const overlayStart = overlay[0].t;
        const overlayEnd = overlay[overlay.length - 1].t;
        start = start === null ? overlayStart : Math.min(start, overlayStart);
        end = end === null ? overlayEnd : Math.max(end, overlayEnd);
      }
      return { start, end };
    }

    /* Map an overlay point onto the primary x-axis using real timestamps. */
    overlayX(point, plot) {
      const span = this.timeSpan();
      if (!Number.isFinite(point.t) || span.start === null || !(span.end > span.start)) {
        return plot.left + plot.width;
      }
      const ratio = (point.t - span.start) / (span.end - span.start);
      return plot.left + clamp(ratio, 0, 1) * plot.width;
    }

    overlayIndex(baseIndex, baseCount) {
      const overlay = this.overlayPoints();
      const points = this.data && this.data.points ? this.data.points : [];
      if (!overlay.length || !points.length || baseIndex < 0 || baseIndex >= points.length) {
        return -1;
      }
      if (this.period === "intraday") {
        // Sessions run on different clock windows, so match by position.
        const ratio = baseIndex / Math.max(1, points.length - 1);
        return Math.min(overlay.length - 1, Math.round(ratio * (overlay.length - 1)));
      }
      const target = points[baseIndex].t;
      let best = 0;
      let bestDelta = Infinity;
      for (let index = 0; index < overlay.length; index += 1) {
        const delta = Math.abs(overlay[index].t - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = index;
        }
      }
      return best;
    }

    scheduleDraw() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.width = rect.width;
      this.height = rect.height;
      this.dpr = dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    draw() {
      if (!this.ctx) return;
      this.resize();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      if (!this.data || !Array.isArray(this.data.points) || this.data.points.length < 2) {
        this.geometry = null;
        return;
      }
      const points = this.data.points;
      const period = this.period;
      const height = this.height;
      const width = this.width;
      const left = 9;
      const right = 64;
      const top = 16;
      const bottom = 24;
      const hasVolume = period !== "intraday" && points.some((point) => Number(point.v) > 0);
      const usableHeight = height - top - bottom;
      const volumeHeight = hasVolume ? Math.max(22, usableHeight * 0.17) : 0;
      const gap = hasVolume ? 12 : 0;
      const priceHeight = usableHeight - volumeHeight - gap;
      const plot = {
        left,
        top,
        width: Math.max(40, width - left - right),
        height: Math.max(30, priceHeight),
        priceBottom: top + priceHeight,
      };

      if (width < 160 || height < 120) return;

      const highs = [];
      const lows = [];
      const overlay = this.overlayPoints();
      for (const series of [points, overlay]) {
        for (const point of series) {
          if (Number.isFinite(point.h)) highs.push(point.h);
          if (Number.isFinite(point.l)) lows.push(point.l);
          for (const key of ["ma5", "ma10", "ma20"]) {
            if (Number.isFinite(point[key])) highs.push(point[key]);
          }
          if (period === "intraday" && Number.isFinite(point.avg)) highs.push(point.avg);
        }
      }
      let maxValue = Math.max(...highs);
      let minValue = Math.min(...lows);
      if (period === "intraday" && Number.isFinite(this.data.prev_close)) {
        maxValue = Math.max(maxValue, this.data.prev_close);
        minValue = Math.min(minValue, this.data.prev_close);
      }
      if (period === "intraday" && this.data.shanghai && Number.isFinite(this.data.shanghai.prev_close)) {
        maxValue = Math.max(maxValue, this.data.shanghai.prev_close);
        minValue = Math.min(minValue, this.data.shanghai.prev_close);
      }
      if (!Number.isFinite(maxValue) || !Number.isFinite(minValue)) return;
      if (maxValue === minValue) {
        const offset = Math.max(Math.abs(maxValue) * 0.002, 1);
        maxValue += offset;
        minValue -= offset;
      }
      const rawRange = maxValue - minValue;
      const targetTicks = width < 480 ? 4 : 5;
      const step = niceStep(rawRange / targetTicks);
      let yMin = Math.floor((minValue - rawRange * 0.055) / step) * step;
      let yMax = Math.ceil((maxValue + rawRange * 0.055) / step) * step;
      if (yMax - yMin < step * 2) {
        yMax += step;
        yMin -= step;
      }
      const tickValues = [];
      for (let value = yMin; value <= yMax + step * 0.01; value += step) {
        tickValues.push(Number(value.toFixed(10)));
      }

      const span = this.timeSpan();
      const useTimeAxis =
        overlay.length > 0 && this.period !== "intraday" && Number.isFinite(span.start) && span.end > span.start;
      const xFor = (index) => {
        if (useTimeAxis) {
          const ratio = (points[index].t - span.start) / (span.end - span.start);
          return left + clamp(ratio, 0, 1) * plot.width;
        }
        const count = points.length;
        return left + ((index + 0.5) / count) * plot.width;
      };
      const yFor = (value) => {
        return top + ((yMax - value) / (yMax - yMin)) * plot.height;
      };

      this.geometry = {
        plot,
        yMin,
        yMax,
        step,
        xFor,
        yFor,
        hasVolume,
        volumeTop: plot.priceBottom + gap,
        volumeHeight,
        points,
      };

      this.drawGrid(ctx, plot, tickValues, yMin, yMax, points, period, xFor, yFor, width);
      this.drawVolume(ctx, points, xFor, plot, volumeHeight, hasVolume);

      if (period === "intraday" && overlay.length) {
        // Draw both intraday lines on their own normalised session width so
        // one screen compares their shapes even when the exchanges are open
        // on different dates (weekends, holidays).  The axis labels below
        // still show each session's real local time.
        this.drawIntraday(ctx, points, xFor, yFor, plot);
        this.drawOverlayLine(ctx, overlay, xFor, yFor, plot, false, true);
      } else if (period === "intraday") {
        this.drawIntraday(ctx, points, xFor, yFor, plot);
      } else {
        this.drawCandles(ctx, points, xFor, yFor, plot);
        this.drawMovingAverages(ctx, points, xFor, yFor);
        this.drawOverlayLine(ctx, overlay, xFor, yFor, plot, true);
      }

      this.drawAxisDates(ctx, points, period, xFor, plot, width, height);
      this.drawLastMarker(ctx, points, xFor, yFor, plot, period);
      this.drawOverlayMarker(ctx, overlay, xFor, yFor, plot);

      if (this.hoverIndex >= 0) {
        this.drawCrosshair(ctx, points, xFor, yFor, plot, height);
        this.updateTooltip(points, xFor, plot);
      }
    }

    drawGrid(ctx, plot, values, yMin, yMax, points, period, xFor, yFor, width) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      for (const value of values) {
        const y = yFor(value);
        if (y < plot.top - 1 || y > plot.priceBottom + 1) continue;
        ctx.moveTo(plot.left, Math.round(y) + 0.5);
        ctx.lineTo(plot.left + plot.width, Math.round(y) + 0.5);
      }
      ctx.stroke();

      const tickCount = width < 480 ? 4 : 5;
      const indexStep = Math.max(1, Math.round((points.length - 1) / tickCount));
      const indices = [];
      for (let i = 0; i < points.length; i += indexStep) indices.push(i);
      if (indices[indices.length - 1] !== points.length - 1) indices.push(points.length - 1);

      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      for (const index of indices) {
        const x = Math.round(xFor(index)) + 0.5;
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.priceBottom);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = COLORS.axisDim;
      ctx.font = '8px "Bahnschrift", "Segoe UI", sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const digits = getAxisDigits(
        Math.abs(yMax - yMin) / Math.max(1, values.length - 1),
        period
      );
      for (const value of values) {
        const y = yFor(value);
        if (y < plot.top - 1 || y > plot.priceBottom + 1) continue;
        ctx.fillText(formatNumber(value, digits), plot.left + plot.width + 9, y);
      }

      // Previous close guide for the intraday chart.
      if (period === "intraday" && Number.isFinite(this.data.prev_close)) {
        const referenceY = yFor(this.data.prev_close);
        if (referenceY > plot.top && referenceY < plot.priceBottom) {
          ctx.strokeStyle = "rgba(233, 186, 104, 0.26)";
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(plot.left, Math.round(referenceY) + 0.5);
          ctx.lineTo(plot.left + plot.width, Math.round(referenceY) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(233, 186, 104, 0.6)";
          ctx.font = '7.5px "Microsoft YaHei UI", sans-serif';
          ctx.textAlign = "left";
          ctx.fillText(
            `昨收 ${formatNumber(this.data.prev_close, 2)}`,
            plot.left + 5,
            referenceY - 7
          );
        }
      }
      ctx.restore();
    }

    drawIntraday(ctx, points, xFor, yFor, plot) {
      const last = points[points.length - 1];
      const reference = Number.isFinite(this.data.prev_close)
        ? this.data.prev_close
        : points[0].c;
      const trend = trendOf(last.c, reference);
      const color = trend === "up" ? COLORS.up : trend === "down" ? COLORS.down : COLORS.flat;

      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.c);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(xFor(points.length - 1), plot.priceBottom);
      ctx.lineTo(xFor(0), plot.priceBottom);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.priceBottom);
      gradient.addColorStop(0, hexToRgba(color, 0.22));
      gradient.addColorStop(0.6, hexToRgba(color, 0.055));
      gradient.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = gradient;
      ctx.fill();

      if (points.some((point) => Number.isFinite(point.avg))) {
        ctx.beginPath();
        let started = false;
        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          if (!Number.isFinite(point.avg)) continue;
          const x = xFor(index);
          const y = yFor(point.avg);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (started) {
          ctx.strokeStyle = COLORS.average;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.beginPath();
      points.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.c);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.55;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = hexToRgba(color, 0.34);
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    drawCandles(ctx, points, xFor, yFor, plot) {
      const count = points.length;
      const slot = plot.width / Math.max(count, 1);
      const bodyWidth = clamp(slot * 0.6, 1, 9);
      ctx.save();
      for (let index = 0; index < count; index += 1) {
        const point = points[index];
        if (!Number.isFinite(point.o) || !Number.isFinite(point.c)) continue;
        const x = xFor(index);
        const isUp = point.c > point.o;
        const isFlat = point.c === point.o;
        const color = isUp ? COLORS.up : isFlat ? COLORS.flat : COLORS.down;
        const yOpen = yFor(point.o);
        const yClose = yFor(point.c);
        const yHigh = yFor(point.h);
        const yLow = yFor(point.l);

        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yHigh);
        ctx.lineTo(Math.round(x) + 0.5, yLow);
        ctx.stroke();

        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.88;
        ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
      }
      ctx.restore();
    }

    drawMovingAverages(ctx, points, xFor, yFor) {
      const definitions = [
        { key: "ma5", color: COLORS.ma5 },
        { key: "ma10", color: COLORS.ma10 },
        { key: "ma20", color: COLORS.ma20 },
      ];
      ctx.save();
      for (const definition of definitions) {
        let started = false;
        ctx.beginPath();
        for (let index = 0; index < points.length; index += 1) {
          const value = points[index][definition.key];
          if (!Number.isFinite(value)) continue;
          const x = xFor(index);
          const y = yFor(value);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        if (!started) continue;
        ctx.strokeStyle = definition.color;
        ctx.globalAlpha = 0.82;
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      ctx.restore();
    }

    drawVolume(ctx, points, xFor, plot, height, hasVolume) {
      if (!hasVolume) return;
      const count = points.length;
      const slot = plot.width / Math.max(count, 1);
      const barWidth = clamp(slot * 0.55, 1, 7);
      const volumes = points.map((point) => (Number.isFinite(point.v) ? point.v : 0));
      const maxVolume = Math.max(...volumes, 1);
      const baseY = plot.priceBottom + height;
      ctx.save();
      for (let index = 0; index < count; index += 1) {
        const point = points[index];
        const volume = volumes[index];
        if (!volume) continue;
        const isUp = point.c >= point.o;
        const barHeight = Math.max(1, (volume / maxVolume) * height * 0.9);
        ctx.fillStyle = isUp ? "rgba(255, 92, 108, 0.24)" : "rgba(15, 196, 140, 0.24)";
        ctx.fillRect(xFor(index) - barWidth / 2, baseY - barHeight, barWidth, barHeight);
      }
      ctx.restore();
    }

    drawAxisDates(ctx, points, period, xFor, plot, width, height) {
      const count = points.length;
      const tickCount = width < 480 ? 3 : width < 720 ? 4 : 5;
      const indices = [];
      for (let tick = 0; tick <= tickCount; tick += 1) {
        indices.push(Math.round((tick / tickCount) * (count - 1)));
      }
      const unique = [...new Set(indices)];
      ctx.save();
      ctx.fillStyle = COLORS.axisDim;
      ctx.font = '8px "Bahnschrift", "Segoe UI", sans-serif';
      ctx.textBaseline = "top";
      unique.forEach((index, position) => {
        const x = xFor(index);
        let align = "center";
        if (position === 0) align = "left";
        if (position === unique.length - 1) align = "right";
        ctx.textAlign = align;
        const label = formatAxisTime(points[index].t, period);
        const drawX = align === "left" ? Math.max(plot.left, x - 2) : align === "right" ? x + 2 : x;
        ctx.fillText(label, drawX, height - 17);
      });
      ctx.restore();
    }

    drawLastMarker(ctx, points, xFor, yFor, plot, period) {
      const last = points[points.length - 1];
      if (!Number.isFinite(last.c)) return;
      const x = xFor(points.length - 1);
      const y = yFor(last.c);
      this.lastLondonY = y;
      const reference = period === "intraday" ? this.data.prev_close : points[0].c;
      const trend = trendOf(last.c, reference);
      const color = trend === "up" ? COLORS.up : trend === "down" ? COLORS.down : COLORS.flat;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.1);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.1, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = hexToRgba(color, 0.7);
      ctx.shadowBlur = 9;
      ctx.fill();
      ctx.shadowBlur = 0;

      // A small price tag attached to the right axis.
      const label = formatNumber(last.c, 2);
      ctx.font = '8.5px "Bahnschrift", "Segoe UI", sans-serif';
      const textWidth = ctx.measureText(label).width;
      const tagWidth = textWidth + 10;
      const tagX = plot.left + plot.width + 2;
      const tagY = clamp(y - 8, plot.top, plot.priceBottom - 16);
      ctx.fillStyle = hexToRgba(color, 0.16);
      ctx.strokeStyle = hexToRgba(color, 0.38);
      ctx.lineWidth = 1;
      roundRect(ctx, tagX, tagY, tagWidth, 15, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tagX + tagWidth / 2, tagY + 7.8);
      ctx.restore();
    }

    drawOverlayLine(ctx, overlay, xFor, yFor, plot, dashed, normalized) {
      if (!overlay.length) return;
      const color = COLORS.sge;
      let lastY = null;
      ctx.save();
      ctx.beginPath();
      let started = false;
      overlay.forEach((point, index) => {
        if (!Number.isFinite(point.c)) return;
        const x = normalized
          ? plot.left + (index / Math.max(1, overlay.length - 1)) * plot.width
          : this.overlayX(point, plot);
        const y = yFor(point.c);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastY = y;
      });
      if (!started) {
        ctx.restore();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.2 : 1.35;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (dashed) ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.95;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      this.overlayLastY = lastY;
    }

    drawOverlayMarker(ctx, overlay, xFor, yFor, plot) {
      if (!overlay.length) return;
      const last = overlay[overlay.length - 1];
      if (!Number.isFinite(last.c)) return;
      const x = this.period === "intraday" ? plot.left + plot.width : this.overlayX(last, plot);
      const y = yFor(last.c);
      const color = COLORS.sge;

      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = hexToRgba(color, 0.65);
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      const label = formatNumber(last.c, 2);
      ctx.font = '8.5px "Bahnschrift", "Segoe UI", sans-serif';
      const tagWidth = ctx.measureText(label).width + 10;
      const tagX = plot.left + plot.width + 2;
      let tagY = clamp(y + 9, plot.top, plot.priceBottom - 16);
      if (Math.abs(y - (this.lastLondonY || -99)) < 16) {
        tagY = clamp(y - 23, plot.top, plot.priceBottom - 16);
      }
      ctx.fillStyle = hexToRgba(color, 0.16);
      ctx.strokeStyle = hexToRgba(color, 0.4);
      ctx.lineWidth = 1;
      roundRect(ctx, tagX, tagY, tagWidth, 15, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tagX + tagWidth / 2, tagY + 7.8);
      ctx.restore();
    }

    drawCrosshair(ctx, points, xFor, yFor, plot, height) {
      const point = points[this.hoverIndex];
      if (!point) return;
      const x = xFor(this.hoverIndex);
      const y = yFor(point.c);
      ctx.save();
      ctx.strokeStyle = "rgba(211, 221, 233, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, plot.top);
      ctx.lineTo(Math.round(x) + 0.5, plot.priceBottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(plot.left, Math.round(y) + 0.5);
      ctx.lineTo(plot.left + plot.width, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#0a0f16";
      ctx.fill();
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }

    updateTooltip(points, xFor, plot) {
      const index = this.hoverIndex;
      const point = points[index];
      if (!point) return;
      const digits = 2;
      const reference =
        this.period === "intraday" && Number.isFinite(this.data.prev_close)
          ? this.data.prev_close
          : index > 0
            ? points[index - 1].c
            : point.o;
      const change = point.c - reference;
      const changePct = reference ? (change / reference) * 100 : 0;
      const direction = trendOf(point.c, reference);
      const unit = this.data && this.data.unit_label ? ` · ${this.data.unit_label}` : "";
      let html = `<div class="tooltip-head">${formatTooltipDate(point.t, this.period)}${unit}</div>`;

      if (this.period === "intraday") {
        html += '<div class="tooltip-grid">';
        html += `<span>价格</span><b>${formatNumber(point.c, digits)}</b>`;
        if (Number.isFinite(point.avg)) {
          html += `<span>均价</span><b>${formatNumber(point.avg, digits)}</b>`;
        }
        html += "</div>";
      } else {
        html += '<div class="tooltip-grid">';
        html += `<span>开</span><b>${formatNumber(point.o, digits)}</b>`;
        html += `<span>高</span><b>${formatNumber(point.h, digits)}</b>`;
        html += `<span>低</span><b>${formatNumber(point.l, digits)}</b>`;
        html += `<span>收</span><b>${formatNumber(point.c, digits)}</b>`;
        html += "</div>";
      }
      const sign = change > 0 ? "+" : "";
      html += `<div class="tooltip-change is-${direction}">${sign}${formatNumber(change, digits)} · ${sign}${formatNumber(changePct, 2)}%</div>`;

      const overlay = this.overlayPoints();
      if (overlay.length) {
        const overlayIndex = this.overlayIndex(index, points.length);
        const overlayPoint = overlay[overlayIndex];
        if (overlayPoint && Number.isFinite(overlayPoint.c)) {
          const gap = point.c - overlayPoint.c;
          const gapPct = overlayPoint.c ? (gap / overlayPoint.c) * 100 : 0;
          const gapSign = gap > 0 ? "+" : "";
          html +=
            '<div class="tooltip-overlay">' +
            `<span class="dot-sge"></span>上海金 <b>${formatNumber(overlayPoint.c, digits)}</b>` +
            `<span class="gap">价差 ${gapSign}${formatNumber(gap, digits)} (${gapSign}${formatNumber(gapPct, 2)}%)</span>` +
            "</div>";
        }
      }

      this.tooltip.innerHTML = html;
      this.tooltip.classList.add("is-visible");

      const tooltipWidth = this.tooltip.offsetWidth;
      const tooltipHeight = this.tooltip.offsetHeight;
      const pointX = xFor(index);
      let left = pointX + 14;
      let top = this.pointer.y - tooltipHeight / 2;
      if (left + tooltipWidth > this.width - 8) {
        left = pointX - tooltipWidth - 14;
      }
      left = clamp(left, 5, this.width - tooltipWidth - 5);
      top = clamp(top, 4, this.height - tooltipHeight - 4);
      this.tooltip.style.left = `${left}px`;
      this.tooltip.style.top = `${top}px`;
    }
  }

  function getAxisDigits(step, period) {
    if (period === "intraday") return step < 0.1 ? 3 : step < 1 ? 2 : step < 10 ? 1 : 0;
    return step < 1 ? 2 : step < 10 ? 1 : 0;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  window.MarketChart = MarketChart;
})();

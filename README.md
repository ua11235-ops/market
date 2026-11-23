# 金市 · 全球行情

一个纯静态的行情网页：顶部展示亚洲 / 欧洲 / 美洲主要股指，点击卡片打开外部行情详情；下方的黄金面板同时显示**伦敦金现**与**上海金 Au99.99**两条曲线，右侧为**科创 50**（000688.SH）走势图，均支持分时、日 K、周 K、月 K；最下方是**飞天茅台 500ml** 散瓶批发参考价走势（日 / 周 / 月折线）。

无需安装、无需后端，直接用浏览器打开即可。

## 在线访问

部署到 GitHub Pages 后即可访问：

```
https://ua11235-ops.github.io/market/
```

## 本地查看

由于页面通过 JSONP 请求公开行情接口，直接双击 `index.html` 也能运行。若浏览器限制本地文件加载脚本，可启动一个静态服务器：

```bash
python -m http.server 8000
# 然后打开 http://127.0.0.1:8000/
```

## 功能

- **全球市场**：亚洲 10 个、欧洲 5 个、美洲 5 个，共 20 个主要指数，分区域切换
- **点击跳转**：任意指数卡片在新标签页打开对应行情详情页
- **黄金双价同框**：
  - 伦敦金现（COMEX 金价按 USD/CNH 折算为元/克）
  - 上海金 Au99.99（上海黄金交易所现货，元/克）
  - 面板直接显示「伦敦 − 上海」价差（元/克与百分比）
- **双线叠加走势图**：伦敦金现实线 + 上海金虚线，悬停提示框同时给出两者价格与价差
- **周期切换**：分时 / 日 K / 周 K / 月 K，K 线含 MA5 / MA10 / MA20 与成交量
- **茅台价格面板**：飞天茅台 53%vol 500ml 散瓶批发参考价，日线 / 周线 / 月线折线，附年初至今涨跌与区间高低
- **自动刷新**：报价约每 30 秒刷新，分时图约每分钟刷新
- **断网提示**：接口不可用时给出明确提示，不会静默显示空图

## 数据来源

| 数据 | 接口 |
| --- | --- |
| 全球指数、伦敦金、上海金、科创 50 | 东方财富公开行情（JSONP） |
| USD/CNH 汇率 | 东方财富公开行情（JSONP） |
| 飞天茅台 500ml 散瓶批价 | 聚金数据（**页面内置快照**，非运行时请求） |

> 全部请求在浏览器端直接发出，项目不包含任何服务端代码，也不收集任何数据。
> 行情为公开数据，可能存在延迟，仅供参考，不构成投资建议。

## 黄金折算说明

伦敦金以美元/盎司报价，页面按实时汇率折算为人民币/克：

```
美元/盎司 × USD/CNH ÷ 31.1034768 = 元/克
```

上海金 Au99.99 本身即以元/克报价，无需换算，因此两者可直接叠加比较。
两者交易时段不同（上海金夜盘 20:00 起），分时图按各自盘口对齐以便比较形态，日 K 及以上按日期对齐，并在图下标注取数区间。

## 茅台数据说明

飞天茅台面板与其他面板有本质区别：聚金数据在运行时抓不到（EdgeOne 拦无头浏览器、
接口返回 AES 密文），所以数据**构建期抓取、快照进仓库**，
存在 `js/moutai-data.js`（`window.AurumMoutaiData`）。

- 该序列是**日频自然日**数据，含周末（当前快照 321 天中有 73 天是周末），
  因此页面标注为「自然日」而非「交易日」，不要改回「交易日」
- 快照由 `scripts/fetch-moutai.js` 生成，**不要手改**；每天 09:10 由本机计划任务更新，
  有变化会自动 commit 并 push
- 周线按 ISO 周（周一起）取该周最后一个价格，月线取该月最后一个价格；
  聚合在 `js/data.js` 的 `moutaiBucketed()` 里做，页面只拿到折线点
- 该价格是批发参考价，不是交易所行情，不构成投资建议

### 更新茅台数据

```powershell
# 手动抓一次（有变化会自动提交并推送）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-daily.ps1

# 只抓不写，看看上游有什么
node scripts\fetch-moutai.js --dry-run

# 安装 / 卸载每天的定时任务
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Time '09:10'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Remove
```

需要在用户环境变量里配 `AURUM_NODE`（node 路径）、`AURUM_GIT`（git 路径）、
`AURUM_GIT_TOKEN`（GitHub PAT，contents:write）。缺 token 时只提交到本地、不推送。
日志在 `.tmp\moutai-fetch.log`。

> 抓取必须在**有头** Chrome 里跑：实测同一个出口 IP 下，有头能过、无头被拦，
> UA/stealth 伪装都无效。所以这套定时任务只能跑在本机，不能放 GitHub Actions 托管 runner。


## 项目结构

```
index.html            页面结构
css/styles.css        全部样式
js/data.js            行情数据层（JSONP 抓取、折算、缓存与重试；含茅台快照聚合）
js/moutai-data.js     飞天茅台价格快照数据（window.AurumMoutaiData）
js/chart.js           Canvas 图表引擎（K 线 / 分时 / 折线 / 双序列叠加）
js/app.js             页面交互与刷新调度
scripts/fetch-moutai.js   抓茅台批价（真实 Chrome，页面自解密）
scripts/run-daily.ps1     抓取 + 有变化则提交推送
scripts/install-task.ps1  注册/卸载每日计划任务
favicon.svg           站点图标
preview*.png          页面截图（README 展示用）
.github/workflows/    GitHub Pages 自动部署
```

## 技术说明

- 纯 HTML / CSS / JavaScript，无框架、无构建步骤、无第三方依赖
- 图表使用原生 Canvas 2D 自绘，支持高 DPI 与响应式
- 行情请求串行排队并带重试，避免公开接口的并发限流
- 部署方式：GitHub Pages（`main` 分支根目录）

## 改代码时注意

- 改任何 `js/*.js` 或 `css/*.css` 后，必须把 `index.html` 里 5 处 `?v=` 一起递增，
  否则回访用户会继续跑缓存里的旧文件（抓取脚本会自动做这件事）
- 仓库用 `.gitattributes` 统一为 LF；不要在 Windows 上按 CRLF 整文件重写，
  否则一次改动会变成「每一行都改了」的 diff
- `scripts/*.ps1` 例外：固定 `eol=crlf` 且必须带 UTF-8 BOM，否则
  Windows PowerShell 5.1 会按 GBK 解析中文注释直接报语法错误

## 许可

[MIT](LICENSE)

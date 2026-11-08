# 交接说明 · 金市 / 全球行情

接手日期：2026-11-08
对应提交：`fa948a4`（在 `effa6f3` 之上新增 2 个修复提交）

---

## 1. 这是什么

一个**纯静态**的行情看板，无后端、无构建步骤、无第三方依赖：

- 顶部：亚洲 10 / 欧洲 5 / 美洲 5 共 20 个主要股指，按区域切换，点击卡片跳东方财富行情页
- 左下：黄金面板，伦敦金现（COMEX 金价按 USD/CNH 折算成元/克）与上海金 Au99.99 双线叠加，显示「伦敦 − 上海」价差
- 右下：科创 50（000688.SH）
- 两个图表都支持 分时 / 日K / 周K / 月K，K 线含 MA5/10/20 与成交量，支持滚轮缩放、拖动平移、双击复位、悬停十字光标

数据全部由浏览器直接向东方财富的 JSONP 接口发起，项目不收集任何数据。

## 2. 代码结构

| 文件 | 职责 | 规模 |
| --- | --- | --- |
| `index.html` | 页面结构，静态资源版本号（`?v=`） | 250 行 |
| `css/styles.css` | 全部样式，暗色主题 | ~1640 行 |
| `js/data.js` | 数据层：JSONP 抓取、序列排队、缓存、汇率折算、交易时段切分 | ~660 行 |
| `js/chart.js` | Canvas 2D 图表引擎：K 线、分时、双序列叠加、缩放/平移/悬停 | ~1274 行 |
| `js/app.js` | 页面控制器：渲染、刷新调度、区域/周期切换 | ~800 行 |

三者通过全局 `AurumData` / `MarketChart` 衔接，没有模块系统，`<script>` 顺序加载。

关键接口：`push2.eastmoney.com/api/qt/{stock,ulist.np}/get`（报价）、
`push2his.eastmoney.com/api/qt/{stock/trends2,stock/kline}/get`（分时/K线）。
所有请求经 `js/data.js` 里的**串行队列**（`enqueue` + 120ms 间隔）发出——东方财富对并发请求会直接掐连接，这是踩过坑的设计，不要改成并行。

## 3. 本次接手做了什么

### 3.1 环境限制（重要）

这台机器 **`github.com:443` 不通**（TCP 连 20.205.243.166 超时），
但 `api.github.com`、`raw.githubusercontent.com`、`codeload.github.com` 和
`ghproxy.net` 可用。因此：

- `git clone https://github.com/...` 会失败
- 可用镜像：`git clone https://ghproxy.net/https://github.com/ua11235-ops/market.git`
  （需 `-c http.sslBackend=openssl`，系统 schannel 报 `SEC_E_NO_CREDENTIALS`；
   并且建议加 `-c http.version=HTTP/1.1`，HTTP/2 下会被 RST）
- 本机**没有 `gh`、没有 node/python 的全局安装、没有 SSH key**，
  GitHub 也是匿名访问，API 限流 60 次/小时（本次已用尽并触发 403）

工作区已恢复为正常的 git 仓库（含完整 38 个历史提交），`origin` 指向
`https://github.com/ua11235-ops/market.git`。**推送同样需要走网络方案**，
详见第 6 节。

### 3.2 修掉的两个真 bug

**① 分时图丢了整个日盘、y 轴被压扁**（提交 `26e357d`）

`fetchTrends()` 原本把所有品种的交易时段起点硬编码成 18:00。
但 COMEX 黄金的真实时段是 **07:00 → 次日 06:00**，于是周五日盘
07:00–18:00 这 11 小时被整段丢弃，图上只剩夜盘（18:00–06:00）。

后果不只是少数据：`prev_close`（昨收 882.62）仍在图上画虚线，
而可见价格区间只有 867–877，昨收线把 y 轴撑到 15.5 元的跨度，
真实波动只占 64% 的高度，曲线被压平，看起来像"没行情"。

改为按品种查表：`SESSION_OPEN_HOUR = { "101.GC00Y": 7, "118.AU9999": 20 }`，
从最新一根向前回退到该品种最近一次开盘时间；非跨夜品种（科创50 等）
仍回退到"最后一个自然日"的旧逻辑。修复后分时点数是 241→1381（黄金），
x 轴标注为 `07:00 … 01:24 06:00`。

**② 页脚更新时间显示 UTC**（提交 `fa948a4`）

`as_of` 是 ISO-8601 的 UTC 字符串，`String(as_of).slice(11, 19)` 取的是 UTC，
于是 23:17 的行情显示成 15:17，和旁边按 `Asia/Shanghai` 格式化的时钟差 8 小时。
改为复用时钟的 `Intl.DateTimeFormat`。连接状态气泡的 `title` 同样处理。

**顺带**：黄金面板资料来源占位文案由「新浪财经」改为实际数据源「东方财富」；
静态资源 `?v=9` → `?v=10`（**改 JS/CSS 后必须递增**，否则老访客继续跑缓存里的旧代码）；
README 的目录结构删掉了并不存在的 `_desktop/`。

### 3.3 未做、但值得知道

- **没有真实浏览器验证**：本沙箱禁止 Chrome/Edge 启动（mojo 命名管道被拒，
  `platform_channel.cc:187 Check failed`），所以改用 Node + 自建 DOM/Canvas
  桩把 `data.js`/`chart.js`/`app.js` 原样跑起来做断言。像素级外观（字体、
  颜色、布局）本次**没有**目视确认过，接手后建议在真机浏览器里过一眼。
- **季度/年度 K 线未提供**：`PERIOD_KLT` 只有 101/102/103（日/周/月）。
- **月 K 数据量偏少**：科创 50 月 K 只有 84 根（2019-12 起），属正常（指数 2019 年发布）。
- **伦敦金折算用固定 31.1034768 克/盎司**，未考虑品种合约规格差异。

## 4. 验证方法（可复现）

验证脚本都在 `.tmp/`（已在 `.gitignore` 里，不会提交）。用 DSH 自带的 node 跑：

```powershell
$node = "C:\Users\ua11235\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$ws   = "<仓库路径>"

& $node "$ws\.tmp\verify-data.js"  $ws   # 数据层：14 项，打真实接口
& $node "$ws\.tmp\smoke.js"        $ws   # UI 层：19 项，跑完整前端逻辑
& $node "$ws\.tmp\check-assets.js" $ws   # 资源层：编码/BOM/版本号/路径
```

三套当前均为全绿（14/14、19/19、19/19）。

- `verify-data.js` — 校验汇率、20 个指数无缺失、金价折算、价差算术、
  8 个「品种×周期」组合的点数/时序/OHLC 合法性/MA 计算
- `smoke.js` — 解析真实 `index.html`，在 DOM 桩里执行三个 JS，
  断言价格渲染、卡片数量、Canvas 实际绘制、区域切换、周期切换、图例
- `check-assets.js` — 防 mojibake／BOM／版本号忘记递增／引用文件缺失

> 编码坑：用 PowerShell 的 `Set-Content -Encoding UTF8` 改中文文件会写入 BOM，
> 用 `-replace` 按 ANSI 读还会把中文变成乱码。**改含中文的文件请用 Node 脚本**
> （本次就是这么做的）。`check-assets.js` 就是为此加的护栏。

## 5. 日常维护要点

- 改任何 `js/*.js` 或 `css/*.css` 后，把 `index.html` 里 4 处 `?v=` 一起递增
- 新增指数：编辑 `js/data.js` 的 `REGIONS`，填 `secid`（`市场.代码`，
  如 `100.HSI`）与 `url`
- 新增品种分时：在 `SESSION_OPEN_HOUR` 补该 `secid` 的开盘小时（北京时间），
  否则会回退到"最后一个自然日"
- 接口挂了的表现：连接状态变成「连接中断」，页面有 toast 提示，不会静默空图；
  连续失败 2 次内会自动重试
- 东方财富限流：保持串行队列，不要加并发；`QUOTE_BATCH = 30` 是批量报价上限

## 6. 后续怎么推送

`git push` 需要 github.com:443，本机不通。可选方案：

1. **换网络环境**（最省事）：能直连 github.com 的机器上 `git push`
2. **走镜像推送**：`git push https://ghproxy.net/https://github.com/ua11235-ops/market.git main`
   （ghproxy 支持 push，但需带凭据；匿名不可推）
3. **配置凭据**：当前机器没有任何 GitHub 凭据（`cmdkey` 无 github 条目、
   无 SSH key、无 `GH_TOKEN`），推送前需要先配 PAT 或 SSH key

本次**未推送**，两个修复提交只在本地 `main` 上。仓库部署走
`.github/workflows/jekyll-gh-pages.yml`（推 main 自动发布到 GitHub Pages），
所以推上去即自动生效，无需手动构建。

## 7. 一句总结

项目本身干净、结构清晰，问题集中在**数据边界情况**而非架构。
本次修掉的两个 bug 都属于"平时看起来正常、特定时段才露馅"的类型，
其中分时图那个会直接误导对金价走势的判断，建议优先在真机确认效果后再发布。

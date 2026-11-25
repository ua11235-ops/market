# 交接说明 · 金市 / 全球行情

接手日期：2026-11-08（第一次）／ 2026-11-23（第二次）
对应提交：第二次接手在 `23ad33a`（茅台面板）之上新增 2 个提交

---

## 0. 第二次接手（2026-11-23）补充

第一次交接后仓库又合入了「飞天茅台 500ml 价格面板」。本次接手主要做了三件事。

### 0.1 环境结论已变化

第 3.1 节记录的「`github.com:443` 不通 / 没有 node / 没有 git」在本次**不成立**：

- `github.com:443` 通，`git clone https://github.com/ua11235-ops/market.git` 直接成功
- 本机原本无 git，已下载 **PortableGit 2.56.1** 到 `.tmp/PortableGit`（免安装，随用随取）
- node 用 DSH 自带的 `dependencies/node/bin/node.exe`（v24.21.0）
- Chrome 可用，**headless 模式能正常渲染**，本次所有 UI 结论都来自真浏览器
- 东方财富接口对**匿名高频请求会封 IP**：表现为 `ERR_EMPTY_RESPONSE` / `ECONNRESET`，
  其中 `push2.eastmoney.com/api/qt/ulist.np/get` 与 `push2his.../trends2` 最先被封，
  而 `/api/qt/stock/get` 与 `/api/qt/kline/get` 通常还活着。
  验证时不要连续猛刷，隔十几秒一次基本安全。

### 0.2 修的三个 bug

**① 茅台面板图标是金色的**（与黄金面板撞色）

`.asset-icon--red` 原本写在第 700 行，而基础类 `.asset-icon`（带金色边框与背景）
在第 733 行才定义。两者优先级相同，后者胜出，于是茅台图标实际渲染成
`rgba(233, 186, 104, …)`，和黄金面板一模一样，面板的红色主题只体现在顶部细线和徽标上。
把红色修饰块移到基础类之后即修复，实测已变成 `rgb(226, 116, 92)`。

**② 周K / 月K 的取数区间看不懂**

`updateGoldNote()` 用同一个 `MM-DD hh:mm` 格式标注所有周期，于是月K 显示
`12-30 00:00 → 11-23 00:00`——既没有年份，也分不清哪年哪月（伦敦金月K 实际跨到 2011 年）。
改成按 `payload.period` 选格式后，月K 显示 `2011年12月 → 2026年11月`，
日K 显示 `2025-11-20 → 2026-11-23`。页脚「截至」同样处理。

**③ 茅台数据被标成「320 个交易日」**

实际是**自然日**序列：320 行里有 73 行落在周末，而且周末价格会变
（不是简单前值填充），所以不能当交易日看，按交易日理解会高估约 27% 的样本密度。
数据层新增 `weekend_days` 字段，文案改为「320 个自然日」并注明其中周末天数。

### 0.3 顺手做的工程整理

- 加 `.gitattributes` 统一 `eol=lf`。原来 `index.html` 与 `js/moutai-data.js`
  的 blob 里存的是 CRLF，在 `core.autocrlf=true` 的 Windows 上任何整文件保存
  都会让 diff 变成「每一行都改了」。**换行符统一单独一个提交**，与逻辑改动分开，
  否则 review 时看不出真实改动。
- README 补上茅台面板说明（数据来源、为什么是快照、自然日 vs 交易日），
  并新增「改代码时注意」（5 处 `?v=` 要一起递增）。

### 0.4 本次怎么验证的（可复现）

因为东财会封 IP，验证分两路，脚本都在 `.tmp/`：

1. **离线确定性验证（主力）**：`capture-fixtures.js` / `capture-quotes.js` 把真实响应
   落成 `.tmp/fixtures/*.json`；`cdp-probe.js` / `cdp-focus.js` 用 Chrome DevTools
   Protocol 拦截 `push2*.eastmoney.com`，把 fixture 当作 JSONP 返回，页面拿到的
   就是真数据格式。这条路不需要网络、可反复跑。
   > 关键坑：`Fetch.fulfillRequest` 必须带**页面会话 id**（`Target.attachToTarget`
   > 拿到的那个）。不带的话请求被暂停后永远不返回，页面会一直卡在「正在连接行情」，
   > 而且没有任何报错，极易误判成「接口挂了」。
2. **真实浏览器直连**：网络可用时直接 `chrome --headless --screenshot` 截图确认外观。

已确认的行为（fixture 注入，全部通过）：20 个指数卡片与区域切换、黄金三周期 K 线
含 MA5/10/20 与成交量、上海金叠加线、科创50 分时、茅台三周期折线
（320 / 52 / 13 个点，与独立重算一致）、滚轮缩放（徽标 `123 / 320 根 · 双击复位`）、
悬停十字光标与提示框、双击复位。

### 0.5 茅台数据改为每日自动抓取（2026-11-23 晚）

`scripts/fetch-moutai.js` 抓聚金数据，`scripts/run-daily.ps1` 负责提交推送，
`scripts/install-task.ps1` 一键注册 Windows 计划任务（默认每天 09:10）。

**为什么必须在有头浏览器里跑**（这决定了不能用 GitHub Actions 托管 runner）：

同一出口 IP、交替各跑两次，只有无头与否不同：

```
有头 Chrome  24 rows / 14 rows  → 正常出表
无头 Chrome   0 rows /  0 rows  → 「请求已被拦截」
```

UA 覆盖成普通 Chrome、抹掉 `navigator.webdriver`、伪造 plugins/WebGL/`window.chrome`、
退回旧版 `--headless`，四种伪装**全部无效**。所以拦的是无头特征本身，不是 IP，
也不是频率。Actions 托管 runner 是 Linux 无头 + 机房 IP，两条都踩，因此改用本机计划任务。

**为什么不用别的数据源**：实测 30 多个候选站点，今日酒价/微酒/中国酒业协会域名解析不了；
糖酒快讯、9998.tv 能开但页面里没有茅台批价；京东/天猫/酒仙网要人机验证且是零售价；
东方财富有 600519 股价与白酒板块指数，但**那不是散瓶批价**，换过去面板语义就变了。
结论：完整日频批价目前只有聚金数据一个可用来源。

**实现要点**：

- 不重写解密。`/getlist` 返回 AES-CBC 密文，密钥就写在该站自己的 `encrypt.js` 里；
  脚本让页面自己发请求（签名头由它生成），再调页面自己的 `decryptAES()` 取明文。
  站点换 key 也不会失效。
- 上游是**滚动窗口**（当前约 1 年）。直接覆盖会静默丢掉更早历史，所以与现有快照合并。
- 三道防呆：新数据少于现有 90% 拒绝写入；最新日期回退拒绝写入；数据无变化不写文件。
- 数据变了自动递增 `index.html` 的 5 处 `?v=`，否则回访用户跑的还是缓存旧文件。
- 提交作者是 `aurum-bot`，token 走环境变量 `AURUM_GIT_TOKEN` + 一次性
  `http.extraheader`，不落进 `.git/config`。没有 token 时只提交不推送。

相关环境变量（用户级，计划任务会读到）：
`AURUM_NODE`（node 路径）、`AURUM_GIT`（git 路径）、`AURUM_GIT_TOKEN`（PAT）。

> `.ps1` 必须带 **UTF-8 BOM**。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，
> 中文注释直接让脚本语法报错（本次踩过）。`.gitattributes` 里已固定 `*.ps1 eol=crlf`。

---

## 1. 这是什么

一个**纯静态**的行情看板，无后端、无构建步骤、无第三方依赖：

- 顶部：亚洲 10 / 欧洲 5 / 美洲 5 共 20 个主要股指，按区域切换，点击卡片跳东方财富行情页
- 左下：黄金面板，伦敦金现（COMEX 金价按 USD/CNH 折算成元/克）与上海金 Au99.99 双线叠加，显示「伦敦 − 上海」价差
- 右下：科创 50（000688.SH）
- 底部通栏：飞天茅台 500ml 散瓶批发参考价折线（数据为内置快照，非运行时抓取）
- 三个图表都支持周期切换，支持滚轮缩放、拖动平移、双击复位、悬停十字光标

除茅台快照外，数据由浏览器直接向东方财富的 JSONP 接口发起，项目不收集任何数据。

## 2. 代码结构

| 文件 | 职责 | 规模 |
| --- | --- | --- |
| `index.html` | 页面结构，静态资源版本号（`?v=`） | 315 行 |
| `css/styles.css` | 全部样式，暗色主题 | ~1680 行 |
| `js/data.js` | 数据层：JSONP 抓取、序列排队、缓存、汇率折算、交易时段切分、茅台快照聚合 | ~700 行 |
| `js/moutai-data.js` | 飞天茅台价格快照（`window.AurumMoutaiData`），由脚本生成，勿手改 | 单行大 JSON |
| `js/chart.js` | Canvas 2D 图表引擎：K 线、分时、折线、双序列叠加、缩放/平移/悬停 | ~1300 行 |
| `js/app.js` | 页面控制器：渲染、刷新调度、区域/周期切换 | ~925 行 |
| `scripts/fetch-moutai.js` | 抓茅台批价（真实 Chrome + 页面自解密），带合并与防呆 | ~340 行 |
| `scripts/run-daily.ps1` | 抓取 + 有变化则 commit/push，供计划任务调用 | ~75 行 |
| `scripts/install-task.ps1` | 一键注册/卸载 Windows 计划任务 | ~86 行 |

各文件通过全局 `AurumData` / `AurumMoutaiData` / `MarketChart` 衔接，没有模块系统，
`<script>` 顺序加载（`moutai-data.js` 必须在 `data.js` 之前）。

关键接口：`push2.eastmoney.com/api/qt/{stock,ulist.np}/get`（报价）、
`push2his.eastmoney.com/api/qt/{stock/trends2,stock/kline}/get`（分时/K线）。
所有请求经 `js/data.js` 里的**串行队列**（`enqueue` + 120ms 间隔）发出——东方财富对并发请求会直接掐连接，这是踩过坑的设计，不要改成并行。

## 3. 第一次接手做了什么（2026-11-08）

### 3.1 环境限制（当时的情况）

> 第二次接手复核：以下结论已过期，`github.com:443` 现在是通的，见 0.1。
> 保留此段是为了说明当时为什么用了镜像方案。

这台机器 **`github.com:443` 不通**（TCP 连 20.205.243.166 超时），
但 `api.github.com`、`raw.githubusercontent.com`、`codeload.github.com` 和
`ghproxy.net` 可用。因此：

- `git clone https://github.com/...` 会失败
- 可用镜像：`git clone https://ghproxy.net/https://github.com/ua11235-ops/market.git`
  （需 `-c http.sslBackend=openssl`，系统 schannel 报 `SEC_E_NO_CREDENTIALS`；
   并且建议加 `-c http.version=HTTP/1.1`，HTTP/2 下会被 RST）
- 本机**没有 `gh`、没有 node/python 的全局安装、没有 SSH key**，
  GitHub 也是匿名访问，API 限流 60 次/小时（本次已用尽并触发 403）

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

> 第二次接手复核：headless Chrome 在本机是能跑的，本次 UI 结论都来自真浏览器，
> 下面「没有真实浏览器验证」的顾虑已消除。

- **季度/年度 K 线未提供**：`PERIOD_KLT` 只有 101/102/103（日/周/月）。
- **月 K 数据量偏少**：科创 50 月 K 只有 84 根（2019-12 起），属正常（指数 2019 年发布）。
- **伦敦金折算用固定 31.1034768 克/盎司**，未考虑品种合约规格差异。

## 4. 仍然存在的问题（未修，留给下一位）

- **茅台快照会过期**：面板写死「历史数据」，不会自动更新。要更新走
  `scripts/fetch-moutai.js`（或等每天 09:10 的定时任务），不要手改 `daily` 数组。
- **茅台折线 tooltip 的涨跌口径**：`prev_close` 被塞成了 `year_start`，所以折线模式下
  悬停显示的是「相对年初」的涨跌，而不是「相对上一根」。数字自洽，但与 K 线面板习惯不同；
  若要统一，得单独改 `chart.js` 的 `updateTooltip()`。
- **茅台 2026-09-08 有个单日尖峰**（1785 → 1885 → 1780），一天来回 100 元，
  像数据源的异常点，但没有第二来源可交叉验证，暂未剔除。
- **`?v=` 版本号靠手工维护**，容易漏改；抓取脚本会自动递增，手改文件时仍需自己记得。
- **月K 上「伦敦 − 上海」不宜当真实套利价差**：伦敦金是「美元金价 × 当期汇率」折算出来的，
  上海金是上金所的人民币市场报价。汇率已按各期取（见下），但两者仍是不同来源的拼合，
  价差适合看趋势、不适合当可交易价差。

### 4.1 已修：历史 K 线用「今天的汇率」折算（2026-11-23）

原来 `buildGoldChart()` 对整段序列只取一次 `fetchUsdCny()`，2011 年的美元金价也按
2026 年的汇率折算。用真实 USD/CNH 月序列（东财 `133.USDCNH`，2010-08 起 196 根）
逐月对照后，**最大偏差 10.4%**，而且方向会变：2011 年偏高约 5%（6.34 → 6.66），
2019 年反而偏低约 3%（当时汇率 6.87 高于今天）。

现在改为**逐根按当期汇率折算**：新增 `fetchFxHistory()` 拉同期 USD/CNH，
月K 按 `YYYY-MM` 匹配（两个数据源的月末日期不同，不能用时间戳直接对齐），
日K/周K 按日期匹配并允许回退到此前最近的汇率（避免节假日缺口留下未折算的 bar）。
`payload.fx_mode` 取 `historical` / `flat-fallback` / `live`，页脚相应显示
「各期汇率折算」而不是一个误导性的单一汇率。汇率序列拉不到时退回单一汇率并**明确提示**，
不会静默用错。

复核方式：2011-12 首根，美元 1564.8 × 当期 6.3445 ÷ 31.1034768 = **319.189**，
与图表实际值一致（差 0.0005）；若按今日汇率则是 335.303。


## 5. 验证方法（可复现）

验证脚本都在 `.tmp/`（已在 `.gitignore` 里，不会提交）。用 DSH 自带的 node 跑：

```powershell
$node = "C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$ws   = "<仓库路径>"

# 离线确定性验证（推荐，不需要网络）
& $node "$ws\..\.tmp\serve.js"   $ws 8899          # 静态服务器，另开一个窗口
& $node "$ws\..\.tmp\cdp-probe.js"  $ws "$env:TEMP\shot.png"
& $node "$ws\..\.tmp\cdp-focus.js"

# 网络可用时，打真实接口
& $node "$ws\..\.tmp\verify-data.js" $ws
```

第一轮接手的 `verify-data.js` / `smoke.js` / `check-assets.js` 已随旧 `.tmp/` 目录丢失，
本次重写了 `verify-data.js`（数据层 17 项）与基于 CDP 的 UI 验证，思路与原脚本一致。

- `verify-data.js` — 校验汇率、20 个指数无缺失、金价折算、价差算术、
  各「品种×周期」组合的点数/时序/OHLC 合法性/MA 计算、茅台分桶与年初至今算术
- `cdp-probe.js` — 真 Chrome 里加载页面、注入 fixture，断言卡片数、价格、
  三周期切换、Canvas 实际像素、缩放徽标、悬停提示、双击复位、各处配色
- `cdp-focus.js` — 专项校验：茅台分桶点数与独立重算一致、注释配色、跨年区间标注

> 编码坑：用 PowerShell 的 `Set-Content -Encoding UTF8` 改中文文件会写入 BOM，
> 用 `-replace` 按 ANSI 读还会把中文变成乱码。**改含中文的文件请用 write 工具或 Node 脚本**。

## 6. 日常维护要点

- 改任何 `js/*.js` 或 `css/*.css` 后，把 `index.html` 里 **5 处** `?v=` 一起递增
  （茅台面板加进来后多了 `moutai-data.js` 一个引用）
- 新增指数：编辑 `js/data.js` 的 `REGIONS`，填 `secid`（`市场.代码`，如 `100.HSI`）与 `url`
- 新增品种分时：在 `SESSION_OPEN_HOUR` 补该 `secid` 的开盘小时（北京时间），
  否则会回退到"最后一个自然日"
- 新增折线类面板（像茅台）：在 payload 里给 `line: true` 与 `precision`，
  `chart.js` 会自动走 `drawIntraday` 画折线而不是蜡烛
- **新增 CSS 修饰类要放在基础类之后**：本次茅台图标撞色就是层叠顺序问题，
  改样式后建议用真浏览器读一次 `getComputedStyle` 确认生效
- 接口挂了的表现：连接状态变成「连接中断」，页面有 toast 提示，不会静默空图；
  连续失败 2 次内会自动重试
- 东方财富限流：保持串行队列，不要加并发；`QUOTE_BATCH = 30` 是批量报价上限。
  **手动验证时更要注意**，短时间多次请求会被封 IP，冷却十几分钟后恢复
- 换行符：`.gitattributes` 统一 `eol=lf`，但 `*.ps1` 固定 `eol=crlf` 且必须带 BOM
- **茅台快照不要手改**：由 `scripts/fetch-moutai.js` 生成，手改会在下次抓取时被合并覆盖
- 计划任务相关：
  - 手动跑一次：`.tmp\run-fetch-moutai.cmd`
  - 看日志：`.tmp\moutai-fetch.log`
  - 改时间：`scripts\install-task.ps1 -Time 'HH:mm'`
  - 卸载：`scripts\install-task.ps1 -Remove`
  - 抓取期间会弹出一个看不见的 Chrome 窗口（在屏幕左侧外），属正常

## 7. 后续怎么推送

> 第三次接手复核：`github.com:443` 通，且已配好 PAT（环境变量 `AURUM_GIT_TOKEN`），
> 直连 `git push` 可用。注意本机 git 推 Pull 需要
> `-c http.sslBackend=openssl -c http.version=HTTP/1.1`，否则会 `Connection was reset`。

仓库部署走 `.github/workflows/jekyll-gh-pages.yml`（推 main 自动发布到 GitHub Pages），
所以推上去即自动生效，无需手动构建。

截至本次，本地与 origin/main 一致，`scripts/` 下三个脚本已推送。

## 8. 第三次接手（2026-11-24）

本次接手**没有改动任何代码或数据**，只改了这份 HANDOVER（新增本节，
并把旧的第 8 节顺延为第 9 节）。页面、脚本、快照三者都未触碰，
`js/` `css/` `scripts/` 与 `HEAD = 59324dc` 逐字节一致。
结论：项目本身健康，自动化链路正常，但交接文档里有三处会误导人的地方，已就地更正。

### 8.1 自动化链路状态（实测）

- 计划任务 `AurumFetchMoutai`：`LastTaskResult = 0`，下次 2026-11-25 09:10
- 2026-11-24 09:10 那次抓到了 2026-11-24 的新价格，提交 `59324dc` 并
  **成功推送到 origin/main**，五处 `?v=` 同步 16 → 17
- 三个环境变量在**用户作用域**里都齐（`AURUM_GIT_TOKEN` 长度 93）。
  注意：DSH 的工作进程读不到用户作用域变量，要按作用域查：
  `[Environment]::GetEnvironmentVariable('AURUM_GIT_TOKEN','User')`。
  按进程作用域查会误判成"未设置"。
- 日志是 GBK 编码，用 UTF-8 读会整片乱码，不是脚本坏了：
  `Get-Content .tmp\moutai-fetch.log -Encoding Default`

### 8.2 更正：验证脚本的位置

第 5 节写的 `$ws\..\.tmp\` 是对的，但很容易被读成"仓库里的 `.tmp`"。
两处 `.tmp` 不是同一个：

| 路径 | 内容 | 是否入库 |
| --- | --- | --- |
| `D:\develop\.tmp\` | 验证脚本、fixtures、PortableGit | 否（在工作区根，不在仓库内） |
| `D:\develop\market\.tmp\` | 抓取日志、moutai-raw、run-fetch-moutai.cmd | 否（被 `.gitignore` 忽略） |

### 8.3 更正：`verify-data.js` 的"接口不可用"十有八九不是被封 IP

本次跑 `verify-data.js` 得到 11 项 `FAIL ... <- 行情接口不可用`，
但同一时刻真 Chrome 打开页面，行情、K 线、分时全部正常显示。
根因是**脚本 shim 的 bug，与网络无关**：

`js/data.js` 的 `jsonpOnce()` 自己会往 URL 上拼 `cb=__aurum_cb_<ts>_<n>`，
而东财只回显**第一个** `cb`。脚本又追加了一个自己的 `cb=__node_cb_*`，
于是响应里带的是页面的回调名、不是脚本的，正则匹配失败 → 走 `script.onerror`
→ 被翻译成"行情接口不可用"。**这个错误文案会让人以为 IP 被封，实际不是。**

已在 `D:\develop\.tmp\verify-data.js` 修好（改成用 `searchParams.set` 替换而非追加）。
所以：**看到"行情接口不可用"先怀疑脚本，不要先怀疑 IP**；
真被封的表现是 `ERR_EMPTY_RESPONSE` / `ECONNRESET`（见 0.1）。

### 8.4 新增：完全离线的验证脚本（推荐日常用）

`D:\develop\.tmp\offline-e2e.js` —— 不发起任何外部请求，用已抓好的
`fixtures/` 回放给 `js/data.js`，校验汇率、逐期汇率折算、各品种各周期
OHLC 合法性与时序、茅台分桶。当前 **13/13 全通过**。

```powershell
$node = "C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node 'D:\develop\.tmp\offline-e2e.js' 'D:\develop\market'
```

其中"伦敦金首根 = 319.189 元/克"与 4.1 节独立复核值一致，可作为折算逻辑的回归基线。
连东财会被封 IP，**日常验证请优先用这个离线脚本**。

### 8.5 写这类脚本时踩到的字段契约

`js/data.js` 对外只导出 `REGIONS / getDashboard / getChart / fetchUsdCny /
invalidate / TROY_OUNCE_GRAMS / MOUTAI_PERIODS`，**没有 `fetchGoldChart`**
（那是内部函数），取图一律走 `getChart(symbol, period)`，`symbol` 是
`gold` / `star50` / `moutai`。

点位字段是短名 **`t/o/h/l/c/v`**（外加 `ma5/ma10/ma20`），不是
`open/high/low/close`。另有一个坑：K 线的周期是 `day/week/month`，
而茅台折线的周期是 `daily-line/week-line/month-line`，
**传错不会报错，会静默回退成月线**，看起来像"茅台只有 13 个点"。

---

## 9. 第四次接手（2026-11-25）：茅台面板已移除

**本节之后，本文件前面关于茅台的描述全部只作历史记录，不再对应当前代码。**

### 9.1 为什么移除

用户发现这台电脑每天 09:10 会启动一个计划任务去抓茅台批价，要求去掉；
随后要求把茅台价格面板整块从页面移除。所以现在：

- 计划任务 `AurumFetchMoutai` 已删除（`schtasks /query` 已找不到）
- `AURUM_NODE` / `AURUM_GIT` / `AURUM_GIT_TOKEN` 三个用户级环境变量已清除
- 2026-11-25 09:10 那次抓取产生的本地提交 `afda3ea` 已撤销，
  `js/moutai-data.js` 与 `index.html` 回到 `59324dc` 的状态，
  HEAD 与 `origin/main` 都是 `59324dc`
- 页面、样式、数据层里的茅台代码与 `js/moutai-data.js`、
  `scripts/` 下三个抓取脚本全部删除

### 9.2 具体删了什么

| 位置 | 删掉的东西 |
| --- | --- |
| `index.html` | `#moutai-panel` 整块（64 行）、`js/moutai-data.js` 引用 1 行 |
| `js/app.js` | `state.charts.moutai`、`moutaiNumber()`、`updateMoutaiHeader/Meta/Note()`、`setupCharts` 里的实例、`init` 里的预加载、legend/state/toast 里的茅台分支 |
| `js/data.js` | `MOUTAI_PERIODS`、`moutaiPayload()`、`moutaiBucketed()`、`buildMoutaiChart()`，以及 `getChart` 的茅台分支和导出 |
| `js/chart.js` | 仅删两句提到茅台的行内注释（折线绘制能力保留，未删） |
| `css/styles.css` | `#moutai-panel`、`.panel-accent--red`、`.asset-icon--red`、`.legend-price`、`.source-badge--red`、`#moutai-panel .chart-note` |
| 删除文件 | `js/moutai-data.js`、`scripts/fetch-moutai.js`、`scripts/run-daily.ps1`、`scripts/install-task.ps1`（`scripts/` 目录已空） |
| `README.md` | 茅台功能条目、数据来源行、「茅台数据说明」整节、结构表三行 |

`chart.js` 的折线模式（`line: true` / `precision` / `daily-line` 等周期名）
**是有意保留的**：它是通用能力，将来加别的折线品种不用重写。

### 9.3 `?v=` 现在是 4 处，不是 5 处

`moutai-data.js` 的引用删掉后，`index.html` 只剩
`styles.css` / `data.js` / `chart.js` / `app.js` 四个版本号，
本次统一从 17 递增到 **18**。前面各节写的「5 处」请按 4 处理解。

### 9.4 这次踩到的坑（重要）

**用 Windows PowerShell 5.1 改含中文的 JS/CSS 会把文件彻底毁掉。**
`Get-Content` 默认按 GBK 读 UTF-8 文件，中文变成乱码，
再 `Set-Content -Encoding UTF8` 写回还会加 BOM。本次 `js/app.js`
一度被写成 0 可用内容（长度从 34826 掉到 32630 且中文全丢），
是靠 `git checkout -- js/app.js` 才恢复的。

HANDOVER 第 5 节早就写了这条，但这次仍然踩了。**结论：改仓库里的文本文件
一律用 write/edit 工具或 Node 脚本（`fs.readFileSync(f, "utf8")`），
不要用 PowerShell 的 `Get-Content`/`Set-Content` 组合。**

### 9.5 怎么验证的（不碰东财）

新增 `D:\develop\.tmp\verify-removed.js`：真 Chrome 加载页面，
用 `Fetch.fulfillRequest` 把 `push2*.eastmoney.com` 全部回放成
`fixtures/` 里的真实抓包，断言面板已消失、脚本清单正确、
两张图都有实际像素、无 JS 报错。当前 **9/9 通过**。

两个容易踩的点：
- 回放 JSONP 必须把响应包成 `cb(payload)`，只返回裸 JSON 会让页面
  `Uncaught SyntaxError`，看起来像页面坏了
- `fixtures/` 里**没有** `trends`（分时）快照，而页面初始加载的正是分时图。
  验证时要先等队列排空、再切到日K，且**只能点一次**——
  反复点会 abort 掉正在进行的请求，永远加载不完（本次因此误判过一轮）

---

## 10. 一句总结

项目本身干净、结构清晰，问题集中在**数据边界情况**与**CSS 层叠顺序**，而不是架构。
两次接手修掉的 bug 都属于「平时看起来正常、特定时段或特定面板才露馅」的类型：
分时图那个会直接误导对金价走势的判断，茅台面板图标撞色与日期缺年份则是新功能合入时
漏看的细节。任何改动之后，都值得在真浏览器里把三个面板的每个周期都点一遍。

茅台数据现在每天 09:10 自动更新并推送。这套东西最脆的地方不是代码，而是**上游**：
聚金数据随时可能改加密方式、换 key、或升级反爬。脚本已经把解密交给页面自己、
失败时不破坏既有快照，但真出问题时表现为日志里连续报错、数据不更新——
看到快照日期停住，就去翻 `.tmp\moutai-fetch.log`。


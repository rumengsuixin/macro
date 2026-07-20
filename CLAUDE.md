# 项目本地文档记录(索引)

> 本文件是「每次会话都自动加载」的**索引**,不是变更日志——精炼、可秒扫。
> 详情不在此:逐次变更细节 → `git log`;模块状态/待办/历史时间线 → `开发计划.md`;字段/协议速查 → 对应专题文档。

## ⚠️ 维护纪律(改本文件前必读)

- **本文件是「每轮对话都加载」的索引,不是变更日志。** 每一字都在每次会话付出上下文成本,臃肿=每轮浪费。它曾膨胀到 ~89K tokens(190KB)、背离「快速恢复」初衷——别让它重演。
- **每条 = 一句话指针**(是什么 + 详情在哪):不写实现细节、验证过程、设计理由、commit 号、字段 schema。那些各有归处——逐次变更 → git commit;模块现状 → `开发计划.md`;字段/协议 → 专题文档。
- **禁止 `〔日期 后续〕` 追加式堆叠。** 功能演进时**改写**原条目为「最新事实」一句话,旧细节靠 `git log` 回溯,绝不在此累积带日期的尾巴。
- **禁止验证痕迹入内**(已验证 / `npm run build` 通过 / E2E 断言 / commit 哈希)——它们属于 commit 与 PR,不属于索引。
- **新增文档只加一行指针**(≤ ~80 字);要写长说明,写进那个文档本身。
- **同一事实只留一处**:本文件只放指针,不复制专题文档 / `开发计划.md` 的正文。
- **定期体检**:本文件 > ~10K tokens 或任一条 > 2 行,先精简再加新内容。
- 本纪律同样适用于 `开发计划.md`:条目浓缩为一句话、只增当前状态;历史行只增不删(时间线完整),全文细节靠 git。

## 工作铁律

- **修改本项目前必须先 commit**(保存当前状态再改动)。
- 对话用中文;新增本地文档须在下方「文档地图」登记一行指针。

## 架构速览

- **二爪鱼**:可视化网页宏「录制 + 回放 + 数据提取 + 导出 Excel」的桌面工具。技术栈 Node + TypeScript + Electron + Playwright + exceljs,本地 JSON 存储。
- **两套浏览器**:录制 = Electron `<webview>`(内置 Chromium);回放/提取 = 独立 Playwright Chromium。回放反检测:抹 `navigator.webdriver` + 真内核回退链 `chrome`→`msedge`→捆绑(`useSystemChrome` 默认开)。
- **安全边界**:Playwright 仅在主进程,渲染进程经 IPC + contextBridge 访问。
- **构建**:纯 tsc 双 tsconfig(主进程 CommonJS + 渲染进程 ESM)+ `scripts/copy-assets.mjs`。入口 `dist/main/main.js`,启动 `npm run dev`。
- **运行时目录**(自动创建):`macros/`(宏)· `exports/`(Excel)· `errors/`(错误截图)· `downloads/`(回放下载)· `timelines/`(请求时间线)· `dumps/`(请求体落盘)。
- **提取 4 模式**(`ExtractConfig.mode`):`single`(整页单行)· `list`(逐项采字段)· `list-detail`(逐项进详情页采字段)· `list-action`(逐项点按钮下载,不采数据)。翻页由步骤右键「标记翻页操作」+ 总页数控制(标了才逐页处理)。
- **请求拦截 8 支路**(配置 `request-rules.json`,**仅回放端生效**,运行中 `fs.watchFile` 热更新):`rules`(改 POST body)· `resends`(命中后延时改参重发,支持响应条件触发 `responseTrigger`/文件整体替换)· `responseRules`(改响应头)· `requestHeaderRules`(改原始请求头)· `blocks`(硬阻断)· `dumps`(请求体落盘为文件)· `bodyReplaces`(本地文件整体替换请求体)· `record`(只记录不改,独立于 `enabled`)。全字段速查见 `拦截器规则配置手册.html`。
- **关键源文件**:`src/core/` — `macro-runner.ts`(回放引擎)· `request-rewrite.ts`(拦截纯逻辑)· `extractor.ts`(提取)· `selector-generator.ts`(选择器生成 + 语义指纹)· `ai-extract.ts`(AI 对接)· `download-manager.ts` · `timeline-recorder.ts` · `post-processors/`(后处理注册表 + 银行整合桥)。`src/main/` — `main.ts`(主进程/IPC)· `webview-preload.ts`(录制注入)· `request-interceptor.ts`(录制端 CDP 拦截器,现已不接线、仅自检直用)。`src/renderer/`(UI)。
- **已知限制**:`waitForSelector` 不自动录制(可手动加 / 拾取器点选);localStorage 注入仅覆盖录制页当前 origin(多域靠持久 profile 兜底)。

## 文档地图(一行一指针)

- `README.md` — 安装/运行/使用步骤、宏 DSL 与提取规则说明
- `开发计划.md` — 模块状态/待办/已知问题时间线(**唯一现状记录**,每次任务后维护)
- `功能开发计划.md` — 欠缺功能路线图(P0/P1/P2 优先级,2026-07-06)
- `拦截器规则配置手册.html` — `request-rules.json` 8 支路全字段速查表
- `YouTube上传流程分析.html` — YouTube Studio 上传三阶段逆向(frontendUploadId↔scottyResourceId 配对绑定)
- `xlsxIntgration融合设计.html` — 与外部 Python 银行整合项目的融合评估(仅设计文档)
- `打包指南.md` — Win/Mac 安装包打包(自带 Chromium;Mac 走 GitHub Actions `build-mac.yml`,未签名)
- `examples/` — 演示宏 `demo-macro.json` / `demo-list-action.json` + `request-rules.example.json`
- `assets/icon.{png,ico,icns}` — 应用图标,由 `scripts/make-icon.mjs` 纯 Node 生成(改几何/颜色常量后重跑)
- **运行时配置**(已 gitignore,首次运行自动生成):`ai-config.json`(AI profile)· `browser-config.json`(登录态复用/反检测)· `request-rules.json`(拦截 8 支路)· `bank-integrate.json`(银行整合 exe 路径)· `<宏名>.captures.json`(选择器上下文旁车)

## 关键命令

> 前置(统一说明一次):多数自检需先 `npm run build`;E2E 需 `MACRO_HEADLESS=1`;本机缺 headless_shell 时前置 `PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright` 走捆绑 Chromium。

- `npm install` — 装依赖(postinstall 自动下 Playwright Chromium)
- `npm run build` — 编译 TS + 拷静态资源到 dist
- `npm run dev` / `npm start` — 启动桌面程序(经 `scripts/start.mjs`,自动剥离 `ELECTRON_RUN_AS_NODE`)
- `npm run dist` / `dist:mac` — 打 Win / Mac 安装包
- **核心自检**:`verify-core.mjs`(跑 demo 宏导出 Excel)· `verify-pagination.mjs`(翻页 3 页 30 行,需网络)· `verify-merge.mjs`(合并后处理器)· `verify-captures.mjs`(旁车往返)· `verify-cancel.mjs`(运行中停止)· `verify-popup-wait.mjs`(新窗口等待竞态)· `verify-stepurls.mjs`(回放回填来源 URL)· `verify-selector-class.mjs`(稳定类判定)· `verify-bank-integrate.mjs`(银行整合 5 代号真跑 exe)
- **拦截器纯逻辑离线**:`verify-request-rewrite` / `verify-response-rewrite` / `verify-response-trigger` / `verify-timeline-recorder`
- **拦截器回放端 E2E**(各测一支路,名自解释):`verify-replay-intercept` / `verify-resend` / `verify-resend-headers` / `verify-resend-replace` / `verify-response-header-replay` / `verify-request-header-replay` / `verify-block-intercept` / `verify-dump-body` / `verify-body-replace` / `verify-timeline-replay` / `verify-hotreload` / `verify-response-trigger-replay`
- **录制端 CDP E2E**(需以应用方式启 Electron):`verify-request-intercept` / `verify-timeline-record`
- **AI 自检**(需 Gateway 运行):`test-ai.mjs [profileId]` / `test-selector-fix.mjs [profileId]`
- **环境变量**:`MACRO_HEADLESS=1`(无头)· `MACRO_TIMEOUT=60000`(回放全局超时,慢站调大)· 环境若已设 `ELECTRON_RUN_AS_NODE=1` 务必用 `npm start` 而非 `electron .`

## 对接要点(稳定事实,非历史)

- **AI 提取/校正**:macro 作 WebSocket 客户端连本机 OpenClaw Gateway(`ws://127.0.0.1:18799`,Ed25519 签名,`chat.send` deliver:false),不 spawn 子进程。两个专用 agent——`webextract`(输出 ExtractConfig JSON)、`selector-fix`(修脆弱选择器)。**选择器质量准则的单一可信源 = 各 agent 的 SOUL.md**;客户端 `ai-extract.ts` 的 `SELECTOR_QUALITY_GUIDE` 仅作兜底红线。依赖 `~/.openclaw/openclaw.json` + `identity/device.json`,Gateway 须运行。生成/校正带「实测命中 → 中文反馈 → 复用同 sessionKey 重生成」自检回路(≤2-3 轮)。校正优先离线读旁车 `<宏名>.captures.json`(录制时抓的 DOM 上下文),旧宏无旁车回退实时 webview DOM。
- **银行整合(独立工具)**:侧栏「🧰 独立工具」板块(非「附加处理」),spawn 外部 `xlsxIntgration` 打包 **exe**(非 Python 脚本),配置 `bank-integrate.json`(按 `process.platform` 指向 exe 路径),覆盖 5 代号 domestic/overseas/order-match/payout/collection-payout。桥 `subprocess-bridge.ts` + handler `post-processors/bank-integrate.ts`,GBK/UTF-8 智能解码,`BANK_INPUT_DIR`/`BANK_OUTPUT_DIR` 临时目录隔离。Mac 二进制走 Actions、路径待填。
- **登录态复用**:`browser-config.json` 三开关——持久化回放 profile(`browser-profile/`)、注入录制 cookie、注入录制 localStorage(仅当前页 origin);均默认关,`useSystemChrome`(反检测)默认开。
- **后处理器**:轻量注册表 `post-processors/index.ts`(`type→{manifest,handler}`),新 handler 自注册 + `index.ts` 末尾 `import` 即热插拔上架。首个 `merge-zip-excel`(解压 zip / 裸文件 → SheetJS 读 csv/xls/xlsx、UTF-8+GBK 兜底 → exceljs 堆叠合并)。

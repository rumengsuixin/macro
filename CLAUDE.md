# 项目本地文档记录

> 本文件记录本项目生成的本地文档与关键信息,便于上下文清空后快速恢复。

## 工作铁律

- **【铁律】修改本项目前必须先 commit**:在对本项目进行任何改动前,必须先对项目执行一次 commit(保存当前状态),再开始改动。

## 本地文档清单

- `README.md` — 安装、运行、使用步骤、宏 DSL 与提取规则说明
- `开发计划.md` — 模块状态、待办、已知问题(每次任务后持续维护)
- `examples/demo-macro.json` — 演示宏(books.toscrape.com,采集 标题 / 价格 / 链接)
- `ai-config.json` — AI 提取配置(项目根,首次运行自动生成):openclaw agent 目标 profile 列表 + 系统/提示词模板
- `browser-config.json` — 浏览器登录态复用配置(项目根,首次设置时生成,已 gitignore):`persistProfile`/`userDataDir`/`injectRecordingSession`
- `browser-profile/` — 持久化回放 profile 默认目录(已 gitignore)
- `scripts/test-ai.mjs` — AI 自检脚本(验证对接 openclaw agent 整链能否跑通)
- `打包指南.md` — Windows 安装包打包说明(自带 Chromium,`npm run dist` 一键打包,产物在 `release/`);安装态用户数据在 `%APPDATA%\macro-recorder\`,`ai-config.json` 首次启动自动生成
- 规划阶段计划文档:`C:\Users\Administrator\.claude\plans\glimmering-brewing-hoare.md`、`...\happy-wishing-hamming.md`(AI 提取)

## AI 提取要点(对接 openclaw agent)

- 方式:macro 作为 WebSocket 客户端连本机 OpenClaw Gateway(`ws://127.0.0.1:18799`),Ed25519 签名认证,`chat.send`(`deliver:false`)请求 agent 生成、收回草稿。**不再** spawn claude/codex。
- 客户端 `src/core/openclaw-client.ts`(参考 `D:\git_object\aiAgentServicer` 的 `test_ws_send.js`/`oclaw-client.js`);依赖 `ws` + Node 内置 `crypto`。
- 专用 agent:`webextract`(用 `openclaw agents add` 创建,workspace 在 `~/.openclaw/workspace-webextract`,SOUL.md 定位为「只输出 ExtractConfig JSON」)。
- 配置在 `ai-config.json`:profile 指定 `agentId` + `sessionKeyPrefix`(实际 sessionKey = 前缀 + uuid),可配多个 agent 目标。
- 依赖:`~/.openclaw/openclaw.json`(端口/token)、`~/.openclaw/identity/device.json`(Ed25519 身份);Gateway 须运行。
- 已验证:自检对接 webextract,24s 产出合法 list 规则。
- agent 管理:`openclaw agents list` 查看,`openclaw agents delete webextract` 回滚。

## 项目要点

- 录制:Electron `<webview>`(内置 Chromium);回放/提取:独立 Playwright Chromium
- 安全:Playwright 仅在主进程,渲染进程通过 IPC + contextBridge 访问
- 构建:纯 tsc 双 tsconfig(主进程 CommonJS + 渲染进程 ESM)+ `scripts/copy-assets.mjs`
- 入口:`dist/main/main.js`;启动:`npm run dev`
- 运行时目录(自动创建):`macros/`(宏)、`exports/`(Excel)、`errors/`(错误截图)
- 翻页标记:步骤行右键「标记翻页操作」可设总页数 N,步骤加 `pagination:true`/`pageCount:N` 字段;回放跳过该步骤,提取(list/list-detail)时按总页数逐页采集,每页采完执行翻页序列。list-detail 先跨所有页收完整列表再统一进详情
- 人工介入暂停:步骤行右键「在此前/此后插入暂停」或工具栏「插入暂停」插入 `pause` 步骤(`{type:'pause',reason?,timeout?}`);回放到此停住,有头浏览器窗口保持可交互,用户手动完成登录/验证码/扫码后,在主窗模态框点「继续」恢复。机制:`MacroRunner(errorDir,timeoutMs?,onPause?)` 注入回调(core 不依赖 Electron,无回调默认放行);主进程 `run-macro` 用递增 `runId` 隔离 `resume-macro` 信号、`macro-paused` 事件通知渲染进程;`timeout` 防无人值守挂死(超时走出错截图)。**pause 与 `pagination` 互斥**(回放主循环跳过 pagination 步骤),UI 禁止对 pause 标翻页
- 登录态复用(回放/录制两浏览器引擎不同,无法严格共用同一目录,故用两条可叠加 UI 开关,默认关,存 `browser-config.json`):①**持久化回放 profile**——回放从临时 profile 改 `chromium.launchPersistentContext(userDataDir)`,跨次复用(含 cookie/localStorage),一次登录长期有效;②**录制→回放 cookie 注入**——回放前主进程从 `session.defaultSession`(webview 默认 session)导出 cookies,`toPlaywrightCookies` 转格式后 `context.addCookies` 注入。`MacroRunner(errorDir,timeoutMs?,onPause?,session?)` 第 4 参 `SessionOptions{userDataDir?,cookies?}`(core 不依赖 Electron,cookie 来源/转换全在主进程,同 onPause 依赖倒置);UI 在侧栏可折叠面板「浏览器登录态」(`#bc-persist`/`#bc-inject`/`#bc-choose`),IPC `get/set-browser-config`、`choose-user-data-dir`
- 新标签页归一(单视图工具,不做真多标签):点击 `target=_blank`/`window.open` 链接时 Electron 默认丢弃弹窗→录制不生效。主进程 `main.ts` 用 `mainWindow.webContents.on('did-attach-webview')` 拿到 guest webContents 后 `setWindowOpenHandler(({url})=>{ loadURL(url); return {action:'deny'} })`,把新窗口导航重定向回同一 webview;点击仍由 preload 的 capture click 先行录制,跳转后 `dom-ready` 自动 `armRecorder`。回放端 `macro-runner.ts` 用 `activePage` 可变引用+`context.on('page')` 跟随弹窗(初始页先建后挂监听,故此后 page 事件皆弹窗),executeStep/extract/pagination/错误截图均改用 `activePage`。两端落点一致(同 URL/DOM),选择器可匹配,无需新增步骤类型
- 已知限制:`waitForSelector` 不自动录制,可手动加入 JSON;回放靠 Playwright auto-wait 兜底;localStorage 暂不跨录制→回放注入(靠持久 profile 兜底)

## 常用命令

- `npm install` — 安装依赖(postinstall 自动下载 Playwright Chromium)
- `npm run build` — 编译 TS + 拷贝静态资源到 dist
- `npm run dev` / `npm start` — 启动桌面程序(经 `scripts/start.mjs` 启动,自动剥离 ELECTRON_RUN_AS_NODE)
- `MACRO_HEADLESS=1 node scripts/verify-core.mjs` — 无头自检:实跑 demo 宏并导出 Excel
- `node scripts/test-ai.mjs [profileId] [需求]` — AI 自检:对接 openclaw agent 出规则(需先 `npm run build` 且 Gateway 运行),如 `node scripts/test-ai.mjs webextract`
- 注:环境若设置了 `ELECTRON_RUN_AS_NODE=1`,务必用 `npm start`(而非 `electron .`)启动
- `MACRO_TIMEOUT=60000`(毫秒,默认 60000)— 回放全局默认超时,影响 click/goto/waitForSelector 等动作;慢加载站点可调大,如 `MACRO_TIMEOUT=90000 npm run dev`

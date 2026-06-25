# 二爪鱼

<p align="center"><img src="assets/icon.svg" width="120" alt="二爪鱼" /></p>

一个本地运行的「可视化网页宏录制 + 回放 + 数据提取 + 导出 Excel」桌面工具,类似八爪鱼采集器的极简版。名字取自「鱼 + 两只爪子」——专注**爪取**网页数据。

- 在**内置浏览器**里浏览网页并**录制**操作(点击 / 输入 / 按键 / 滚动)
- 录制结果保存为 **JSON 宏(DSL)**,不保存 JS 代码
- 用 **Playwright** 回放宏,并按规则**提取数据**
- 一键**导出 Excel(xlsx)**

## 技术栈

- Node.js + TypeScript
- Electron(桌面端 + 内置浏览器 `<webview>`)
- Playwright(宏回放 + 数据提取)
- exceljs(Excel 导出)
- 本地 JSON 文件存储(不使用数据库)

## 架构说明

录制与回放使用两套浏览器,职责分离:

| 环节 | 引擎 | 说明 |
| -- | -- | -- |
| 浏览 + 录制 | Electron `<webview>`(内置 Chromium) | 真正内嵌在窗口里,用户可见可交互 |
| 回放 + 提取 | Playwright(独立 Chromium) | 与「回放用 Playwright 启动浏览器」一致 |

两套都是 Chromium,生成的 CSS / XPath 选择器通用,录制出的宏可直接被 Playwright 回放。
Playwright 对象只存在于 Electron 主进程,**不会暴露给渲染进程**,主进程与渲染进程通过 IPC 通信。

## 目录结构

```
macro/
  package.json
  tsconfig.json                # 主进程 / core / storage / preload → CommonJS
  tsconfig.renderer.json       # 渲染进程 → ESM
  scripts/copy-assets.mjs      # 构建时拷贝 html 到 dist
  src/
    main/
      main.ts                  # 主进程入口:窗口、IPC、持有 Playwright 回放
      preload.ts               # contextBridge 暴露 window.electronAPI
      webview-preload.ts       # 注入内置浏览器页面的录制器
    renderer/
      index.html               # UI 界面
      renderer.ts              # UI 逻辑、收集步骤、调用 electronAPI
    core/
      macro-types.ts           # 宏 DSL 的 TS 类型定义
      selector-generator.ts    # generateSelector(element) 稳定选择器生成
      macro-runner.ts          # MacroRunner 回放引擎
      extractor.ts             # extract(page, config) 数据提取
      excel-exporter.ts        # exportToExcel(rows, path) 导出 Excel
      logger.ts                # 中文日志
    storage/
      macro-store.ts           # 宏 JSON 的保存 / 加载
  examples/demo-macro.json     # 演示宏(books.toscrape.com)
  macros/   exports/   errors/ # 运行时自动创建
```

## 环境要求

- Windows 10/11(也可在 macOS / Linux 运行)
- Node.js ≥ 18(推荐 20 / 22)
- 首次安装会自动下载 Playwright 的 Chromium,需要网络

## 安装

```bash
npm install
```

> `npm install` 会自动执行 `postinstall`,下载 Playwright 所需的 Chromium。
> 若下载失败,可单独重试:`npx playwright install chromium`

## 运行

```bash
npm run dev      # 先编译再启动(开发常用)
```

其他命令:

```bash
npm run build    # 仅编译 TypeScript 并拷贝静态资源到 dist/
npm start        # 直接用已编译产物启动(需先 build)
```

## 使用步骤

1. `npm run dev` 启动桌面程序。
2. 在地址栏输入网址(默认已填 `https://books.toscrape.com/`),点击「打开网页」。
3. 点击「**开始录制**」(会自动把当前页面作为第一步 `goto` 记录)。
4. 在内置浏览器中点击、输入、按回车、滚动 —— 右侧「录制步骤」会实时显示。
5. 点击「**停止录制**」。
6. (可选)在右侧「提取规则」编辑 `extract` 的 JSON(默认已填演示规则);也可用下方「**AI 提取**」自动生成(见下节)。
7. 点击「**保存宏**」,选择路径写出 JSON 文件。
8. 点击「**加载宏**」可重新载入宏(默认定位到 `examples/` 目录,可直接选 `demo-macro.json`)。
9. 点击「**运行宏**」,会弹出 Playwright 浏览器执行步骤,日志区显示「第 N/总 步」。
10. 运行成功后点击「**导出 Excel**」,文件保存到 `exports/result-{时间戳}.xlsx`,日志区显示路径。

## 宏 DSL 格式

```json
{
    "name": "demo-task",
    "version": 1,
    "steps": [
        { "type": "goto", "url": "https://example.com" },
        { "type": "fill", "selector": "input[name='keyword']", "value": "iphone" },
        { "type": "click", "selector": "button[type='submit']" },
        { "type": "waitForSelector", "selector": ".product-item" }
    ],
    "extract": {
        "mode": "list",
        "listSelector": ".product-item",
        "fields": [
            { "name": "title", "selector": ".title", "type": "text" },
            { "name": "price", "selector": ".price", "type": "text" },
            { "name": "link", "selector": "a", "type": "attr", "attr": "href" }
        ]
    }
}
```

### 步骤类型(steps)

| type | 字段 | 说明 |
| -- | -- | -- |
| `goto` | `url` | 打开网址 |
| `click` | `selector` | 点击元素 |
| `fill` | `selector`, `value` | 输入文本 |
| `press` | `key`, `selector?` | 按键(如 `Enter`);无 selector 则全局按键 |
| `scroll` | `x`, `y` | 滚动到窗口坐标 |
| `waitForSelector` | `selector`, `timeout?` | 等待元素出现 |
| `pause` | `reason?`, `timeout?` | 人工介入暂停:回放停住等用户在浏览器里手动操作后点「继续」 |

### 人工介入暂停(pause)

遇到需要**人工操作**才能继续的环节(登录、验证码、扫码、二次验证等),可在任意步骤前后插入 `pause` 步骤。回放执行到该步时:

1. 有头的浏览器窗口**停在当前页**且保持可交互;
2. 程序主窗弹出模态框显示 `reason` 提示;
3. 你切到浏览器窗口手动完成操作(登录/扫码/过验证码),回主窗点「**继续**」,回放恢复执行后续步骤。

```json
{ "type": "pause", "reason": "请手动扫码登录后点继续", "timeout": 120000 }
```

- `reason`:模态框里显示的提示文案(可省略)。
- `timeout`:无人值守时的等待上限(毫秒);省略则**无限等待**。超时按回放失败处理(截图 + 关闭浏览器)。
- **插入方式**:步骤列表右键「在此前/此后插入暂停」,或工具栏「插入暂停」(追加到末尾);右键 pause 步骤可改提示文案。
- **注意**:`pause` 步骤**不能同时标记为翻页**(回放主循环会跳过翻页步骤,二者互斥)。

### 选择器生成优先级

录制时为元素生成稳定选择器,优先级:
`data-testid` → `id` → `name` → `aria-label` → role+文本(XPath) → class → CSS path → 绝对 XPath 兜底。
每个候选都会校验唯一性,命中唯一才采用。

### 提取规则(extract)

两种模式:

- **single**:整页单字段提取
  ```json
  { "mode": "single", "fields": [ { "name": "title", "selector": "h1", "type": "text" } ] }
  ```
- **list**:遍历列表项提取(`listSelector` 定位每条,字段选择器在条目内查找)
  ```json
  {
      "mode": "list",
      "listSelector": ".item",
      "fields": [
          { "name": "title", "selector": ".title", "type": "text" },
          { "name": "link", "selector": "a", "type": "attr", "attr": "href" }
      ]
  }
  ```

字段类型(`type`):

| type | 说明 |
| -- | -- |
| `text` | 提取 innerText |
| `html` | 提取 innerHTML |
| `attr` | 提取指定属性(需配合 `attr` 字段) |
| `href` | 提取 href 属性 |
| `src` | 提取 src 属性 |

## AI 提取(对接 openclaw agent 自动生成规则)

不想手写选择器时,可让 **openclaw agent** 看页面 HTML 自动生成上面的 `extract` 规则。macro 作为 WebSocket 客户端连本机 **OpenClaw Gateway**(Ed25519 签名认证),把「采集需求 + 网页 HTML」发给指定 agent,收回规则 JSON。

**用法**:打开目标网页 → 在侧栏「AI 提取」区选择 **agent**、用一句话填写**采集需求**(如「采集每个商品的标题、价格、详情链接」)→ 点「**AI 生成规则**」→ 生成的规则自动填入「提取规则」框,可直接「运行宏」。

### 前置条件

1. **OpenClaw Gateway 正在运行**(默认 `ws://127.0.0.1:18799`)。
2. 本机存在 `~/.openclaw/openclaw.json`(含 `gateway.auth.token`)与 `~/.openclaw/identity/device.json`(Ed25519 身份)。
3. **创建一个用于提取的 agent**(一次性):
   ```bash
   openclaw agents add webextract --non-interactive \
     --workspace C:\Users\Administrator\.openclaw\workspace-webextract
   ```
   然后把该 workspace 的 `SOUL.md` 定位为「只输出 ExtractConfig JSON 的提取规则生成器」(本项目已附示例)。`openclaw agents list` 可确认,`openclaw agents delete webextract` 可回滚。

### 配置文件 `ai-config.json`(项目根,首次运行自动生成)

采用 **profile 列表**,每档指定一个 openclaw agent 目标,可配多个:

```jsonc
{
    "defaultProfile": "webextract",
    "profiles": [
        { "id": "webextract", "label": "网页提取 Agent(webextract)",
          "agentId": "webextract", "sessionKeyPrefix": "agent:webextract:macro:extract", "timeout": 120000 }
    ],
    "openclaw": {},                  // 可覆盖 { "url": "ws://...", "token": "..." },默认自动读 ~/.openclaw
    "systemPrompt": "……(可改)",
    "promptTemplate": "……支持占位符 {requirement} 与 {html}"
}
```

- 实际 `sessionKey` = `sessionKeyPrefix` + `:` + 随机 uuid;`agentId` 即 OpenClaw 中注册的 agent。
- 协议:连 Gateway → 收 `connect.challenge` → Ed25519 签名 `connect` 认证 → `chat.send`(`deliver:false`)→ 等 `chat` final 事件取文本。实现见 `src/core/openclaw-client.ts`(参考 `D:\git_object\aiAgentServicer`)。
- HTML 发送前会去掉 script/style/注释降噪(不截断长度)。

### 先单独自检(验证对接整链,需先 `npm run build` 且 Gateway 运行)

```bash
node scripts/test-ai.mjs                 # 用默认档(webextract)
node scripts/test-ai.mjs webextract "采集标题和价格"
```

> 自检会连 Gateway、认证、发样例 HTML 给 agent,并打印返回的规则 JSON。失败时打印原始回复便于排查。

## 错误处理

回放出错时:

- 日志区给出**失败步骤序号、步骤类型、selector、当前页面 URL、错误原因**
- 自动截图保存到 `errors/error-{时间戳}.png`

### 回放超时

回放默认超时为 **60 秒**(影响 click / goto / waitForSelector 等动作,包括点击后等待页面跳转加载)。
若目标站点加载较慢导致超时,可用环境变量 `MACRO_TIMEOUT`(毫秒)调大,例如 `MACRO_TIMEOUT=90000 npm run dev`。

## 已知限制(第一版)

- `waitForSelector` **不会自动录制**(可靠的自动判定成本较高)。DSL、回放引擎与示例均完整支持该步骤,可在保存的 JSON 中手动添加;回放点击时也依赖 Playwright 内置的 auto-wait 兜底。
- 录制依赖图形界面交互,因此录制必须在本机桌面环境进行。
- 验证码/扫码等需人工操作的环节:可用 `pause` 步骤人工介入(见上文),暂不含自动识别;登录态持久化(免重复登录)为后续计划。
- 第一版不含:云采集、代理池、验证码自动识别、登录态持久化、AI 自动修复等。

## 演示

`examples/demo-macro.json` 已配置为采集 `https://books.toscrape.com/` 首页书籍的标题、价格、链接,
直接「加载宏」→「运行宏」→「导出 Excel」即可看到完整效果。

## 无头自检(可选)

无需打开界面,直接验证「回放 → 提取 → 导出 Excel」管道是否正常:

```bash
npm run build
# Windows PowerShell:$env:MACRO_HEADLESS=1; node scripts/verify-core.mjs
# Git Bash / macOS / Linux:
MACRO_HEADLESS=1 node scripts/verify-core.mjs
```

成功会在 `exports/` 生成 `verify-result.xlsx`,并打印提取行数。

## 故障排查

- **启动后报 `Cannot read properties of undefined (reading 'whenReady')`**:
  当前环境设置了 `ELECTRON_RUN_AS_NODE=1`(常见于 VSCode 扩展宿主),使 Electron 退化为普通 Node。
  请使用 `npm start` / `npm run dev`(已通过 `scripts/start.mjs` 自动剥离该变量),不要直接执行 `electron .`。
- **`npm install` 卡在下载 Chromium**:重试 `npx playwright install chromium`,或检查网络。

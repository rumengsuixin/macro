// 宏 DSL 的 TypeScript 类型定义。
// 所有宏均以 JSON 形式保存,不保存 JS 代码。

/** 步骤类型 */
export type StepType =
    | 'goto'
    | 'click'
    | 'fill'
    | 'press'
    | 'scroll'
    | 'scroll-bottom'
    | 'wait-for-load'
    | 'waitForSelector'
    | 'waitForClickable'
    | 'pause';

/** 打开网址 */
export interface GotoStep {
    type: 'goto';
    url: string;
}

/**
 * 元素语义指纹:录制时随 click 步骤一并保存,供回放时「主选择器命中数 ≠1」时通用重定位。
 * 全部可选,旧宏(无此字段)照常解析与运行。
 */
export interface ElementFingerprint {
    /** 标签名(小写) */
    tag?: string;
    /** 归一化可见文本(截断) */
    text?: string;
    /** aria-label */
    ariaLabel?: string;
    /** 原始 href attribute(翻页等动态 href 仅作最弱信号) */
    href?: string;
    /** 最近一个带稳定锚点(id、data-* 属性、稳定 class、aria)的祖先选择器,如 li.next */
    anchor?: string;
}

/**
 * 元素录制时的 DOM 上下文快照:供「AI 校正选择器」离线(不依赖当前页面)重挑选择器。
 * 录制那一刻元素一定存在,故在此抓取;存到宏同名的旁车文件 `<宏名>.captures.json`,宏本体不含。
 */
export interface StepCapture {
    /** 目标元素 outerHTML(截断,不含临时标记),喂给 AI */
    outerHTML: string;
    /** 祖先链摘要(tag+id+稳定属性+class,从近到远),喂给 AI */
    ancestors: string;
    /**
     * 邻域子树 HTML(目标最近的、体积受控的祖先 outerHTML,目标元素上带 data-macro-cap 标记):
     * 仅供离线验证「AI 新选择器在此子树内是否唯一命中被标记的目标」,AI 不接触。
     */
    contextHtml: string;
}

/** 旁车单条:与宏 steps 同序对齐;非选择器步骤或无上下文为 null。带 type/selector 作加载时的一致性校验 */
export interface CaptureEntry {
    type: string;
    selector: string;
    capture: StepCapture;
}

/** 宏旁车文件结构(`<宏名>.captures.json`):steps 与宏 steps 同序对齐 */
export interface MacroCaptures {
    version: number;
    steps: (CaptureEntry | null)[];
}

/** 点击元素 */
export interface ClickStep {
    type: 'click';
    selector: string;
    /** 语义指纹:回放时主选择器命中 ≠1 时用于通用重定位;旧宏可缺省 */
    fingerprint?: ElementFingerprint;
}

/** 输入文本 */
export interface FillStep {
    type: 'fill';
    selector: string;
    value: string;
    /** 语义指纹:供「AI 校正选择器」在旧选择器失效时重定位元素;旧宏可缺省 */
    fingerprint?: ElementFingerprint;
}

/** 按键(如 Enter)。selector 可选:有则聚焦该元素后按键,无则全局按键 */
export interface PressStep {
    type: 'press';
    selector?: string;
    key: string;
}

/** 滚动到指定坐标(窗口滚动位置) */
export interface ScrollStep {
    type: 'scroll';
    x: number;
    y: number;
}

/** 滚动到页面最底部(常用于触发无限滚动懒加载;无固定坐标,运行时取实际页面高度) */
export interface ScrollBottomStep {
    type: 'scroll-bottom';
}

/** 等待页面加载完成(回放到此等 load 事件,即 DOM 与所有资源加载完毕,再继续后续步骤) */
export interface WaitForLoadStep {
    type: 'wait-for-load';
}

/** 等待元素出现 */
export interface WaitForSelectorStep {
    type: 'waitForSelector';
    selector: string;
    timeout?: number;
    /** 语义指纹:供「AI 校正选择器」在旧选择器失效时重定位元素;旧宏可缺省 */
    fingerprint?: ElementFingerprint;
}

/**
 * 等待元素可点击:比「出现(visible)」更强,要求元素可交互
 * (尺寸非零、未 disabled、视口内时未被遮罩遮挡)。判定为纯只读、零副作用,不滚动页面。
 * 用于「透明遮罩盖住内容」「disabled 按钮变 enabled」等下一步非点击的同步场景。
 */
export interface WaitForClickableStep {
    type: 'waitForClickable';
    selector: string;
    timeout?: number;
    /** 语义指纹:供「AI 校正选择器」在旧选择器失效时重定位元素;旧宏可缺省 */
    fingerprint?: ElementFingerprint;
}

/** 人工介入暂停:回放到此步时停下,等用户在浏览器里手动操作(登录/验证码/扫码等)后点继续 */
export interface PauseStep {
    type: 'pause';
    /** 提示文案,展示在暂停模态框里,如「请手动登录后点继续」 */
    reason?: string;
    /** 超时(毫秒):无人值守时的等待上限;省略则无限等待 */
    timeout?: number;
}

/** 翻页标记:可附加到任意步骤 */
export interface StepFlags {
    /** 标记为翻页动作:正常回放时跳过;提取翻页时按序执行 */
    pagination?: boolean;
    /** 总页数 N(共采集 N 页 → 翻页序列执行 N-1 次);仅 pagination=true 时有效 */
    pageCount?: number;
    /** 录制此步骤时所在页面 URL(仅用于步骤列表按来源分组显示,回放忽略) */
    recordedUrl?: string;
}

/** 步骤可辨识联合(交叉 StepFlags 以携带翻页标记,仍保持 type 可辨识) */
export type Step = StepFlags & (
    | GotoStep
    | ClickStep
    | FillStep
    | PressStep
    | ScrollStep
    | ScrollBottomStep
    | WaitForLoadStep
    | WaitForSelectorStep
    | WaitForClickableStep
    | PauseStep
);

/** 人工介入暂停的回调信息 */
export interface PauseInfo {
    stepIndex: number;
    reason?: string;
    timeout?: number;
}

/** 暂停回调:回放引擎执行到 pause 步骤时调用,promise resolve 表示用户已点继续 */
export type OnPause = (info: PauseInfo) => Promise<void>;

/** 字段提取类型 */
export type FieldType = 'text' | 'html' | 'attr' | 'href' | 'src';

/** 提取字段定义 */
export interface ExtractField {
    name: string;
    /** 字段选择器;列表模式下留空则取列表项本身 */
    selector: string;
    type: FieldType;
    /** 当 type 为 attr 时,指定要提取的属性名 */
    attr?: string;
}

/** 单字段提取(整页) */
export interface SingleExtractConfig {
    mode: 'single';
    fields: ExtractField[];
}

/** 列表提取(遍历列表项) */
export interface ListExtractConfig {
    mode: 'list';
    listSelector: string;
    fields: ExtractField[];
}

/** 列表+详情页提取:列表页取每项基础字段与详情链接,再逐个进详情页抓详情字段,合并成行 */
export interface ListDetailExtractConfig {
    mode: 'list-detail';
    /** 列表项容器选择器 */
    listSelector: string;
    /** 列表页每项基础字段(可为空数组) */
    fields: ExtractField[];
    /** fields 中作为详情页入口的字段名(取其元素 href 进详情页);留空则取列表项自身 */
    detailLinkField: string;
    /** 详情页要抓取的字段(字段名勿与 fields 重名,否则会被覆盖) */
    detailFields: ExtractField[];
}

/** 列表逐项动作:遍历列表项,逐项点击其中按钮(常用于每点一次触发一次文件下载) */
export interface ListActionExtractConfig {
    mode: 'list-action';
    /** 列表项容器选择器 */
    listSelector: string;
    /** 列表项内要点击的按钮选择器;留空则点列表项本身 */
    actionSelector: string;
    /** 每次点击后等待下载开始的超时(毫秒);省略沿用全局默认 */
    actionTimeout?: number;
}

/** 提取配置 */
export type ExtractConfig =
    | SingleExtractConfig
    | ListExtractConfig
    | ListDetailExtractConfig
    | ListActionExtractConfig;

/**
 * 后处理器规格:挂在 Macro 上,回放产出(数据/下载)后由主进程按序执行。
 * 轻量「type → handler」注册表机制,非通用插件框架;旧宏无此字段照常解析。
 */
export interface PostProcessSpec {
    /** 注册表 key,如 'merge-zip-excel' */
    type: string;
    /** 该 handler 的可选参数 */
    options?: Record<string, unknown>;
}

/** 单个后处理器的执行结果(回传渲染进程展示) */
export interface PostProcessResult {
    type: string;
    /** 产出文件绝对路径(若有) */
    output?: string;
    /** 中文摘要,如「已合并 5 个表格 / 共 120 行 → merged-xxx.xlsx」 */
    message: string;
}

/** 插件元数据:驱动 UI 的可选插件列表(放此处便于 preload/renderer 共用类型) */
export interface PostProcessorManifest {
    /** 注册表 key,与 PostProcessSpec.type 对应 */
    type: string;
    /** 列表展示名,如「批量下载表格合并」 */
    label: string;
    /** 一句话说明,展示为副文字 */
    description: string;
}

/** 宏定义 */
export interface Macro {
    name: string;
    version: number;
    steps: Step[];
    extract?: ExtractConfig;
    /** 回放产出后按序执行的后处理器(如 list-action 下载后合并 zip 内 excel) */
    postProcess?: PostProcessSpec[];
}

/** 宏库列表项摘要(扫描 macros/ 目录得到,用于渲染宏库面板) */
export interface MacroSummary {
    /** 宏文件绝对路径 */
    filePath: string;
    /** 宏名称(取 macro.name,缺省用文件名) */
    name: string;
    /** 步骤数 */
    stepCount: number;
    /** 文件最后修改时间(unix 毫秒),用于排序 */
    modifiedMs: number;
}

/** 提取结果的一行 */
export type ExtractRow = Record<string, string>;

/** 回放出错时的结构化错误信息 */
export interface RunError {
    /** 失败步骤索引(从 0 开始) */
    stepIndex: number;
    /** 失败步骤类型 */
    stepType: StepType;
    /** 失败步骤的 selector(若有) */
    selector?: string;
    /** 失败时所在页面 URL */
    url?: string;
    /** 错误信息 */
    message: string;
    /** 错误截图路径(若成功保存) */
    screenshot?: string;
}

/** 回放结果 */
export interface RunResult {
    ok: boolean;
    rows?: ExtractRow[];
    /** list-action 等模式下捕获并保存的下载文件绝对路径(无数据行时用它反馈) */
    downloads?: string[];
    /** 后处理器执行结果(由主进程在 runner 之后填充,如合并 zip 内 excel 的产物) */
    postProcessed?: PostProcessResult[];
    /** 回放时记录的每步真实所在页面 URL(与 steps 同序,取不到为 null);供旧宏回填 recordedUrl 精确分组 */
    stepUrls?: (string | null)[];
    /** 用户中途点「停止回放」主动中止(非失败):UI 据此提示"已停止"而非报错截图 */
    cancelled?: boolean;
    error?: RunError;
}

/**
 * 录制端请求改写规则:命中 urlPattern 的 POST 请求,按 set/remove 改写其 body 顶层字段。
 * 存于 request-rules.json(项目根/打包 userData);仅作用于录制阶段的 Electron webview。
 */
export interface RequestRule {
    /** URL 匹配模式(CDP glob,`*` 通配),如 `* /api/search*`(勿含空格,示例避开注释闭合) */
    urlPattern: string;
    /** body 类型;省略则按请求 Content-Type 嗅探(json / form) */
    bodyType?: 'json' | 'form';
    /** 设置/覆盖的 body 顶层字段(json 保留原始类型,form 转字符串) */
    set?: Record<string, unknown>;
    /** 往 body 顶层字段追加(json:确保为数组后 push,值为数组则逐元素,已存在的值去重;form:追加为重复参数、同值去重) */
    append?: Record<string, unknown>;
    /** 删除的 body 顶层字段名 */
    remove?: string[];
}

/**
 * 「只记录不修改」支路配置(存于 request-rules.json 的 record 段)。
 * 独立于 RequestRulesConfig.enabled——即便改写关闭,只要 record.enabled 就记录。
 * 记录所有请求(不限 method)+ 响应到 timelines/ 下的 JSONL 时间线文件,供事后分析。
 */
export interface TimelineRecordConfig {
    /** 独立开关:true 即开启记录,与改写总开关无关 */
    enabled: boolean;
    /** 只记录命中该 CDP glob 的 URL;缺省/`*` → 记录所有请求 */
    urlPattern?: string;
    /** 是否记录完整请求 body(缺省视为 true;禁止截断) */
    includeBody?: boolean;
}

/** 录制端请求改写配置(存于 request-rules.json;默认 enabled=false 不干预) */
export interface RequestRulesConfig {
    /** 总开关:false 时完全不拦截(改写) */
    enabled: boolean;
    /** 规则列表(按序尝试匹配,命中即改写) */
    rules: RequestRule[];
    /** 只记录不修改支路(独立开关);缺省视为不记录 */
    record?: TimelineRecordConfig;
}

/** 浏览器会话/登录态复用配置(存于项目根 browser-config.json) */
export interface BrowserConfig {
    /** 启用持久化回放 profile(Playwright launchPersistentContext) */
    persistProfile: boolean;
    /** profile 目录(默认 <projectRoot>/browser-profile) */
    userDataDir: string;
    /** 回放前注入录制 webview(默认 session)的 cookies */
    injectRecordingSession: boolean;
    /** 回放前注入录制 webview 当前页面 origin 的 localStorage(仅当前页 origin) */
    injectRecordingLocalStorage: boolean;
    /** 优先使用本机真 Chrome/Edge 内核回放(反检测);找不到时回退捆绑 Chromium */
    useSystemChrome: boolean;
}

/** Playwright addCookies 入参形状(由主进程从 Electron cookie 转换得到) */
export interface BrowserCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    /** unix 秒,-1 表示会话 cookie */
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

/** 回放时注入的会话选项(由主进程组装,core 层不依赖 Electron) */
export interface SessionOptions {
    /** 有值 → 用持久化 context(launchPersistentContext) */
    userDataDir?: string;
    /** 有值 → context 建好后 addCookies */
    cookies?: BrowserCookie[];
    /** 有值 → 导航前 addInitScript 按 origin 注入 localStorage;键为 origin,值为该 origin 的 {key:value} 表 */
    localStorage?: Record<string, Record<string, string>>;
    /** 真 → 优先用本机 Chrome/Edge 内核(反检测),失败回退捆绑 Chromium */
    preferSystemChrome?: boolean;
    /** 有值且 enabled → 回放时按规则拦截改写命中的 POST body(与录制端共用同一份规则/函数) */
    requestRules?: RequestRulesConfig;
}

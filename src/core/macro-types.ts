// 宏 DSL 的 TypeScript 类型定义。
// 所有宏均以 JSON 形式保存,不保存 JS 代码。

/** 步骤类型 */
export type StepType =
    | 'goto'
    | 'click'
    | 'fill'
    | 'press'
    | 'scroll'
    | 'waitForSelector'
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

/** 等待元素出现 */
export interface WaitForSelectorStep {
    type: 'waitForSelector';
    selector: string;
    timeout?: number;
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
}

/** 步骤可辨识联合(交叉 StepFlags 以携带翻页标记,仍保持 type 可辨识) */
export type Step = StepFlags & (
    | GotoStep
    | ClickStep
    | FillStep
    | PressStep
    | ScrollStep
    | WaitForSelectorStep
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

/** 宏定义 */
export interface Macro {
    name: string;
    version: number;
    steps: Step[];
    extract?: ExtractConfig;
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
    error?: RunError;
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
}

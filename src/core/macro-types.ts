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
    /**
     * 为 true 表示「独立工具」:不随宏勾选、只能选文件直接运行(如银行整合/对账),
     * 前端渲染到独立工具板块且不带复选框;缺省 false = 随宏勾选、回放后自动执行的后处理器。
     */
    standalone?: boolean;
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
 * 「重发型」拦截规则的**响应条件触发器**。设了 ResendRule.responseTrigger 时,该规则改由**响应观察器**驱动
 * (而非请求侧 urlPattern 命中即触发):
 *   ① 回放期间**捕获**命中顶层 urlPattern 的请求(记下 url/method/头/体,存最近一次);
 *   ② 当命中 `triggerUrl` 的**响应**满足 status / headers / bodyJson 三组条件**全部满足(AND)**时,
 *      把①捕获到的请求原样(可叠加 set/replaceWithFile/setHeaders 修饰)重发。
 * 即「监听 triggerUrl 的响应 → 重发 urlPattern 捕获的请求」。仅回放端生效
 * (Playwright 在网络层读响应体,不受页面 CORS 限制)。status/headers/bodyJson 均可选、都不给则该响应恒满足条件。
 */
export interface ResendResponseTrigger {
    /** **必填**:监听哪个响应作为触发闸门(CDP glob 匹配响应 URL);缺失则整条规则被丢弃 */
    triggerUrl: string;
    /** 可选:响应状态码需**等于**此值(如 200) */
    status?: number;
    /** 可选:响应头条件,这些头需**全部相等**才命中(AND,头名大小写不敏感,值精确相等) */
    headers?: Record<string, string>;
    /**
     * 可选:响应体 JSON 条件,**点路径 → 期望值**(如 `{"data.state":"done"}`),全部满足才命中(AND)。
     * 响应体先 JSON.parse,按点路径(`a.b.c`)逐层取值,`String()` 后与期望值精确等值比较(值大小写敏感)。
     * 解析失败 / 路径不存在 / 响应体读不到 → 该条件**不命中**。
     */
    bodyJson?: Record<string, string>;
}

/**
 * 「重发型」拦截规则:命中 urlPattern 的 POST 请求作为**触发器**,延时后取原 body 改参、
 * 主动重新发起一个新请求(**不改原请求**,原请求照常放行)。与改写规则 rules[] 物理分开存
 * resends[],避免 matchRule「首个命中即返回」让改写/重发互抢首命中。受 RequestRulesConfig.enabled
 * 总开关统管(enabled=true 且有 resends 才生效)。重发请求带标记头 x-macro-resend 防递归自触发。
 */
export interface ResendRule {
    /**
     * 触发观察的 URL 匹配模式(CDP glob,`*` 通配);唯一必填。
     * - 不带 responseTrigger(请求触发):命中该 URL 的 POST 请求即改参重发它自己;
     * - 带 responseTrigger(响应触发):这是**要捕获并重发的请求**(见 ResendResponseTrigger)。
     */
    urlPattern: string;
    /** 命中后首次重发延时(毫秒),"间隔 n 秒"= n*1000;缺省 0=立即 */
    delayMs?: number;
    /** 重发使用的 method;缺省 'POST'。**仅请求触发生效;响应触发用捕获请求的原方法、忽略此字段** */
    method?: 'POST' | 'GET';
    /** body 类型;省略则按触发请求 Content-Type 嗅探(语义同 RequestRule) */
    bodyType?: 'json' | 'form';
    /** 对重发副本改哪些参数(以下三者复用 rewritePostBody;都不填=原样重发) */
    set?: Record<string, unknown>;
    append?: Record<string, unknown>;
    remove?: string[];
    /**
     * 可选,本地文件**绝对路径**。设了它则**整体**用该文件完整字节作重发 body,
     * 忽略 set/append/remove/bodyType(二进制文件无法做字段级改写);
     * content-type 保留触发请求原值(不强制 json/form)。读文件失败则**跳过本次重发**(不抛)。
     * 仅回放端生效。典型用途:命中上传型触发后,用本地另一个 mp4 的字节作为重发体。
     */
    replaceWithFile?: string;
    /** 一次触发重发几次;缺省 1,归一化时 clamp 到 [1,100] */
    repeat?: number;
    /** repeat>1 时相邻两次重发的间隔(毫秒);缺省 0 */
    intervalMs?: number;
    /** 同规则去抖窗口(毫秒);缺省 0=每次命中都重发。设 N 则 N 毫秒内同规则只发一次 */
    dedupeMs?: number;
    /**
     * 可选,设置/覆盖重发请求头(如换 token、改 X-Requested-With);同名头大小写不敏感覆盖,
     * 不产生大小写不同的重复键。防递归标记头 x-macro-resend 不可被覆盖(始终强制为 1)。
     */
    setHeaders?: Record<string, string>;
    /**
     * 可选,删除重发请求头名数组(大小写不敏感;可删继承自触发请求的头)。
     * 防递归标记头 x-macro-resend 不可被删除(始终强制补回)。
     */
    removeHeaders?: string[];
    /**
     * 可选,**响应条件触发器**。设了它 → 本规则改由「响应观察器」触发:捕获命中 urlPattern 的请求,
     * 当 responseTrigger.triggerUrl 的响应满足条件(AND)时重发捕获的请求;不设 = 保持原「请求侧
     * urlPattern 命中即触发」。仍复用上面的动作字段(set/replaceWithFile/setHeaders/delayMs/repeat…)。
     * 仅回放端生效。triggerUrl 必填,缺失则整条规则被归一化丢弃。
     */
    responseTrigger?: ResendResponseTrigger;
}

/**
 * 「响应头条件改写」规则:命中 urlPattern 的响应,当其响应头满足 when 条件时,
 * 按 setHeaders / removeHeaders 改写响应头。与改写 rules[]、重发 resends[] 物理分开存
 * responseRules[](matchRule「首个命中即返回」,混数组会互抢首命中)。受 RequestRulesConfig.enabled
 * 总开关统管(enabled=true 且有 responseRules 才生效)。
 * 与请求侧改写机制不同:必须在**响应返回后**介入——录制端走 CDP Fetch 响应阶段(continueResponse)、
 * 回放端走 Playwright route.fetch()+route.fulfill()。
 */
export interface ResponseHeaderRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 条件:这些响应头需**全部相等**才改(AND,头名大小写不敏感);缺省=无条件总是改 */
    when?: Record<string, string>;
    /** 设置/覆盖的响应头(如 cc=1);同名头大小写不敏感覆盖,不产生重复键 */
    setHeaders?: Record<string, string>;
    /** 删除的响应头名(大小写不敏感) */
    removeHeaders?: string[];
}

/**
 * 「真拦截(硬阻断)」规则:命中 urlPattern(可选限定 method)的请求**直接阻断、不让其发出**——
 * 回放端 Playwright route.abort()(页面的 fetch/XHR 收到网络错误)。与 rules[]/resends[]/responseRules[]
 * 物理分开存 blocks[](matchRule「首个命中即返回」,混数组会互抢首命中)。受 RequestRulesConfig.enabled
 * 总开关统管(enabled=true 且有 blocks 才生效)。这是本模块唯一「不放行」的分支。
 */
export interface BlockRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 可选,仅拦截指定 HTTP 方法(大小写不敏感,如 POST/GET);缺省=拦截所有方法 */
    method?: string;
}

/**
 * 「请求体落盘(dump)」规则:命中 urlPattern(可选限定 method)的请求,把其**完整**请求体
 * (从第一字节到最后一字节)按原始二进制(postDataBuffer)写成一个文件(缺省 .mp4)。用于抓取
 * 上传型接口的字节体(如把视频上传请求体落盘成 mp4)。与 rules/resends/responseRules/blocks 物理
 * 分开存 dumps[](matchRule「首个命中即返回」,混数组会互抢首命中)。受 RequestRulesConfig.enabled
 * 总开关统管(enabled=true 且有 dumps 才生效);被动观察、不改写请求。**仅回放端生效**。
 */
export interface DumpRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 可选,仅落盘指定 HTTP 方法(大小写不敏感,如 PUT/POST);缺省=落盘所有方法(上传常是 PUT/POST) */
    method?: string;
    /** 输出文件后缀(可含或不含前导点,如 'mp4' 或 '.bin');缺省 'mp4' */
    extension?: string;
}

/**
 * 「请求体整体替换(拦截替换)」规则:命中 urlPattern(可选限定 method)的请求,在拦截点把其**整个**
 * 请求体替换成一个本地文件的完整字节,再放行发出。与 dump 是一对(dump 读、这个写)。因要能替换
 * File/Blob 上传体,走 CDP Fetch `continueRequest({postData})` 整体替换(Content-Length 网络栈重算)。
 * 与 rules/resends/responseRules/blocks/dumps 物理分开存 bodyReplaces[](matchRule 首命中即返回)。
 * 受 RequestRulesConfig.enabled 总开关统管。**仅回放端生效**。
 */
export interface BodyReplaceRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 可选,仅替换指定 HTTP 方法(大小写不敏感,如 PUT/POST);缺省=替换命中 URL 的所有方法 */
    method?: string;
    /** 本地文件绝对路径;命中即用其完整字节整体替换请求体(缺省/读失败则原样放行不替换) */
    replaceWithFile: string;
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
    /** 重发规则列表(命中后延时改参重发一个新请求;受 enabled 总开关管);缺省视为无重发 */
    resends?: ResendRule[];
    /** 响应头条件改写规则列表(命中且满足 when 条件则改响应头;受 enabled 总开关管);缺省视为无 */
    responseRules?: ResponseHeaderRule[];
    /** 真拦截(硬阻断)规则列表(命中即 route.abort 阻断、不发出;受 enabled 总开关管);缺省视为无 */
    blocks?: BlockRule[];
    /** 请求体落盘规则列表(命中即把完整二进制请求体写成文件;受 enabled 总开关管;仅回放端);缺省视为无 */
    dumps?: DumpRule[];
    /** 请求体整体替换规则列表(命中即用本地文件字节整体替换请求体;受 enabled 总开关管;仅回放端);缺省视为无 */
    bodyReplaces?: BodyReplaceRule[];
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

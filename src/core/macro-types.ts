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
    /** 总页数 N(共采集 N 页 → 翻页序列执行 N-1 次);**0 = 不限页数,一直翻到翻不动为止**;仅 pagination=true 时有效 */
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

/**
 * 被挂起请求的信息:命中 `blocks` 中 `mode:'hold'` 规则的请求被回放引擎挂起时,传给 onHold 回调
 * 供 UI 展示。holdId 由主进程赋(回放引擎不感知,只透传回调返回的决定)。
 */
export interface HoldInfo {
    /** 被拦截请求的完整 URL */
    url: string;
    /** HTTP 方法(大写,如 GET/POST) */
    method: string;
    /** 资源类型(Playwright request.resourceType(),如 xhr/fetch/document);仅供展示 */
    resourceType?: string;
    /** 是否为本工具自己发出的「重发请求」(带 x-macro-resend 标记头);true=重发、false/缺省=真实请求。供 UI 区分展示 */
    isResend?: boolean;
}

/** 人工对被挂起请求的处置:continue=放行(route.continue)、abort=丢弃(route.abort) */
export type HoldDecision = 'continue' | 'abort';

/**
 * 挂起放行回调:回放引擎命中 `mode:'hold'` 的 block 规则时调用,await 其 promise 把请求悬在半空,
 * resolve 的值即人工在 UI 上做出的处置(continue/abort)。无回调(无头/单测)时引擎默认立即 continue,
 * 避免永久挂死回放。与 [[OnPause]] 同构(都是「await promise 直到 UI 信号」)。
 */
export type OnHold = (info: HoldInfo) => Promise<HoldDecision>;

/** 字段提取类型 */
export type FieldType = 'text' | 'html' | 'attr' | 'href' | 'src';

/**
 * 字段清洗动作(声明式,按序施加,每步 string→string)。以 op 判别:
 * - trim               去首尾空白
 * - collapseWhitespace 连续空白折叠为单空格并去首尾
 * - replace            正则替换(pattern 非法则跳过该步,不影响后续)
 * - stripThousands     剥离数字千分位逗号(1,234 → 1234)
 * - number             规整为数字文本(decimals 指定小数位;非数字保持原值,不猜)
 * - date               解析日期并按 to 模板格式化(YYYY/MM/DD/HH/mm/ss;非法日期保持原值)
 */
export type TransformOp =
    | { op: 'trim' }
    | { op: 'collapseWhitespace' }
    | { op: 'replace'; pattern: string; flags?: string; to?: string }
    | { op: 'stripThousands' }
    | { op: 'number'; decimals?: number }
    | { op: 'date'; from?: string; to: string };

/** 提取字段定义 */
export interface ExtractField {
    name: string;
    /** 字段选择器;列表模式下留空则取列表项本身 */
    selector: string;
    type: FieldType;
    /** 当 type 为 attr 时,指定要提取的属性名 */
    attr?: string;
    /** 导出列名(缺省 = name) */
    label?: string;
    /** 导出列排序键(升序;缺省 = 字段定义顺序) */
    order?: number;
    /** 隐藏列:仍提取但导出时不出列 */
    hidden?: boolean;
    /** 清洗后仍为空时的填充值(缺省沿用 '') */
    default?: string;
    /** 声明式清洗链,按序施加;缺省时 text 类型仍隐含一步 trim(兼容旧行为) */
    transform?: TransformOp[];
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
    /**
     * 可选:详情页内的「子列表项」选择器,用于**一个列表项对应详情页多条明细**的 1:N 场景
     * (如一个订单的详情页里有一张几百行的 Pin 码表)。
     * - **不设(缺省)**:现状语义——一个列表项产出**一行**,detailFields 在详情页**整页**求值。
     * - **设了**:详情页按该选择器逐项产出**一行**,detailFields 相对**子项**求值,
     *   列表页字段(fields)在这些行里原样重复;子项 0 命中时仍保一行(详情字段填默认),不丢单。
     * 旧宏无此字段,行为不变。
     */
    detailListSelector?: string;
}

/**
 * list-action 单个动作:一次点击。
 * scope 缺省 'item'(相对当前列表项查找);'page' 为全局页面查找,
 * 用于「逻辑属于该项、但按钮选择器挂在页面别处」的场景。
 */
export interface ListAction {
    selector: string;
    scope?: 'item' | 'page';
    /**
     * 动作级前置筛选(gate,可选):执行本动作前对「实时页面 DOM」求值(结构同行级 filter)。
     * 因在动作序列中途求值,前序动作弹出的弹窗此刻已在 DOM 中,用 scope:'page' 的变量即可读弹窗内的值。
     * 不满足时按 onFilterFail 处置。行级 filter 与动作级 filter 可并存(先粗筛行、再精筛动作)。
     */
    filter?: ListActionFilter;
    /** gate 不满足时的处置:'abort'(缺省)跳出本行剩余动作;'skip' 仅跳过本动作、继续后续 */
    onFilterFail?: 'skip' | 'abort';
    /** 求值/点击前先等此选择器可见(可选);用于等前序动作弹出的弹窗内容异步渲染完成再判定 */
    waitFor?: string;
    /**
     * 标记为「收尾动作」(可选,非必配):被标记的动作从正常序列抽出,在本行动作序列结束后
     * 总会执行一次(无论正常跑完 / abort 中止 / 某动作报错),且忽略自身 gate。专用于关闭弹窗,
     * 避免残留弹窗遮挡下一行点击。对标录制板块「标记翻页操作」——在已有动作上打标,不新增特殊步骤。
     */
    finally?: boolean;
}

/**
 * list-action 行筛选变量:从行内/整页选择器取一个命名值,供筛选表达式引用。
 * 内置变量 text(本行 innerText)/html(本行 innerHTML)已自动注入,无需在此声明。
 */
export interface ListActionFilterVar {
    /** 表达式里引用的变量名 */
    name: string;
    /** 取值选择器;留空取列表项本身 */
    selector: string;
    /** 相对列表项(item,缺省)还是整页(page)查找,与 ListAction.scope 同义 */
    scope?: 'item' | 'page';
    /** 取值方式:text(缺省)/html/attr/href/src;exists=元素 count()>0 布尔(与取值互斥) */
    source?: FieldType | 'exists';
    /** source=attr 时的属性名 */
    attr?: string;
}

/**
 * list-action 行级筛选:仅匹配条件的行才执行动作,不匹配的行整行跳过。
 * 表达式为 when 引擎语法(同 responseTrigger.when):可用内置变量 text/html + vars 声明的变量,
 * 内置函数 contains(a,b)/match(str,pattern[,flags])。注意:变量取值恒为字符串,
 * 数值比较用 ==/</>(自动数值化),勿用 ===(严格比较跨类型恒 false)。
 * 失败即安全:表达式 parse/eval 失败 → 该条件记 false(all 下跳过该行,any 下不贡献)。
 */
export interface ListActionFilter {
    /** 多条件组合:all=全部满足(AND,缺省) / any=任一满足(OR) */
    match?: 'all' | 'any';
    /** 命名变量(可选);内置 text/html 已自动注入 */
    vars?: ListActionFilterVar[];
    /** 布尔表达式条件,多条按 match 组合;去空白后全空 → 不筛选 */
    conditions?: string[];
}

/** 列表逐项动作:遍历列表项,逐项按序执行动作(常用于每点一次触发一次文件下载) */
export interface ListActionExtractConfig {
    mode: 'list-action';
    /** 列表项容器选择器 */
    listSelector: string;
    /**
     * 每项要依次执行的动作序列(向后兼容多种写法):
     *  - string ''                 → 无动作,点列表项本身(保留旧语义)
     *  - string 'sel'              → 单个项内动作(等价 [{ selector:'sel', scope:'item' }])
     *  - Array<string | ListAction> → 逐个执行,字符串项视为 scope:'item'
     */
    actionSelector: string | Array<string | ListAction>;
    /** 每次点击后等待下载开始的超时(毫秒);省略沿用全局默认 */
    actionTimeout?: number;
    /** 行级筛选(可选):仅匹配条件的行执行动作;旧宏无此字段=不筛选,行为不变 */
    filter?: ListActionFilter;
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
    /** 示例文件名列表(供 UI 渲染成可点复制的示例 chip,方便用户照着命名输入文件);缺省则不展示 */
    examples?: string[];
    /**
     * 是否支持「直接运行」(不跑宏、弹文件多选后直接处理)。缺省 true = 渲染该按钮(现状)。
     * 设 false 用于**输入来自回放本身、而非人工选文件**的后处理器(如 export-rows-excel 吃的是
     * 回放提取的数据行):`run-plugin` 通道不跑宏、ctx 无 rows,点了只会弹一个无意义的文件框再报
     * 「已跳过」。此时面板不渲染该按钮,只保留复选框。standalone 独立工具勿设 false——那按钮是其唯一入口。
     */
    directRun?: boolean;
    /**
     * 该插件可配的选项字段:驱动「附加处理」面板在其复选框下渲染一行文本输入,
     * 填的值存进该宏 `PostProcessSpec.options[key]` 随宏保存,回放时由 handler 自取。
     * 缺省 = 该插件无可配项(现状,面板只有复选框)。
     */
    optionFields?: PostProcessorOptionField[];
}

/** 插件可配选项的单个字段描述(纯文本输入,值恒为字符串) */
export interface PostProcessorOptionField {
    /** 存进 PostProcessSpec.options 的键名 */
    key: string;
    /** 输入框前的标签 */
    label: string;
    /** 输入框 placeholder(常用于给出模板示例) */
    placeholder?: string;
    /** 输入框下的一句话说明 */
    hint?: string;
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

/** 导出列规格:由 ExtractField 的 label/order/hidden/transform 推导,驱动 Excel 列名/排序/隐藏/格式 */
export interface ColumnSpec {
    /** 行对象的 key(= 字段 name) */
    key: string;
    /** 表头显示名 */
    label: string;
    /** 排序键(升序) */
    order: number;
    /** 是否隐藏该列 */
    hidden: boolean;
    /** Excel 数字/日期格式串(如 '0.00' / 'yyyy-mm-dd');缺省按文本 */
    numFmt?: string;
    /** 导出单元格类型:number/date 时写真类型便于 Excel 计算;缺省 text */
    kind?: 'text' | 'number' | 'date';
}

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
 * 单次运行的选项(由渲染层随「运行宏」传入;缺省 = 现状行为)。
 * 与宏 JSON 里的配置区分开:这里放的是**每次运行的意图**,不随宏文件走。
 */
export interface RunMacroOptions {
    /**
     * 宏文件绝对路径。仅用于给补抓快照定唯一键(宏名会重复,不同目录的同名宏不能共用快照)。
     * 未保存过的宏为空,此时退化为按宏名定位。
     */
    macroPath?: string;
    /**
     * 本次是否复用补抓快照、跳过上次已抓成功的详情项(list-detail 专用)。
     * 缺省 false = 全量抓取(但仍会落快照,供下次补抓用)。
     */
    resume?: boolean;
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
 * 「重发型」响应触发的**变量提取源**:从触发响应里取一个值,命名后供动作字段用 `{{name}}` 占位注入重发。
 * fromBody 与 fromHeader **二选一**(都给时 fromBody 优先);两者都取不到 → 用 default(缺省空串)。
 * 仅回放端生效。
 */
export interface ResendVarSource {
    /** 从触发响应体 JSON 按点路径(`a.b.c`)取值,复用 getJsonByPath;命中值为对象/数组则 JSON.stringify,否则 String() */
    fromBody?: string;
    /** 从触发响应头按名取值(大小写不敏感) */
    fromHeader?: string;
    /** 取不到时的兜底默认值;缺省空串 */
    default?: string;
}

/**
 * 「被动变量捕获」规则(仅回放端):命中 urlPattern 的响应(+可选 when 门槛),用 extract 从**该条响应**
 * 的头/体提取命名变量,merge 进回放期变量池,供 resends 的 `{{占位符}}`(set/append/setHeaders/setUrl)注入。
 * **不触发重发、不改写响应**,只「喂」变量池。用于解决「触发闸门」与「变量提取源」是**不同响应**的场景——
 * 如:A 的 feedback 响应作触发闸门(晚),但要注入的 scottyResourceId 在更早的 B `upload/studio` start 响应头里。
 * 变量池按变量名后到覆盖、runId 生命周期(每次回放开始清空)。仅回放端生效。
 */
export interface CaptureRule {
    /** **必填**:观察哪些响应(CDP glob,`*` 通配);缺失则整条规则被归一化丢弃 */
    urlPattern: string;
    /**
     * 可选:**JS 风格布尔表达式**门槛,满足才捕获;空 / 不给 = 无条件捕获。语义/上下文同 responseTrigger.when
     * (status/hop/body/text + header/reqHeader/match/contains);解析失败 / 求值异常 → 不捕获(失败即安全)。
     * 用请求头区分同一 URL 的多次响应时很有用(如 `reqHeader('x-macro') == '1'` 只抓带标记的那条)。
     */
    when?: string;
    /**
     * **必填**:变量名 → 取值源(复用 ResendVarSource 的 fromBody/fromHeader/default)。
     * 归一化后为空则整条规则被丢弃(无提取源的捕获规则无意义)。
     */
    extract: Record<string, ResendVarSource>;
}

/**
 * 「重发型」拦截规则的**响应条件触发器**。设了 ResendRule.responseTrigger 时,该规则改由**响应观察器**驱动
 * (而非请求侧 urlPattern 命中即触发):
 *   ① 回放期间**捕获**命中顶层 urlPattern 的请求(记下 url/method/头/体,存最近一次);
 *   ② 当命中 `triggerUrl` 的**响应**满足 status / headers / requestHeaders / bodyJson / bodyContains 各组条件
 *      **全部满足(AND)**时,把①捕获到的请求原样(可叠加 set/replaceWithFile/setHeaders 修饰)重发。
 *      其中 requestHeaders 判的是 triggerUrl 那条**请求**的头(其余判响应侧)。
 * 即「监听 triggerUrl 的响应 → 重发 urlPattern 捕获的请求」。仅回放端生效
 * (Playwright 在网络层读响应体,不受页面 CORS 限制)。各组条件均可选、都不给则该响应恒满足条件。
 */
export interface ResendResponseTrigger {
    /** **必填**:监听哪个响应作为触发闸门(CDP glob 匹配响应 URL);缺失则整条规则被丢弃 */
    triggerUrl: string;
    /** 可选:响应状态码需**等于**此值(如 200) */
    status?: number;
    /** 可选:响应头条件,这些头需**全部相等**才命中(AND,头名大小写不敏感,值精确相等) */
    headers?: Record<string, string>;
    /**
     * 可选:**请求头条件**——triggerUrl 那条请求(即被监听的触发闸门事务本身)的请求头需**全部相等**才命中
     * (AND,头名大小写不敏感,值精确相等)。与 headers(响应头)对称,同判一个 triggerUrl 事务的请求侧/响应侧。
     * 缺省=不校验请求头。请求头同步可得,不触发异步读响应体。
     */
    requestHeaders?: Record<string, string>;
    /**
     * 可选:响应体 JSON 条件,**点路径 → 期望值**(如 `{"data.state":"done"}`),全部满足才命中(AND)。
     * 响应体先 JSON.parse,按点路径(`a.b.c`)逐层取值,`String()` 后与期望值精确等值比较(值大小写敏感)。
     * 解析失败 / 路径不存在 / 响应体读不到 → 该条件**不命中**。
     */
    bodyJson?: Record<string, string>;
    /**
     * 可选:响应体**原文子串**条件,这些子串需**全部出现**在响应体文本里才命中(AND,大小写敏感)。
     * 不解析 JSON、不依赖路径,适配深层嵌套 / 异构数组结构(点路径难写易碎的场景)。
     * 如 `["\"fractionCompleted\":1"]` 或 `["已上传 100%"]`。响应体读不到 → 不命中。
     */
    bodyContains?: string[];
    /**
     * 可选:从触发响应提取命名变量(变量名 → 取值源),供本规则的动作字段 set / append / setHeaders / setUrl 用
     * `{{name}}` 占位引用注入重发(如把响应体里的新 token 写进重发请求头 Authorization、或把新 id 拼进重发 URL)。
     * 取值在触发命中后、复用已读到的响应体/响应头进行;取不到用各源的 default(缺省空串)。仅回放端生效。
     */
    extract?: Record<string, ResendVarSource>;
    /**
     * 可选:**JS 风格布尔表达式**,与上面各静态条件 **AND**(它们都通过后再判 when);空 / 不给 = 无条件。
     * 用于表达静态字段做不到的判断——不等 / 正则 / OR / 跳数(hop)。**核心用例**:`when: "hop == 0"`
     * 只在真实浏览器响应触发,任何工具自身重发引发的响应(hop≥1)一律不触发 → 连环从源头切断,不再依赖 maxResendHops 兜底。
     * 上下文变量:`status`(数字)、`hop`(触发响应对应请求的重发跳数,真实=0/重发=1,2,…)、
     * `body`(响应体 JSON.parse 后对象,失败=undefined)、`text`(响应体原文);内置函数:`header('名')`、
     * `reqHeader('名')`(大小写不敏感,缺失='')、`match(str,正则,flags?)`、`contains(a,b)`。
     * 相等:`==`/`!=` 松散(严格或 String() 相等,对齐 bodyJson)、`===`/`!==` 严格、`> < >= <=` 数值比较。
     * 判缺失用 `!body.x`(无 undefined 字面量)。受限求值器,禁原型逃逸 / 全局访问;
     * 解析失败 / 求值异常一律判**不命中**(失败即安全)。仅回放端生效。
     */
    when?: string;
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
    /**
     * 可选,重发目标 URL 模板。设了它则用该模板作重发目标 URL(整体覆盖捕获/触发请求的原 URL);
     * 值里可写 `{{name}}` 占位引用 responseTrigger.extract 提取的变量(与 setHeaders 同款渲染)。
     * 渲染后 trim,渲染为空/纯空白则回退原 URL。无 extract 变量时=静态 URL 覆盖(重发到另一端点)。
     * 仅回放端生效。响应触发下 method 仍用捕获请求原方法(本字段只改 URL,不改方法/体)。
     */
    setUrl?: string;
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
     * urlPattern 命中即触发」。仍复用上面的动作字段(set/replaceWithFile/setHeaders/setUrl/delayMs/repeat…)。
     * 仅回放端生效。triggerUrl 必填,缺失则整条规则被归一化丢弃。
     */
    responseTrigger?: ResendResponseTrigger;
}

/**
 * 「响应条件改写」规则:命中 urlPattern 的响应,当其响应头满足 when 条件时,按下述动作改写响应
 * (响应头 / 状态码 / 响应体),或直接 mock 一个假响应。与改写 rules[]、重发 resends[] 物理分开存
 * responseRules[](matchRule「首个命中即返回」,混数组会互抢首命中)。受 RequestRulesConfig.enabled
 * 总开关统管(enabled=true 且有 responseRules 才生效)。
 * 与请求侧改写机制不同:必须在**响应返回后**介入——录制端走 CDP Fetch 响应阶段(continueResponse)、
 * 回放端走 Playwright route.fetch()+route.fulfill()。
 *
 * 动作分两类,同一条规则可组合(mock 除外):
 * - **改真实响应**(缺省):先 route.fetch 拿到真实响应,再按 setHeaders/removeHeaders/setStatus/setBody
 *   /bodyReplaceFile 覆盖后 fulfill。改响应体/状态码同样受 when 门槛(与改头一致);覆盖响应体时自动
 *   剥离 content-length,交回放引擎按新体重算,避免「声明长度≠实际体」。
 * - **mock 假响应**(mock:true):**不发真实请求**,直接用 setStatus(缺省 200)+ setBody/bodyReplaceFile
 *   (缺省空体)+ setHeaders 构造一个响应返回。此时 when / removeHeaders 忽略(没有真实响应可判/可删)。
 */
export interface ResponseHeaderRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 条件:这些响应头需**全部相等**才改(AND,头名大小写不敏感);缺省=无条件总是改。mock:true 时忽略 */
    when?: Record<string, string>;
    /** 设置/覆盖的响应头(如 cc=1);同名头大小写不敏感覆盖,不产生重复键 */
    setHeaders?: Record<string, string>;
    /** 删除的响应头名(大小写不敏感);mock:true 时忽略(无真实响应头可删) */
    removeHeaders?: string[];
    /**
     * 可选:覆盖响应**状态码**(如 200 / 403 / 500)。归一化后取整、clamp 到 [100,599];非法则忽略。
     * 改真实响应时:when 满足才覆盖。mock 时:缺省 200。仅回放端生效。
     */
    setStatus?: number;
    /**
     * 可选:**整体替换响应体**为此字符串(如注入一段 JSON)。空串 = 空响应体(合法)。
     * 与 bodyReplaceFile 二选一,同时给时 setBody 优先。改真实响应时受 when 门槛。仅回放端生效。
     * 注:P0-1 只支持整体替换;深层字段级改响应体(点路径)由后续 setPath 机制统一提供。
     */
    setBody?: string;
    /**
     * 可选,本地文件**绝对路径**:用该文件完整字节整体替换响应体(二进制安全,如换一张图/一个 json)。
     * 与 setBody 二选一(setBody 优先)。读文件失败 → **跳过响应体替换、用原响应体**(失败即安全)。仅回放端生效。
     */
    bodyReplaceFile?: string;
    /**
     * 可选:true = **mock 模式**,命中即**不发真实请求**,直接用 setStatus/setBody/bodyReplaceFile/setHeaders
     * 构造并返回一个假响应(典型:桩接口、断网仿真、强制某状态)。缺省 false=改真实响应。仅回放端生效。
     */
    mock?: boolean;
}

/**
 * 「请求头条件改写」规则:命中 urlPattern 的请求,当其**原始请求头**满足 when 条件时,
 * 在请求发出前按 setHeaders / removeHeaders 改写请求头。对称于 responseRules[],但介入点在
 * 请求侧(回放端 route.continue({headers}) / route.fetch({headers}))。
 * 与 rules[](改请求 body)、resends[].setHeaders(改**重发副本**的头)语义不同:本支路改的是
 * **原始在途请求本身**的头。与其它支路物理分开存 requestHeaderRules[](matchRule 首命中即返回)。
 * 受 RequestRulesConfig.enabled 总开关统管。**仅回放端生效**。
 * 注:cookie / host 由浏览器管理,route.continue 无法覆盖,对其 set/remove 无效(改 cookie 用 addCookies)。
 */
export interface RequestHeaderRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 条件:这些**请求头**需**全部相等**才改(AND,头名大小写不敏感);缺省=无条件总是改 */
    when?: Record<string, string>;
    /** 设置/覆盖的请求头(如 Authorization);同名头大小写不敏感覆盖,不产生重复键 */
    setHeaders?: Record<string, string>;
    /** 删除的请求头名(大小写不敏感;cookie/host 无法删,由浏览器管理) */
    removeHeaders?: string[];
}

/**
 * 「真拦截」规则:命中触发条件的请求被拦在发送阶段,按 mode 处置——
 * - `abort`(缺省):**硬阻断、不让其发出**,回放端 Playwright route.abort()(页面 fetch/XHR 收到网络错误);
 * - `hold`:**挂起等待人工放行**,回放端在 route handler 里 await 一个受控 promise 把请求悬在半空(pending,
 *   不发也不失败),同时把它登记到「被拦截请求列表」推给 UI,人工逐条选「继续(route.continue)」或
 *   「阻断(route.abort)」后才终结。仅回放端支持 hold(录制端 CDP 不涉及)。
 *
 * 触发条件不止 urlPattern:urlPattern / method / requestHeaders / query / bodyJson / bodyContains / when
 * **各组均可选、缺省=不校验、全组 AND**——沿用 resends.responseTrigger 同款词汇但**判的是请求自身**
 * (请求头 / query 参数 / 请求体)。旧配置(仅 urlPattern)完全向后兼容。命中判定见 request-rewrite 的
 * `matchBlockRule`(遍历取**首个全条件命中**者,不会被仅 URL 命中却条件不符的前序规则遮蔽)。
 *
 * 与 rules[]/resends[]/responseRules[] 物理分开存 blocks[]。受 RequestRulesConfig.enabled 总开关统管
 * (enabled=true 且有 blocks 才生效)。**仅回放端生效**(请求头 / 请求体在回放端 route handler 同步可得)。
 */
export interface BlockRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 可选,仅拦截指定 HTTP 方法(大小写不敏感,如 POST/GET);缺省=拦截所有方法 */
    method?: string;
    /** 可选:**请求头条件**——这些头需全部相等才命中(AND,头名大小写不敏感,值精确相等);缺省=不校验 */
    requestHeaders?: Record<string, string>;
    /** 可选:**URL query 参数条件**——这些参数需全部相等才命中(AND,参数名大小写敏感,值精确相等);缺省=不校验 */
    query?: Record<string, string>;
    /**
     * 可选:**请求体 JSON 条件**,点路径 → 期望值(如 `{"action":"delete"}`),全部满足才命中(AND)。
     * 请求体先 JSON.parse,按点路径逐层取值,`String()` 后与期望值精确等值比较。解析失败 / 路径不存在 /
     * 无请求体 → 该条件不命中。
     */
    bodyJson?: Record<string, string>;
    /** 可选:**请求体原文子串**条件,这些子串需全部出现在请求体文本里才命中(AND,大小写敏感);无请求体 → 不命中 */
    bodyContains?: string[];
    /**
     * 可选:**通用布尔表达式**(evalBoolExpr 引擎,同 responseTrigger.when),与上述静态条件 AND;空 → 无条件。
     * 上下文变量:`method`/`url`/`body`(请求体 JSON.parse,失败=undefined)/`text`(请求体原文);
     * 函数 `header(n)` 与 `reqHeader(n)`(**都取请求头**,兼容从 resends 迁移的写法)/`query(n)`(取 query 参数)/
     * 内置 `contains`/`match`。求值出错或结果非真 → 判**不命中**(fail-open:不拦、放行)。
     */
    when?: string;
    /** 处置模式:`abort`=硬阻断(缺省,向后兼容旧配置);`hold`=挂起等人工放行(仅回放端) */
    mode?: 'abort' | 'hold';
    /**
     * 可选:是否**也拦截本工具自己发出的「重发请求」**(带 x-macro-resend 标记头)。缺省 false=重发免疫(现状:
     * route handler 对重发请求提前放行,不判 block);设 true 则该 block 规则对重发请求也生效(可 hold/abort 重发)。
     * 仅回放端。用于「连真实请求带工具重发一起拦下人工审查」的场景。
     */
    includeResend?: boolean;
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
 * 「请求体 + 响应体独立落盘」规则(record 支路的 saveBodies 子项)。命中 urlPattern(可选限 method)的
 * 请求,把其**完整请求体**和/或**完整响应体**各写成一个独立文件(禁止截断),供事后分析。走 CDP Fetch
 * 「请求阶段 + 响应阶段」两次暂停:请求阶段用 postDataEntries 重组(对 File/Blob 上传保真)、响应阶段用
 * Fetch.getResponseBody 取(含二进制/解压后)。同一请求的 req/res 文件按 CDP requestId 天然配对。
 * 随 record 走(**独立于 RequestRulesConfig.enabled**),**仅回放端生效**;与 record.urlPattern(JSONL 记录
 * 范围)解耦——各条自带 urlPattern,通常只对特定上传/接口 URL 落盘。文件落 dumps/ 目录,名 rec-<戳>-<id>-<req|res>.<ext>。
 */
export interface BodySaveRule {
    /** URL 匹配模式(CDP glob,`*` 通配);唯一必填 */
    urlPattern: string;
    /** 可选,仅落盘指定 HTTP 方法(大小写不敏感,如 PUT/POST);缺省=命中 URL 的所有方法 */
    method?: string;
    /** 是否落请求体(缺省视为 true) */
    request?: boolean;
    /** 是否落响应体(缺省视为 true) */
    response?: boolean;
    /** 请求体文件后缀(可含/不含前导点);缺省按请求 content-type 推断,推不出用 'bin' */
    requestExt?: string;
    /** 响应体文件后缀(可含/不含前导点);缺省按响应 content-type 推断,推不出用 'bin' */
    responseExt?: string;
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
    /**
     * 「请求体 + 响应体独立落盘」规则列表(仅回放端;随 record 走、独立于 enabled)。命中即把完整请求/响应体
     * 各写成一个文件(走 CDP Fetch 响应阶段)。缺省/空 = 不落盘 body,record 仍只写 JSONL 时间线。
     */
    saveBodies?: BodySaveRule[];
}

/**
 * 「JS Hook 探针」单条规则(jsHooks 支路)。回放端向页面**主世界**注入 hook 脚本,拦截网络出口
 * (fetch/XHR)、标准加密库(CryptoJS/crypto.subtle/btoa/JSON.stringify)与**平台自定义签名/加密函数**
 * (hookPaths 指定的全局点路径,如 byted_acrawler.sign),抓「明文入参 ↔ 密文出参 + 调用栈」。
 * 注意:apis / hookPaths 是**全局并集**(注入脚本装载时一次性决定包裹哪些目标,不可撤销);urlPattern 才是
 * **逐条**的落盘过滤(命中任一条规则的 urlPattern 才落盘)。**仅回放端生效**,被动观察、不改页面行为。
 */
export interface JsHookRule {
    /** 页面 URL 匹配模式(CDP glob,`*` 通配);缺省 = 匹配所有页面(按 location.href 判定) */
    urlPattern?: string;
    /**
     * 限定包裹哪些基础集 api(取值:'fetch'|'xhr'|'json'|'btoa'|'subtle'|'cryptojs');**全局并集**。
     * 缺省(所有规则都不写)= 默认基础集 fetch/xhr/btoa/subtle(json 因高频、cryptojs 需按需,均需显式开)。
     */
    apis?: string[];
    /** 自定义全局函数点路径列表(如 'byted_acrawler.sign'、'_0xabc.encrypt'),按路径惰性包裹;**全局并集** */
    hookPaths?: string[];
    /** 明文/密文内联进索引的字节阈值,超过则旁落独立文件(完整不截断);缺省 2048 */
    maxInline?: number;
}

/**
 * 「JS Hook 探针」支路配置(存于 request-rules.json 的 jsHooks 段)。自带 enabled 子开关,
 * **独立于 RequestRulesConfig.enabled**(像 record)——即便网络改写总闸关闭,只要 jsHooks.enabled
 * 就注入抓取。输出到 dumps/:索引 jshook-index-<戳>.jsonl + 大体旁落文件 jshook-<戳>-<seq>-<in|out>.<ext>。
 * enabled 可热更新(注入脚本恒装恒抓、Node 侧按开关落盘);但「包裹哪些 api/函数」在回放启动时定,
 * 增删 apis/hookPaths 需重启回放才生效。
 */
export interface JsHookConfig {
    /** 独立开关:true 即启用注入抓取,与网络改写总闸无关 */
    enabled: boolean;
    /** 规则列表(命中任一条的 urlPattern 即落盘;apis/hookPaths 全局并集);缺省/空 = 默认基础集全抓 */
    rules?: JsHookRule[];
    /** 单次回放命中落盘条数上限(防高频 api 如 JSON.stringify 刷爆 dumps/);达上限熔断并告警一次。缺省 20000 */
    maxEntries?: number;
}

/**
 * 「支路级分闸」开关映射:键 = 支路名,值 = 是否启用。**缺省 / 缺键 = true(启用)**,只有显式
 * false 才关闭该支路。与顶层 enabled 是 **AND** 关系:enabled 是总闸、sections 是各支路分闸——
 * 某支路生效需「enabled 为真 且 sections[该支路] !== false 且 该支路有规则」。
 * 用于「关掉某一支路、但保留其规则数组、也不影响其它支路」。record 支路**不受此管**(用它自己的
 * record.enabled,独立于 enabled 与 sections)。
 */
export interface RequestSectionToggles {
    /** rules(请求体改写)支路开关;缺省 true */
    rules?: boolean;
    /** resends(重发)支路开关;缺省 true */
    resends?: boolean;
    /** responseRules(响应头改写)支路开关;缺省 true */
    responseRules?: boolean;
    /** requestHeaderRules(请求头改写)支路开关;缺省 true */
    requestHeaderRules?: boolean;
    /** blocks(硬阻断)支路开关;缺省 true */
    blocks?: boolean;
    /** dumps(请求体落盘)支路开关;缺省 true */
    dumps?: boolean;
    /** bodyReplaces(请求体整体替换)支路开关;缺省 true */
    bodyReplaces?: boolean;
    /** captures(被动变量捕获)支路开关;缺省 true */
    captures?: boolean;
}

/** 录制端请求改写配置(存于 request-rules.json;默认 enabled=false 不干预) */
export interface RequestRulesConfig {
    /** 总开关:false 时完全不拦截(改写) */
    enabled: boolean;
    /**
     * 支路级分闸(缺省视为全部启用)。与 enabled 是 AND:enabled 总闸开着时,再按 sections 逐支路启停。
     * 缺该字段 / 缺某键 = 该支路启用(向后兼容)。record 不在此列(用 record.enabled)。
     */
    sections?: RequestSectionToggles;
    /** 规则列表(按序尝试匹配,命中即改写) */
    rules: RequestRule[];
    /** 重发规则列表(命中后延时改参重发一个新请求;受 enabled 总开关管);缺省视为无重发 */
    resends?: ResendRule[];
    /** 被动变量捕获规则列表(命中响应即提取命名变量入变量池,供 resends 的 {{占位符}} 注入;受 enabled 总开关管;仅回放端);缺省视为无 */
    captures?: CaptureRule[];
    /** 响应头条件改写规则列表(命中且满足 when 条件则改响应头;受 enabled 总开关管);缺省视为无 */
    responseRules?: ResponseHeaderRule[];
    /** 请求头条件改写规则列表(命中且满足 when 则改原始请求头;受 enabled 总开关管;仅回放端);缺省视为无 */
    requestHeaderRules?: RequestHeaderRule[];
    /** 真拦截(硬阻断)规则列表(命中即 route.abort 阻断、不发出;受 enabled 总开关管);缺省视为无 */
    blocks?: BlockRule[];
    /** 请求体落盘规则列表(命中即把完整二进制请求体写成文件;受 enabled 总开关管;仅回放端);缺省视为无 */
    dumps?: DumpRule[];
    /** 请求体整体替换规则列表(命中即用本地文件字节整体替换请求体;受 enabled 总开关管;仅回放端);缺省视为无 */
    bodyReplaces?: BodyReplaceRule[];
    /** 只记录不修改支路(独立开关);缺省视为不记录 */
    record?: TimelineRecordConfig;
    /** JS Hook 探针支路(独立开关,独立于 enabled;回放端主世界注入抓明文↔密文);缺省视为不启用 */
    jsHooks?: JsHookConfig;
    /**
     * 响应触发重发的**链式跳数上限**(熔断阈值,仅回放端)。真实浏览器请求视为第 0 跳,每被重发一次 +1。
     * 当触发响应所属请求的跳数已达此值时,不再继续触发新的重发——用来在支持「连环触发」(一条重发的响应
     * 再触发下一条规则)的同时,兜底防止无限自环/互环。缺省 5;归一化后 clamp 到 [1,100]。
     */
    maxResendHops?: number;
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
/** 单步出错处置策略:abort=中止全流程 / skip·continue=记录后跳过该步继续 / retry=按退避重试 */
export type OnErrorPolicy = 'abort' | 'skip' | 'continue' | 'retry';

/** 重试退避策略 */
export interface RetryPolicy {
    /** 重试次数(0=不重试) */
    count: number;
    /** 退避方式:fixed=固定 baseMs;exponential=baseMs*factor^(n-1),封顶 maxMs */
    backoff: 'fixed' | 'exponential';
    baseMs: number;
    factor: number;
    maxMs: number;
}

/** 步骤间延时(min==max=固定;min<max=区间随机拟人化,躲行为风控) */
export interface StepDelay {
    min: number;
    max: number;
}

/** 翻页节奏 */
export interface PaginationPacing {
    /** 等列表就绪/换页的上限(毫秒) */
    settleTimeoutMs: number;
    /** 每页处理后额外停顿(毫秒;0=不停) */
    perPageDelayMs: number;
}

/** 单个回放行为档:所有字段均已补全(由 resolveActiveProfile 合并默认得到) */
export interface ReplayProfile {
    /** 全局默认超时(作用于 click/fill/waitForSelector/goto 等) */
    globalTimeoutMs: number;
    /** 按步骤类型覆盖超时(缺省走全局) */
    stepTimeoutMs: Record<string, number>;
    retry: RetryPolicy;
    stepDelay: StepDelay;
    /** 全局出错策略 */
    onError: OnErrorPolicy;
    /** 按步骤类型覆盖出错策略 */
    onErrorByType: Record<string, OnErrorPolicy>;
    pagination: PaginationPacing;
    /** scroll-bottom 步骤等懒加载的停顿(毫秒) */
    scrollBottomWaitMs: number;
}

/** replay-profile.json 顶层结构:多档可切换 */
export interface ReplayProfileConfig {
    /** 当前生效档名(须存在于 profiles;缺则回退 default) */
    activeProfile: string;
    profiles: Record<string, ReplayProfile>;
}

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
    /** 当前生效的回放行为档(超时/重试/延时/出错策略/翻页节奏);缺省则全部走历史写死值 */
    replayProfile?: ReplayProfile;
}

/** 事件钩子的生命周期事件 */
export type HookEvent = 'on-start' | 'on-progress' | 'on-complete' | 'on-failure';

/**
 * 单个钩子动作(以 action 判别):
 * - webhook     HTTP POST 到静态 url(url/headers 只取配置、禁注入页面变量防 SSRF;bodyTemplate 变量按 JSON 转义)
 * - command     spawn 外部程序(exe 静态;args 可含变量,array 传参无 shell 故无注入)
 * - status-file 写状态文件(path 限定在 dataRoot 内防穿越)
 * - notify      桌面通知(Electron Notification,由主进程注入)
 */
export type HookAction =
    | {
          action: 'webhook';
          url: string;
          method?: string;
          headers?: Record<string, string>;
          bodyTemplate?: string;
          timeoutMs?: number;
      }
    | { action: 'command'; exe: string; args?: string[]; cwd?: string; timeoutMs?: number }
    | { action: 'status-file'; path: string; template?: string }
    | { action: 'notify'; title: string; body?: string };

/** hooks.json 顶层结构:默认 enabled:false(inert,不显式开则零对外) */
export interface HooksConfig {
    enabled: boolean;
    events: Partial<Record<HookEvent, HookAction[]>>;
}

/** 派发钩子时注入模板的运行时数据 */
export interface RunHookPayload {
    macroName: string;
    status: 'started' | 'progress' | 'success' | 'failure';
    rowCount?: number;
    elapsedMs?: number;
    startedAt?: string;
    finishedAt?: string;
    dataRoot?: string;
    downloads?: string[];
    outputs?: string[];
    /** 失败事件专有:结构化错误详情 */
    error?: RunError;
    /** 进度事件专有 */
    progress?: { page?: number; rows?: number };
}

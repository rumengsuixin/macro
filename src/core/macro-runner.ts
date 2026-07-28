// 宏回放引擎:读取 JSON 宏,使用 Playwright 启动浏览器并逐步执行。
// 每种 step 类型都有独立的处理方法;每一步执行前后打印中文日志;
// 出错时截图保存到 errors/ 目录,并返回结构化错误信息。
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
    type Locator,
    type Route,
    type Request,
    type Response,
    type APIResponse,
    type CDPSession,
} from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import type {
    Macro,
    Step,
    PauseStep,
    RunResult,
    RunError,
    ExtractRow,
    OnPause,
    OnHold,
    HoldDecision,
    SessionOptions,
    ReplayProfile,
    OnErrorPolicy,
    ElementFingerprint,
    RequestRule,
    ResendRule,
    ResponseHeaderRule,
    RequestHeaderRule,
    BlockRule,
    DumpRule,
    BodyReplaceRule,
    BodySaveRule,
    JsHookRule,
    RequestRulesConfig,
} from './macro-types';
import { extract, type PaginationContext } from './extractor';
import { DownloadManager } from './download-manager';
import {
    matchRule,
    matchBlockRule,
    globToRegExp,
    decideBodyType,
    rewritePostBody,
    rewriteResponseHeaderRecord,
    responseRuleHasBodyAction,
    resolveResponseOverride,
    resolveMockStatus,
    rewriteRequestHeaderRecord,
    headerValue,
    isResendOrigin,
    resendHop,
    buildResendHeaders,
    responseTriggerMet,
    triggerNeedsBody,
    explainResponseTriggerMiss,
    extractResendVars,
    renderResendActions,
    checkExprSyntax,
    sectionEnabled,
} from './request-rewrite';
import { TimelineRecorder } from './timeline-recorder';
import { RecordBodyIndex } from './record-body-index';
import { JsHookIndex } from './js-hook-index';
import {
    buildJsHookInitScript,
    buildInjectConfig,
    pickMaxInline,
    type JsHookProbePayload,
} from './js-hook-script';
import { logInfo, logError } from './logger';

/** CDP Fetch.requestPaused 事件里的 request 结构(取用到的字段;Playwright CDPSession 事件为弱类型) */
interface CdpPausedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** 小文本 body 事件自带(字符串);二进制/大 body 走 postDataEntries */
    postData?: string;
    /** post data 分块,每块 bytes 为 base64(对 File/Blob 也保真,重组即完整字节) */
    postDataEntries?: Array<{ bytes?: string }>;
    hasPostData?: boolean;
}

/** CDP Fetch.requestPaused 事件参数(取用到的字段) */
interface CdpRequestPaused {
    requestId: string;
    request: CdpPausedRequest;
    /** 有值=响应阶段(dump 只配 Request 阶段;record 的 saveBodies 会另配 Response 阶段) */
    responseStatusCode?: number;
    /** 响应头(仅响应阶段带;用于按 content-type 推断落盘文件后缀) */
    responseHeaders?: Array<{ name: string; value: string }>;
    /** 底层网络请求 id;== 同 session `Network.requestWillBeSent` 的 requestId,作 record↔body 的 join 键 */
    networkId?: string;
}

/** CDP Network.requestWillBeSent 事件里的 request 结构(取用到的字段) */
interface CdpNetworkRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** 是否带请求体(带才去 Network.getRequestPostData 取完整 body) */
    hasPostData?: boolean;
    /** 事件自带的 body(可能被截断;完整 body 走 getRequestPostData) */
    postData?: string;
}

/** content-type → 落盘文件后缀(取主类型,仅覆盖常见类型;推不出返回 null,交调用方回退 bin) */
function extFromContentType(ct?: string): string | null {
    if (!ct) {
        return null;
    }
    const mime = ct.split(';')[0].trim().toLowerCase();
    const map: Record<string, string> = {
        'application/json': 'json',
        'text/json': 'json',
        'text/html': 'html',
        'text/plain': 'txt',
        'text/css': 'css',
        'text/csv': 'csv',
        'application/javascript': 'js',
        'text/javascript': 'js',
        'application/xml': 'xml',
        'text/xml': 'xml',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'video/mp4': 'mp4',
        'audio/mpeg': 'mp3',
        'application/pdf': 'pdf',
        'application/zip': 'zip',
        'application/octet-stream': 'bin',
    };
    return map[mime] ?? null;
}

/** 从 CDP 头数组([{name,value}])里大小写不敏感取值;取不到返回 undefined */
function headerListValue(
    headers: Array<{ name: string; value: string }> | undefined,
    name: string
): string | undefined {
    if (!headers) {
        return undefined;
    }
    const lower = name.toLowerCase();
    for (const h of headers) {
        if (h.name.toLowerCase() === lower) {
            return h.value;
        }
    }
    return undefined;
}

/** 现状写死值构成的默认回放档:无 session.replayProfile(无头/单测)时兜底,保证行为与历史一致 */
function defaultReplayProfile(): ReplayProfile {
    return {
        globalTimeoutMs: 60000,
        stepTimeoutMs: {},
        retry: { count: 0, backoff: 'fixed', baseMs: 500, factor: 2, maxMs: 10000 },
        stepDelay: { min: 0, max: 0 },
        onError: 'abort',
        onErrorByType: {},
        pagination: { settleTimeoutMs: 30000, perPageDelayMs: 0 },
        scrollBottomWaitMs: 1000,
    };
}

export class MacroRunner {
    private errorDir: string;
    private timeoutMs: number;
    /** 当前回放行为档(超时/重试/延时/出错策略/翻页节奏);缺省 = 现状写死值 */
    private replay: ReplayProfile;
    /** 人工介入暂停回调:由主进程注入,负责通知 UI 并等待用户点继续;无则默认立即放行 */
    private onPause: OnPause;
    /**
     * 挂起放行回调:命中 blocks 中 mode:'hold' 规则时调用,await 直到人工在 UI 上选 continue/abort。
     * 由主进程经 setOnHold 注入;缺省(无头/单测)立即 continue,避免永久挂死回放。
     */
    private onHold: OnHold = async (): Promise<HoldDecision> => 'continue';
    /** 会话选项:持久化目录 / 注入的 cookies;由主进程组装,缺省则用临时 profile、不注入 */
    private session: SessionOptions;
    /** 下载文件保存目录;缺省回退到 errorDir 同级的 downloads */
    private downloadDir: string;
    /** 请求时间线记录输出目录(record 支路);缺省回退到 errorDir 同级的 timelines */
    private timelinesDir: string;
    /** 用户已请求停止:主循环每步前检查,已置位则抛出并跳过后续步骤/提取 */
    private cancelled = false;
    /** 当前 context 引用:停止时主动关闭以打断正在进行的 Playwright 操作(慢步骤/提取阶段) */
    private activeContext: BrowserContext | null = null;
    /** 当前活动页(跟随弹窗切换):回放端「页面内 fetch」重发用它在页面上下文执行 */
    private activePage: Page | null = null;

    // --- 请求改写/记录的运行期热更新状态(main 侧 fs.watchFile 改动即经 updateRequestRules 推入) ---
    /** 改写 route handler:只建一次,注册/注销都用同一引用 */
    private rewriteHandler: ((route: Route, request: Request) => Promise<void>) | null = null;
    /** 当前生效的改写规则(handler 实时读,支持规则热更新) */
    private rewriteRules: RequestRule[] = [];
    /** 当前生效的响应头改写规则(handler 实时读;命中则 route.fetch()+route.fulfill() 改响应头) */
    private responseHeaderRules: ResponseHeaderRule[] = [];
    /** 当前生效的请求头改写规则(handler 实时读;命中且 when 满足则改原始请求头随请求发出) */
    private requestHeaderRules: RequestHeaderRule[] = [];
    /** 当前生效的真拦截规则(handler 实时读;命中即 route.abort() 硬阻断,不发出) */
    private blockRules: BlockRule[] = [];
    /** 改写 route 是否已注册(仅 enabled 且有改写/响应头/真拦截规则时注册 → 未启用零 route 开销) */
    private rewriteInstalled = false;
    /** 记录器;record.enabled 时创建(非 null 即正在记录),关闭时置 null。监听常挂,靠它决定是否写 */
    private recorder: TimelineRecorder | null = null;
    /** 是否记录完整请求 body */
    private recordWantBody = true;
    /** 当前 record 段签名:去重 + 判 urlPattern/includeBody 是否变化 */
    private recordCfgKey = '';
    // --- 「重发型」支路运行期状态(受 enabled 总开关管,与改写共用 fs.watchFile 热更新) ---
    /** 当前生效的**请求触发**重发规则(无 responseTrigger;命中请求 URL 后延时改参重发) */
    private resendRules: ResendRule[] = [];
    /** 是否启用请求触发重发(enabled 且有请求触发规则) */
    private resendWant = false;
    /** 当前生效的**响应触发**重发规则(有 responseTrigger;命中响应并满足条件后重发) */
    private responseResendRules: ResendRule[] = [];
    /** 是否启用响应触发重发(enabled 且有响应触发规则) */
    private resendResponseWant = false;
    /** 响应触发的请求捕获:规则 urlPattern → 最近一次命中它的请求(供触发时重发,后到覆盖) */
    private readonly resendCaptures = new Map<
        string,
        { url: string; method: string; headers: Record<string, string>; body: string }
    >();
    /** 响应触发「未命中原因」诊断日志的去重键(按失败模式 signature,同种只打一次) */
    private readonly resendMissWarned = new Set<string>();
    /** 未触发的重发定时器集合:cancel/run 结束/热关闭时统一清理,防泄漏与 "Target closed" */
    private readonly resendTimers = new Set<ReturnType<typeof setTimeout>>();
    /** 去抖:重发规则 urlPattern → 上次触发时刻(ms) */
    private readonly resendLastFireAt = new Map<string, number>();
    /**
     * 响应触发的**链式跳数上限**(熔断阈值):触发响应所属请求跳数达此值即不再继续触发。
     * 支持「连环触发」的同时防无限自环/互环。由 request-rules.json 的 maxResendHops 覆盖,缺省 5。
     */
    private maxResendHops = 5;
    // --- 「请求体落盘(dump)」支路运行期状态(受 enabled 总开关管,与改写共用 fs.watchFile 热更新) ---
    /** 请求体落盘输出目录;缺省回退到 errorDir 同级的 dumps */
    private dumpsDir: string;
    /** 当前生效的落盘规则(命中即把完整二进制请求体写成一个文件;不改原请求) */
    private dumpRules: DumpRule[] = [];
    /** 是否启用落盘(enabled 且有落盘规则) */
    private dumpWant = false;
    /** 落盘文件序号:与毫秒戳组合保证同毫秒内也不撞名 */
    private dumpSeq = 0;
    /** 落盘目录懒建标志(仿 TimelineRecorder.ready) */
    private dumpsReady = false;
    /** 每页一个 CDP 会话(Fetch 域拦截,从 postDataEntries 取完整二进制;dump 落盘 + 整体替换共用) */
    private readonly dumpCdpSessions = new Map<Page, CDPSession>();
    /** 所有活动 page 引用(初始页 + 每个弹窗):供 dump/替换 热更新开启时补挂 CDP */
    private readonly dumpPages = new Set<Page>();
    // --- 「请求体整体替换(拦截替换)」支路运行期状态(与 dump 共用上面的 per-page CDP Fetch 拦截) ---
    /** 当前生效的整体替换规则(命中即用本地文件字节整体替换请求体后放行) */
    private replaceRules: BodyReplaceRule[] = [];
    /** 是否启用整体替换(enabled 且有替换规则) */
    private replaceWant = false;
    // --- 「record 支路:请求/响应体独立落盘(saveBodies)」运行期状态(随 record 走,独立于 enabled;共用 per-page CDP Fetch) ---
    /** 当前生效的 body 落盘规则(命中即把完整请求体/响应体各写成一个文件;走 CDP 请求+响应阶段) */
    private recordBodyRules: BodySaveRule[] = [];
    /** 是否启用 body 落盘(record.enabled 且有 saveBodies 规则) */
    private recordBodyWant = false;
    /** CDP 同源精确索引:每落一个 body 文件追加一行,同 requestId 串联 req/res;开→关建/停(新文件) */
    private recordBodyIndex: RecordBodyIndex | null = null;
    /** requestId → 请求阶段落盘时刻(ms),供响应阶段算 timingMs;响应阶段取用后删除 */
    private readonly recordBodyStart = new Map<string, number>();
    // --- 「record 时间线走 CDP Network 域」运行期状态(回放端记录源;与 saveBodies 共用 per-page CDP session)---
    /** per-page CDP session 编号:作 record id / rec-index networkId 的前缀,避免跨 session requestId 撞号 */
    private cdpSessionSeq = 0;
    /** page → 该 session 的编号前缀(热更新补挂 Network 时复用) */
    private readonly cdpSessionIds = new Map<Page, string>();
    /** 已 enable Network 域(record)的 session:去重防重复 enable / 重复挂 handler */
    private readonly networkEnabledSessions = new Set<CDPSession>();
    /** 已挂记录 session 的 CDP targetId:一个 target 只保留一个 session,防同一 target 被多 Page 对象/多次事件重复记录 */
    private readonly attachedTargets = new Set<string>();
    // --- 「JS Hook 探针(jsHooks)」运行期状态(随 jsHooks.enabled,独立于 enabled;回放端主世界注入抓明文↔密文)---
    /** 当前生效的 hook 规则(URL 过滤 + maxInline;apis/hookPaths 已在注入时聚合、不在此) */
    private jsHookRules: JsHookRule[] = [];
    /** 是否落盘(jsHooks.enabled;注入脚本恒抓,此标志控 Node 侧落不落盘) */
    private jsHookWant = false;
    /** 命中落盘索引(jshook-index-<戳>.jsonl);关→null 停写 */
    private jsHookIndex: JsHookIndex | null = null;
    /** 旁落文件序号:与毫秒戳组合防同毫秒撞名 */
    private jsHookSeq = 0;
    /** 明文/密文内联阈值(字节),超则旁落独立文件(完整不截断);缺省 2048 */
    private jsHookMaxInline = 2048;
    /** 本次回放命中落盘条数上限(防高频 api 刷爆 dumps/);达上限熔断并告警一次。缺省 20000 */
    private jsHookMaxEntries = 20000;
    /** 本次回放已落盘的命中条数(达 maxEntries 即停止记录) */
    private jsHookCount = 0;
    /** 上限告警是否已发(每次回放只发一次,不刷屏) */
    private jsHookLimitWarned = false;
    /** 注入脚本 + exposeBinding 是否已装(恒装一次,不可撤销) */
    private jsHookScriptInstalled = false;

    constructor(
        errorDir: string,
        timeoutMs?: number,
        onPause?: OnPause,
        session?: SessionOptions,
        downloadDir?: string,
        timelinesDir?: string,
        dumpsDir?: string
    ) {
        this.errorDir = errorDir;
        // 无回调(无头/单测场景)时立即放行,避免永久挂起
        this.onPause = onPause ?? (async (): Promise<void> => {});
        this.session = session ?? {};
        // 回放行为档:优先用主进程解析好的当前档,缺省(无头/单测)用现状默认档
        this.replay = this.session.replayProfile ?? defaultReplayProfile();
        // 回放全局超时优先级:构造入参 > 环境变量 MACRO_TIMEOUT(保留旧用法)> 当前档 globalTimeoutMs
        this.timeoutMs = timeoutMs ?? (Number(process.env.MACRO_TIMEOUT) || this.replay.globalTimeoutMs);
        this.downloadDir = downloadDir ?? path.join(errorDir, '..', 'downloads');
        this.timelinesDir = timelinesDir ?? path.join(errorDir, '..', 'timelines');
        this.dumpsDir = dumpsDir ?? path.join(errorDir, '..', 'dumps');
    }

    /**
     * 注入「挂起放行」回调(主进程在 new 之后调用)。与 onPause 走构造入参不同,此处用 setter
     * 以避免动 7 个位置参数的构造签名、破坏所有既有 new MacroRunner 调用点。缺省保持默认立即 continue。
     */
    setOnHold(cb: OnHold): void {
        this.onHold = cb;
    }

    /**
     * 请求停止当前回放(由主进程在收到「停止」信号时调用,依赖倒置——core 不依赖 Electron)。
     * 置取消标志让主循环干净退出;并主动关闭 context 以**立即打断**正在 await 的 Playwright
     * 操作(如卡在慢 waitForSelector / goto / 提取阶段),使 run() 尽快从 catch 退出。
     */
    cancel(): void {
        this.cancelled = true;
        this.clearResendTimers(); // 停止:清掉未触发的重发定时器
        void this.detachAllDumpCdp(); // 停止:卸载 dump CDP 会话(须早于 context 关闭)
        if (this.activeContext) {
            // 关闭失败(如已关)静默忽略;正在进行的操作会抛 "Target closed" 由 run() 的 catch 兜住
            this.activeContext.close().catch(() => undefined);
        }
    }

    /** 回放整个宏 */
    async run(macro: Macro): Promise<RunResult> {
        logInfo(`开始回放宏「${macro.name}」,共 ${macro.steps.length} 个步骤。`);

        let browser: Browser | null = null;
        let context: BrowserContext | null = null;
        let page: Page | null = null;
        let activePage: Page | null = null; // 当前活动页(跟随新标签页弹窗切换),供 catch 取 url/截图
        let currentStepIndex = -1;
        let currentStep: Step | null = null;
        // 回放中记录每步真实所在页面 URL(供旧宏回填 recordedUrl 精确分组);与 steps 同序,取不到为 null
        const stepUrls: (string | null)[] = new Array(macro.steps.length).fill(null);
        const snapUrl = (p: Page | null): string | null => {
            try {
                const u = p ? p.url() : '';
                return u && u !== 'about:blank' ? u : null;
            } catch {
                return null;
            }
        };

        // 活动页焦点管理:把原先双写的 activePage(局部)+ this.activePage(实例)收敛为单一入口,
        // 并维护存活页栈,支撑「弹窗关闭自动回切」与未来多标签场景。
        const livePages: Page[] = []; // 存活页栈(创建序,栈顶=最近新建且未关)
        const POPUP_SWITCH = '检测到新标签页弹窗,已切换为活动页继续回放。';
        // 统一决定活动页:写 this.activePage(重发器/CDP 跨方法读的单一入口)+ 设该页默认超时 + 可选打日志,
        // 并回传该页;局部 activePage 由调用点以 `activePage = setActivePage(...)` 直接赋值(保留 TS 控制流 narrowing)。
        const setActivePage = (p: Page, logMsg?: string): Page => {
            this.activePage = p;
            try {
                p.setDefaultTimeout(this.timeoutMs);
                p.setDefaultNavigationTimeout(this.timeoutMs);
            } catch {
                /* 页面正在关闭等,忽略 */
            }
            if (logMsg) {
                logInfo(logMsg);
            }
            return p;
        };
        // 给页面挂关闭监听:关闭即移出存活栈 + per-page CDP 轻清理;若关的正是当前焦点,回切到栈顶首个未关页。
        // 拆机时 finally 先置 this.activePage=null(早于 context.close),故初始页关闭时回切分支天然跳过 —— 单页零副作用。
        const attachClose = (p: Page): void => {
            p.on('close', () => {
                const idx = livePages.indexOf(p);
                if (idx >= 0) {
                    livePages.splice(idx, 1);
                }
                // 关页的 CDP session 已死,顺手卸载,免热更新对已关页重试 attachDumpCdp 刷日志
                // (不清 attachedTargets:无 page→targetId 反查表且 targetId 不复用,残留无害,交整批清理)
                const cdp = this.dumpCdpSessions.get(p);
                if (cdp) {
                    void cdp.detach().catch(() => undefined);
                    this.dumpCdpSessions.delete(p);
                }
                this.cdpSessionIds.delete(p);
                this.dumpPages.delete(p);
                // 仅当被关的是当前焦点、且非主动停止(cancel 关 context 会连环关页,此时回切/告警是噪声)才回切
                if (!this.cancelled && this.activePage === p) {
                    for (let k = livePages.length - 1; k >= 0; k -= 1) {
                        if (!livePages[k].isClosed()) {
                            activePage = setActivePage(
                                livePages[k],
                                '活动页已关闭,已回切到上一个存活页继续回放。'
                            );
                            return;
                        }
                    }
                    logError('活动页已关闭且无其它存活页,后续步骤可能失败。');
                }
            });
        };

        try {
            // 默认有头(回放可视);设置 MACRO_HEADLESS=1 可无头运行(便于自动化测试)
            const headless = process.env.MACRO_HEADLESS === '1';

            // 反检测加固:去掉自动化开关与 infobar,抑制 navigator.webdriver(对所有内核生效)
            const hardenedArgs = [
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
            ];
            const ignoreDefaultArgs = ['--enable-automation'];

            // 内核优选回退链:优先本机真 Chrome → 本机 Edge → 捆绑 Chromium(undefined)。
            // 真品牌内核(Chrome/Edge)指纹更接近真实用户;Windows 10 必带 Edge,故几乎总能命中真品牌。
            const channelChain: Array<string | undefined> = this.session.preferSystemChrome
                ? ['chrome', 'msedge', undefined]
                : [undefined];

            // 仅在回退到捆绑 Chromium 时规整 context(其默认指纹偏「测试版」);
            // 真 Chrome/Edge 自身 UA 已是合法品牌串,覆盖反而易与 Sec-CH-UA 等版本错配,故不动。
            const bundledContextOptions = {
                userAgent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                locale: 'zh-CN',
                viewport: { width: 1280, height: 800 },
            };

            // 通用下载捕获:允许下载;落盘由 DownloadManager 统一处理(对所有 mode 生效)
            const downloadContextOptions = { acceptDownloads: true };

            let lastErr: unknown = null;
            for (const channel of channelChain) {
                const isBundled = !channel;
                const launchOpts = {
                    headless,
                    args: hardenedArgs,
                    ignoreDefaultArgs,
                    ...(channel ? { channel } : {}),
                };
                try {
                    if (this.session.userDataDir) {
                        // 持久化 profile:跨次回放复用同一目录(含 cookie/localStorage),登录态长期有效
                        context = await chromium.launchPersistentContext(this.session.userDataDir, {
                            ...launchOpts,
                            ...downloadContextOptions,
                            ...(isBundled ? bundledContextOptions : {}),
                        });
                        page = context.pages()[0] ?? (await context.newPage());
                    } else {
                        browser = await chromium.launch(launchOpts);
                        context = await browser.newContext({
                            ...downloadContextOptions,
                            ...(isBundled ? bundledContextOptions : {}),
                        });
                        page = await context.newPage();
                    }
                    logInfo(
                        `回放浏览器内核:${channel ?? '捆绑 Chromium'}` +
                            `${this.session.userDataDir ? '(持久化目录)' : ''}。`
                    );
                    lastErr = null;
                    break;
                } catch (err) {
                    // 该内核不可用(如未装 Chrome)→ 清理半开资源,尝试下一个回退
                    lastErr = err;
                    logInfo(`内核 ${channel ?? '捆绑 Chromium'} 启动失败,尝试下一回退:${(err as Error).message}`);
                    if (browser) {
                        try {
                            await browser.close();
                        } catch {
                            /* 忽略清理异常 */
                        }
                        browser = null;
                    }
                    context = null;
                    page = null;
                }
            }
            if (!context || !page) {
                throw lastErr ?? new Error('所有浏览器内核均启动失败。');
            }
            // 持有 context 引用,供 cancel() 停止时主动关闭以打断正在进行的操作
            this.activeContext = context;
            // 若用户在浏览器启动期间已点「停止」,此处直接退出,不再往下跑
            if (this.cancelled) {
                throw new Error('回放已被用户停止。');
            }

            // 回放端请求改写 + 只记录不修改支路:必须早于第一个 goto,挂在 context 上覆盖初始页与后续弹窗。
            // 建 route handler + 常挂记录监听 + 应用初始配置;之后 main 侧 fs.watchFile 经 updateRequestRules 热更新。
            await this.setupRequestHandling(context);

            // 反检测注入脚本(必须在任何导航前注册;早于 cookie 注入):抹掉自动化痕迹、补齐常见浏览器特征
            await context.addInitScript(() => {
                // navigator.webdriver 兜底置空(即便已用 --disable-blink-features 抑制)
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                // 补 window.chrome runtime(部分检测脚本据此判定是否真 Chrome)
                const w = window as unknown as { chrome?: unknown };
                if (!w.chrome) {
                    w.chrome = { runtime: {} };
                }
                // permissions.query 对 notifications 返回与真实浏览器一致的状态(自动化常暴露此处不一致)
                const perms = window.navigator.permissions;
                const origQuery = perms.query.bind(perms);
                perms.query = (params: PermissionDescriptor): Promise<PermissionStatus> =>
                    params && (params as { name?: string }).name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                        : origQuery(params);
                // languages / plugins 非空(无头/测试内核常为空,易被识别)
                if (!navigator.languages || navigator.languages.length === 0) {
                    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
                }
                if (!navigator.plugins || navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                }
            });

            // JS Hook 探针:主世界注入抓取脚本 + exposeBinding 回传管子(仅当配置了 jsHooks 支路)。
            // 必须在第一个 goto 之前挂 context 上——自动覆盖初始页与后续弹窗;恒装恒抓,落盘由 jsHookWant 热控。
            await this.installJsHookProbe(context);

            // 注入录制 webview 的 cookies(把录制时登录的账号带进回放)
            if (this.session.cookies && this.session.cookies.length > 0) {
                await context.addCookies(this.session.cookies);
                logInfo(`已注入录制会话 cookies:${this.session.cookies.length} 条`);
            }
            // 注入录制 localStorage(按 origin 隔离):用独立 addInitScript,在导航前注册,
            // 脚本内按 window.location.origin 精准命中目标站,不污染其它 origin。
            if (this.session.localStorage && Object.keys(this.session.localStorage).length > 0) {
                await context.addInitScript((store: Record<string, Record<string, string>>) => {
                    try {
                        const items = store[window.location.origin];
                        if (!items) {
                            return; // 当前页 origin 无对应数据,跳过
                        }
                        for (const [key, val] of Object.entries(items)) {
                            try {
                                window.localStorage.setItem(key, val);
                            } catch {
                                /* 配额超限等单条异常跳过 */
                            }
                        }
                    } catch {
                        /* localStorage 不可用(如 about:blank)时静默跳过 */
                    }
                }, this.session.localStorage);
                logInfo(`已注入录制会话 localStorage:${Object.keys(this.session.localStorage).length} 个 origin`);
            }
            // 提高默认超时,避免点击后慢页面导航等待("waiting for scheduled navigations")超时
            page.setDefaultTimeout(this.timeoutMs); // 影响 click/fill/waitForSelector 等动作(含 click 的导航等待)
            page.setDefaultNavigationTimeout(this.timeoutMs); // 影响 goto 等导航
            logInfo(`回放默认超时已设为 ${this.timeoutMs} 毫秒。`);

            // 跟随「新标签页」弹窗:录制时点击 target=_blank / window.open 会被重定向到同一视图,
            // 回放时同样的点击会在 Playwright 中开新页(popup),这里自动切换为活动页继续回放。
            // 初始页已创建完毕(挂监听前),故此后每次 page 事件都是弹窗。
            livePages.push(page);
            attachClose(page);
            activePage = setActivePage(page);
            // per-page CDP session(record 走 Network 域 + saveBodies 走 Fetch 域):给初始页挂一个。
            // **await**:必须在第一个 goto 前完成 enable,否则 record 会漏掉页面早期请求(全站覆盖红线)。
            this.dumpPages.add(page);
            await this.attachDumpCdp(page);
            context.on('page', (popup) => {
                livePages.push(popup);
                attachClose(popup);
                activePage = setActivePage(popup, POPUP_SWITCH);
                // 弹窗也各自挂 CDP,保证在新标签页里的上传体也能落盘
                this.dumpPages.add(popup);
                void this.attachDumpCdp(popup);
            });

            // 通用下载捕获:挂在 context 上,回放过程中任何触发的下载都落盘
            const downloadManager = new DownloadManager(context, this.downloadDir);

            for (let i = 0; i < macro.steps.length; i += 1) {
                currentStepIndex = i;
                currentStep = macro.steps[i];
                const step = currentStep;
                // 用户已请求停止:在执行本步前干净退出(天然覆盖 pause 步骤 resume 后的下一轮迭代)
                if (this.cancelled) {
                    throw new Error('回放已被用户停止。');
                }
                // 记录本步执行前所在页面 URL(即该步骤的来源页,语义与录制时打戳一致)
                stepUrls[i] = snapUrl(activePage);
                // 翻页步骤正常回放时跳过,改由提取流程在采完一页后驱动
                if (step.pagination) {
                    logInfo(`第 ${i + 1}/${macro.steps.length} 步为翻页动作,正常回放跳过。`);
                    continue;
                }
                logInfo(`第 ${i + 1}/${macro.steps.length} 步:${describeStep(step)} —— 执行中`);
                await this.executeStepWithPolicy(activePage, step, i, context);
                logInfo(`第 ${i + 1}/${macro.steps.length} 步:${step.type} —— 完成`);
            }

            // 提取阶段前再检查一次;提取阶段本身若被停止,靠 cancel() 关 context 强制中断
            if (this.cancelled) {
                throw new Error('回放已被用户停止。');
            }

            let rows: ExtractRow[] | undefined;
            if (macro.extract) {
                // 收集翻页步骤(保持文档顺序),构造翻页上下文供提取流程驱动
                const paginationSteps = macro.steps.filter((s) => s.pagination);
                let pagination: PaginationContext | undefined;
                if (paginationSteps.length > 0) {
                    const totalPages = Math.max(
                        1,
                        ...paginationSteps.map((s) => s.pageCount ?? 1)
                    );
                    logInfo(
                        `检测到 ${paginationSteps.length} 个翻页步骤,总页数设为 ${totalPages}。`
                    );
                    const runPage = activePage;
                    const runContext = context; // 闭包内 context 收窄丢失,捕获非空引用
                    pagination = {
                        totalPages,
                        // 翻页节奏来自当前回放档(缺省 = 现状:settle 30s、每页间隔 0)
                        settleTimeoutMs: this.replay.pagination.settleTimeoutMs,
                        perPageDelayMs: this.replay.pagination.perPageDelayMs,
                        turnPage: async (): Promise<void> => {
                            for (const s of paginationSteps) {
                                await this.executeStep(runPage, s, -1, runContext);
                            }
                            // 翻页点击常触发整页导航;等页面加载稳定再交回提取流程,
                            // 避免「在旧页/半载页上采集(少采)或读到旧分页器(误判命中数)」的竞态。
                            // 纯 JS 换内容(无导航)时此调用即时返回,由提取端 waitForSelector 兜底。
                            await runPage
                                .waitForLoadState('domcontentloaded')
                                .catch(() => undefined);
                        },
                    };
                }
                logInfo('开始按提取规则提取数据……');
                rows = await extract(activePage, macro.extract, pagination, downloadManager);
                logInfo(`数据提取完成,共 ${rows.length} 行。`);
            } else {
                logInfo('未配置提取规则,跳过数据提取。');
            }

            logInfo('宏回放成功。');
            const downloads = downloadManager.savedPaths;
            if (downloads.length > 0) {
                logInfo(`本次回放共保存下载文件 ${downloads.length} 个,目录:${this.downloadDir}`);
            }
            return {
                ok: true,
                rows,
                downloads: downloads.length > 0 ? downloads : undefined,
                stepUrls,
            };
        } catch (err) {
            // 用户主动停止:不当作失败,不尝试错误截图(此时页面/context 多半已关会抛错)
            if (this.cancelled) {
                logInfo('回放已被用户停止。');
                return { ok: false, cancelled: true };
            }
            const message = err instanceof Error ? err.message : String(err);
            const selector =
                currentStep && 'selector' in currentStep ? currentStep.selector : undefined;
            const url = activePage ? activePage.url() : undefined;
            const screenshot = activePage ? await this.captureErrorScreenshot(activePage) : undefined;

            const runError: RunError = {
                stepIndex: currentStepIndex,
                stepType: currentStep ? currentStep.type : 'goto',
                selector,
                url,
                message,
                screenshot,
            };

            logError(
                `回放失败 —— 第 ${currentStepIndex + 1} 步(${runError.stepType})` +
                    `${selector ? ',selector=' + selector : ''},` +
                    `URL=${url ?? '未知'},原因:${message}`
            );
            if (screenshot) {
                logError(`已保存错误截图:${screenshot}`);
            }
            // 部分执行也回传已记录的来源 URL,供旧宏回填(失败前跑到的步骤仍可精确分组)
            return { ok: false, error: runError, stepUrls };
        } finally {
            // 先清未触发的重发定时器,避免它们在 context 关闭后 fire 抛 "Target closed"
            this.clearResendTimers();
            await this.detachAllDumpCdp(); // 卸载 dump CDP 会话(须早于 context 关闭,同重发定时器)
            this.dumpPages.clear();
            this.activePage = null; // 清活动页引用(重发用它);run 结束后页面即将关闭
            // 持久化 context 关闭即退浏览器进程;临时模式下额外关 browser。
            // 停止(cancel)时 context 可能已被关过,故各自 try/catch,避免二次 close 抛错覆盖返回值。
            if (context) {
                try {
                    await context.close();
                } catch {
                    /* 已关闭等异常忽略 */
                }
            }
            if (browser) {
                try {
                    await browser.close();
                } catch {
                    /* 已关闭等异常忽略 */
                }
            }
            if (context || browser) {
                logInfo('浏览器已关闭。');
            }
        }
    }

    /**
     * 装配回放端请求处理(改写 + 只记录不修改两支路),并应用初始配置。
     * 必须早于第一个 goto 调用(挂 context 上覆盖初始页与后续所有弹窗)。此后 main 侧 fs.watchFile
     * 经 updateRequestRules 运行期热更新——改写走 route 注册/注销、记录靠常挂监听 + recorder 标志。
     *
     * 记录到的是页面**原始 body**(改写前):context.on('request') 的 postData() 反映页面本来要发什么,
     * 与 route.continue({postData}) 的改写解耦——这正是「支路互不影响」的正确表现。
     */
    private async setupRequestHandling(context: BrowserContext): Promise<void> {
        // ① 改写 route handler:只建一次,读实时 this.rewriteRules;与录制端(CDP)共用
        // core/request-rewrite 的 matchRule/decideBodyType/rewritePostBody,用全量 route + 内部
        // globToRegExp 匹配(不把 urlPattern 交给 Playwright,避免 glob 方言漂移)。每条必 continue。
        this.rewriteHandler = async (route: Route, request: Request): Promise<void> => {
            try {
                // 重发请求(页面内 fetch,带标记头)直接放行:它已是最终请求,不再被改写(也防自触发/自阻断)
                if (isResendOrigin(request.headers())) {
                    await route.continue();
                    return;
                }
                // 真拦截:命中 block 规则(urlPattern + method + 请求头 / query / body / when 复合 AND)在
                // 发送阶段拦下,按 mode 处置。放在 isResendOrigin 之后 → 工具自己发的重发请求不会被自己阻断;
                // 放在改写之前 → 命中即拦最干净。请求头 / 请求体在回放端 route handler 同步可得。
                const blockRule = matchBlockRule(
                    this.blockRules,
                    request.url(),
                    request.method(),
                    request.headers(),
                    request.postData()
                );
                if (blockRule) {
                    if (blockRule.mode === 'hold') {
                        // 挂起模式:await onHold 把请求悬在半空(pending,不发也不失败),等人工在 UI 上决定。
                        // 运行结束/取消时主进程会把未决 hold 统一 resolve('abort'),此后 route 可能已失效,
                        // continue/abort 抛错由本 handler 末尾的 catch 兜住,安全。
                        logInfo(
                            `回放请求拦截器:已挂起等待人工放行 [${request.method()} ${request.url()}]`
                        );
                        const decision = await this.onHold({
                            url: request.url(),
                            method: request.method(),
                            resourceType: request.resourceType(),
                        });
                        if (decision === 'abort') {
                            logInfo(`回放请求拦截器:人工阻断 [${request.method()} ${request.url()}]`);
                            await route.abort();
                        } else {
                            logInfo(`回放请求拦截器:人工放行 [${request.method()} ${request.url()}]`);
                            await route.continue();
                        }
                        return;
                    }
                    // 硬阻断(缺省 abort):直接丢弃、不放行——页面 fetch/XHR 收到网络错误。
                    logInfo(`回放请求拦截器:已阻断 [${request.method()} ${request.url()}]`);
                    await route.abort();
                    return;
                }
                // 请求头条件改写:命中即算一次全量新头(读**原始请求头**做 when 判定),供下方三条放行路径复用。
                // 放在 isResendOrigin 之后(重发请求头零改写、防递归标记不被破坏)、响应头/body 之前(它们都要用)。
                // newReqHeaders = null 表示未命中/无动作/when 不满足 → withHdr 退化为不带 headers 的原调用。
                const reqHdrRule = matchRule(this.requestHeaderRules, request.url());
                const newReqHeaders = reqHdrRule
                    ? rewriteRequestHeaderRecord(request.headers(), reqHdrRule)
                    : null;
                if (newReqHeaders !== null) {
                    logInfo(
                        `回放请求头改写器:已改写请求头 [${request.method()} ${request.url()}];` +
                            `set=${Object.keys(reqHdrRule!.setHeaders ?? {}).join(',') || '无'};` +
                            `remove=${(reqHdrRule!.removeHeaders ?? []).join(',') || '无'}`
                    );
                }
                // 把改写后的请求头合并进 continue 选项(null 则原样返回,退化为不带 headers)
                const withHdr = (
                    opts: { postData?: string } = {}
                ): { postData?: string; headers?: Record<string, string> } =>
                    newReqHeaders !== null ? { ...opts, headers: newReqHeaders } : opts;
                // 响应头改写规则(与 method 无关,GET 也可能要改):命中则改走 fetch()+fulfill();
                // 请求头改写结果 newReqHeaders 随 fetch 发出(fetch 已消费请求,不能再 continue)
                const respRule = matchRule(this.responseHeaderRules, request.url());
                if (respRule) {
                    await this.handleResponseHeaderRoute(route, request, respRule, newReqHeaders);
                    return;
                }
                // 以下为请求体改写(仅 POST):route.continue({postData[,headers]}) 放行,不触碰响应
                if (request.method().toUpperCase() !== 'POST') {
                    await route.continue(withHdr());
                    return;
                }
                const rule = matchRule(this.rewriteRules, request.url());
                if (!rule) {
                    await route.continue(withHdr());
                    return;
                }
                const original = request.postData();
                if (!original) {
                    await route.continue(withHdr());
                    return;
                }
                const contentType = headerValue(request.headers(), 'content-type');
                const bodyType = decideBodyType(rule, contentType, original);
                let newBody: string | null = null;
                try {
                    newBody = rewritePostBody(original, bodyType, rule);
                } catch (err) {
                    logError(
                        `回放请求改写器:解析/改写 body 失败(原样放行):${(err as Error).message}`
                    );
                    newBody = null;
                }
                if (newBody !== null) {
                    const setKeys = rule.set ? Object.keys(rule.set) : [];
                    const appendKeys = rule.append ? Object.keys(rule.append) : [];
                    const removeKeys = rule.remove ?? [];
                    logInfo(
                        `回放请求改写器:已改写${bodyType === 'json' ? ' JSON ' : '表单'}请求体 [${request.url()}];` +
                            `set=${setKeys.join(',') || '无'};append=${appendKeys.join(',') || '无'};` +
                            `remove=${removeKeys.join(',') || '无'}`
                    );
                    await route.continue(withHdr({ postData: newBody }));
                } else {
                    await route.continue(withHdr());
                }
            } catch (err) {
                logError(`回放请求改写器:处理请求出错:${(err as Error).message}`);
                try {
                    await route.continue();
                } catch {
                    /* 请求可能已失效,忽略 */
                }
            }
        };

        // ② 记录支路(record):已从 Playwright context.on 迁到 **per-page CDP Network 域**(见 attachRecordNetwork,
        //    在 attachDumpCdp 里与 saveBodies 的 Fetch 共用同一 session)。这样 record 的 Network requestId 与
        //    saveBodies 的 Fetch networkId 天然一致 → 时间线与 body 索引可精确 join。CDP Network 同样全站被动
        //    (不暂停)、有 loadingFailed 记失败;此处不再挂 context.on 记录监听。

        // ④ 重发观察监听:常挂、被动(不改原请求)。两支:
        //    A. 请求触发(resendWant,仅 POST):命中 resends 规则 → 延时改参、主动发新请求;
        //    B. 响应触发捕获(resendResponseWant,不限方法):命中 responseTrigger 规则的 urlPattern →
        //       把该请求 url/method/头/体存进 resendCaptures(最近一次),等其 triggerUrl 的响应满足条件再重发。
        context.on('request', (req: Request) => {
            try {
                if (isResendOrigin(req.headers())) {
                    return; // 我们自己发的重发请求,跳过(防递归自触发 + 不被自己捕获)
                }
                if (this.resendWant && req.method().toUpperCase() === 'POST') {
                    const rr = matchRule(this.resendRules, req.url());
                    if (rr) {
                        this.scheduleReplayResend(rr, {
                            url: req.url(),
                            method: rr.method ?? 'POST',
                            headers: req.headers(),
                            body: req.postData() ?? '',
                        });
                    }
                }
                if (this.resendResponseWant) {
                    for (const rr of this.responseResendRules) {
                        try {
                            if (globToRegExp(rr.urlPattern).test(req.url())) {
                                // 只在首次捕获 / 捕获的 URL 变化时打日志(高频轮询同一 URL 不刷屏)
                                const prev = this.resendCaptures.get(rr.urlPattern);
                                if (!prev || prev.url !== req.url()) {
                                    logInfo(
                                        `回放请求重发器(响应触发):已捕获待重发请求 [${rr.urlPattern}] ← ${req.method()} ${req.url()}`
                                    );
                                }
                                this.resendCaptures.set(rr.urlPattern, {
                                    url: req.url(),
                                    method: req.method(),
                                    headers: req.headers(),
                                    body: req.postData() ?? '',
                                });
                            }
                        } catch {
                            /* 非法 pattern 跳过 */
                        }
                    }
                }
            } catch {
                /* 重发支路不得影响主流程 */
            }
        });

        // ⑥ 响应条件触发重发观察监听:常挂、被动(不改响应),靠 resendResponseWant 标志决定是否处理。
        //    命中某规则的 responseTrigger.triggerUrl 且 status/headers/bodyJson 条件满足 →
        //    重发④已捕获的、命中该规则 urlPattern 的那个请求。
        context.on('response', (resp: Response) => {
            void this.handleResponseTrigger(resp).catch(() => undefined);
        });

        // ⑤ 请求体落盘:不走被动 context.on('request')(其 postDataBuffer 对 File/Blob 上传体返回 null),
        //    改为 per-page CDP Fetch 域拦截,从 Fetch.requestPaused 的 postDataEntries 取完整二进制。
        //    CDP session 按页挂载(见 attachDumpCdp),在 run() 的 page 生命周期处接线,此处仅应用初始标志。

        // ③ 应用初始配置(初始改写注册须 await,保证 route 早于第一个 goto 就位)
        const initial = this.session.requestRules ?? { enabled: false, rules: [] };
        await this.applyReplayRewrite(initial);
        this.applyReplayRecord(initial);
        this.applyReplayResend(initial);
        this.applyReplayDump(initial);
        this.applyReplayBodyReplace(initial);
        this.applyReplayJsHook(initial);
    }

    /**
     * 运行期热更新入口:main 侧 fs.watchFile 侦测到 request-rules.json 改动后,读入最新配置调用本方法,
     * 把改写/记录两支路幂等地上/下线。run 未开始/已结束(activeContext 为空)则忽略。
     */
    updateRequestRules(cfg: RequestRulesConfig): void {
        if (!this.activeContext) {
            return; // 兜住「watcher 晚于 run 结束一拍触发」的竞态
        }
        void this.applyReplayRewrite(cfg).catch(() => undefined);
        this.applyReplayRecord(cfg);
        this.applyReplayResend(cfg);
        this.applyReplayDump(cfg);
        this.applyReplayBodyReplace(cfg);
        this.applyReplayJsHook(cfg);
    }

    /**
     * 按配置启用/停用改写 route(仿录制端 applyPatterns):enabled 且有规则才 context.route,
     * 否则 context.unroute——**未启用零 route 开销**(不给不用改写的回放加延迟)。规则变化时
     * handler 读实时 this.rewriteRules 自动生效(rules 一并热更新)。
     */
    private async applyReplayRewrite(cfg: RequestRulesConfig): Promise<void> {
        const ctx = this.activeContext;
        if (!ctx || !this.rewriteHandler) {
            return;
        }
        // 支路分闸:某支路被 sections 关掉 → 该数组视作空,下游 want / matchRule 天然把它当无规则。
        // 四支路共用同一个 route handler,故必须在此各自分闸,而非只在合并的 want 上关。
        this.rewriteRules = sectionEnabled(cfg, 'rules') ? cfg.rules ?? [] : [];
        this.responseHeaderRules = sectionEnabled(cfg, 'responseRules') ? cfg.responseRules ?? [] : [];
        this.requestHeaderRules = sectionEnabled(cfg, 'requestHeaderRules')
            ? cfg.requestHeaderRules ?? []
            : [];
        this.blockRules = sectionEnabled(cfg, 'blocks') ? cfg.blocks ?? [] : [];
        // 改写 body / 响应头 / 请求头 / 真拦截规则 任一非空即需注册 route(只配其中一类也要拦)
        const want =
            cfg.enabled &&
            (this.rewriteRules.length > 0 ||
                this.responseHeaderRules.length > 0 ||
                this.requestHeaderRules.length > 0 ||
                this.blockRules.length > 0);
        try {
            if (want && !this.rewriteInstalled) {
                await ctx.route('**/*', this.rewriteHandler);
                this.rewriteInstalled = true;
                logInfo(
                    `回放请求改写器:已启用,改写 ${this.rewriteRules.length} 条 / ` +
                        `响应头改写 ${this.responseHeaderRules.length} 条 / ` +
                        `请求头改写 ${this.requestHeaderRules.length} 条 / ` +
                        `真拦截 ${this.blockRules.length} 条,匹配 URL:` +
                        [
                            ...this.rewriteRules,
                            ...this.responseHeaderRules,
                            ...this.requestHeaderRules,
                            ...this.blockRules,
                        ]
                            .map((r) => r.urlPattern)
                            .join(' | ')
                );
            } else if (!want && this.rewriteInstalled) {
                await ctx.unroute('**/*', this.rewriteHandler);
                this.rewriteInstalled = false;
                logInfo('回放请求改写器:已停用(enabled=false 或无规则)。');
            }
        } catch (err) {
            logError(`回放请求改写器:切换 route 失败:${(err as Error).message}`);
        }
    }

    /**
     * 回放端响应条件改写:命中 responseRules 的请求,按规则改写响应(头 / 状态码 / 响应体),或 mock 假响应。
     * 两条路径:
     * - **mock:true**:不发真实请求,直接用 setStatus/setBody/bodyReplaceFile/setHeaders 构造响应 fulfill;
     * - 缺省:route.fetch 拿真实响应(若同一 POST 也命中 body 改写 / 请求头改写规则则一并带上发出),
     *   再按 when 门槛叠加 响应头 / 状态码 / 响应体 覆盖后 fulfill。
     * 一旦 fetch 就已消费该请求,故后续统一 fulfill;仅出错才回退 route.continue(保持「每条必放行」铁律 I1)。
     * 改响应体时:显式重发头并**剥离 content-length**,交回放引擎按新体重算;只改头/状态时保留原响应体不动。
     * 任一步失败(读文件 / 解析)一律**失败即安全**——退回原响应,绝不悬空请求。
     * @param reqHeaders 请求头改写结果(null=不改;非 null 则作为 route.fetch 的 headers 入参一并发出)
     */
    private async handleResponseHeaderRoute(
        route: Route,
        request: Request,
        respRule: ResponseHeaderRule,
        reqHeaders: Record<string, string> | null
    ): Promise<void> {
        // 剥离 content-length(大小写不敏感):覆盖/构造响应体后交引擎按新体重算,避免声明长度≠实际体
        const stripCL = (h: Record<string, string>): Record<string, string> => {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(h || {})) {
                if (k.toLowerCase() !== 'content-length') {
                    out[k] = v;
                }
            }
            return out;
        };
        try {
            // ── mock:不发真实请求,直接构造假响应 ──
            if (respRule.mock === true) {
                const status = resolveMockStatus(respRule);
                let body: string | Buffer = typeof respRule.setBody === 'string' ? respRule.setBody : '';
                if (typeof respRule.setBody !== 'string' && respRule.bodyReplaceFile) {
                    try {
                        body = fs.readFileSync(respRule.bodyReplaceFile);
                    } catch (err) {
                        logError(
                            `回放响应改写器:mock 读响应体文件失败(用空体):${(err as Error).message}`
                        );
                        body = '';
                    }
                }
                const bodyLen = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
                logInfo(
                    `回放响应改写器:mock 假响应 [${request.url()}];status=${status};body=${bodyLen} 字节`
                );
                await route.fulfill({ status, headers: stripCL(respRule.setHeaders ?? {}), body });
                return;
            }
            // 若同一请求也命中 body 改写规则(POST),先算改后的 body 一并发出(两种改写可组合)
            const fetchOptions: { postData?: string; headers?: Record<string, string> } = {};
            if (request.method().toUpperCase() === 'POST') {
                const bodyRule = matchRule(this.rewriteRules, request.url());
                const original = request.postData();
                if (bodyRule && original) {
                    try {
                        const contentType = headerValue(request.headers(), 'content-type');
                        const bodyType = decideBodyType(bodyRule, contentType, original);
                        const newBody = rewritePostBody(original, bodyType, bodyRule);
                        if (newBody !== null) {
                            fetchOptions.postData = newBody;
                        }
                    } catch (err) {
                        logError(
                            `回放响应改写器:附带的 body 改写失败(用原 body 发出):${(err as Error).message}`
                        );
                    }
                }
            }
            // 请求头改写(组合 c):随 fetch 一并发出;fetch 已消费请求,不能再走 continue
            if (reqHeaders !== null) {
                fetchOptions.headers = reqHeaders;
            }
            const response = await route.fetch(fetchOptions);
            const headers = response.headers();
            const newHeaders = rewriteResponseHeaderRecord(headers, respRule); // 头覆盖(null=不改/条件不满足)
            // 响应体/状态码覆盖:与改头共用同一 when 门槛(resolveResponseOverride 判定)
            let bodyOverride: string | Buffer | null = null;
            let statusOverride: number | null = null;
            if (responseRuleHasBodyAction(respRule)) {
                const ov = resolveResponseOverride(headers, respRule);
                statusOverride = ov.status;
                if (ov.body !== null) {
                    bodyOverride = ov.body; // setBody 整体替换(优先,允许空串)
                } else if (ov.condMet && respRule.bodyReplaceFile) {
                    try {
                        bodyOverride = fs.readFileSync(respRule.bodyReplaceFile); // 文件字节整体替换
                    } catch (err) {
                        logError(
                            `回放响应改写器:读响应体文件失败(用原响应体):${(err as Error).message}`
                        );
                        bodyOverride = null; // 失败即安全
                    }
                }
            }
            if (bodyOverride !== null) {
                // 覆盖响应体:显式重发头(剥 content-length)+ 状态(未指定则保留原状态)+ 新体,不再带 response
                const baseHeaders = newHeaders ?? headers;
                const finalStatus = statusOverride !== null ? statusOverride : response.status();
                const bodyLen =
                    typeof bodyOverride === 'string' ? Buffer.byteLength(bodyOverride) : bodyOverride.length;
                logInfo(
                    `回放响应改写器:已改写响应体 [${request.url()}];status=${finalStatus};body=${bodyLen} 字节`
                );
                await route.fulfill({ status: finalStatus, headers: stripCL(baseHeaders), body: bodyOverride });
            } else if (newHeaders !== null || statusOverride !== null) {
                // 只改头 / 状态,不改体:以真实响应为基覆盖(响应体不变,content-length 无需动)
                const opts: { response: APIResponse; headers?: Record<string, string>; status?: number } = {
                    response,
                };
                if (newHeaders !== null) {
                    opts.headers = newHeaders;
                }
                if (statusOverride !== null) {
                    opts.status = statusOverride;
                }
                logInfo(
                    `回放响应改写器:已改写响应${newHeaders !== null ? '头' : ''}${statusOverride !== null ? '状态码=' + statusOverride : ''} [${request.url()}];` +
                        `set=${Object.keys(respRule.setHeaders ?? {}).join(',') || '无'};` +
                        `remove=${(respRule.removeHeaders ?? []).join(',') || '无'}`
                );
                await route.fulfill(opts);
            } else {
                // 条件不满足 / 无动作:用原响应回填(请求已被 fetch 消费,必须 fulfill 而非 continue)
                await route.fulfill({ response });
            }
        } catch (err) {
            logError(`回放响应改写器:处理响应出错(原样放行):${(err as Error).message}`);
            try {
                await route.continue();
            } catch {
                /* 请求可能已失效或已被 fetch 消费,忽略 */
            }
        }
    }

    /**
     * 按配置启用/停用/更新记录支路(仿录制端 applyRecording):监听已常挂,这里只建/停 recorder。
     * 开→关置 null 停写;关→开建**新** TimelineRecorder(新文件);仅 urlPattern/includeBody 变则原地更新。
     */
    private applyReplayRecord(cfg: RequestRulesConfig): void {
        const rec = cfg.record;
        const want = rec?.enabled === true;
        const key = JSON.stringify(rec ?? null);
        if (want && !this.recorder) {
            this.recorder = new TimelineRecorder(this.timelinesDir, 'replay', rec?.urlPattern);
            this.recordWantBody = rec?.includeBody !== false;
            this.recordCfgKey = key;
            logInfo(
                `回放请求记录:已启用(记录所有请求到时间线,不改写),匹配 URL:${rec?.urlPattern || '全部'};` +
                    `输出:${this.recorder.file}`
            );
        } else if (want && this.recorder && key !== this.recordCfgKey) {
            this.recorder.setPattern(rec?.urlPattern);
            this.recordWantBody = rec?.includeBody !== false;
            this.recordCfgKey = key;
            logInfo(`回放请求记录:配置已更新,匹配 URL:${rec?.urlPattern || '全部'}。`);
        } else if (!want && this.recorder) {
            this.recorder = null;
            this.recordCfgKey = '';
            logInfo('回放请求记录:已停用。');
        }
        // record.saveBodies:请求/响应体独立落盘(随 record.enabled 走,独立于 cfg.enabled;走 per-page CDP Fetch)。
        this.recordBodyRules = want ? rec?.saveBodies ?? [] : [];
        const bodyWant = this.recordBodyRules.length > 0;
        if (this.recordBodyWant !== bodyWant) {
            if (bodyWant) {
                // 关→开:建**新**精确索引文件(与 body 文件同目录);随后落盘时每文件追加一行
                this.recordBodyIndex = new RecordBodyIndex(this.dumpsDir);
                logInfo(
                    `record 体落盘:已启用,共 ${this.recordBodyRules.length} 条规则,` +
                        `匹配 URL:${this.recordBodyRules.map((r) => r.urlPattern).join(' | ')};` +
                        `输出目录:${this.dumpsDir};精确索引:${this.recordBodyIndex.file}`
                );
            } else {
                // 开→关:停写索引 + 清空计时 map
                this.recordBodyIndex = null;
                this.recordBodyStart.clear();
                logInfo('record 体落盘:已停用。');
            }
        }
        this.recordBodyWant = bodyWant;
        // 开启则对所有已知 page 补挂/更新 patterns,关闭则全部卸载(与 applyReplayDump 同构的热更新)
        void this.refreshDumpCdp();
    }

    /**
     * 按配置启用/停用重发支路(仿 applyReplayRewrite/Record):观察监听已常挂,这里只切标志。
     * 把 resends 按有无 responseTrigger 拆两组:请求触发(原行为)+ 响应触发(新)。
     * 关→开记日志;两组均关闭时清掉未触发的定时器(定时器共享,热关即时停)。
     */
    private applyReplayResend(cfg: RequestRulesConfig): void {
        // 链式跳数上限:有效正整数才覆盖默认 5,clamp 到 [1,100](与 store 归一化一致,双保险)
        if (
            typeof cfg.maxResendHops === 'number' &&
            Number.isFinite(cfg.maxResendHops) &&
            cfg.maxResendHops >= 1
        ) {
            this.maxResendHops = Math.min(Math.floor(cfg.maxResendHops), 100);
        }
        // 支路分闸:resends 被 sections 关掉 → 请求触发 + 响应触发两组都视作空(一处覆盖两者)。
        const all = sectionEnabled(cfg, 'resends') ? cfg.resends ?? [] : [];
        this.resendRules = all.filter((r) => !r.responseTrigger);
        this.responseResendRules = all.filter((r) => !!r.responseTrigger);
        // 加载期语法体检:带 when 的规则若表达式语法错,一次性中文告警(该规则将永不命中,避免静默失效)
        for (const rr of this.responseResendRules) {
            const w = rr.responseTrigger?.when;
            if (w && w.trim()) {
                const err = checkExprSyntax(w);
                if (err) {
                    const sig = `when-syntax:${w}`;
                    if (!this.resendMissWarned.has(sig)) {
                        this.resendMissWarned.add(sig);
                        logInfo(
                            `回放请求重发器(响应触发):规则 [${rr.urlPattern}] 的 when 表达式语法错误,将永不命中(请修正):${err}`
                        );
                    }
                }
            }
        }
        const want = cfg.enabled && this.resendRules.length > 0;
        const respWant = cfg.enabled && this.responseResendRules.length > 0;
        const prevAny = this.resendWant || this.resendResponseWant;
        const nowAny = want || respWant;
        if (prevAny && !nowAny) {
            this.clearResendTimers(); // 两组都关才清 pending
        }
        // 请求触发组日志
        if (!this.resendWant && want) {
            logInfo(
                `回放请求重发器(请求触发):已启用,共 ${this.resendRules.length} 条规则,` +
                    `触发 URL:${this.resendRules.map((r) => r.urlPattern).join(' | ')}`
            );
        } else if (this.resendWant && !want) {
            logInfo('回放请求重发器(请求触发):已停用。');
        }
        // 响应触发组日志
        if (!this.resendResponseWant && respWant) {
            logInfo(
                `回放请求重发器(响应触发):已启用,共 ${this.responseResendRules.length} 条规则,` +
                    `监听→重发:${this.responseResendRules
                        .map((r) => `${r.responseTrigger?.triggerUrl} → ${r.urlPattern}`)
                        .join(' | ')}`
            );
        } else if (this.resendResponseWant && !respWant) {
            logInfo('回放请求重发器(响应触发):已停用。');
        }
        this.resendWant = want;
        this.resendResponseWant = respWant;
    }

    /**
     * 响应条件触发重发:被动观察每条响应,遍历所有响应触发规则——命中某规则的 triggerUrl 且
     * status/headers/bodyJson 条件满足时,重发④已捕获的、命中该规则 urlPattern 的那个请求。
     * 门控:resendResponseWant;防递归:自发重发的响应(其请求带 x-macro-resend)跳过。
     * 未捕获到目标请求 → 记日志跳过本次(不中断回放)。读体竞态(context 关闭)与任何异常都吞掉。
     */
    private async handleResponseTrigger(resp: Response): Promise<void> {
        try {
            if (!this.resendResponseWant) {
                return;
            }
            const reqHeaders = resp.request().headers(); // triggerUrl 那条请求的头(供 requestHeaders 条件用 + 读跳数)
            // 链式熔断:触发响应所属请求已达跳数上限 → 不再继续触发(支持连环的同时防无限自环/互环)。
            // 真实浏览器请求 hop=0 正常放行;工具重发的响应带 hop>=1,未达上限时也放行以支持连环触发。
            const triggerHop = resendHop(reqHeaders);
            if (triggerHop >= this.maxResendHops) {
                const sig = `hopcap:${triggerHop}`;
                if (!this.resendMissWarned.has(sig)) {
                    this.resendMissWarned.add(sig);
                    logInfo(
                        `回放请求重发器(响应触发):链式重发已达跳数上限 ${this.maxResendHops}(当前第 ${triggerHop} 跳),熔断,不再继续触发(防无限自环)。`
                    );
                }
                return;
            }
            const status = resp.status();
            const headers = resp.headers();
            const url = resp.url();
            // 响应体最多懒读一次,多条规则命中同一响应时复用
            let bodyText: string | null = null;
            let bodyRead = false;
            for (const rr of this.responseResendRules) {
                const trigger = rr.responseTrigger;
                if (!trigger || !trigger.triggerUrl) {
                    continue;
                }
                try {
                    if (!globToRegExp(trigger.triggerUrl).test(url)) {
                        continue;
                    }
                } catch {
                    continue; // 非法 triggerUrl 跳过
                }
                if (triggerNeedsBody(trigger) && !bodyRead) {
                    bodyRead = true;
                    try {
                        bodyText = await resp.text();
                    } catch {
                        bodyText = null; // 读不到(竞态/中断)→ 有 body 条件的规则将不命中
                    }
                }
                if (!responseTriggerMet(trigger, status, headers, bodyText, reqHeaders, triggerHop)) {
                    // 诊断:triggerUrl 命中但条件没过 → 说清为什么(缺哪个子串/实际片段/仅空白差异/请求头不符),
                    // 按失败模式去重限流,避免轮询期刷屏。
                    const miss = explainResponseTriggerMiss(
                        trigger,
                        status,
                        headers,
                        bodyText,
                        reqHeaders,
                        triggerHop
                    );
                    if (miss && !this.resendMissWarned.has(miss.signature)) {
                        this.resendMissWarned.add(miss.signature);
                        logInfo(
                            `回放请求重发器(响应触发):未命中 [${rr.urlPattern}] ← ${miss.message}`
                        );
                    }
                    continue;
                }
                const cap = this.resendCaptures.get(rr.urlPattern);
                if (!cap) {
                    logInfo(
                        `回放请求重发器(响应触发):命中 triggerUrl 但尚未捕获到 [${rr.urlPattern}] 的请求,跳过本次重发。`
                    );
                    continue;
                }
                // 从触发响应提取命名变量(复用已读的响应头/体),供动作字段 {{占位符}} 注入重发
                const vars = extractResendVars(trigger, headers, bodyText);
                // 新重发跳数 = 触发源跳数 + 1(链式接力;真实源 hop0 → 首发 hop1)
                this.scheduleReplayResend(rr, cap, triggerHop + 1, vars);
            }
        } catch {
            /* 响应触发支路不得影响主流程 */
        }
    }

    /**
     * 按配置启用/停用请求体落盘支路(仿 applyReplayResend):观察监听已常挂,这里只切标志。
     * enabled 且有落盘规则才处理;关→开/开→关各记一条日志。
     */
    private applyReplayDump(cfg: RequestRulesConfig): void {
        this.dumpRules = sectionEnabled(cfg, 'dumps') ? cfg.dumps ?? [] : [];
        const want = cfg.enabled && this.dumpRules.length > 0;
        if (this.dumpWant && !want) {
            logInfo('回放请求体落盘:已停用。');
        } else if (!this.dumpWant && want) {
            logInfo(
                `回放请求体落盘:已启用,共 ${this.dumpRules.length} 条落盘规则,` +
                    `匹配 URL:${this.dumpRules.map((r) => r.urlPattern).join(' | ')};` +
                    `输出目录:${this.dumpsDir}`
            );
        }
        this.dumpWant = want;
        // 落盘走 per-page CDP Fetch:开启则对所有已知 page 补挂/更新 patterns,关闭则全部卸载(热更新)
        void this.refreshDumpCdp();
    }

    /**
     * 按配置启用/停用请求体整体替换支路(仿 applyReplayDump):与 dump 共用 per-page CDP Fetch。
     * enabled 且有替换规则才处理;关→开/开→关各记一条日志;尾部刷新 CDP(补挂/更新 patterns/卸载)。
     */
    private applyReplayBodyReplace(cfg: RequestRulesConfig): void {
        this.replaceRules = sectionEnabled(cfg, 'bodyReplaces') ? cfg.bodyReplaces ?? [] : [];
        const want = cfg.enabled && this.replaceRules.length > 0;
        if (this.replaceWant && !want) {
            logInfo('回放请求体替换:已停用。');
        } else if (!this.replaceWant && want) {
            logInfo(
                `回放请求体替换:已启用,共 ${this.replaceRules.length} 条替换规则,` +
                    `匹配 URL:${this.replaceRules.map((r) => r.urlPattern).join(' | ')}`
            );
        }
        this.replaceWant = want;
        void this.refreshDumpCdp();
    }

    /**
     * 把一条命中请求的完整二进制请求体写成一个文件(缺省 .mp4)。文件名用毫秒戳 + 自增序号防撞名;
     * 目录懒建。写失败只记日志不抛(落盘支路不得影响回放)。**完整字节、禁止截断**。
     */
    private writeDumpFile(rule: DumpRule, buf: Buffer, url: string): void {
        try {
            if (!this.dumpsReady) {
                fs.mkdirSync(this.dumpsDir, { recursive: true });
                this.dumpsReady = true;
            }
            this.dumpSeq += 1;
            const ext = (rule.extension || 'mp4').replace(/^\./, ''); // 容忍带或不带前导点
            const file = path.join(this.dumpsDir, `dump-${Date.now()}-${this.dumpSeq}.${ext}`);
            fs.writeFileSync(file, buf); // 一次性写完整二进制,不做任何大小上限/截断
            logInfo(`回放请求体落盘:已保存 ${buf.length} 字节 [${url}] → ${file}`);
        } catch (err) {
            logError(`回放请求体落盘:写文件失败(不影响回放):${(err as Error).message}`);
        }
    }

    /**
     * record.saveBodies:把命中请求的完整请求体/响应体写成一个独立文件(**完整字节、禁止截断**)。
     * 文件名 rec-<毫秒戳>-<safeId>-<req|res>.<ext>——同一 CDP requestId 使请求体/响应体文件天然配对;
     * 后缀优先规则显式配(requestExt/responseExt),否则按 content-type 推断,推不出用 bin。
     * 复用 dumpsDir + dumpsReady 懒建;写失败只记日志不抛(落盘支路不得影响回放)。
     */
    private writeRecordBodyFile(
        rule: BodySaveRule,
        buf: Buffer,
        url: string,
        requestId: string,
        kind: 'req' | 'res',
        contentType?: string
    ): string | null {
        try {
            if (!this.dumpsReady) {
                fs.mkdirSync(this.dumpsDir, { recursive: true });
                this.dumpsReady = true;
            }
            const explicit = kind === 'req' ? rule.requestExt : rule.responseExt;
            const ext = (explicit || extFromContentType(contentType) || 'bin').replace(/^\./, '');
            const safeId = requestId.replace(/[^A-Za-z0-9_]/g, '_'); // 消毒:仅留字母数字下划线,使文件名可按 '-' 稳定分段(req/res 配对)
            const name = `rec-${Date.now()}-${safeId}-${kind}.${ext}`;
            const file = path.join(this.dumpsDir, name);
            fs.writeFileSync(file, buf); // 一次性写完整字节,不做任何大小上限/截断
            logInfo(
                `record ${kind === 'req' ? '请求' : '响应'}体落盘:已保存 ${buf.length} 字节 [${url}] → ${file}`
            );
            return name; // 返回 basename,供 onDumpRequestPaused 写进精确索引
        } catch (err) {
            logError(
                `record ${kind === 'req' ? '请求' : '响应'}体落盘:写文件失败(不影响回放):${(err as Error).message}`
            );
            return null;
        }
    }

    // ===== JS Hook 探针(jsHooks):主世界注入抓明文↔密文 + 回传落盘 =====

    /**
     * 向页面主世界一次性注入抓取脚本 + 挂 exposeBinding 回传管子(仅当 session 配置了 jsHooks 支路)。
     * 必须在第一个 goto 之前、挂在 context 上——自动覆盖初始页与后续所有弹窗,无需 per-page 补挂。
     * addInitScript/exposeBinding **不可撤销**,故恒装恒抓;「落不落盘」由 applyReplayJsHook 的 jsHookWant 热控。
     */
    private async installJsHookProbe(context: BrowserContext): Promise<void> {
        if (this.jsHookScriptInstalled) {
            return;
        }
        const j = this.session.requestRules?.jsHooks;
        if (!j) {
            return; // 未配置 jsHooks 支路 → 完全不注入,对现有用户零影响
        }
        const injectCfg = buildInjectConfig(j.rules ?? []);
        try {
            await context.exposeBinding('__macroProbe', (_src, payload) => {
                this.onJsHookProbe(payload as JsHookProbePayload);
            });
            await context.addInitScript({ content: buildJsHookInitScript(injectCfg) });
            this.jsHookScriptInstalled = true;
            logInfo(
                `JS Hook 探针:已注入主世界抓取脚本(基础集:${injectCfg.apis.join(',') || '无'};` +
                    `自定义函数:${injectCfg.hookPaths.join(',') || '无'})。`
            );
        } catch (err) {
            logError(`JS Hook 探针:注入失败(不影响回放):${(err as Error).message}`);
        }
    }

    /**
     * exposeBinding 回调:页面主世界每次 hook 命中回传一条 payload。按最新 jsHookWant + URL 过滤后落盘:
     * 短明文/短密文内联进索引,超 maxInline 或二进制的 payload 旁落独立文件(完整不截断)。整体 try/catch,不拖垮回放。
     */
    private onJsHookProbe(payload: JsHookProbePayload): void {
        try {
            if (!this.jsHookWant || !this.jsHookIndex) {
                return; // 支路已停用(注入脚本仍在抓,这里丢弃)
            }
            if (!this.jsHookMatch(payload.url ?? '')) {
                return;
            }
            // 防爆上限:高频 api(如 JSON.stringify)刷爆时熔断——达上限即停止记录并告警一次(不静默丢弃)
            if (this.jsHookCount >= this.jsHookMaxEntries) {
                if (!this.jsHookLimitWarned) {
                    this.jsHookLimitWarned = true;
                    logInfo(
                        `JS Hook 探针:本次回放命中已达上限 ${this.jsHookMaxEntries} 条,后续命中不再记录(调大 jsHooks.maxEntries 可放宽)。`
                    );
                }
                return;
            }
            const inp = this.materializeHookField(payload.input, payload.inputEnc, 'in');
            const out = this.materializeHookField(payload.output, payload.outputEnc, 'out');
            this.jsHookIndex.writeEntry({
                api: payload.api ?? 'unknown',
                url: payload.url ?? '',
                input: inp.inline,
                inputEnc: inp.enc,
                inputFile: inp.file,
                output: out.inline,
                outputEnc: out.enc,
                outputFile: out.file,
                stack: payload.stack,
            });
            this.jsHookCount += 1;
        } catch (err) {
            logError(`JS Hook 探针:处理回传出错(不影响回放):${(err as Error).message}`);
        }
    }

    /**
     * 决定一个 hook 字段(明文/密文)内联进索引还是旁落文件:字节 ≤ maxInline 内联(base64 保留标注),
     * 否则写成独立文件返回文件名(完整不截断)。落盘失败退回内联,保证数据不丢。
     */
    private materializeHookField(
        s: string | undefined,
        enc: 'base64' | undefined,
        kind: 'in' | 'out'
    ): { inline?: string; enc?: 'base64'; file?: string } {
        if (s === undefined) {
            return {};
        }
        const buf = enc === 'base64' ? Buffer.from(s, 'base64') : Buffer.from(s, 'utf-8');
        if (buf.length <= this.jsHookMaxInline) {
            return enc ? { inline: s, enc } : { inline: s };
        }
        const file = this.writeJsHookFile(buf, kind, enc);
        return file ? { file } : enc ? { inline: s, enc } : { inline: s };
    }

    /**
     * 把超阈值/二进制的 hook payload 写成独立文件(**完整字节、禁止截断**)。命名 jshook-<戳>-<seq>-<in|out>.<ext>;
     * 二进制(base64)用 .bin、文本用 .txt。复用 dumpsDir + dumpsReady 懒建;写失败只记日志返回 null。
     */
    private writeJsHookFile(buf: Buffer, kind: 'in' | 'out', enc?: 'base64'): string | null {
        try {
            if (!this.dumpsReady) {
                fs.mkdirSync(this.dumpsDir, { recursive: true });
                this.dumpsReady = true;
            }
            this.jsHookSeq += 1;
            const ext = enc === 'base64' ? 'bin' : 'txt';
            const name = `jshook-${Date.now()}-${this.jsHookSeq}-${kind}.${ext}`;
            fs.writeFileSync(path.join(this.dumpsDir, name), buf); // 一次性写完整字节,不截断
            return name;
        } catch (err) {
            logError(`JS Hook 探针:写旁落文件失败(不影响回放):${(err as Error).message}`);
            return null;
        }
    }

    /** 当前页面 URL 是否命中任一 jsHooks 规则的 urlPattern(无规则 = 全抓;规则无 urlPattern = 匹配所有页面)。 */
    private jsHookMatch(url: string): boolean {
        if (this.jsHookRules.length === 0) {
            return true;
        }
        return this.jsHookRules.some((r) => {
            if (!r.urlPattern) {
                return true;
            }
            try {
                return globToRegExp(r.urlPattern).test(url);
            } catch {
                return true; // 非法 pattern 兜底放行(与 matchRule 容错一致)
            }
        });
    }

    /**
     * 按配置启用/停用 JS Hook 探针支路(随 jsHooks.enabled,**独立于 cfg.enabled**)。注入脚本 + exposeBinding
     * 在 run() 首个 goto 前由 installJsHookProbe 一次性装(恒抓);此处只切 want/规则/阈值/索引对象——
     * 热更新即时改「落不落盘」与「URL 过滤」,但「包裹哪些 api/函数」由装载时快照决定(注入不可撤销)。
     */
    private applyReplayJsHook(cfg: RequestRulesConfig): void {
        const j = cfg.jsHooks;
        const want = j?.enabled === true;
        this.jsHookRules = want ? j?.rules ?? [] : [];
        this.jsHookMaxInline = pickMaxInline(this.jsHookRules);
        this.jsHookMaxEntries =
            typeof j?.maxEntries === 'number' && j.maxEntries > 0 ? Math.floor(j.maxEntries) : 20000;
        if (this.jsHookWant !== want) {
            if (want) {
                if (!this.jsHookIndex) {
                    this.jsHookIndex = new JsHookIndex(this.dumpsDir);
                }
                this.jsHookCount = 0; // 新一轮回放:命中计数与告警标志归零
                this.jsHookLimitWarned = false;
                logInfo(
                    `JS Hook 探针:已启用,共 ${this.jsHookRules.length} 条规则;` +
                        `输出目录:${this.dumpsDir};索引:${this.jsHookIndex.file}`
                );
            } else {
                this.jsHookIndex = null;
                logInfo('JS Hook 探针:已停用(注入脚本仍在页面,回传将被丢弃)。');
            }
        }
        this.jsHookWant = want;
    }

    // ===== 请求体落盘的 CDP Fetch 拦截(抓 File/Blob 上传体;Playwright postDataBuffer 对 Blob 返回 null)=====

    /**
     * dump/整体替换/record 落请求体 → 请求阶段 pattern;record 落响应体 → 响应阶段 pattern。
     * 只暂停命中 URL 的对应阶段,降开销。同一 URL 既落请求体又落响应体则出两条 pattern(各一阶段)。
     */
    private dumpFetchPatterns(): Array<{ urlPattern: string; requestStage: 'Request' | 'Response' }> {
        const reqUrls = new Set<string>(); // 需在请求阶段暂停的 URL
        const resUrls = new Set<string>(); // 需在响应阶段暂停的 URL
        for (const r of this.dumpRules) {
            reqUrls.add(r.urlPattern);
        }
        for (const r of this.replaceRules) {
            reqUrls.add(r.urlPattern);
        }
        for (const r of this.recordBodyRules) {
            if (r.request !== false) {
                reqUrls.add(r.urlPattern);
            }
            if (r.response !== false) {
                resUrls.add(r.urlPattern);
            }
        }
        const patterns: Array<{ urlPattern: string; requestStage: 'Request' | 'Response' }> = [];
        for (const urlPattern of reqUrls) {
            patterns.push({ urlPattern, requestStage: 'Request' });
        }
        for (const urlPattern of resUrls) {
            patterns.push({ urlPattern, requestStage: 'Response' });
        }
        return patterns;
    }

    /** dump / 整体替换 / record 落 body 任一启用(决定是否需要挂 CDP Fetch 拦截) */
    private cdpFetchWant(): boolean {
        return (
            (this.dumpWant && this.dumpRules.length > 0) ||
            (this.replaceWant && this.replaceRules.length > 0) ||
            (this.recordBodyWant && this.recordBodyRules.length > 0)
        );
    }

    /** 是否需要 per-page CDP session:Fetch(saveBodies/dump/整体替换)或 Network(record 时间线)任一需要 */
    private cdpSessionWant(): boolean {
        return this.cdpFetchWant() || this.recorder !== null;
    }

    /**
     * 从 CDP 暂停请求里重组**完整二进制**请求体:优先 postDataEntries(base64 分块,对 File/Blob 保真)
     * 逐块 Buffer.concat;为空则回退事件自带 postData 字符串(小文本 body);都无返回 null。禁止截断。
     */
    private reassemblePostData(request: CdpPausedRequest): Buffer | null {
        const entries = request.postDataEntries;
        if (Array.isArray(entries) && entries.length > 0) {
            const bufs: Buffer[] = [];
            for (const e of entries) {
                if (e && typeof e.bytes === 'string') {
                    bufs.push(Buffer.from(e.bytes, 'base64'));
                }
            }
            if (bufs.length > 0) {
                return Buffer.concat(bufs);
            }
        }
        if (typeof request.postData === 'string' && request.postData.length > 0) {
            return Buffer.from(request.postData, 'utf8');
        }
        return null;
    }

    /**
     * 给一个 page 挂 per-page CDP session:按需启用 Fetch 域(saveBodies/dump/整体替换,请求阶段暂停)与
     * Network 域(record 时间线,被动全站不暂停)。幂等;都不需要或已挂则跳过;挂载失败记告警、该页不生效、不致命。
     * 每个 session 分配一个编号前缀 sid,使 record id / rec-index networkId 跨 session 不撞号。
     */
    private async attachDumpCdp(page: Page): Promise<void> {
        if (!this.cdpSessionWant() || this.dumpCdpSessions.has(page)) {
            return;
        }
        const ctx = this.activeContext;
        if (!ctx) {
            return;
        }
        let targetId: string | undefined;
        try {
            const cdp = await ctx.newCDPSession(page);
            // 按 CDP targetId 去重:持久 context 的多 Page 对象 / context.on('page') 多次事件可能都指向**同一底层
            // target**,若各挂一个 session 会把同一批请求记/落多遍(实测同一 delete 被记 3 遍、落 3 份)。一个 target
            // 只保留一个记录 session,重复的直接 detach 跳过。拿不到 targetId 时退化为按 Page 幂等(不去重),不致命。
            try {
                const info = (await cdp.send('Target.getTargetInfo')) as {
                    targetInfo?: { targetId?: string };
                };
                targetId = info.targetInfo?.targetId;
            } catch {
                /* 拿不到 targetId:退化按 Page 幂等 */
            }
            if (targetId && this.attachedTargets.has(targetId)) {
                logInfo(
                    `回放 CDP 会话:target 已挂记录 session,跳过该 page 的重复 session(去重防同一 target 被记多遍)[${page.url()}]`
                );
                try {
                    await cdp.detach();
                } catch {
                    /* 忽略 */
                }
                return;
            }
            if (targetId) {
                this.attachedTargets.add(targetId);
            }
            this.dumpCdpSessions.set(page, cdp);
            const sid = String(this.cdpSessionSeq++);
            this.cdpSessionIds.set(page, sid);
            logInfo(`回放 CDP 会话已挂:sid=${sid} target=${targetId ?? '?'} [${page.url()}]`);
            // Network 域(record 时间线)**先** enable:确保不漏该页任何请求的 requestWillBeSent(全站覆盖红线);
            // 被动监听、不暂停、含 loadingFailed 记失败。若 Fetch 先 enable 会暂停请求、抢在 Network 之前,
            // record 可能错过该请求的 requestWillBeSent(实测首次冷启动会漏)。
            if (this.recorder) {
                await this.attachRecordNetwork(cdp, sid);
            }
            // Fetch 域(saveBodies/dump/整体替换)**后** enable:请求阶段暂停命中 URL。注:dump(CDP Fetch)与
            // 改写/真拦截(Playwright route,底层亦 CDP Fetch)命中同一 URL 各自拦截同一请求,实测共存不冲突。
            if (this.cdpFetchWant()) {
                cdp.on('Fetch.requestPaused', (params: CdpRequestPaused) => {
                    void this.onDumpRequestPaused(cdp, sid, params);
                });
                await cdp.send('Fetch.enable', { patterns: this.dumpFetchPatterns() });
            }
        } catch (err) {
            this.dumpCdpSessions.delete(page);
            this.cdpSessionIds.delete(page);
            if (targetId) {
                this.attachedTargets.delete(targetId);
            }
            logError(`回放 CDP 会话挂载失败(该页不落盘/不记录,不影响回放):${(err as Error).message}`);
        }
    }

    /**
     * 在给定 CDP session 上启用 Network 域并挂 record 时间线监听(被动、全站、不暂停;含 loadingFailed 记失败)。
     * 幂等(networkEnabledSessions 去重)。移植自录制端 request-interceptor 的 onNetworkEvent,差异:
     * **响应行在 responseReceived 就写**(不等 loadingFinished),规避「宏结束 context 立即关闭、异步来不及」竞态。
     * 每条 id = `${sid}#${Network requestId}`,与 saveBodies rec-index 的 networkId 一致 → 精确 join。
     */
    private async attachRecordNetwork(cdp: CDPSession, sid: string): Promise<void> {
        if (this.networkEnabledSessions.has(cdp)) {
            return;
        }
        this.networkEnabledSessions.add(cdp);
        // per-session 暂存:Network requestId → 请求元数据 + 起始时刻(等响应/失败事件补齐后写响应行)
        const pending = new Map<string, { id: string; url: string; method: string; startTs: number }>();
        cdp.on(
            'Network.requestWillBeSent',
            (p: { requestId: string; request: CdpNetworkRequest; timestamp: number }) => {
                try {
                    const rec = this.recorder;
                    if (!rec || !rec.matches(p.request.url)) {
                        return;
                    }
                    pending.set(p.requestId, {
                        id: `${sid}#${p.requestId}`,
                        url: p.request.url,
                        method: p.request.method,
                        startTs: p.timestamp,
                    });
                    void this.emitRecordRequestLine(cdp, sid, p.requestId, p.request);
                } catch {
                    /* 记录支路不得影响主流程 */
                }
            }
        );
        cdp.on(
            'Network.responseReceived',
            (p: {
                requestId: string;
                timestamp: number;
                response: { status: number; mimeType?: string; headers?: Record<string, string> };
            }) => {
                try {
                    const rec = this.recorder;
                    const m = pending.get(p.requestId);
                    if (!rec || !m) {
                        return;
                    }
                    // 红线⑥:响应头到达即写响应行(不等 loadingFinished),规避 context 关闭竞态
                    rec.writeResponse({
                        id: m.id,
                        method: m.method,
                        url: m.url,
                        status: p.response.status,
                        timingMs: Math.round((p.timestamp - m.startTs) * 1000),
                        respHeaders: p.response.headers,
                        mimeType: p.response.mimeType || undefined,
                    });
                    pending.delete(p.requestId);
                } catch {
                    /* 记录支路不得影响主流程 */
                }
            }
        );
        cdp.on(
            'Network.loadingFailed',
            (p: { requestId: string; timestamp: number; errorText?: string }) => {
                try {
                    const rec = this.recorder;
                    const m = pending.get(p.requestId);
                    if (!rec || !m) {
                        return; // 无 responseReceived 的失败(DNS/连接/被拦)才走这里
                    }
                    rec.writeResponse({
                        id: m.id,
                        method: m.method,
                        url: m.url,
                        timingMs: Math.round((p.timestamp - m.startTs) * 1000),
                        error: p.errorText,
                    });
                    pending.delete(p.requestId);
                } catch {
                    /* 记录支路不得影响主流程 */
                }
            }
        );
        await cdp.send('Network.enable');
    }

    /** 写一条 record 请求行:includeBody 时用 Network.getRequestPostData 取**完整** body(禁止截断) */
    private async emitRecordRequestLine(
        cdp: CDPSession,
        sid: string,
        requestId: string,
        request: CdpNetworkRequest
    ): Promise<void> {
        const rec = this.recorder;
        if (!rec) {
            return;
        }
        let reqBody: string | undefined;
        if (this.recordWantBody && request.hasPostData) {
            try {
                const r = (await cdp.send('Network.getRequestPostData', { requestId })) as {
                    postData?: string;
                };
                reqBody = typeof r.postData === 'string' ? r.postData : request.postData;
            } catch {
                reqBody = request.postData; // 无 body / 请求已失效:回退事件自带值(可能 undefined)
            }
        }
        rec.writeRequest({
            id: `${sid}#${requestId}`,
            method: request.method,
            url: request.url,
            reqHeaders: request.headers,
            reqBody,
        });
    }

    /**
     * CDP Fetch.requestPaused 处理:先按 dump 规则落盘原始 body,再按替换规则用文件字节整体替换后放行。
     * dump 读旧、替换发新,可同时命中。**每条路径恰好放行一次**(替换命中即带 postData 放行并 return)。
     */
    private async onDumpRequestPaused(
        cdp: CDPSession,
        sid: string,
        params: CdpRequestPaused
    ): Promise<void> {
        const { requestId, request } = params;
        const isResponseStage = params.responseStatusCode !== undefined;
        // join 键:与 record 时间线的 id 同构(`${sid}#${networkId}`);拿不到 networkId 则省略
        const joinKey =
            typeof params.networkId === 'string' ? `${sid}#${params.networkId}` : undefined;
        try {
            if (isResponseStage) {
                // 响应阶段:只可能因 record.saveBodies 的 Response pattern 到这里。命中且要落响应体则取体落盘。
                if (!isResendOrigin(request.headers)) {
                    const rule = matchRule(this.recordBodyRules, request.url);
                    if (
                        rule &&
                        rule.response !== false &&
                        (!rule.method ||
                            rule.method.toUpperCase() === request.method.toUpperCase())
                    ) {
                        try {
                            const r = (await cdp.send('Fetch.getResponseBody', { requestId })) as {
                                body: string;
                                base64Encoded: boolean;
                            };
                            const buf = Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8');
                            if (buf.length > 0) {
                                const mimeType = headerListValue(
                                    params.responseHeaders,
                                    'content-type'
                                );
                                const file = this.writeRecordBodyFile(
                                    rule,
                                    buf,
                                    request.url,
                                    requestId,
                                    'res',
                                    mimeType
                                );
                                if (file) {
                                    const start = this.recordBodyStart.get(requestId);
                                    if (start !== undefined) {
                                        this.recordBodyStart.delete(requestId);
                                    }
                                    this.recordBodyIndex?.writeResponse({
                                        requestId,
                                        networkId: joinKey,
                                        method: request.method,
                                        url: request.url,
                                        file,
                                        status: params.responseStatusCode,
                                        mimeType,
                                        timingMs:
                                            start !== undefined ? Date.now() - start : undefined,
                                    });
                                }
                            }
                        } catch (err) {
                            logError(
                                `record 响应体落盘:取响应体失败(不影响回放):${(err as Error).message}`
                            );
                        }
                    }
                }
                // 铁律:响应阶段必须用 continueResponse 放行(continueRequest 在响应阶段无效,会挂起页面)
                try {
                    await cdp.send('Fetch.continueResponse', { requestId });
                } catch {
                    /* 请求/会话可能已失效,忽略 */
                }
                return;
            }
            // ↓ 请求阶段
            if (!isResendOrigin(request.headers)) {
                // ① dump:命中则重组完整原始 body 落盘(落的是替换前的原始字节)
                const dumpRule = matchRule(this.dumpRules, request.url);
                if (
                    dumpRule &&
                    (!dumpRule.method ||
                        dumpRule.method.toUpperCase() === request.method.toUpperCase())
                ) {
                    const buf = this.reassemblePostData(request);
                    if (buf && buf.length > 0) {
                        this.writeDumpFile(dumpRule, buf, request.url);
                    }
                }
                // ①b record.saveBodies:命中且要落请求体则重组原始 body 落盘(与 dump 并列,落替换前字节)
                const recRule = matchRule(this.recordBodyRules, request.url);
                if (
                    recRule &&
                    recRule.request !== false &&
                    (!recRule.method ||
                        recRule.method.toUpperCase() === request.method.toUpperCase())
                ) {
                    const buf = this.reassemblePostData(request);
                    if (buf && buf.length > 0) {
                        const file = this.writeRecordBodyFile(
                            recRule,
                            buf,
                            request.url,
                            requestId,
                            'req',
                            headerValue(request.headers, 'content-type')
                        );
                        if (file) {
                            this.recordBodyStart.set(requestId, Date.now()); // 供响应阶段算 timingMs
                            this.recordBodyIndex?.writeRequest({
                                requestId,
                                networkId: joinKey,
                                method: request.method,
                                url: request.url,
                                file,
                            });
                        }
                    }
                }
                // ② 整体替换:命中则用本地文件字节整体替换请求体后放行(读文件失败落到末尾原样放行)
                const rr = matchRule(this.replaceRules, request.url);
                if (
                    rr &&
                    (!rr.method || rr.method.toUpperCase() === request.method.toUpperCase())
                ) {
                    try {
                        const nb = fs.readFileSync(rr.replaceWithFile);
                        await cdp.send('Fetch.continueRequest', {
                            requestId,
                            postData: nb.toString('base64'), // CDP 要 base64;Content-Length 网络栈重算
                        });
                        logInfo(
                            `回放请求体替换:已用文件整体替换请求体 ${nb.length} 字节 [${request.url}] ← ${rr.replaceWithFile}`
                        );
                        return; // 已放行,不再走末尾
                    } catch (err) {
                        logError(
                            `回放请求体替换:读替换文件失败(原样放行不替换):${(err as Error).message}`
                        );
                    }
                }
            }
        } catch (err) {
            logError(`回放请求体拦截:CDP 处理请求出错:${(err as Error).message}`);
        }
        // 铁律:请求阶段每个暂停请求都必须放行,否则页面卡死(未命中替换/替换失败走这里原样放行)
        try {
            await cdp.send('Fetch.continueRequest', { requestId });
        } catch {
            /* 请求/会话可能已失效,忽略 */
        }
    }

    /**
     * CDP session 热更新:需要(Fetch 或 record Network 任一)则对所有已知 page 补挂(未挂的)/更新(已挂的:
     * 重下发 Fetch patterns + record 后来才开则补挂 Network),都不需要则全部卸载。在 applyReplayDump/Record 与
     * page 生命周期处驱动。
     */
    private async refreshDumpCdp(): Promise<void> {
        if (this.cdpSessionWant()) {
            for (const page of this.dumpPages) {
                const existing = this.dumpCdpSessions.get(page);
                if (!existing) {
                    await this.attachDumpCdp(page);
                    continue;
                }
                if (this.cdpFetchWant()) {
                    try {
                        await existing.send('Fetch.enable', { patterns: this.dumpFetchPatterns() });
                    } catch {
                        /* 会话可能已失效,下次 attach 重建 */
                    }
                }
                // record 后来才开(session 因 saveBodies 先挂)→ 补挂 Network(幂等)
                if (this.recorder && !this.networkEnabledSessions.has(existing)) {
                    const sid = this.cdpSessionIds.get(page) ?? String(this.cdpSessionSeq++);
                    this.cdpSessionIds.set(page, sid);
                    try {
                        await this.attachRecordNetwork(existing, sid);
                    } catch {
                        /* 补挂失败该页不记录,不致命 */
                    }
                }
            }
        } else {
            await this.detachAllDumpCdp();
        }
    }

    /** 卸载所有 per-page CDP 会话(Network/Fetch.disable + detach;context 关闭后 transport 已断会抛,全 try/catch)。 */
    private async detachAllDumpCdp(): Promise<void> {
        for (const cdp of this.dumpCdpSessions.values()) {
            try {
                await cdp.send('Network.disable');
            } catch {
                /* 忽略(可能未 enable Network) */
            }
            try {
                await cdp.send('Fetch.disable');
            } catch {
                /* 忽略 */
            }
            try {
                await cdp.detach();
            } catch {
                /* 忽略 */
            }
        }
        this.dumpCdpSessions.clear();
        this.cdpSessionIds.clear();
        this.networkEnabledSessions.clear();
        this.attachedTargets.clear();
    }

    /**
     * 命中重发规则后调度:去抖 → 算类型/改参/头 → repeat 次 setTimeout 延时发射。
     * base = 重发蓝本(url/method/头/体):请求触发时是触发请求本身,响应触发时是捕获到的 urlPattern 请求。
     * 目标 URL 恒为 base.url(已无 targetUrl 概念)。不改原请求,这里只额外发新请求。
     */
    private scheduleReplayResend(
        rr: ResendRule,
        base: { url: string; method: string; headers: Record<string, string>; body: string },
        hop = 1,
        vars: Record<string, string> = {}
    ): void {
        // 用提取到的变量渲染动作字段(set/append/setHeaders 里的 {{占位符}});vars 空 → 原样返回不动。
        // 后续 decideBodyType/rewritePostBody/buildResendHeaders 全部基于 eff(rr 的超集副本)。
        const eff = renderResendActions(rr, vars);
        // 去抖:同规则 dedupeMs 内只发一次(默认 0=每次命中都发)
        if (eff.dedupeMs && eff.dedupeMs > 0) {
            const now = Date.now();
            const last = this.resendLastFireAt.get(eff.urlPattern) ?? 0;
            if (now - last < eff.dedupeMs) {
                return;
            }
            this.resendLastFireAt.set(eff.urlPattern, now);
        }
        // 目标 URL:设了 setUrl(占位符已由 renderResendActions 渲染)则整体覆盖原捕获 URL;
        // 渲染成空/纯空白 → 回退捕获请求原 URL(安全兜底,不发到坏地址)
        const renderedUrl = eff.setUrl?.trim();
        const target = renderedUrl ? renderedUrl : base.url;
        const method = base.method || 'POST';
        const isGet = method.toUpperCase() === 'GET';
        const triggerHeaders = base.headers;
        const originalBody = base.body;
        const contentType = headerValue(triggerHeaders, 'content-type');

        // 两路产出统一的 (payload, binary, ctForHeaders):
        //  - 文件路:整体用本地文件字节作重发体(payload=base64,binary=true),忽略 set/append/remove;
        //  - 改参路:取原 body 用 rewritePostBody 做 set/append/remove(payload=明文,binary=false)。
        let payload: string;
        let binary = false;
        let ctForHeaders: string;
        if (eff.replaceWithFile && eff.replaceWithFile.trim() && !isGet) {
            // 文件整体替换路:读字节 → base64(文件只读一次,repeat 个定时器复用);读失败则跳过本次重发
            let buf: Buffer;
            try {
                buf = fs.readFileSync(eff.replaceWithFile);
            } catch (err) {
                logError(
                    `回放请求重发器:读替换文件失败,跳过本次重发 [${eff.replaceWithFile}]:${(err as Error).message}`
                );
                return;
            }
            payload = buf.toString('base64');
            binary = true;
            ctForHeaders = contentType; // 保留触发请求原 content-type,不强制 json/form 默认
            logInfo(
                `回放请求重发器:用文件字节作重发体 ${buf.length} 字节 ← ${eff.replaceWithFile}`
            );
        } else {
            // 改参路:eff 的 set/append/remove(占位符已渲染)复用 rewritePostBody;无动作则原样重发
            const bodyType = decideBodyType(eff, contentType, originalBody || '');
            payload = originalBody || '';
            try {
                const out = rewritePostBody(payload, bodyType, eff);
                if (out !== null) {
                    payload = out;
                }
            } catch (err) {
                logError(`回放请求重发器:改参失败(按原 body 重发):${(err as Error).message}`);
            }
            const defaultCt =
                bodyType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
            ctForHeaders = contentType || defaultCt;
        }
        const headers = buildResendHeaders(
            triggerHeaders,
            ctForHeaders,
            {
                setHeaders: eff.setHeaders,
                removeHeaders: eff.removeHeaders,
            },
            hop // 链上跳数写进标记头,供响应触发的熔断判定(真实源→首发 hop1,连环逐跳 +1)
        );
        const repeat = Math.min(Math.max(1, eff.repeat ?? 1), 100);
        const delay = Math.max(0, eff.delayMs ?? 0);
        const interval = Math.max(0, eff.intervalMs ?? 0);
        for (let i = 0; i < repeat; i += 1) {
            const timer = setTimeout(
                () => {
                    this.resendTimers.delete(timer);
                    void this.fireReplayResend(target, method, headers, payload, binary);
                },
                delay + i * interval
            );
            this.resendTimers.add(timer);
        }
    }

    /**
     * 在当前活动页里跑 fetch 主动发一个重发请求(页面上下文:DevTools Network 可见、带页面完整登录态)。
     * 代价:受该页面 CSP/CORS 约束(跨域目标可能被浏览器拦);无可用活动页(页面已关/导航中)则跳过。
     * evaluate 用序列化参数传值(Playwright 自动序列化,不做字符串拼接,免注入)。
     */
    private async fireReplayResend(
        target: string,
        method: string,
        headers: Record<string, string>,
        body: string,
        binaryBase64 = false
    ): Promise<void> {
        const page = this.activePage;
        if (!page || page.isClosed()) {
            logError(`回放请求重发器:无可用活动页,跳过重发 ${method} ${target}`);
            return;
        }
        try {
            await page.evaluate(
                ({ url, m, h, b, bin }) => {
                    const noBody = m.toUpperCase() === 'GET' || m.toUpperCase() === 'HEAD';
                    // payload 用 any:二进制路是 Uint8Array,规避 DOM BodyInit 泛型对 Uint8Array 的挑剔
                    let payload: any;
                    if (!noBody) {
                        // bin:base64 → 二进制串 → 逐字节 Uint8Array(还原任意二进制,含无效 UTF-8)
                        payload = bin ? Uint8Array.from(atob(b), (c) => c.charCodeAt(0)) : b;
                    }
                    void fetch(url, {
                        method: m,
                        headers: h,
                        ...(noBody ? {} : { body: payload }),
                        credentials: 'include',
                    }).catch(() => {});
                },
                { url: target, m: method, h: headers, b: body, bin: binaryBase64 }
            );
            logInfo(
                `回放请求重发器:已重发(页面内)${method} ${target}${binaryBase64 ? '(文件字节体)' : ''}`
            );
        } catch (err) {
            logError(`回放请求重发器:重发失败 [${target}]:${(err as Error).message}`);
        }
    }

    /** 清空所有未触发的重发定时器 + 去抖记录 + 响应触发捕获(cancel / run 结束 / 热关闭时调用) */
    private clearResendTimers(): void {
        for (const t of this.resendTimers) {
            clearTimeout(t);
        }
        this.resendTimers.clear();
        this.resendLastFireAt.clear();
        this.resendCaptures.clear();
        this.resendMissWarned.clear();
    }

    /**
     * 分发并执行单个步骤;stepIndex 仅用于 pause 步骤向 UI 报告位置。
     * context 传入时,等待类步骤会兼顾「随后弹出的新窗口」(解决活动页切换晚于下一步的竞态)。
     */
    /** 按当前档算一次步骤间延时:min==max=固定;min<max=区间随机(拟人化);max<=0=不延时 */
    private pickStepDelay(): number {
        const { min, max } = this.replay.stepDelay;
        if (max <= 0) {
            return 0;
        }
        if (max <= min) {
            return Math.max(0, min);
        }
        return Math.floor(min + Math.random() * (max - min));
    }

    /** 第 attempt 次重试的退避等待(attempt 从 1 起):fixed=baseMs;exponential=baseMs*factor^(attempt-1),封顶 maxMs */
    private computeBackoff(attempt: number): number {
        const r = this.replay.retry;
        const ms =
            r.backoff === 'exponential' ? r.baseMs * Math.pow(r.factor, attempt - 1) : r.baseMs;
        return Math.min(r.maxMs, Math.max(0, ms));
    }

    /**
     * 按回放档执行一步:每步类型超时覆盖 + 出错策略(重试/跳过/继续/中止)+ 成功后拟人化延时。
     * - onError/onErrorByType:abort=抛出(走既有失败截图流程)、skip/continue=记录后跳过继续、retry=按退避重试。
     * - 用户主动停止(cancelled)一律立即冒泡,不受策略影响。
     */
    private async executeStepWithPolicy(
        page: Page,
        step: Step,
        stepIndex: number,
        context?: BrowserContext
    ): Promise<void> {
        const type = step.type;
        const stepTimeout = this.replay.stepTimeoutMs[type];
        const hasOverride = typeof stepTimeout === 'number' && stepTimeout > 0;
        if (hasOverride) {
            page.setDefaultTimeout(stepTimeout);
        }
        const policy: OnErrorPolicy = this.replay.onErrorByType[type] ?? this.replay.onError;
        const maxAttempts = policy === 'retry' ? this.replay.retry.count + 1 : 1;
        let lastErr: unknown;
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    await this.executeStep(page, step, stepIndex, context);
                    lastErr = undefined;
                    break;
                } catch (err) {
                    lastErr = err;
                    if (this.cancelled) {
                        throw err; // 用户停止:立即冒泡,不重试不吞
                    }
                    if (policy === 'retry' && attempt < maxAttempts) {
                        const wait = this.computeBackoff(attempt);
                        const msg = err instanceof Error ? err.message : String(err);
                        logInfo(
                            `第 ${stepIndex + 1} 步失败(${msg}),${wait}ms 后重试(${attempt}/${this.replay.retry.count})……`
                        );
                        await page.waitForTimeout(wait);
                        continue;
                    }
                    break;
                }
            }
            if (lastErr !== undefined) {
                if (policy === 'skip' || policy === 'continue') {
                    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
                    logError(`第 ${stepIndex + 1} 步失败(${msg}),按策略「${policy}」跳过继续。`);
                } else {
                    throw lastErr; // abort:冒泡到 run() 的 catch,走既有失败截图流程
                }
            } else {
                const delay = this.pickStepDelay();
                if (delay > 0) {
                    await page.waitForTimeout(delay);
                }
            }
        } finally {
            // 恢复全局默认超时,避免本步的短超时污染后续步骤 / 翻页 / 提取
            if (hasOverride) {
                page.setDefaultTimeout(this.timeoutMs);
            }
        }
    }

    private async executeStep(
        page: Page,
        step: Step,
        stepIndex = -1,
        context?: BrowserContext
    ): Promise<void> {
        switch (step.type) {
            case 'goto':
                await this.handleGoto(page, step.url);
                break;
            case 'click':
                await this.handleClick(page, step.selector, step.fingerprint);
                break;
            case 'fill':
                await this.handleFill(page, step.selector, step.value);
                break;
            case 'press':
                await this.handlePress(page, step.selector, step.key);
                break;
            case 'scroll':
                await this.handleScroll(page, step.x, step.y);
                break;
            case 'scroll-bottom':
                await this.handleScrollBottom(page);
                break;
            case 'wait-for-load':
                await this.handleWaitForLoad(page);
                break;
            case 'waitForSelector':
                await this.handleWaitForSelector(page, step.selector, step.timeout, context);
                break;
            case 'waitForClickable':
                await this.handleWaitForClickable(page, step.selector, step.timeout, context);
                break;
            case 'pause':
                await this.handlePause(step, stepIndex);
                break;
            default: {
                // 穷尽性检查:若新增 step 类型而未处理,此处会编译报错
                const exhaustive: never = step;
                throw new Error(`未知的步骤类型:${JSON.stringify(exhaustive)}`);
            }
        }
    }

    private async handleGoto(page: Page, url: string): Promise<void> {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    private async handleClick(
        page: Page,
        selector: string,
        fingerprint?: ElementFingerprint
    ): Promise<void> {
        const loc = page.locator(selector);
        let n = -1; // -1 表示选择器非法
        try {
            n = await loc.count();
        } catch {
            n = -1;
        }
        if (n === 1) {
            // 主路径:选择器唯一命中,信任录制结果
            await loc.first().click();
            return;
        }
        // 命中 0 个 / 多个 / 非法 → 用语义指纹通用重定位(不限分页器)
        if (fingerprint) {
            const hit = await this.relocateByFingerprint(page, fingerprint);
            if (hit) {
                logInfo(
                    `主选择器「${selector}」命中 ${n < 0 ? '非法' : n} 个,` +
                        `已用语义指纹(${hit.strategy})重定位点击。`
                );
                await hit.locator.click();
                return;
            }
        }
        // 无指纹或重定位失败 → 回退原生 click,沿用既有失败路径(严格模式报错/超时 → 出错截图)
        await page.click(selector);
    }

    /**
     * 用语义指纹在当前页通用重定位:按可靠性逐条尝试,返回首个唯一可见可用的元素。
     * 与位置无关,适用于任意 click(分页器只是其中一例)。
     */
    private async relocateByFingerprint(
        page: Page,
        fp: ElementFingerprint
    ): Promise<{ locator: Locator; strategy: string } | null> {
        const tag = fp.tag && /^[a-z][a-z0-9]*$/i.test(fp.tag) ? fp.tag : '';
        const candidates: Array<{ strategy: string; locator: Locator }> = [];

        // 1) anchor 缩小(最稳):在稳定祖先范围内按 tag(+文本)定位
        if (fp.anchor) {
            try {
                let inner = page.locator(fp.anchor).locator(tag || '*');
                if (fp.text) {
                    const narrowed = inner.filter({ hasText: fp.text });
                    if ((await narrowed.count().catch(() => 0)) > 0) {
                        inner = narrowed;
                    }
                }
                candidates.push({ strategy: 'anchor', locator: inner });
            } catch {
                /* 非法 anchor 选择器,跳过 */
            }
        }
        // 2) 文本精确
        if (fp.text) {
            candidates.push({
                strategy: 'text',
                locator: page.locator(tag || 'a, button, [role="button"]', { hasText: fp.text }),
            });
        }
        // 3) aria-label
        if (fp.ariaLabel) {
            candidates.push({
                strategy: 'aria',
                locator: page.locator(`[aria-label="${cssAttrEscape(fp.ariaLabel)}"]`),
            });
        }
        // 4) href 精确(最弱:翻页等动态 href 会变,仅作兜底)
        if (fp.href) {
            candidates.push({
                strategy: 'href',
                locator: page.locator(`${tag || 'a'}[href="${cssAttrEscape(fp.href)}"]`),
            });
        }

        for (const c of candidates) {
            const visible = await firstVisible(c.locator);
            if (visible) {
                return { locator: visible, strategy: c.strategy };
            }
        }
        return null;
    }

    private async handleFill(page: Page, selector: string, value: string): Promise<void> {
        await page.fill(selector, value);
    }

    private async handlePress(page: Page, selector: string | undefined, key: string): Promise<void> {
        if (selector) {
            await page.press(selector, key);
        } else {
            await page.keyboard.press(key);
        }
    }

    private async handleScroll(page: Page, x: number, y: number): Promise<void> {
        await page.evaluate(({ sx, sy }) => window.scrollTo(sx, sy), { sx: x, sy: y });
    }

    /** 滚动到页面最底部:window 与所有内部可滚动容器(含 fixed 定位)各自滚到底,触发无限滚动懒加载;滚后短暂等待新内容就绪 */
    private async handleScrollBottom(page: Page): Promise<void> {
        const scrolled = await page.evaluate(() => {
            // 1) 窗口/文档滚到底
            const doc = document.scrollingElement || document.documentElement;
            window.scrollTo(0, doc ? doc.scrollHeight : document.body.scrollHeight);
            // 2) 扫描所有元素,把「自身可垂直滚动」的容器各自滚到底
            //    (overflowY 为 auto/scroll/overlay 且 scrollHeight 明显大于 clientHeight)
            let n = 0;
            const els = document.querySelectorAll('*');
            for (let i = 0; i < els.length; i += 1) {
                const el = els[i] as HTMLElement;
                const oy = getComputedStyle(el).overflowY;
                if (
                    (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                    el.scrollHeight - el.clientHeight > 4
                ) {
                    el.scrollTop = el.scrollHeight; // 设 scrollTop 会派发 scroll 事件,兼容滚动监听型懒加载
                    n += 1;
                }
            }
            return n; // 命中的内部可滚动容器数,供日志诊断
        });
        logInfo(`滚动到底部:已滚动 window + ${scrolled} 个内部可滚动容器。`);
        // 等懒加载内容就绪(非致命,时长取当前回放档 scrollBottomWaitMs,缺省 1000ms)
        await page.waitForTimeout(this.replay.scrollBottomWaitMs);
    }

    /** 等待页面加载完成:等 load 事件(DOM 与全部资源加载完毕);超时只告警不致命,避免轮询型站点永久挂死 */
    private async handleWaitForLoad(page: Page): Promise<void> {
        try {
            await page.waitForLoadState('load');
            logInfo('页面加载完成(load)。');
        } catch (e) {
            logInfo(`等待页面加载完成超时,继续后续步骤:${(e as Error).message}`);
        }
    }

    private async handleWaitForSelector(
        page: Page,
        selector: string,
        timeout?: number,
        context?: BrowserContext
    ): Promise<void> {
        // 未指定 timeout 时走全局默认超时(setDefaultTimeout);宏里显式指定的优先。
        // 兼顾「上一步点击刚弹出的新窗口」:活动页切换可能晚于本步,故同时盯当前页与新弹窗。
        const opts = timeout ? { timeout } : undefined;
        await this.raceWaitAcrossPopup(
            page,
            context,
            (p) => p.waitForSelector(selector, opts),
            timeout
        );
    }

    /**
     * 在「当前页」与「随后弹出的新页」之间竞态等待:哪个先满足用哪个。
     * 解决「点击触发新窗口后,活动页(context.on('page'))切换晚于下一步」的竞态——
     * 等待步骤主动追随迟到的新窗口,而非卡在旧页等一个永不出现的元素直至超时。
     * context 缺省(如无头单测/无上下文)时退化为仅等当前页,行为不变。
     * 致命语义不变:当前页无该元素且无新窗口时,两分支各自超时 reject,race 以先 reject 者结束。
     */
    private async raceWaitAcrossPopup(
        page: Page,
        context: BrowserContext | undefined,
        waitFn: (p: Page) => Promise<unknown>,
        timeout?: number
    ): Promise<void> {
        const current = waitFn(page); // 唯一携带「致命超时 reject」的分支
        if (!context) {
            await current;
            return;
        }
        // 弹窗侧分支「只赢不输」:命中目标才 resolve;DOM 未就绪 / 元素不在该页 / 页已关一律吞掉并永久挂起,
        // 绝不把 race 拖 reject —— 致命超时语义仍只由 current(当前页)分支承载。
        const winOnly = (p: Page): Promise<unknown> =>
            p
                .waitForLoadState('domcontentloaded')
                .catch(() => undefined)
                .then(() => waitFn(p))
                .catch(() => new Promise<never>(() => undefined));
        // 先纳入「已存在但晚于本步的其它页」——修复 waitForEvent 只等「下一个」弹窗、会漏掉「已发生」page 事件的竞态;
        // 再叠加「未来新弹窗」。哪个页先命中目标用哪个;activePage 由 context.on('page') 同步更新,后续步骤自然接续。
        const existing = context
            .pages()
            .filter((p) => p !== page && !p.isClosed())
            .map(winOnly);
        const future = context
            .waitForEvent('page', timeout ? { timeout } : undefined)
            .then(winOnly)
            .catch(() => new Promise<never>(() => undefined));
        const branches = [current, ...existing, future];
        try {
            await Promise.race(branches);
        } finally {
            // 抑制未采纳分支的迟到 rejection(超时/页面关闭),避免 unhandledRejection
            branches.forEach((b) => b.catch(() => undefined));
        }
    }

    /**
     * 等待元素「可点击」:比 waitForSelector 的 visible 更强,要求元素可交互。
     * 判定完全在页面内做纯只读检查(尺寸非零、非隐藏、非 disabled、视口内时未被遮挡),
     * 不用 Playwright 的 trial click——后者会 scroll into view 改变滚动位置(本项目对滚动敏感)。
     * 超时致命(同 waitForSelector 的强前置语义);未指定 timeout 走全局默认(setDefaultTimeout 对 waitForFunction 生效)。
     */
    private async handleWaitForClickable(
        page: Page,
        selector: string,
        timeout?: number,
        context?: BrowserContext
    ): Promise<void> {
        // 与 waitForSelector 一致:兼顾上一步点击刚弹出的新窗口(活动页切换可能晚于本步)
        const opts = timeout ? { timeout } : undefined;
        const check = (p: Page): Promise<unknown> =>
            p.waitForFunction(
                (sel: string) => {
                let el: Element | null = null;
                try {
                    if (sel.slice(0, 6) === 'xpath=') {
                        // xpath= 前缀:走浏览器原生 XPath 接口(document.querySelector 只认 CSS)
                        const r = document.evaluate(
                            sel.slice(6),
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                        );
                        el = r.singleNodeValue as Element | null;
                    } else {
                        el = document.querySelector(sel); // CSS 走原路,行为完全不变
                    }
                } catch {
                    return false; // 非法选择器/XPath 语法错误:判为未就绪,继续等到超时
                }
                if (!el || el.nodeType !== 1) return false; // 必须是元素节点(XPath 可能命中文本/属性节点)
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false; // 尺寸为 0 视为不可见
                const style = getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') return false;
                // enabled:原生 disabled 或 aria-disabled
                if ((el as HTMLButtonElement).disabled === true) return false;
                if (el.getAttribute('aria-disabled') === 'true') return false;
                // 遮挡检测:仅当元素中心点在视口内时做(视口外 elementFromPoint 测不准 → 降级跳过)
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const inViewport =
                    cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
                if (inViewport) {
                    const top = document.elementFromPoint(cx, cy);
                    if (!top) return false;
                    // 命中自身、自身后代、或自身祖先(同渲染栈)都算未被遮挡
                    if (top !== el && !el.contains(top) && !top.contains(el)) return false;
                }
                return true;
                },
                selector,
                opts
            );
        await this.raceWaitAcrossPopup(page, context, check, timeout);
    }

    /** 人工介入暂停:阻塞回放,等用户在浏览器里手动操作后点继续;可设超时避免无人值守永久挂起 */
    private async handlePause(step: PauseStep, stepIndex: number): Promise<void> {
        logInfo(
            `第 ${stepIndex + 1} 步:人工介入暂停。${step.reason ?? '请在浏览器窗口完成操作后点击继续。'}`
        );
        const pausePromise = this.onPause({
            stepIndex,
            reason: step.reason,
            timeout: step.timeout,
        });
        if (step.timeout && step.timeout > 0) {
            // 暂停期间无 Playwright 动作,setDefaultTimeout 不生效,这里自行实现超时
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`人工介入暂停超时(${step.timeout} 毫秒未点继续)。`)),
                    step.timeout
                );
            });
            try {
                await Promise.race([pausePromise, timeoutPromise]);
            } finally {
                if (timer) {
                    clearTimeout(timer);
                }
            }
        } else {
            await pausePromise;
        }
        logInfo(`第 ${stepIndex + 1} 步:已收到继续信号,恢复回放。`);
    }

    /** 出错时截图保存到 errors/ 目录 */
    private async captureErrorScreenshot(page: Page): Promise<string | undefined> {
        try {
            if (!fs.existsSync(this.errorDir)) {
                fs.mkdirSync(this.errorDir, { recursive: true });
            }
            const filePath = path.join(this.errorDir, `error-${timestamp()}.png`);
            await page.screenshot({ path: filePath, fullPage: true });
            return filePath;
        } catch {
            return undefined;
        }
    }
}

/** 用于日志的步骤中文描述 */
function describeStep(step: Step): string {
    switch (step.type) {
        case 'goto':
            return `打开网址 ${step.url}`;
        case 'click':
            return `点击 ${step.selector}`;
        case 'fill':
            return `输入「${step.value}」到 ${step.selector}`;
        case 'press':
            return `按键 ${step.key}${step.selector ? ' @ ' + step.selector : ''}`;
        case 'scroll':
            return `滚动到 (${step.x}, ${step.y})`;
        case 'scroll-bottom':
            return '滚动到底部';
        case 'wait-for-load':
            return '等待页面加载完成';
        case 'waitForSelector':
            return `等待元素出现 ${step.selector}`;
        case 'waitForClickable':
            return `等待元素可点击 ${step.selector}`;
        case 'pause':
            return `人工介入暂停${step.reason ? ':' + step.reason : ''}`;
        default:
            return '未知步骤';
    }
}

/** 在候选 locator 中返回首个可见元素(用于指纹重定位时挑出唯一可点目标);均不可见返回 null */
async function firstVisible(loc: Locator): Promise<Locator | null> {
    let count = 0;
    try {
        count = await loc.count();
    } catch {
        return null;
    }
    if (count === 0) {
        return null;
    }
    // 限制扫描数量,避免极端页面遍历过多
    const max = Math.min(count, 20);
    for (let i = 0; i < max; i += 1) {
        const item = loc.nth(i);
        try {
            if (await item.isVisible()) {
                return item;
            }
        } catch {
            /* 个别元素判定失败,继续下一个 */
        }
    }
    return null;
}

/** 转义属性值中的双引号,用于 [attr="value"] */
function cssAttrEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 生成形如 20260622-153012 的时间戳 */
function timestamp(): string {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

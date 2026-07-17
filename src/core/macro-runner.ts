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
    SessionOptions,
    ElementFingerprint,
    RequestRule,
    ResendRule,
    ResponseHeaderRule,
    BlockRule,
    DumpRule,
    BodyReplaceRule,
    RequestRulesConfig,
} from './macro-types';
import { extract, type PaginationContext } from './extractor';
import { DownloadManager } from './download-manager';
import {
    matchRule,
    globToRegExp,
    decideBodyType,
    rewritePostBody,
    rewriteResponseHeaderRecord,
    headerValue,
    isResendOrigin,
    buildResendHeaders,
    responseTriggerMet,
    triggerNeedsBody,
} from './request-rewrite';
import { TimelineRecorder } from './timeline-recorder';
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
    /** 有值=响应阶段(dump 只配 Request 阶段,理论不出现) */
    responseStatusCode?: number;
}

export class MacroRunner {
    private errorDir: string;
    private timeoutMs: number;
    /** 人工介入暂停回调:由主进程注入,负责通知 UI 并等待用户点继续;无则默认立即放行 */
    private onPause: OnPause;
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
    /** 未触发的重发定时器集合:cancel/run 结束/热关闭时统一清理,防泄漏与 "Target closed" */
    private readonly resendTimers = new Set<ReturnType<typeof setTimeout>>();
    /** 去抖:重发规则 urlPattern → 上次触发时刻(ms) */
    private readonly resendLastFireAt = new Map<string, number>();
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
        // 回放默认超时:默认 60 秒;可用环境变量 MACRO_TIMEOUT(毫秒)覆盖
        this.timeoutMs = timeoutMs ?? (Number(process.env.MACRO_TIMEOUT) || 60000);
        // 无回调(无头/单测场景)时立即放行,避免永久挂起
        this.onPause = onPause ?? (async (): Promise<void> => {});
        this.session = session ?? {};
        this.downloadDir = downloadDir ?? path.join(errorDir, '..', 'downloads');
        this.timelinesDir = timelinesDir ?? path.join(errorDir, '..', 'timelines');
        this.dumpsDir = dumpsDir ?? path.join(errorDir, '..', 'dumps');
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
            activePage = page;
            this.activePage = page;
            // 请求体落盘:CDP session 是 per-page,给初始页挂一个(dumpWant 时才真正 attach)
            this.dumpPages.add(page);
            void this.attachDumpCdp(page);
            context.on('page', (popup) => {
                activePage = popup;
                this.activePage = popup;
                popup.setDefaultTimeout(this.timeoutMs);
                popup.setDefaultNavigationTimeout(this.timeoutMs);
                logInfo('检测到新标签页弹窗,已切换为活动页继续回放。');
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
                await this.executeStep(activePage, step, i, context);
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
                // 真拦截(硬阻断):命中 block 规则(可选限定 method)直接 abort,不放行——本模块唯一不放行分支。
                // 放在 isResendOrigin 之后 → 工具自己发的重发请求不会被自己阻断;放在改写之前 → 命中即拦最干净。
                const blockRule = matchRule(this.blockRules, request.url());
                if (
                    blockRule &&
                    (!blockRule.method ||
                        blockRule.method.toUpperCase() === request.method().toUpperCase())
                ) {
                    logInfo(`回放请求拦截器:已阻断 [${request.method()} ${request.url()}]`);
                    await route.abort();
                    return;
                }
                // 响应头改写规则(与 method 无关,GET 也可能要改):命中则改走 fetch()+fulfill()
                const respRule = matchRule(this.responseHeaderRules, request.url());
                if (respRule) {
                    await this.handleResponseHeaderRoute(route, request, respRule);
                    return;
                }
                // 以下为请求体改写(仅 POST):route.continue({postData}) 放行,不触碰响应
                if (request.method().toUpperCase() !== 'POST') {
                    await route.continue();
                    return;
                }
                const rule = matchRule(this.rewriteRules, request.url());
                if (!rule) {
                    await route.continue();
                    return;
                }
                const original = request.postData();
                if (!original) {
                    await route.continue();
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
                    await route.continue({ postData: newBody });
                } else {
                    await route.continue();
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

        // ② 记录监听:一次性常挂(被动本地事件、开销可忽略),靠 this.recorder 是否存在决定写不写。
        // Playwright 无 CDP requestId,用 WeakMap 记住每个请求的关联 id/起始时刻/记录它的 recorder
        //(响应写回同一 recorder,保证请求行与响应行落在同一文件、并能完成中途关闭前已开始的交换)。
        const meta = new WeakMap<Request, { id: string; start: number; recorder: TimelineRecorder }>();
        let seq = 0;

        context.on('request', (req: Request) => {
            try {
                const recorder = this.recorder;
                if (!recorder || !recorder.matches(req.url())) {
                    return;
                }
                seq += 1;
                const id = String(seq);
                meta.set(req, { id, start: Date.now(), recorder });
                // Playwright 直接给完整 body(不截断);recordWantBody=false 时跳过
                const reqBody = this.recordWantBody ? req.postData() ?? undefined : undefined;
                recorder.writeRequest({
                    id,
                    method: req.method(),
                    url: req.url(),
                    reqHeaders: req.headers(),
                    reqBody,
                });
            } catch {
                /* 记录支路不得影响主流程 */
            }
        });

        // 用 response 事件(而非 requestfinished)写响应行:响应头到达即触发,早于 body 完成与 context 关闭,
        // 且 status/headers 同步可取——避免「宏结束后 context 立即关闭,异步 req.response() 来不及」的竞态。
        context.on('response', (resp) => {
            try {
                const m = meta.get(resp.request());
                if (!m) {
                    return; // 未记录该请求(记录关闭时发出 / matches 未过)
                }
                const req = resp.request();
                const respHeaders = resp.headers();
                const mimeType = headerValue(respHeaders, 'content-type');
                m.recorder.writeResponse({
                    id: m.id,
                    method: req.method(),
                    url: req.url(),
                    status: resp.status(),
                    timingMs: Date.now() - m.start, // 墙钟耗时(足够分析用)
                    respHeaders,
                    mimeType: mimeType || undefined,
                });
            } catch {
                /* 记录支路不得影响主流程 */
            }
        });

        context.on('requestfailed', (req: Request) => {
            try {
                const m = meta.get(req);
                if (!m) {
                    return;
                }
                m.recorder.writeResponse({
                    id: m.id,
                    method: req.method(),
                    url: req.url(),
                    timingMs: Date.now() - m.start,
                    error: req.failure()?.errorText,
                });
            } catch {
                /* 记录支路不得影响主流程 */
            }
        });

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
        this.rewriteRules = cfg.rules ?? [];
        this.responseHeaderRules = cfg.responseRules ?? [];
        this.blockRules = cfg.blocks ?? [];
        // 改写 body 规则 / 响应头规则 / 真拦截规则 任一非空即需注册 route(只配其中一类也要拦)
        const want =
            cfg.enabled &&
            (this.rewriteRules.length > 0 ||
                this.responseHeaderRules.length > 0 ||
                this.blockRules.length > 0);
        try {
            if (want && !this.rewriteInstalled) {
                await ctx.route('**/*', this.rewriteHandler);
                this.rewriteInstalled = true;
                logInfo(
                    `回放请求改写器:已启用,改写 ${this.rewriteRules.length} 条 / ` +
                        `响应头改写 ${this.responseHeaderRules.length} 条 / ` +
                        `真拦截 ${this.blockRules.length} 条,匹配 URL:` +
                        [...this.rewriteRules, ...this.responseHeaderRules, ...this.blockRules]
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
     * 回放端响应头改写:实际发出请求(route.fetch;若同一 POST 也命中 body 改写规则则带上改后的 body),
     * 拿到真实响应后按规则改响应头,route.fulfill 回填。一旦 fetch 就已消费该请求,故后续统一 fulfill;
     * 仅 fetch 前出错才回退 route.continue(保持「每条必放行」铁律)。
     */
    private async handleResponseHeaderRoute(
        route: Route,
        request: Request,
        respRule: ResponseHeaderRule
    ): Promise<void> {
        try {
            // 若同一请求也命中 body 改写规则(POST),先算改后的 body 一并发出(两种改写可组合)
            const fetchOptions: { postData?: string } = {};
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
                            `回放响应头改写器:附带的 body 改写失败(用原 body 发出):${(err as Error).message}`
                        );
                    }
                }
            }
            const response = await route.fetch(fetchOptions);
            const headers = response.headers();
            const newHeaders = rewriteResponseHeaderRecord(headers, respRule);
            if (newHeaders !== null) {
                logInfo(
                    `回放响应头改写器:已改写响应头 [${request.url()}];` +
                        `set=${Object.keys(respRule.setHeaders ?? {}).join(',') || '无'};` +
                        `remove=${(respRule.removeHeaders ?? []).join(',') || '无'}`
                );
                await route.fulfill({ response, headers: newHeaders });
            } else {
                // 条件不满足 / 无动作:用原响应回填(请求已被 fetch 消费,必须 fulfill 而非 continue)
                await route.fulfill({ response });
            }
        } catch (err) {
            logError(`回放响应头改写器:处理响应头出错(原样放行):${(err as Error).message}`);
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
    }

    /**
     * 按配置启用/停用重发支路(仿 applyReplayRewrite/Record):观察监听已常挂,这里只切标志。
     * 把 resends 按有无 responseTrigger 拆两组:请求触发(原行为)+ 响应触发(新)。
     * 关→开记日志;两组均关闭时清掉未触发的定时器(定时器共享,热关即时停)。
     */
    private applyReplayResend(cfg: RequestRulesConfig): void {
        const all = cfg.resends ?? [];
        this.resendRules = all.filter((r) => !r.responseTrigger);
        this.responseResendRules = all.filter((r) => !!r.responseTrigger);
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
            if (isResendOrigin(resp.request().headers())) {
                return; // 我们自己发的重发的响应,跳过(防递归自触发)
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
                if (!responseTriggerMet(trigger, status, headers, bodyText)) {
                    continue;
                }
                const cap = this.resendCaptures.get(rr.urlPattern);
                if (!cap) {
                    logInfo(
                        `回放请求重发器(响应触发):命中 triggerUrl 但尚未捕获到 [${rr.urlPattern}] 的请求,跳过本次重发。`
                    );
                    continue;
                }
                this.scheduleReplayResend(rr, cap);
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
        this.dumpRules = cfg.dumps ?? [];
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
        this.replaceRules = cfg.bodyReplaces ?? [];
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

    // ===== 请求体落盘的 CDP Fetch 拦截(抓 File/Blob 上传体;Playwright postDataBuffer 对 Blob 返回 null)=====

    /** dump ∪ 整体替换 规则 URL → CDP Fetch.enable 的 patterns(只暂停命中 URL 的请求阶段,降开销) */
    private dumpFetchPatterns(): Array<{ urlPattern: string; requestStage: 'Request' }> {
        const urls = new Set<string>();
        for (const r of this.dumpRules) {
            urls.add(r.urlPattern);
        }
        for (const r of this.replaceRules) {
            urls.add(r.urlPattern);
        }
        return [...urls].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
    }

    /** dump 或整体替换 任一启用(决定是否需要挂 CDP Fetch 拦截) */
    private cdpFetchWant(): boolean {
        return (
            (this.dumpWant && this.dumpRules.length > 0) ||
            (this.replaceWant && this.replaceRules.length > 0)
        );
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
     * 给一个 page 挂 CDP Fetch 拦截:命中 dump/替换 规则的请求在发出前暂停,落盘/整体替换后立即放行。
     * 幂等;不需要 CDP(dump 与替换都关)或已挂则跳过;attach 失败记告警、该页不生效、不致命。
     */
    private async attachDumpCdp(page: Page): Promise<void> {
        if (!this.cdpFetchWant() || this.dumpCdpSessions.has(page)) {
            return;
        }
        const ctx = this.activeContext;
        if (!ctx) {
            return;
        }
        try {
            const cdp = await ctx.newCDPSession(page);
            this.dumpCdpSessions.set(page, cdp);
            // 注:dump(独立 CDP Fetch)与改写/真拦截(Playwright route,底层亦 CDP Fetch)命中同一 URL 时,
            // 两者各自拦截同一请求(实测共存不冲突、都生效);dump 抓到的 body 时序上可能是改写前或改写后。
            cdp.on('Fetch.requestPaused', (params: CdpRequestPaused) => {
                void this.onDumpRequestPaused(cdp, params);
            });
            await cdp.send('Fetch.enable', { patterns: this.dumpFetchPatterns() });
        } catch (err) {
            this.dumpCdpSessions.delete(page);
            logError(`回放请求体落盘:CDP 挂载失败(该页不落盘,不影响回放):${(err as Error).message}`);
        }
    }

    /**
     * CDP Fetch.requestPaused 处理:先按 dump 规则落盘原始 body,再按替换规则用文件字节整体替换后放行。
     * dump 读旧、替换发新,可同时命中。**每条路径恰好放行一次**(替换命中即带 postData 放行并 return)。
     */
    private async onDumpRequestPaused(cdp: CDPSession, params: CdpRequestPaused): Promise<void> {
        const { requestId, request } = params;
        try {
            // 只处理请求阶段(patterns 只配了 Request,响应阶段带 responseStatusCode,理论不会到这里,保险跳过)
            if (params.responseStatusCode === undefined && !isResendOrigin(request.headers)) {
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
        // 铁律:每个暂停请求都必须放行,否则页面卡死(未命中替换/替换失败走这里原样放行)
        try {
            await cdp.send('Fetch.continueRequest', { requestId });
        } catch {
            /* 请求/会话可能已失效,忽略 */
        }
    }

    /**
     * 落盘热更新:开启则对所有已知 page 补挂(未挂的)/重下发 patterns(已挂的),关闭则全部卸载。
     * 与录制端 applyPatterns、回放端 applyReplay* 同构;在 applyReplayDump 与 page 生命周期处驱动。
     */
    private async refreshDumpCdp(): Promise<void> {
        if (this.cdpFetchWant()) {
            for (const page of this.dumpPages) {
                const existing = this.dumpCdpSessions.get(page);
                if (!existing) {
                    await this.attachDumpCdp(page);
                } else {
                    try {
                        await existing.send('Fetch.enable', { patterns: this.dumpFetchPatterns() });
                    } catch {
                        /* 会话可能已失效,下次 attach 重建 */
                    }
                }
            }
        } else {
            await this.detachAllDumpCdp();
        }
    }

    /** 卸载所有 dump CDP 会话(Fetch.disable + detach;context 关闭后 transport 已断会抛,全 try/catch)。 */
    private async detachAllDumpCdp(): Promise<void> {
        for (const cdp of this.dumpCdpSessions.values()) {
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
    }

    /**
     * 命中重发规则后调度:去抖 → 算类型/改参/头 → repeat 次 setTimeout 延时发射。
     * base = 重发蓝本(url/method/头/体):请求触发时是触发请求本身,响应触发时是捕获到的 urlPattern 请求。
     * 目标 URL 恒为 base.url(已无 targetUrl 概念)。不改原请求,这里只额外发新请求。
     */
    private scheduleReplayResend(
        rr: ResendRule,
        base: { url: string; method: string; headers: Record<string, string>; body: string }
    ): void {
        // 去抖:同规则 dedupeMs 内只发一次(默认 0=每次命中都发)
        if (rr.dedupeMs && rr.dedupeMs > 0) {
            const now = Date.now();
            const last = this.resendLastFireAt.get(rr.urlPattern) ?? 0;
            if (now - last < rr.dedupeMs) {
                return;
            }
            this.resendLastFireAt.set(rr.urlPattern, now);
        }
        const target = base.url;
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
        if (rr.replaceWithFile && rr.replaceWithFile.trim() && !isGet) {
            // 文件整体替换路:读字节 → base64(文件只读一次,repeat 个定时器复用);读失败则跳过本次重发
            let buf: Buffer;
            try {
                buf = fs.readFileSync(rr.replaceWithFile);
            } catch (err) {
                logError(
                    `回放请求重发器:读替换文件失败,跳过本次重发 [${rr.replaceWithFile}]:${(err as Error).message}`
                );
                return;
            }
            payload = buf.toString('base64');
            binary = true;
            ctForHeaders = contentType; // 保留触发请求原 content-type,不强制 json/form 默认
            logInfo(
                `回放请求重发器:用文件字节作重发体 ${buf.length} 字节 ← ${rr.replaceWithFile}`
            );
        } else {
            // 改参路:rr 的 set/append/remove 复用 rewritePostBody;无动作则原样重发
            const bodyType = decideBodyType(rr, contentType, originalBody || '');
            payload = originalBody || '';
            try {
                const out = rewritePostBody(payload, bodyType, rr);
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
        const headers = buildResendHeaders(triggerHeaders, ctForHeaders, {
            setHeaders: rr.setHeaders,
            removeHeaders: rr.removeHeaders,
        });
        const repeat = Math.min(Math.max(1, rr.repeat ?? 1), 100);
        const delay = Math.max(0, rr.delayMs ?? 0);
        const interval = Math.max(0, rr.intervalMs ?? 0);
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
    }

    /**
     * 分发并执行单个步骤;stepIndex 仅用于 pause 步骤向 UI 报告位置。
     * context 传入时,等待类步骤会兼顾「随后弹出的新窗口」(解决活动页切换晚于下一步的竞态)。
     */
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
        // 等懒加载内容就绪(非致命,固定短等待)
        await page.waitForTimeout(1000);
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
        const current = waitFn(page);
        if (!context) {
            await current;
            return;
        }
        const popup = context
            .waitForEvent('page', timeout ? { timeout } : undefined)
            .then(async (p) => {
                // 新窗口:等 DOM 就绪后在其上执行同样的等待
                // (activePage 由既有 context.on('page') 监听同步更新,故本步解决后续步骤自然在新页继续)
                await p.waitForLoadState('domcontentloaded').catch(() => undefined);
                return waitFn(p);
            });
        try {
            await Promise.race([current, popup]);
        } finally {
            // 抑制未采纳分支的迟到 rejection(超时/页面关闭),避免 unhandledRejection
            current.catch(() => undefined);
            popup.catch(() => undefined);
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

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
} from './macro-types';
import { extract, type PaginationContext } from './extractor';
import { DownloadManager } from './download-manager';
import { matchRule, decideBodyType, rewritePostBody, headerValue } from './request-rewrite';
import { TimelineRecorder } from './timeline-recorder';
import { logInfo, logError } from './logger';

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

    constructor(
        errorDir: string,
        timeoutMs?: number,
        onPause?: OnPause,
        session?: SessionOptions,
        downloadDir?: string,
        timelinesDir?: string
    ) {
        this.errorDir = errorDir;
        // 回放默认超时:默认 60 秒;可用环境变量 MACRO_TIMEOUT(毫秒)覆盖
        this.timeoutMs = timeoutMs ?? (Number(process.env.MACRO_TIMEOUT) || 60000);
        // 无回调(无头/单测场景)时立即放行,避免永久挂起
        this.onPause = onPause ?? (async (): Promise<void> => {});
        this.session = session ?? {};
        this.downloadDir = downloadDir ?? path.join(errorDir, '..', 'downloads');
        this.timelinesDir = timelinesDir ?? path.join(errorDir, '..', 'timelines');
    }

    /**
     * 请求停止当前回放(由主进程在收到「停止」信号时调用,依赖倒置——core 不依赖 Electron)。
     * 置取消标志让主循环干净退出;并主动关闭 context 以**立即打断**正在 await 的 Playwright
     * 操作(如卡在慢 waitForSelector / goto / 提取阶段),使 run() 尽快从 catch 退出。
     */
    cancel(): void {
        this.cancelled = true;
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

            // 回放端请求改写:必须早于第一个 goto 注册;挂在 context 上自动覆盖初始页与后续所有弹窗
            await this.installRequestRoutes(context);
            // 回放端「只记录不修改」支路:同样早于第一个 goto、挂 context 覆盖初始页与弹窗;与改写路径独立
            this.installTimelineRecording(context);

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
            context.on('page', (popup) => {
                activePage = popup;
                popup.setDefaultTimeout(this.timeoutMs);
                popup.setDefaultNavigationTimeout(this.timeoutMs);
                logInfo('检测到新标签页弹窗,已切换为活动页继续回放。');
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
     * 回放端请求改写:在 context 上注册全量 route,命中规则的 POST 改写其 body 再放行。
     * 与录制端(CDP)共用 core/request-rewrite 的 matchRule/decideBodyType/rewritePostBody,
     * 用全量 route(匹配所有 URL)+ 内部 globToRegExp 匹配,保证 glob 方言与录制端完全一致
     *(不把 rule.urlPattern 直接交给 Playwright route,两者 glob 方言不同会致命中集漂移)。
     * 仅在 enabled 且有规则时注册 → 未启用零 route 开销;每条请求都必须 continue,否则页面卡死。
     */
    private async installRequestRoutes(context: BrowserContext): Promise<void> {
        const cfg = this.session.requestRules;
        if (!cfg || !cfg.enabled || cfg.rules.length === 0) {
            return; // 未启用 / 无规则:完全不注册,回放零额外开销
        }
        const rules = cfg.rules;
        logInfo(
            `回放请求改写器:已启用,共 ${rules.length} 条规则,` +
                `匹配 URL:${rules.map((r) => r.urlPattern).join(' | ')}`
        );
        await context.route('**/*', async (route: Route, request: Request) => {
            try {
                // 非 POST → 原样放行
                if (request.method().toUpperCase() !== 'POST') {
                    await route.continue();
                    return;
                }
                const rule = matchRule(rules, request.url());
                if (!rule) {
                    await route.continue(); // 未命中规则
                    return;
                }
                // Playwright 直接给完整 body(无需像 CDP 单独取);无 body 可改则放行
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
                    // 非法 JSON 等:记日志、原样放行(与录制端 rewriteBody 一致)
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
                    // Playwright 收普通字符串(非 base64);Content-Length 由网络栈重算
                    await route.continue({ postData: newBody });
                } else {
                    await route.continue(); // 规则没定义任何改写动作
                }
            } catch (err) {
                // 兜底:出任何错都尝试放行,避免页面卡死(铁律:每条请求必 continue)
                logError(`回放请求改写器:处理请求出错:${(err as Error).message}`);
                try {
                    await route.continue();
                } catch {
                    /* 请求可能已失效,忽略 */
                }
            }
        });
    }

    /**
     * 回放端「只记录不修改」支路:被动监听 context 级请求/响应事件,把命中的请求+响应写入
     * 时间线 JSONL 文件,供事后分析。**独立于 installRequestRoutes 的改写门槛**——即便改写关闭,
     * 只要 record.enabled 就记录;记录不改写、不进 route,与改写彻底解耦。
     *
     * 记录到的是页面**原始 body**(改写前):context.on('request') 的 postData() 反映页面本来要发什么,
     * 与 route.continue({postData}) 的改写解耦——这正是「支路互不影响」的正确表现。
     * context 级事件天然覆盖初始页与后续所有弹窗(同 installRequestRoutes / DownloadManager)。
     */
    private installTimelineRecording(context: BrowserContext): void {
        const rec = this.session.requestRules?.record;
        if (!rec || !rec.enabled) {
            return; // 未开启记录支路:零监听开销
        }
        const recorder = new TimelineRecorder(this.timelinesDir, 'replay', rec.urlPattern);
        const wantBody = rec.includeBody !== false;
        // Playwright 无 CDP requestId,用 WeakMap 记住每个请求的关联 id 与起始时刻(自增计数分配 id)
        const meta = new WeakMap<Request, { id: string; start: number }>();
        let seq = 0;
        logInfo(
            `回放请求记录:已启用(记录所有请求到时间线,不改写),匹配 URL:${rec.urlPattern || '全部'};` +
                `输出:${recorder.file}`
        );

        context.on('request', (req: Request) => {
            try {
                if (!recorder.matches(req.url())) {
                    return;
                }
                seq += 1;
                const id = String(seq);
                meta.set(req, { id, start: Date.now() });
                // Playwright 直接给完整 body(不截断);wantBody=false 时跳过
                const reqBody = wantBody ? req.postData() ?? undefined : undefined;
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
                const req = resp.request();
                const m = meta.get(req);
                if (!m) {
                    return; // 未命中记录条件(matches 未过)的请求
                }
                const respHeaders = resp.headers();
                const mimeType = headerValue(respHeaders, 'content-type');
                recorder.writeResponse({
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
                recorder.writeResponse({
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

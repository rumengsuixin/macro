// 宏回放引擎:读取 JSON 宏,使用 Playwright 启动浏览器并逐步执行。
// 每种 step 类型都有独立的处理方法;每一步执行前后打印中文日志;
// 出错时截图保存到 errors/ 目录,并返回结构化错误信息。
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
} from './macro-types';
import { extract, type PaginationContext } from './extractor';
import { DownloadManager } from './download-manager';
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

    constructor(
        errorDir: string,
        timeoutMs?: number,
        onPause?: OnPause,
        session?: SessionOptions,
        downloadDir?: string
    ) {
        this.errorDir = errorDir;
        // 回放默认超时:默认 60 秒;可用环境变量 MACRO_TIMEOUT(毫秒)覆盖
        this.timeoutMs = timeoutMs ?? (Number(process.env.MACRO_TIMEOUT) || 60000);
        // 无回调(无头/单测场景)时立即放行,避免永久挂起
        this.onPause = onPause ?? (async (): Promise<void> => {});
        this.session = session ?? {};
        this.downloadDir = downloadDir ?? path.join(errorDir, '..', 'downloads');
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
                // 翻页步骤正常回放时跳过,改由提取流程在采完一页后驱动
                if (step.pagination) {
                    logInfo(`第 ${i + 1}/${macro.steps.length} 步为翻页动作,正常回放跳过。`);
                    continue;
                }
                logInfo(`第 ${i + 1}/${macro.steps.length} 步:${describeStep(step)} —— 执行中`);
                await this.executeStep(activePage, step, i);
                logInfo(`第 ${i + 1}/${macro.steps.length} 步:${step.type} —— 完成`);
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
                    pagination = {
                        totalPages,
                        turnPage: async (): Promise<void> => {
                            for (const s of paginationSteps) {
                                await this.executeStep(runPage, s);
                            }
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
            return { ok: true, rows, downloads: downloads.length > 0 ? downloads : undefined };
        } catch (err) {
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
            return { ok: false, error: runError };
        } finally {
            // 持久化 context 关闭即退浏览器进程;临时模式下额外关 browser
            if (context) {
                await context.close();
            }
            if (browser) {
                await browser.close();
            }
            if (context || browser) {
                logInfo('浏览器已关闭。');
            }
        }
    }

    /** 分发并执行单个步骤;stepIndex 仅用于 pause 步骤向 UI 报告位置 */
    private async executeStep(page: Page, step: Step, stepIndex = -1): Promise<void> {
        switch (step.type) {
            case 'goto':
                await this.handleGoto(page, step.url);
                break;
            case 'click':
                await this.handleClick(page, step.selector);
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
            case 'waitForSelector':
                await this.handleWaitForSelector(page, step.selector, step.timeout);
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

    private async handleClick(page: Page, selector: string): Promise<void> {
        await page.click(selector);
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

    private async handleWaitForSelector(
        page: Page,
        selector: string,
        timeout?: number
    ): Promise<void> {
        // 未指定 timeout 时走全局默认超时(setDefaultTimeout);宏里显式指定的优先
        await page.waitForSelector(selector, timeout ? { timeout } : undefined);
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
        case 'waitForSelector':
            return `等待元素 ${step.selector}`;
        case 'pause':
            return `人工介入暂停${step.reason ? ':' + step.reason : ''}`;
        default:
            return '未知步骤';
    }
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

// 宏回放引擎:读取 JSON 宏,使用 Playwright 启动浏览器并逐步执行。
// 每种 step 类型都有独立的处理方法;每一步执行前后打印中文日志;
// 出错时截图保存到 errors/ 目录,并返回结构化错误信息。
import { chromium, type Browser, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import type { Macro, Step, RunResult, RunError, ExtractRow } from './macro-types';
import { extract, type PaginationContext } from './extractor';
import { logInfo, logError } from './logger';

export class MacroRunner {
    private errorDir: string;
    private timeoutMs: number;

    constructor(errorDir: string, timeoutMs?: number) {
        this.errorDir = errorDir;
        // 回放默认超时:默认 60 秒;可用环境变量 MACRO_TIMEOUT(毫秒)覆盖
        this.timeoutMs = timeoutMs ?? (Number(process.env.MACRO_TIMEOUT) || 60000);
    }

    /** 回放整个宏 */
    async run(macro: Macro): Promise<RunResult> {
        logInfo(`开始回放宏「${macro.name}」,共 ${macro.steps.length} 个步骤。`);

        let browser: Browser | null = null;
        let page: Page | null = null;
        let currentStepIndex = -1;
        let currentStep: Step | null = null;

        try {
            // 默认有头(回放可视);设置 MACRO_HEADLESS=1 可无头运行(便于自动化测试)
            const headless = process.env.MACRO_HEADLESS === '1';
            browser = await chromium.launch({ headless });
            const context = await browser.newContext();
            page = await context.newPage();
            // 提高默认超时,避免点击后慢页面导航等待("waiting for scheduled navigations")超时
            page.setDefaultTimeout(this.timeoutMs); // 影响 click/fill/waitForSelector 等动作(含 click 的导航等待)
            page.setDefaultNavigationTimeout(this.timeoutMs); // 影响 goto 等导航
            logInfo(`回放默认超时已设为 ${this.timeoutMs} 毫秒。`);

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
                await this.executeStep(page, step);
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
                    const runPage = page;
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
                rows = await extract(page, macro.extract, pagination);
                logInfo(`数据提取完成,共 ${rows.length} 行。`);
            } else {
                logInfo('未配置提取规则,跳过数据提取。');
            }

            logInfo('宏回放成功。');
            return { ok: true, rows };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const selector =
                currentStep && 'selector' in currentStep ? currentStep.selector : undefined;
            const url = page ? page.url() : undefined;
            const screenshot = page ? await this.captureErrorScreenshot(page) : undefined;

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
            if (browser) {
                await browser.close();
                logInfo('浏览器已关闭。');
            }
        }
    }

    /** 分发并执行单个步骤 */
    private async executeStep(page: Page, step: Step): Promise<void> {
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

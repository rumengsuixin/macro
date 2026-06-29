// 数据提取器:根据 ExtractConfig 从 Playwright 页面提取数据。
// 支持单字段(single)、列表(list)、列表+详情页(list-detail)、列表逐项动作(list-action)四种模式。
import type { Page, Locator } from 'playwright';
import type {
    ExtractConfig,
    ListExtractConfig,
    ListDetailExtractConfig,
    ListActionExtractConfig,
    ExtractField,
    ExtractRow,
} from './macro-types';
import type { DownloadManager } from './download-manager';
import { logInfo, logError } from './logger';

/** 翻页上下文:由回放引擎构造,提取流程在采完一页后驱动翻页 */
export interface PaginationContext {
    /** 总页数 N(共采集 N 页 → 翻页序列执行 N-1 次) */
    totalPages: number;
    /** 执行一次翻页(按序执行所有被标记的翻页步骤) */
    turnPage: () => Promise<void>;
}

/** 等列表渲染/换页的上限(毫秒):空页不干等满全局 60s;与 list-action 既有 actionTimeout 默认一致但语义独立 */
const PAGE_SETTLE_TIMEOUT = 30000;

/**
 * 每页处理前等列表项渲染就绪(三种翻页模式共用)。
 * 修首页:此前各循环只在 turnPage 后才等,首页之前无等待→AJAX 未就绪 count=0 整页被跳过。
 * 超时不抛(catch):真空结果页自然按 0 项处理,非致命。
 */
async function waitListReady(page: Page, listSelector: string): Promise<void> {
    await page
        .waitForSelector(listSelector, { timeout: PAGE_SETTLE_TIMEOUT })
        .catch(() => undefined);
}

/**
 * 翻页并等内容真正切换(三种翻页模式共用)。
 * SPA 翻页(纯 JS 换内容)后旧行常仍在 DOM,单纯 waitForSelector 会立即通过→下一轮读到旧页/重复处理。
 * 比较翻页前后「首个列表项文本」是否变化来确认换页;换页后的就绪等待由下一轮循环顶部的 waitListReady 承接。
 */
async function turnPageAndSettle(
    page: Page,
    pagination: PaginationContext,
    listSelector: string
): Promise<void> {
    const before = await page
        .locator(listSelector)
        .first()
        .textContent()
        .catch(() => null);
    await pagination.turnPage();
    if (before != null) {
        await page
            .waitForFunction(
                ([sel, prev]: readonly [string, string]) => {
                    let el: Element | null = null;
                    try {
                        el = document.querySelector(sel); // 非 CSS 选择器会抛→放行,交回 waitListReady
                    } catch {
                        return true;
                    }
                    return !!el && el.textContent !== prev;
                },
                [listSelector, before] as const,
                { timeout: PAGE_SETTLE_TIMEOUT }
            )
            .catch(() => undefined); // 两页首行恰好相同/超时:放行,靠下一轮 waitListReady 兜底
    }
}

/**
 * 从页面按配置提取数据。
 * - single:对每个字段取首个匹配元素,返回单行(翻页不适用)。
 * - list:逐页遍历列表项,在每项内提取各字段,返回多行。
 * - list-detail:先跨所有页采集每项基础字段与详情链接,再逐个进详情页抓详情字段,合并成行。
 * - list-action:逐页遍历列表项,逐项点击其中按钮(常用于每点一次触发一次下载),无数据行。
 * pagination 缺省时按单页处理(totalPages=1),行为与无翻页一致。
 * downloads 仅 list-action 用到(逐项节流);其它 mode 忽略。
 */
export async function extract(
    page: Page,
    config: ExtractConfig,
    pagination?: PaginationContext,
    downloads?: DownloadManager
): Promise<ExtractRow[]> {
    if (config.mode === 'single') {
        const row: ExtractRow = {};
        for (const field of config.fields) {
            row[field.name] = await extractFieldValue(page.locator(field.selector).first(), field);
        }
        return [row];
    }

    if (config.mode === 'list-detail') {
        return extractListDetail(page, config, pagination);
    }

    if (config.mode === 'list-action') {
        return extractListAction(page, config, pagination, downloads);
    }

    // list 模式:逐页采集
    const rows: ExtractRow[] = [];
    const totalPages = pagination ? pagination.totalPages : 1;
    for (let p = 1; p <= totalPages; p += 1) {
        await waitListReady(page, config.listSelector);
        const pageRows = await collectListRows(page, config);
        rows.push(...pageRows);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageRows.length} 行,累计 ${rows.length} 行。`);
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await turnPageAndSettle(page, pagination, config.listSelector);
        }
    }
    return rows;
}

/** 采集当前页所有列表项的字段,返回多行 */
async function collectListRows(page: Page, config: ListExtractConfig): Promise<ExtractRow[]> {
    const rows: ExtractRow[] = [];
    const items = page.locator(config.listSelector);
    const count = await items.count();
    for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const row: ExtractRow = {};
        for (const field of config.fields) {
            // 字段选择器留空时,直接取列表项本身
            const target = field.selector ? item.locator(field.selector).first() : item;
            row[field.name] = await extractFieldValue(target, field);
        }
        rows.push(row);
    }
    return rows;
}

/** 日志限长:单条诊断日志里的属性/文本最多保留这么多字符,超出截断标注(仅展示用,不影响数据) */
const DIAG_TEXT_MAX = 120;
/** 诊断时最多逐个列出多少个按钮,避免刷屏 */
const DIAG_BUTTON_MAX = 8;
/** 结构性伪类:这类伪类在 element-plus 这类包裹结构里最容易把匹配卡成 0 */
const STRUCTURAL_PSEUDO = /:(?:first-of-type|last-of-type|first-child|last-child|nth-child\([^)]*\)|nth-of-type\([^)]*\)|only-child|only-of-type)\s*$/i;

/** 把可能很长的文本压成一行并限长,供诊断日志展示 */
function clip(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > DIAG_TEXT_MAX ? `${oneLine.slice(0, DIAG_TEXT_MAX)}…` : oneLine;
}

/**
 * 诊断 list-action 某项「未找到可点击的按钮」的原因(全只读,绝不点击/改页面)。
 * 依次输出:①项内 button 概览(总数 + 各 class/文本)②选择器分段探测(第一处归零层级)
 * ③结构性伪类剥离重测。全程 try/catch,诊断本身出错也不影响回放。
 */
async function diagnoseMissingTarget(
    item: Locator,
    actionSelector: string | undefined,
    p: number,
    i: number
): Promise<void> {
    const tag = `第 ${p} 页第 ${i + 1} 项诊断`;
    // ① 项内按钮概览:让用户直接看到"正确的按钮长什么样"
    try {
        const buttons = item.locator('button');
        const btnCount = await buttons.count();
        logInfo(`${tag}:项内共有 ${btnCount} 个 <button>。`);
        const show = Math.min(btnCount, DIAG_BUTTON_MAX);
        for (let b = 0; b < show; b += 1) {
            const btn = buttons.nth(b);
            const cls = (await btn.getAttribute('class')) ?? '(无 class)';
            let txt = '';
            try {
                txt = await btn.innerText();
            } catch {
                txt = '';
            }
            logInfo(`${tag}:button[${b}] class="${clip(cls)}" 文本="${clip(txt)}"`);
        }
        if (btnCount > show) {
            logInfo(`${tag}:……还有 ${btnCount - show} 个 button 未列出。`);
        }
    } catch (err) {
        logInfo(`${tag}:统计项内 button 失败(${err instanceof Error ? err.message : String(err)})。`);
    }

    if (!actionSelector) {
        return;
    }

    // ② 选择器分段探测:按空格拆成后代层级,逐级累积前缀,定位第一处归零的层级
    try {
        const segs = actionSelector.split(/\s+/).filter(Boolean);
        let prefix = '';
        let brokeAt = -1;
        for (let s = 0; s < segs.length; s += 1) {
            prefix = prefix ? `${prefix} ${segs[s]}` : segs[s];
            const n = await item.locator(prefix).count();
            logInfo(`${tag}:分段「${prefix}」命中 ${n} 个。`);
            if (n === 0) {
                brokeAt = s;
                break;
            }
        }
        if (brokeAt >= 0) {
            logInfo(`${tag}:首处归零在第 ${brokeAt + 1} 段「${segs[brokeAt]}」,问题大概率出在这一段。`);
        }
    } catch (err) {
        logInfo(`${tag}:分段探测失败(${err instanceof Error ? err.message : String(err)})。`);
    }

    // ③ 结构性伪类剥离重测:去掉末段结构性伪类后若能命中,则伪类即元凶
    try {
        if (STRUCTURAL_PSEUDO.test(actionSelector)) {
            const stripped = actionSelector.replace(STRUCTURAL_PSEUDO, '');
            const n = await item.locator(stripped).count();
            if (n > 0) {
                logInfo(
                    `${tag}:去掉结构性伪类后「${stripped}」命中 ${n} 个 —— ` +
                        `伪类导致 0 匹配,建议移除伪类或改用 .first()。`
                );
            } else {
                logInfo(`${tag}:去掉结构性伪类后仍 0 匹配,问题不在伪类。`);
            }
        }
    } catch (err) {
        logInfo(`${tag}:伪类剥离重测失败(${err instanceof Error ? err.message : String(err)})。`);
    }
}

/**
 * list-action 模式:逐页遍历列表项,逐项点击其中按钮(常为下载按钮)。
 * 不产出数据行;下载由 context 层的 DownloadManager 通用捕获并落盘。
 * 每点一项后等这次下载开始(waitForNext)再点下一项,避免点太快;
 * 超时只告警并继续(晚到的下载仍会被全局 handler 保存,稳健)。
 */
async function extractListAction(
    page: Page,
    config: ListActionExtractConfig,
    pagination?: PaginationContext,
    downloads?: DownloadManager
): Promise<ExtractRow[]> {
    const actionTimeout = config.actionTimeout ?? 30000;
    const totalPages = pagination ? pagination.totalPages : 1;
    let clicked = 0;
    for (let p = 1; p <= totalPages; p += 1) {
        await waitListReady(page, config.listSelector);
        const items = page.locator(config.listSelector);
        const count = await items.count();
        logInfo(`第 ${p}/${totalPages} 页发现 ${count} 个列表项,开始逐项点击……`);
        for (let i = 0; i < count; i += 1) {
            const item = items.nth(i);
            // 动作选择器留空时,直接点列表项本身
            const target = config.actionSelector
                ? item.locator(config.actionSelector).first()
                : item;
            // 逐项进度日志:让 UI 实时可见、能定位卡在第几项(此前循环内零日志,易被误判卡死)
            logInfo(
                `第 ${p} 页 ${i + 1}/${count} 项:点击 ${config.actionSelector || '列表项本身'}……`
            );
            try {
                if ((await target.count()) === 0) {
                    logError(`第 ${p} 页第 ${i + 1} 项未找到可点击的按钮,跳过。`);
                    // 补一组只读诊断,帮助判断未命中的具体原因(哪一段断了/伪类元凶/项内实际按钮)
                    await diagnoseMissingTarget(item, config.actionSelector, p, i);
                    continue;
                }
                // 下载等待须在点击前注册,确保等待者先于 download 事件就位,不漏接快下载(修注册竞态)
                const waitPromise = downloads ? downloads.waitForNext(actionTimeout) : null;
                // 动作点击用专属较短超时(actionTimeout),坏选择器在此超时内快速暴露而非静默等满全局 60s
                await target.click({ timeout: actionTimeout });
                clicked += 1;
                // 等这次下载开始再继续;无下载管理器或超时则不阻塞下一项
                if (waitPromise) {
                    logInfo(
                        `第 ${p} 页第 ${i + 1} 项已点击,等待下载开始(最多 ${actionTimeout} 毫秒)……`
                    );
                    const saved = await waitPromise;
                    if (!saved) {
                        logError(
                            `第 ${p} 页第 ${i + 1} 项点击后 ${actionTimeout} 毫秒内未捕获到下载` +
                                `(若为非下载动作可忽略;晚到的下载仍会被保存)。`
                        );
                    }
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`第 ${p} 页第 ${i + 1} 项点击失败:${message},继续下一项。`);
            }
        }
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await turnPageAndSettle(page, pagination, config.listSelector);
        }
    }
    logInfo(
        `列表逐项动作完成:共点击 ${clicked} 项,捕获保存下载 ${downloads ? downloads.count() : 0} 个。`
    );
    return [];
}

/** 采集当前页每项的基础字段 + 详情链接(绝对化),返回待进详情的条目 */
async function collectListDetailPage(
    page: Page,
    config: ListDetailExtractConfig
): Promise<{ row: ExtractRow; detailUrl: string }[]> {
    const collected: { row: ExtractRow; detailUrl: string }[] = [];
    const items = page.locator(config.listSelector);
    const count = await items.count();
    for (let i = 0; i < count; i += 1) {
        const item = items.nth(i);
        const row: ExtractRow = {};
        for (const field of config.fields) {
            // 字段选择器留空时,直接取列表项本身
            const target = field.selector ? item.locator(field.selector).first() : item;
            row[field.name] = await extractFieldValue(target, field);
        }
        // 取详情链接 href 并绝对化(相对当前列表页 URL)。
        // 详情入口由用户从 fields 中选定(detailLinkField),用该字段的 selector 在项内取 href;
        // 字段缺失/留空时取列表项自身(沿用原语义)。
        const linkField = config.fields.find((f) => f.name === config.detailLinkField);
        const linkLoc =
            linkField && linkField.selector ? item.locator(linkField.selector).first() : item;
        const href = (await linkLoc.count()) ? (await linkLoc.getAttribute('href')) ?? '' : '';
        let detailUrl = '';
        if (href) {
            try {
                detailUrl = new URL(href, page.url()).toString();
            } catch {
                detailUrl = ''; // href 非法时按缺失处理
            }
        }
        collected.push({ row, detailUrl });
    }
    return collected;
}

/**
 * list-detail 模式:两阶段提取。
 * 阶段一:先跨所有页采集每项基础字段 + 详情链接(绝对化),全部收集完;
 * 阶段二:逐个进入详情页抓取详情字段并合并进对应行。
 * 单个详情页失败不致命:该行详情字段留空并记录日志,继续下一条。
 */
async function extractListDetail(
    page: Page,
    config: ListDetailExtractConfig,
    pagination?: PaginationContext
): Promise<ExtractRow[]> {
    // ===== 阶段一:跨所有页收集列表(必须先收集完整列表,再导航进详情;否则列表 DOM 丢失) =====
    const collected: { row: ExtractRow; detailUrl: string }[] = [];
    const totalPages = pagination ? pagination.totalPages : 1;
    for (let p = 1; p <= totalPages; p += 1) {
        await waitListReady(page, config.listSelector);
        const pageItems = await collectListDetailPage(page, config);
        collected.push(...pageItems);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageItems.length} 项,累计 ${collected.length} 项。`);
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await turnPageAndSettle(page, pagination, config.listSelector);
        }
    }

    logInfo(`列表全部采集完成,共 ${collected.length} 项,开始逐个进入详情页抓取……`);

    // ===== 阶段二:逐个进入详情页抓取详情字段 =====
    const rows: ExtractRow[] = [];
    for (let i = 0; i < collected.length; i += 1) {
        const { row, detailUrl } = collected[i];
        if (detailUrl) {
            try {
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
                for (const field of config.detailFields) {
                    row[field.name] = await extractFieldValue(
                        page.locator(field.selector).first(),
                        field
                    );
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`详情页抓取失败(${detailUrl}):${message},该行详情字段留空。`);
                for (const field of config.detailFields) {
                    if (!(field.name in row)) {
                        row[field.name] = '';
                    }
                }
            }
        } else {
            // 无详情链接:详情字段留空,保证列对齐
            for (const field of config.detailFields) {
                row[field.name] = '';
            }
        }
        logInfo(`详情进度 ${i + 1}/${collected.length}`);
        rows.push(row);
    }
    return rows;
}

/** 按字段类型从定位器取值;元素缺失时返回空串(保证数据完整,不截断) */
async function extractFieldValue(locator: Locator, field: ExtractField): Promise<string> {
    const exists = await locator.count();
    if (exists === 0) {
        return '';
    }
    switch (field.type) {
        case 'text':
            return ((await locator.innerText()) ?? '').trim();
        case 'html':
            return (await locator.innerHTML()) ?? '';
        case 'attr':
            return (await locator.getAttribute(field.attr ?? '')) ?? '';
        case 'href':
            return (await locator.getAttribute('href')) ?? '';
        case 'src':
            return (await locator.getAttribute('src')) ?? '';
        default:
            return '';
    }
}

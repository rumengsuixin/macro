// 数据提取器:根据 ExtractConfig 从 Playwright 页面提取数据。
// 支持单字段(single)、列表(list)、列表+详情页(list-detail)三种模式。
import type { Page, Locator } from 'playwright';
import type {
    ExtractConfig,
    ListExtractConfig,
    ListDetailExtractConfig,
    ExtractField,
    ExtractRow,
} from './macro-types';
import { logInfo, logError } from './logger';

/** 翻页上下文:由回放引擎构造,提取流程在采完一页后驱动翻页 */
export interface PaginationContext {
    /** 总页数 N(共采集 N 页 → 翻页序列执行 N-1 次) */
    totalPages: number;
    /** 执行一次翻页(按序执行所有被标记的翻页步骤) */
    turnPage: () => Promise<void>;
}

/**
 * 从页面按配置提取数据。
 * - single:对每个字段取首个匹配元素,返回单行(翻页不适用)。
 * - list:逐页遍历列表项,在每项内提取各字段,返回多行。
 * - list-detail:先跨所有页采集每项基础字段与详情链接,再逐个进详情页抓详情字段,合并成行。
 * pagination 缺省时按单页处理(totalPages=1),行为与无翻页一致。
 */
export async function extract(
    page: Page,
    config: ExtractConfig,
    pagination?: PaginationContext
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

    // list 模式:逐页采集
    const rows: ExtractRow[] = [];
    const totalPages = pagination ? pagination.totalPages : 1;
    for (let p = 1; p <= totalPages; p += 1) {
        const pageRows = await collectListRows(page, config);
        rows.push(...pageRows);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageRows.length} 行,累计 ${rows.length} 行。`);
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await pagination.turnPage();
            await page.waitForSelector(config.listSelector);
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
        // 取详情链接 href 并绝对化(相对当前列表页 URL)
        const linkLoc = config.detailLinkSelector
            ? item.locator(config.detailLinkSelector).first()
            : item;
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
        const pageItems = await collectListDetailPage(page, config);
        collected.push(...pageItems);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageItems.length} 项,累计 ${collected.length} 项。`);
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await pagination.turnPage();
            await page.waitForSelector(config.listSelector);
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

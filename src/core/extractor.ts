// 数据提取器:根据 ExtractConfig 从 Playwright 页面提取数据。
// 支持单字段(single)、列表(list)、列表+详情页(list-detail)、列表逐项动作(list-action)四种模式。
import type { Page, Locator } from 'playwright';
import type {
    ExtractConfig,
    ListExtractConfig,
    ListDetailExtractConfig,
    ListActionExtractConfig,
    ListActionFilter,
    ExtractField,
    FieldType,
    ExtractRow,
} from './macro-types';
import type { DownloadManager } from './download-manager';
import { logInfo, logError } from './logger';
import { evalBoolExpr, checkExprSyntax } from './expr-eval';
import { cleanFieldValue } from './field-transform';

/** 翻页上下文:由回放引擎构造,提取流程在采完一页后驱动翻页 */
export interface PaginationContext {
    /** 总页数 N(共采集 N 页 → 翻页序列执行 N-1 次) */
    totalPages: number;
    /** 执行一次翻页(按序执行所有被标记的翻页步骤) */
    turnPage: () => Promise<void>;
    /** 等列表就绪/换页的上限(毫秒);缺省走 PAGE_SETTLE_TIMEOUT(由回放档 pagination.settleTimeoutMs 注入) */
    settleTimeoutMs?: number;
    /** 每页处理后额外停顿(毫秒;缺省 0,由回放档 pagination.perPageDelayMs 注入) */
    perPageDelayMs?: number;
}

/** 等列表渲染/换页的上限(毫秒)缺省值:空页不干等满全局 60s;可被回放档 settleTimeoutMs 覆盖 */
const PAGE_SETTLE_TIMEOUT = 30000;

/**
 * 每页处理前等列表项渲染就绪(三种翻页模式共用)。
 * 修首页:此前各循环只在 turnPage 后才等,首页之前无等待→AJAX 未就绪 count=0 整页被跳过。
 * 超时不抛(catch):真空结果页自然按 0 项处理,非致命。
 */
async function waitListReady(
    page: Page,
    listSelector: string,
    settleMs: number = PAGE_SETTLE_TIMEOUT
): Promise<void> {
    await page.waitForSelector(listSelector, { timeout: settleMs }).catch(() => undefined);
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
                { timeout: pagination.settleTimeoutMs ?? PAGE_SETTLE_TIMEOUT }
            )
            .catch(() => undefined); // 两页首行恰好相同/超时:放行,靠下一轮 waitListReady 兜底
    }
}

/**
 * 翻页采集骨架(三种翻页模式共用):逐页「等列表就绪 → 处理本页 → 翻页并等内容切换」。
 * 把等待/翻页/翻页日志收敛成单一事实来源——新模式只需提供「处理本页」回调,
 * 避免接线遗漏(此前三处复制粘贴,首页缺等待的 bug 即因此三发)。
 * 累加(rows/collected/clicked)由调用方在闭包里维护;pagination 缺省 → 单页(totalPages=1)。
 */
async function paginatedCollect(
    page: Page,
    listSelector: string,
    pagination: PaginationContext | undefined,
    processPage: (pageIndex: number, totalPages: number) => Promise<void>
): Promise<void> {
    const totalPages = pagination ? pagination.totalPages : 1;
    const settleMs = pagination?.settleTimeoutMs ?? PAGE_SETTLE_TIMEOUT;
    const perPageDelay = pagination?.perPageDelayMs ?? 0;
    for (let p = 1; p <= totalPages; p += 1) {
        await waitListReady(page, listSelector, settleMs);
        await processPage(p, totalPages);
        if (perPageDelay > 0) {
            await page.waitForTimeout(perPageDelay); // 每页处理后拟人化停顿(回放档 perPageDelayMs)
        }
        if (p < totalPages && pagination) {
            logInfo(`执行翻页(前往第 ${p + 1}/${totalPages} 页)……`);
            await turnPageAndSettle(page, pagination, listSelector);
        }
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
    await paginatedCollect(page, config.listSelector, pagination, async (p, totalPages) => {
        const pageRows = await collectListRows(page, config);
        rows.push(...pageRows);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageRows.length} 行,累计 ${rows.length} 行。`);
    });
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
 * 归一化后的 list-action 动作(缺省已补全 + 动作级 gate / 收尾标记)。
 * filter=null 表示无动作级筛选;isFinally=true 表示收尾动作(总会在末尾执行、忽略自身 gate)。
 */
interface NormalizedAction {
    selector: string;
    scope: 'item' | 'page';
    filter: NormalizedFilter | null;
    onFilterFail: 'skip' | 'abort';
    waitFor: string;
    isFinally: boolean;
}

/**
 * 把 list-action 的 actionSelector(字符串 / 字符串或对象数组)归一化为动作数组。
 * 兼容旧格式:空串 → 空数组(点列表项本身);单字符串 → 单个项内动作;
 * 数组内字符串项视为 scope:'item',对象项补默认 scope。过滤空 selector。
 * 对象项另归一化:动作级 filter(复用 normalizeFilter)、onFilterFail(缺省 abort)、waitFor、finally 标记。
 */
function normalizeActions(actionSelector: ListActionExtractConfig['actionSelector']): NormalizedAction[] {
    const raw = Array.isArray(actionSelector) ? actionSelector : [actionSelector];
    const actions: NormalizedAction[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string') {
            const selector = entry.trim();
            if (selector) {
                actions.push({
                    selector,
                    scope: 'item',
                    filter: null,
                    onFilterFail: 'abort',
                    waitFor: '',
                    isFinally: false,
                });
            }
        } else if (entry && typeof entry === 'object' && typeof entry.selector === 'string') {
            const selector = entry.selector.trim();
            if (selector) {
                actions.push({
                    selector,
                    scope: entry.scope === 'page' ? 'page' : 'item',
                    filter: normalizeFilter(entry.filter),
                    onFilterFail: entry.onFilterFail === 'skip' ? 'skip' : 'abort',
                    waitFor: typeof entry.waitFor === 'string' ? entry.waitFor.trim() : '',
                    isFinally: entry.finally === true,
                });
            }
        }
    }
    return actions;
}

/**
 * 诊断 list-action 某个动作「未找到可点击的目标」的原因(全只读,绝不点击/改页面)。
 * 依次输出:①范围内 button 概览(总数 + 各 class/文本)②选择器分段探测(第一处归零层级)
 * ③结构性伪类剥离重测。全程 try/catch,诊断本身出错也不影响回放。
 * root 可为列表项 Locator(scope=item)或全页根 Locator(scope=page);label 用于日志区分动作。
 */
async function diagnoseMissingTarget(
    root: Locator,
    actionSelector: string | undefined,
    p: number,
    i: number,
    label = ''
): Promise<void> {
    const item = root;
    const tag = `第 ${p} 页第 ${i + 1} 项${label ? ` ${label}` : ''}诊断`;
    // ① 范围内按钮概览:让用户直接看到"正确的按钮长什么样"(item 根=项内,:root 根=全页)
    try {
        const buttons = item.locator('button');
        const btnCount = await buttons.count();
        logInfo(`${tag}:范围内共有 ${btnCount} 个 <button>。`);
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
        logInfo(`${tag}:统计范围内 button 失败(${err instanceof Error ? err.message : String(err)})。`);
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
    // 动作序列归一化:空 → 点列表项本身(旧语义);单/多动作各自带 scope(项内/全局)+ 动作级 gate / 收尾标记
    const actions = normalizeActions(config.actionSelector);
    // 拆分收尾动作(finally 标记)与主动作:收尾动作抽出,在每行主动作结束后总会执行(关弹窗)
    const finallyActions = actions.filter((a) => a.isFinally);
    const mainActions = actions.filter((a) => !a.isFinally);
    // 行级筛选归一化:null=无筛选(旧宏 / 无条件),否则每行先求筛选、不匹配整行跳过
    const filter = normalizeFilter(config.filter);
    // 筛选表达式求值失败的去重告警集(按条件文本 key),避免每行刷屏
    const warned = new Set<string>();
    // 载入期一次性语法体检:非法表达式提前中文告警(该条件将永不命中 → 相关行不执行动作)
    if (filter) {
        for (const cond of filter.conditions) {
            const err = checkExprSyntax(cond);
            if (err) {
                logError(`筛选条件「${cond}」语法错误:${err};该条件将永不命中,相关行不会执行动作。`);
            }
        }
    }
    // 动作级 gate 也做一次性语法体检(仅主动作;收尾动作忽略自身 gate)
    for (let a = 0; a < mainActions.length; a += 1) {
        const af = mainActions[a].filter;
        if (!af) {
            continue;
        }
        for (const cond of af.conditions) {
            const err = checkExprSyntax(cond);
            if (err) {
                logError(`动作${a + 1} 筛选条件「${cond}」语法错误:${err};该条件将永不命中。`);
            }
        }
    }
    let clicked = 0;
    // 执行一次点击并(可选)等这次下载开始;超时只告警不阻断(晚到的下载仍被全局 handler 保存)。
    // waitDownload=false 用于收尾等非下载点击,避免白等一个 actionTimeout + 误报「未捕获到下载」。
    const clickOnce = async (target: Locator, label: string, waitDownload = true): Promise<void> => {
        // 下载等待须在点击前注册,确保等待者先于 download 事件就位,不漏接快下载(修注册竞态)
        const waitPromise = waitDownload && downloads ? downloads.waitForNext(actionTimeout) : null;
        // 动作点击用专属较短超时(actionTimeout),坏选择器在此超时内快速暴露而非静默等满全局 60s
        await target.click({ timeout: actionTimeout });
        clicked += 1;
        if (waitPromise) {
            const saved = await waitPromise;
            if (!saved) {
                logError(
                    `${label} 点击后 ${actionTimeout} 毫秒内未捕获到下载` +
                        `(若为非下载动作可忽略;晚到的下载仍会被保存)。`
                );
            }
        }
    };
    await paginatedCollect(page, config.listSelector, pagination, async (p, totalPages) => {
        const items = page.locator(config.listSelector);
        const count = await items.count();
        logInfo(
            `第 ${p}/${totalPages} 页发现 ${count} 个列表项,每项 ${actions.length || 1} 个动作,开始逐项执行……`
        );
        let matched = 0;
        let skipped = 0;
        for (let i = 0; i < count; i += 1) {
            const item = items.nth(i);
            // 行级筛选:先对该行求筛选条件,不匹配则整行跳过(不执行任何动作)
            if (filter && !(await evalRowFilter(page, item, filter, warned))) {
                skipped += 1;
                logInfo(`第 ${p} 页 ${i + 1}/${count} 项:未匹配筛选条件,跳过。`);
                continue;
            }
            matched += 1;
            // 无任何动作:保留旧语义,直接点列表项本身。判据用原始 actions 是否为空——
            // 「只标了收尾、没有主动作」时不应误点列表项(此时 mainActions 空但仍要跑收尾)。
            if (actions.length === 0) {
                const label = `第 ${p} 页第 ${i + 1} 项`;
                logInfo(`第 ${p} 页 ${i + 1}/${count} 项:点击 列表项本身……`);
                try {
                    await clickOnce(item, label);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logError(`${label} 点击失败:${message},继续下一项。`);
                }
                continue;
            }
            // 逐个执行主动作(收尾动作已抽出,不在此循环):每个动作按 scope 选择项内 / 全局根
            for (let a = 0; a < mainActions.length; a += 1) {
                const action = mainActions[a];
                const usePage = action.scope === 'page';
                // page 根用 :root Locator 承载,使全局查找与只读诊断都能统一走 Locator API
                const root: Locator = usePage ? page.locator(':root') : item;
                const scopeLabel = usePage ? '全局' : '项内';
                const actLabel = mainActions.length > 1 ? `动作${a + 1}/${mainActions.length}[${scopeLabel}]` : `[${scopeLabel}]`;
                const label = `第 ${p} 页第 ${i + 1} 项 ${actLabel}`;
                // ① 可选等待:等前序动作弹出的弹窗内容渲染完成再判定/点击(尤其 gate 用 exists 时)
                if (action.waitFor) {
                    try {
                        await page.waitForSelector(action.waitFor, { state: 'visible', timeout: actionTimeout });
                    } catch {
                        logError(`${label} 等待 ${action.waitFor} 可见超时,仍继续判定/点击。`);
                    }
                }
                // ② 动作级 gate:对实时页面 DOM 求值(此刻前序动作弹出的弹窗已在 DOM,scope:'page' 变量可读弹窗内值)
                //    不满足按 onFilterFail 处置:skip=仅跳过本动作续后续;abort(缺省)=跳出本行剩余主动作(收尾照跑)
                if (action.filter && !(await evalRowFilter(page, item, action.filter, warned))) {
                    if (action.onFilterFail === 'skip') {
                        logInfo(`第 ${p} 页 ${i + 1}/${count} 项 ${actLabel}:未匹配动作级筛选,跳过该动作。`);
                        continue;
                    }
                    logInfo(`第 ${p} 页 ${i + 1}/${count} 项 ${actLabel}:未匹配动作级筛选,中止本行剩余动作。`);
                    break;
                }
                const target = root.locator(action.selector).first();
                // 逐项进度日志:让 UI 实时可见、能定位卡在第几项/第几个动作
                logInfo(`第 ${p} 页 ${i + 1}/${count} 项 ${actLabel}:点击 ${action.selector}……`);
                try {
                    if ((await target.count()) === 0) {
                        logError(`${label} 未找到可点击目标,跳过该动作。`);
                        // 补一组只读诊断,帮助判断未命中的具体原因(哪一段断了/伪类元凶/范围内实际按钮)
                        await diagnoseMissingTarget(root, action.selector, p, i, actLabel);
                        continue;
                    }
                    await clickOnce(target, label);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logError(`${label} 点击失败:${message},继续。`);
                }
            }
            // ③ 收尾动作:无论主动作正常跑完 / gate 中止 / 报错,已执行动作的行总会执行一次(关弹窗)。
            //    收尾点击不等下载(waitDownload=false),避免每行白等一个 actionTimeout。
            for (let f = 0; f < finallyActions.length; f += 1) {
                const action = finallyActions[f];
                const usePage = action.scope === 'page';
                const root: Locator = usePage ? page.locator(':root') : item;
                const target = root.locator(action.selector).first();
                const label = `第 ${p} 页第 ${i + 1} 项 收尾${finallyActions.length > 1 ? f + 1 : ''}`;
                try {
                    if ((await target.count()) === 0) {
                        logInfo(`${label}:未找到收尾目标(${action.selector}),跳过。`);
                        continue;
                    }
                    logInfo(`${label}:执行收尾 ${action.selector}……`);
                    await clickOnce(target, label, false);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    logError(`${label} 收尾失败:${message},继续下一项。`);
                }
            }
        }
        if (filter) {
            logInfo(`第 ${p} 页筛选:命中 ${matched} 项,跳过 ${skipped} 项(共 ${count} 项)。`);
        }
    });
    logInfo(
        `列表逐项动作完成:共执行点击 ${clicked} 次,捕获保存下载 ${downloads ? downloads.count() : 0} 个。`
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
    await paginatedCollect(page, config.listSelector, pagination, async (p, totalPages) => {
        const pageItems = await collectListDetailPage(page, config);
        collected.push(...pageItems);
        logInfo(`第 ${p}/${totalPages} 页采集到 ${pageItems.length} 项,累计 ${collected.length} 项。`);
    });

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
                        row[field.name] = cleanFieldValue(field, '');
                    }
                }
            }
        } else {
            // 无详情链接:详情字段填默认值(缺省空串),保证列对齐
            for (const field of config.detailFields) {
                row[field.name] = cleanFieldValue(field, '');
            }
        }
        logInfo(`详情进度 ${i + 1}/${collected.length}`);
        rows.push(row);
    }
    return rows;
}

/** 按字段类型从定位器取原始值;元素缺失时返回空串(清洗层负责 trim/转换) */
async function extractRawFieldValue(locator: Locator, field: ExtractField): Promise<string> {
    const exists = await locator.count();
    if (exists === 0) {
        return '';
    }
    switch (field.type) {
        case 'text':
            return (await locator.innerText()) ?? ''; // 不在此 trim,交清洗层统一处理
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

/** 取值并施加字段清洗链 + 默认值(保证数据完整,不截断) */
async function extractFieldValue(locator: Locator, field: ExtractField): Promise<string> {
    const raw = await extractRawFieldValue(locator, field);
    return cleanFieldValue(field, raw);
}

/** 归一化后的行筛选变量(缺省已补全) */
interface NormalizedFilterVar {
    name: string;
    selector: string;
    scope: 'item' | 'page';
    source: FieldType | 'exists';
    attr: string;
}

/** 归一化后的行筛选;仅当 ≥1 条非空条件时才产出,否则视为无筛选 */
interface NormalizedFilter {
    match: 'all' | 'any';
    vars: NormalizedFilterVar[];
    conditions: string[];
}

/**
 * 归一化 list-action 行筛选:去空白、补默认(match=all / var scope=item / source=text)。
 * 激活判据:conditions 去空后至少 1 条非空;否则返回 null(仅声明变量无意义 → 不筛选)。
 */
function normalizeFilter(filter?: ListActionFilter): NormalizedFilter | null {
    if (!filter || typeof filter !== 'object') {
        return null;
    }
    const conditions = Array.isArray(filter.conditions)
        ? filter.conditions
              .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
              .map((c) => c.trim())
        : [];
    // 至少 1 条非空条件才激活筛选(仅声明变量不生效)
    if (conditions.length === 0) {
        return null;
    }
    const vars: NormalizedFilterVar[] = [];
    if (Array.isArray(filter.vars)) {
        for (const v of filter.vars) {
            if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name.trim()) {
                continue;
            }
            vars.push({
                name: v.name.trim(),
                selector: typeof v.selector === 'string' ? v.selector.trim() : '',
                scope: v.scope === 'page' ? 'page' : 'item',
                source: v.source ?? 'text',
                attr: typeof v.attr === 'string' ? v.attr : '',
            });
        }
    }
    return { match: filter.match === 'any' ? 'any' : 'all', vars, conditions };
}

/**
 * 对单个列表项求行筛选:先注入内置变量 text(本行文本)/html(本行 HTML),
 * 再叠加用户命名变量(各自 scope 取值;同名覆盖内置),组成求值上下文;
 * 逐条布尔表达式求值后按 match(all=全真 / any=任一真)组合。
 * 失败即安全:某条 parse/eval 失败 → 该条记 false(all 下跳过该行,any 下不贡献),
 * 并按条件文本去重告警一次(warned),避免每行刷屏。
 */
async function evalRowFilter(
    page: Page,
    item: Locator,
    filter: NormalizedFilter,
    warned: Set<string>
): Promise<boolean> {
    const vars: Record<string, unknown> = {};
    // 内置 text/html:最常见筛选(本行文本含关键词)无需声明变量,直接 contains(text, '...')
    try {
        vars.text = ((await item.innerText()) ?? '').trim();
    } catch {
        vars.text = '';
    }
    try {
        vars.html = (await item.innerHTML()) ?? '';
    } catch {
        vars.html = '';
    }
    // 用户命名变量:各自 scope 取值(page 用 :root 承载整页,与动作逻辑一致);同名覆盖内置
    for (const v of filter.vars) {
        const root: Locator = v.scope === 'page' ? page.locator(':root') : item;
        const loc = v.selector ? root.locator(v.selector).first() : root;
        try {
            if (v.source === 'exists') {
                vars[v.name] = (await loc.count()) > 0;
            } else {
                vars[v.name] = await extractFieldValue(loc, {
                    name: v.name,
                    selector: v.selector,
                    type: v.source,
                    attr: v.attr,
                });
            }
        } catch {
            vars[v.name] = v.source === 'exists' ? false : '';
        }
    }
    // 逐条求值:失败即安全(记 false),按条件文本去重告警
    const results = filter.conditions.map((cond) => {
        const r = evalBoolExpr(cond, vars);
        if (!r.ok) {
            if (!warned.has(cond)) {
                warned.add(cond);
                logError(
                    `筛选条件「${cond}」${r.phase === 'parse' ? '语法错误' : '求值出错'}:${r.message};该条件按不满足处理。`
                );
            }
            return false;
        }
        return Boolean(r.value);
    });
    return filter.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

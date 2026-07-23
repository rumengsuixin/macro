// 通用 {{var}} 模板渲染 + 文件名消毒。纯字符串处理,无 Electron / fs 依赖。
// 块七 payload / status-file 模板、以及日后 merge 的 {stamp}/{date} 可共用。

/** 按点路径(如 error.message)从对象取值;任一层缺失返回 undefined */
function getByPath(obj: unknown, dotted: string): unknown {
    let cur: unknown = obj;
    for (const seg of dotted.split('.')) {
        if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[seg];
        } else {
            return undefined;
        }
    }
    return cur;
}

export interface RenderOptions {
    /**
     * 真 → 把替换进去的变量值按 JSON 字符串内容转义(去外层引号),
     * 供把变量注入 JSON body/模板时防止引号/换行破坏结构或注入。字面模板本身不受影响。
     */
    jsonEscape?: boolean;
}

/**
 * 渲染 {{var}} / {{a.b}} 模板。缺失变量替换为空串;数组/对象替换为其 JSON 文本。
 * 仅替换变量占位,字面文本原样保留;jsonEscape 只作用于被替换进去的变量值。
 */
export function renderTemplate(
    tpl: string,
    vars: Record<string, unknown>,
    opts: RenderOptions = {}
): string {
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
        const v = getByPath(vars, key);
        if (v === undefined || v === null) {
            return '';
        }
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (opts.jsonEscape) {
            const j = JSON.stringify(s); // "..." 带转义
            return j.slice(1, j.length - 1); // 去掉外层引号,只留转义后的内容
        }
        return s;
    });
}

/**
 * 文件名非法字符消毒(非路径):路径分隔 / 盘符冒号 / 通配 / 控制字符 → 下划线。
 * 与 merge-config 输出名消毒口径一致。
 */
export function sanitizeFilename(name: string): string {
    return name.replace(/[/\<>:"|?*]/g, '_');
}

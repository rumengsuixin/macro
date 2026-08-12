// 通用 {{var}} 模板渲染 + 输出文件名模板渲染 / 消毒。纯字符串处理,无 Electron / fs 依赖。
// 两套语法各司其职:双花括号 {{var}} 用于钩子 payload / status-file;
// 单花括号 {stamp} 用于输出文件名(merge-zip-excel、export-rows-excel 共用 renderFileNameTemplate)。

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
 * 结果恒为**单层文件名**——因为两种路径分隔符本身都被替换掉了,故
 * `path.join(某目录, sanitizeFilename(x))` 无法逃出该目录(防目录穿越)。
 */
export function sanitizeFilename(name: string): string {
    // eslint-disable-next-line no-control-regex
    return name.replace(/[/\\<>:"|?*\x00-\x1f]/g, '_');
}

/**
 * 与目标格式易混淆的表格类扩展名。产物格式由插件的写盘逻辑决定(exceljs → xlsx),不由用户
 * 填的后缀决定;但用户会按直觉填 `报表.csv`,无条件追加就得到 `报表.csv.xlsx` 这种双后缀。
 * 故补扩展名前先剥掉这一类冗余尾巴。只认表格类——避免吃掉文件名里有意义的部分。
 */
const REDUNDANT_TABLE_EXT_RE = /\.(csv|xls|xlsx|xlsm|xlsb|ods)$/i;

/** 文件名模板可用的占位符变量(未提供的键渲染为空串) */
export interface FileNameVars {
    /** 运行时间戳 YYYYMMDD-HHMMSS(由主进程传入,core 层不调时间 API) */
    stamp: string;
    /** 宏名称 */
    macro?: string;
    /** 产出该文件的插件 type */
    plugin?: string;
    /** 本次数据行数 */
    rows?: number;
}

/**
 * 渲染「输出文件名模板」:替换占位符 → 消毒 → 保证扩展名。
 * 占位符:{stamp} {date} {time} {macro} {plugin} {rows};{date}/{time} 由 stamp 派生
 * (stamp 不合 YYYYMMDD-HHMMSS 格式时,{date} 整段回退为 stamp、{time} 回退空串)。
 * 模板缺省 / trim 后为空 / 消毒后为空 → 一律用 fallback(fallback 自身也会被补扩展名)。
 * 补扩展名前会剥掉误填的表格类后缀(见 REDUNDANT_TABLE_EXT_RE),`报表.csv` → `报表.xlsx`
 * 而非 `报表.csv.xlsx`。
 * @param template 模板串(可为 undefined)
 * @param vars 占位符取值
 * @param fallback 模板不可用时的缺省文件名
 * @param ext 强制扩展名(含前导点,大小写不敏感判定);缺省 '.xlsx'
 */
export function renderFileNameTemplate(
    template: string | undefined,
    vars: FileNameVars,
    fallback: string,
    ext = '.xlsx'
): string {
    const { stamp } = vars;
    const dm = /^(\d{4})(\d{2})(\d{2})/.exec(stamp);
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : stamp;
    const tm = /-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
    const time = tm ? `${tm[1]}${tm[2]}${tm[3]}` : '';
    const table: Record<string, string> = {
        stamp,
        date,
        time,
        macro: vars.macro ?? '',
        plugin: vars.plugin ?? '',
        rows: vars.rows === undefined ? '' : String(vars.rows),
    };

    const tpl = typeof template === 'string' && template.trim() ? template : fallback;
    // 只替换已知占位符;未知的 {xxx} 原样保留(它本身是合法文件名字符)
    let name = tpl.replace(/\{(stamp|date|time|macro|plugin|rows)\}/g, (_m, k: string) => table[k]);
    name = sanitizeFilename(name).trim();
    if (!name) {
        name = sanitizeFilename(fallback).trim() || `output-${stamp}${ext}`;
    }
    const extRe = new RegExp(`${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (!extRe.test(name)) {
        // 先剥掉误填的表格类后缀(容忍叠了多层),再补目标扩展名;
        // 若剥到空(模板本身就只有一个后缀,如 ".csv")则放弃剥,保留原名再补。
        let base = name;
        for (;;) {
            const stripped = base.replace(REDUNDANT_TABLE_EXT_RE, '');
            if (stripped === base || !stripped) {
                break;
            }
            base = stripped;
        }
        name = base + ext;
    }
    return name;
}

// merge-zip-excel 的解析配置(运行时可编辑,配置驱动)
// 目的:不同下载模板的「真表头在第几行 / 用哪个工作表 / 裁到哪列」各不相同(例如银行/交易所导出的
//       模板前面常有标题、说明块,右侧还有说明面板)。把这些解析参数外置到 merge-config.json,
//       按「文件名 glob 或 工作表名 glob」匹配规则决定——以后适配新格式只改配置,不动代码、不重打包。
// 加载惯例照抄 request-rules-store 的「代码内联模板」变体:首次不存在写文档化模板、坏 JSON 兜底默认。
// 纯 node:fs/path,不依赖 Electron(与其它 core 层 loader 同风格)。
import fs from 'fs';

/** 单条解析规则(字段均可选;命中后按已设字段覆盖 defaults) */
export interface MergeRule {
    /** 文件名(basename)glob,`*`/`?`,大小写不敏感 */
    match?: string;
    /** 工作表首表名 glob,`*`/`?`,大小写不敏感 */
    matchSheet?: string;
    /** 工作表选择:数字(0 起索引)或工作表名字符串 */
    sheet?: number | string;
    /** 真表头所在行,1 起 */
    headerRow?: number;
    /** 裁列上界列字母(如 'D'),只取 A..endColumn;空串=全列 */
    endColumn?: string;
    /** 人工备注(不参与逻辑) */
    note?: string;
}

/** 一次读取所用的有效解析参数(defaults 与命中规则合并后的结果) */
export interface MergeOpts {
    sheet: number | string;
    headerRow: number;
    endColumn: string;
}

/** merge-config.json 结构 */
export interface MergeConfig {
    /** 全局缺省 + addSourceColumn(是否追加「来源文件」列) */
    defaults: MergeOpts & { addSourceColumn: boolean };
    /** 匹配规则,按顺序取首条命中 */
    rules: MergeRule[];
}

/** 内置默认:等价于历史行为(首表、行1 表头、不裁列、不加来源列) */
export const DEFAULT_CONFIG: MergeConfig = {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false },
    rules: [],
};

/** 首次生成的文档化模板(含一条 Binance payout 示例规则,开箱即可命中该类模板) */
function templateConfig(): MergeConfig {
    return {
        defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false },
        rules: [
            {
                matchSheet: '*Payout Template*',
                match: '*payout*.xls',
                sheet: 0,
                headerRow: 2,
                endColumn: 'D',
                note: 'Binance Pay Payout 模板:行1标题、真表头在行2、数据行3起;右侧是说明面板故只取 A:D',
            },
        ],
    };
}

/** glob(`*`/`?`)转大小写不敏感、整串锚定的 RegExp */
function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${body}$`, 'i');
}

/** 取路径 basename(同时兼容 `/` 与 `\` 分隔,供 zip 内条目名/裸文件名统一处理) */
function baseName(name: string): string {
    const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    return i >= 0 ? name.slice(i + 1) : name;
}

/** sheet 归一:number≥0 或非空字符串才有效,否则回退 0 */
function normSheet(v: unknown): number | string {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        return Math.floor(v);
    }
    if (typeof v === 'string' && v.length > 0) {
        return v;
    }
    return 0;
}

/** headerRow 归一:正整数(1 起)才有效,否则回退 1 */
function normHeaderRow(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1) {
        return Math.floor(v);
    }
    return 1;
}

/** endColumn 归一:仅接受纯字母(如 'D'/'AB'),统一大写;否则空串(全列) */
function normEndColumn(v: unknown): string {
    if (typeof v === 'string' && /^[A-Za-z]+$/.test(v)) {
        return v.toUpperCase();
    }
    return '';
}

/** 单条规则归一:既无 match 又无 matchSheet 的丢弃(返回 null) */
function normRule(raw: unknown): MergeRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    const match = typeof r.match === 'string' && r.match ? r.match : undefined;
    const matchSheet = typeof r.matchSheet === 'string' && r.matchSheet ? r.matchSheet : undefined;
    if (!match && !matchSheet) {
        return null; // 无匹配键的规则永不命中,直接剔除
    }
    const rule: MergeRule = {};
    if (match) rule.match = match;
    if (matchSheet) rule.matchSheet = matchSheet;
    if (r.sheet !== undefined) rule.sheet = normSheet(r.sheet);
    if (r.headerRow !== undefined) rule.headerRow = normHeaderRow(r.headerRow);
    if (r.endColumn !== undefined) rule.endColumn = normEndColumn(r.endColumn);
    if (typeof r.note === 'string') rule.note = r.note;
    return rule;
}

/**
 * 加载 merge-config.json。
 * - 不存在:写文档化模板并返回它(写失败不致命)。
 * - 存在:逐字段校验、非法项回退默认 / 剔除。
 * - 坏 JSON 等异常:回退 DEFAULT_CONFIG(= 历史行为)。
 * @param filePath 配置路径(dataRoot/merge-config.json)
 */
export function loadMergeConfig(filePath: string): MergeConfig {
    try {
        if (!fs.existsSync(filePath)) {
            const tpl = templateConfig();
            try {
                fs.writeFileSync(filePath, JSON.stringify(tpl, null, 4), 'utf-8');
            } catch {
                /* 写模板失败(如只读目录)不致命 */
            }
            return tpl;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<MergeConfig>;
        const d = (raw.defaults ?? {}) as Record<string, unknown>;
        const defaults = {
            sheet: normSheet(d.sheet),
            headerRow: normHeaderRow(d.headerRow),
            endColumn: normEndColumn(d.endColumn),
            addSourceColumn: d.addSourceColumn === true,
        };
        const rules = Array.isArray(raw.rules)
            ? raw.rules.map(normRule).filter((x): x is MergeRule => x !== null)
            : [];
        return { defaults, rules };
    } catch {
        return DEFAULT_CONFIG;
    }
}

/**
 * 为一个待读文件解析有效参数:取首条命中规则(match 匹配文件名 basename,或 matchSheet 匹配工作表名),
 * 与 defaults 合并(命中规则的已设字段覆盖);无命中则用 defaults。
 * @param fileName 文件名(裸文件名或 zip 内条目名)
 * @param sheetName 该工作簿首表名(用于 matchSheet;CSV 无意义时传空串即可)
 */
export function resolveMergeOpts(
    config: MergeConfig,
    fileName: string,
    sheetName: string
): MergeOpts & { addSourceColumn: boolean } {
    const base = baseName(fileName);
    for (const rule of config.rules) {
        const hitName = rule.match ? globToRegExp(rule.match).test(base) : false;
        const hitSheet = rule.matchSheet ? globToRegExp(rule.matchSheet).test(sheetName) : false;
        if (hitName || hitSheet) {
            return {
                sheet: rule.sheet !== undefined ? rule.sheet : config.defaults.sheet,
                headerRow: rule.headerRow !== undefined ? rule.headerRow : config.defaults.headerRow,
                endColumn: rule.endColumn !== undefined ? rule.endColumn : config.defaults.endColumn,
                addSourceColumn: config.defaults.addSourceColumn,
            };
        }
    }
    return { ...config.defaults };
}

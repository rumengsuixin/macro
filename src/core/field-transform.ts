// 字段清洗引擎:声明式 transform 链施加 + 导出列规格推导。
// 纯函数,无 Electron / Playwright 依赖,可被 core(extractor)与主进程(export)复用。
import type { ExtractConfig, ExtractField, TransformOp, ColumnSpec } from './macro-types';

/** 补零到两位 */
function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/** 按模板格式化日期(支持 YYYY/MM/DD/HH/mm/ss) */
function formatDate(d: Date, fmt: string): string {
    return fmt
        .replace(/YYYY/g, String(d.getFullYear()))
        .replace(/MM/g, pad2(d.getMonth() + 1))
        .replace(/DD/g, pad2(d.getDate()))
        .replace(/HH/g, pad2(d.getHours()))
        .replace(/mm/g, pad2(d.getMinutes()))
        .replace(/ss/g, pad2(d.getSeconds()));
}

/** 施加单个清洗动作;非法正则等异常由调用方兜底跳过该步 */
function applyOp(op: TransformOp, value: string): string {
    switch (op.op) {
        case 'trim':
            return value.trim();
        case 'collapseWhitespace':
            return value.replace(/\s+/g, ' ').trim();
        case 'replace': {
            const re = new RegExp(op.pattern, op.flags ?? '');
            return value.replace(re, op.to ?? '');
        }
        case 'stripThousands':
            // 仅剥离夹在数字之间的逗号(1,234,567 → 1234567),避免误伤普通文本
            return value.replace(/(\d),(?=\d)/g, '$1');
        case 'number': {
            const n = parseFloat(value.replace(/[^0-9.\-]/g, ''));
            if (Number.isNaN(n)) {
                return value; // 非数字保持原值,不猜
            }
            return typeof op.decimals === 'number' ? n.toFixed(op.decimals) : String(n);
        }
        case 'date': {
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) {
                return value; // 非法日期保持原值
            }
            return formatDate(d, op.to);
        }
        default:
            return value;
    }
}

/**
 * 对一个字段的原始取值施加清洗链并套用默认值。
 * - transform 缺省时:text 类型隐含 trim(兼容旧行为),其它类型原样返回(与历史一致)。
 * - 单步异常(非法正则等)跳过该步、保留当前值,不影响后续步骤(数据完整优先)。
 * - 清洗后为空且配了 default 则填充。
 */
export function cleanFieldValue(field: ExtractField, raw: string): string {
    let v = raw;
    const ops = field.transform;
    if (ops && ops.length > 0) {
        for (const op of ops) {
            try {
                v = applyOp(op, v);
            } catch {
                /* 非法步骤跳过,保留当前值 */
            }
        }
    } else if (field.type === 'text') {
        v = v.trim(); // 兼容旧行为:无 transform 时 text 仍 trim
    }
    if (v === '' && typeof field.default === 'string') {
        v = field.default;
    }
    return v;
}

/** 把 number 的小数位转成 Excel 数字格式串 */
function numFmtForDecimals(decimals?: number): string {
    if (typeof decimals === 'number' && decimals > 0) {
        return `0.${'0'.repeat(decimals)}`;
    }
    return '0';
}

/** 把日期模板(YYYY-MM-DD)转成 Excel numFmt(yyyy-mm-dd);月份 MM→mm 靠 Excel 上下文识别 */
function excelDateFmt(to: string): string {
    return to
        .replace(/YYYY/g, 'yyyy')
        .replace(/DD/g, 'dd')
        .replace(/HH/g, 'hh')
        .replace(/MM/g, 'mm');
}

/**
 * 从提取规则里收集全部导出字段:fields + list-detail 的 detailFields(按此序,与提取产出的
 * 行对象一致)。list-action 无字段 → 空数组。结果直接喂 fieldsToColumnSpecs。
 * 与渲染端 currentExportFields() 同口径,但放在 core 供主进程组装后处理器上下文时用。
 */
export function collectExtractFields(extract: ExtractConfig | undefined): ExtractField[] {
    if (!extract || typeof extract !== 'object') {
        return [];
    }
    const cfg = extract as { fields?: unknown; detailFields?: unknown };
    const fields = Array.isArray(cfg.fields) ? (cfg.fields as ExtractField[]) : [];
    const detail = Array.isArray(cfg.detailFields) ? (cfg.detailFields as ExtractField[]) : [];
    return [...fields, ...detail];
}

/**
 * 由字段定义推导导出列规格(列名 / 排序 / 隐藏 / 数字日期格式)。
 * list-detail 场景由调用方把 fields.concat(detailFields) 一并传入(见 collectExtractFields)。
 */
export function fieldsToColumnSpecs(fields: ExtractField[]): ColumnSpec[] {
    return fields.map((f, i) => {
        const spec: ColumnSpec = {
            key: f.name,
            label: typeof f.label === 'string' && f.label.trim() ? f.label : f.name,
            order: typeof f.order === 'number' ? f.order : i,
            hidden: f.hidden === true,
        };
        const ops = f.transform ?? [];
        const dateOp = ops.find((o) => o.op === 'date') as
            | Extract<TransformOp, { op: 'date' }>
            | undefined;
        const numOp = ops.find((o) => o.op === 'number') as
            | Extract<TransformOp, { op: 'number' }>
            | undefined;
        if (dateOp) {
            spec.kind = 'date';
            spec.numFmt = excelDateFmt(dateOp.to);
        } else if (numOp) {
            spec.kind = 'number';
            spec.numFmt = numFmtForDecimals(numOp.decimals);
        }
        return spec;
    });
}

// Excel 导出器:将提取结果写入 xlsx 文件。
// 第一行为列名(字段名或字段 label),后续行为数据。
import ExcelJS from 'exceljs';
import type { ExtractRow, ColumnSpec } from './macro-types';

/**
 * 将数据行导出到 Excel 文件。
 * @param rows 数据行数组(每行是字段名 → 值的对象)
 * @param outputPath 输出文件完整路径
 * @param columns 可选列规格(label/order/hidden/numFmt/kind);缺省时退回历史行为(行 key 并集、列名=key)
 * @returns 实际写入的文件路径
 */
export async function exportToExcel(
    rows: ExtractRow[],
    outputPath: string,
    columns?: ColumnSpec[]
): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('数据');

    const specs = resolveColumns(rows, columns);

    if (specs.length === 0) {
        sheet.addRow(['(无数据)']);
        await workbook.xlsx.writeFile(outputPath);
        return outputPath;
    }

    // 首行:列名(label)
    const header = sheet.addRow(specs.map((s) => s.label));
    header.font = { bold: true };

    // 数据行:按列规格取值 + 类型/格式
    for (const row of rows) {
        const excelRow = sheet.addRow(specs.map((s) => cellValue(row[s.key] ?? '', s)));
        specs.forEach((s, idx) => {
            if (s.numFmt) {
                excelRow.getCell(idx + 1).numFmt = s.numFmt;
            }
        });
    }

    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
}

/**
 * 决定导出列:
 * - 传入列规格:过滤 hidden、按 order 稳定升序。
 * - 未传:退回历史行为——收集所有行 key 的并集(保持首次出现顺序),列名=key。
 */
function resolveColumns(rows: ExtractRow[], columns?: ColumnSpec[]): ColumnSpec[] {
    if (columns && columns.length > 0) {
        return columns
            .filter((c) => !c.hidden)
            .map((c, i) => ({ ...c, order: typeof c.order === 'number' ? c.order : i }))
            .sort((a, b) => a.order - b.order);
    }
    const keys: string[] = [];
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!keys.includes(key)) {
                keys.push(key);
            }
        }
    }
    return keys.map((k, i) => ({ key: k, label: k, order: i, hidden: false }));
}

/** 按列类型把字符串值转为 Excel 单元格值(number/date 转真类型便于计算;失败退回字符串) */
function cellValue(raw: string, spec: ColumnSpec): string | number | Date {
    if (raw === '') {
        return '';
    }
    if (spec.kind === 'number') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
    }
    if (spec.kind === 'date') {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? raw : d;
    }
    return raw;
}

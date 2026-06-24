// Excel 导出器:将提取结果写入 xlsx 文件。
// 第一行为字段名,后续行为数据。
import ExcelJS from 'exceljs';
import type { ExtractRow } from './macro-types';

/**
 * 将数据行导出到 Excel 文件。
 * @param rows 数据行数组(每行是字段名 → 值的对象)
 * @param outputPath 输出文件完整路径
 * @returns 实际写入的文件路径
 */
export async function exportToExcel(rows: ExtractRow[], outputPath: string): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('数据');

    // 收集所有字段名(并集,保持首次出现顺序),保证不丢列
    const columns: string[] = [];
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!columns.includes(key)) {
                columns.push(key);
            }
        }
    }

    if (columns.length === 0) {
        sheet.addRow(['(无数据)']);
    } else {
        // 首行:字段名
        const header = sheet.addRow(columns);
        header.font = { bold: true };
        // 数据行
        for (const row of rows) {
            sheet.addRow(columns.map((c) => row[c] ?? ''));
        }
    }

    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
}

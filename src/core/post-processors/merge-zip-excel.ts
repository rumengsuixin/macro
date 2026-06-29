// 后处理器:merge-zip-excel
// 定制需求 —— list-action 逐项下载得到的每个文件是 zip,内部仅一个 excel 表;
// 将这一批 zip 内的 excel「堆叠合并成一张总表」,产出 exports/merged-<时间戳>.xlsx。
// 复用现有 exportToExcel 写盘(不重写),用 exceljs 读 xlsx、adm-zip 解压(均不落临时文件)。
import path from 'path';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import type { PostProcessSpec, PostProcessResult, ExtractRow } from '../macro-types';
import { exportToExcel } from '../excel-exporter';
import { logInfo, logError } from '../logger';
import { registerPostProcessor, type PostProcessContext, type PostProcessHandler } from './index';

/** 来源文件列名(options.addSourceColumn 为真时追加) */
const SOURCE_COLUMN = '来源文件';

/**
 * 读取一个 xlsx Buffer 的首个工作表,转成 ExtractRow[]。
 * 第 1 行为表头,其余为数据行;空单元格填空串。无数据返回 []。
 */
async function readXlsxBuffer(buf: Buffer): Promise<ExtractRow[]> {
    const wb = new ExcelJS.Workbook();
    // adm-zip 的 Buffer 与 exceljs 期望的 Buffer 泛型有差异,运行期兼容,此处仅消类型噪声
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet || sheet.rowCount < 1) {
        return [];
    }
    // 取表头(第 1 行);ExcelJS 行/列从 1 开始,values[0] 恒为空
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col - 1] = cellToString(cell.value);
    });
    const rows: ExtractRow[] = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const obj: ExtractRow = {};
        let hasValue = false;
        for (let c = 0; c < headers.length; c += 1) {
            const key = headers[c] || `列${c + 1}`;
            const val = cellToString(row.getCell(c + 1).value);
            obj[key] = val;
            if (val !== '') {
                hasValue = true;
            }
        }
        // 跳过整行皆空的行
        if (hasValue) {
            rows.push(obj);
        }
    }
    return rows;
}

/** ExcelJS 单元格值归一为字符串(处理富文本/公式/超链接/日期等常见形态) */
function cellToString(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        const v = value as unknown as Record<string, unknown>;
        // 超链接单元格
        if (typeof v.text === 'string') {
            return v.text;
        }
        // 公式结果
        if ('result' in v && v.result !== undefined && v.result !== null) {
            return String(v.result);
        }
        // 富文本
        if (Array.isArray(v.richText)) {
            return (v.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
        }
    }
    return String(value);
}

const handler: PostProcessHandler = async (
    spec: PostProcessSpec,
    ctx: PostProcessContext
): Promise<PostProcessResult> => {
    const addSourceColumn = spec.options?.addSourceColumn === true;
    const zips = ctx.downloads.filter((p) => p.toLowerCase().endsWith('.zip'));
    if (zips.length === 0) {
        return { type: spec.type, message: '本次下载中没有 zip 文件,无可合并内容。' };
    }

    const allRows: ExtractRow[] = [];
    let mergedSheetCount = 0;
    for (const zipPath of zips) {
        const baseName = path.basename(zipPath);
        let zip: AdmZip;
        try {
            zip = new AdmZip(zipPath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`打开 zip 失败(跳过):${baseName} —— ${message}`);
            continue;
        }
        const xlsxEntries = zip
            .getEntries()
            .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xlsx'));
        const xlsEntries = zip
            .getEntries()
            .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xls'));
        if (xlsxEntries.length === 0) {
            if (xlsEntries.length > 0) {
                logError(`zip ${baseName} 内仅含老式 .xls(exceljs 不支持),已跳过。`);
            } else {
                logError(`zip ${baseName} 内未找到 .xlsx 表格,已跳过。`);
            }
            continue;
        }
        // 规格是每个 zip 内仅一个 excel,但容错多个:逐个读入
        for (const entry of xlsxEntries) {
            try {
                const rows = await readXlsxBuffer(entry.getData());
                if (addSourceColumn) {
                    for (const row of rows) {
                        row[SOURCE_COLUMN] = baseName;
                    }
                }
                allRows.push(...rows);
                mergedSheetCount += 1;
                logInfo(`已读取 ${baseName} → ${entry.entryName}:${rows.length} 行。`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`读取 ${baseName} → ${entry.entryName} 失败(跳过):${message}`);
            }
        }
    }

    if (mergedSheetCount === 0) {
        return { type: spec.type, message: `共 ${zips.length} 个 zip,但未能从中读出任何 .xlsx 表格。` };
    }

    const output = path.join(ctx.exportsDir, `merged-${ctx.stamp}.xlsx`);
    await exportToExcel(allRows, output);
    const fileName = path.basename(output);
    return {
        type: spec.type,
        output,
        message: `已合并 ${mergedSheetCount} 个表格 / 共 ${allRows.length} 行 → ${fileName}`,
    };
};

registerPostProcessor(
    {
        type: 'merge-zip-excel',
        label: '批量下载表格合并',
        description: '解压每个 zip 取内部 excel,堆叠为一张总表(产出 exports/merged-*.xlsx)',
    },
    handler
);

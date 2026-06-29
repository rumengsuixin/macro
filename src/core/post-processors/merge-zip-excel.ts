// 后处理器:merge-zip-excel
// 需求 —— list-action 逐项下载得到一批表格文件(zip 包内的 csv/xls/xlsx,或直接下载的裸表格),
// 把它们「堆叠合并成一张总表」,产出 exports/merged-<时间戳>.xlsx。
// 读:用 SheetJS(xlsx 库)通用读取器通吃 csv/xls/xlsx;csv 自己用 iconv-lite 解码(UTF-8 主 + GBK 兜底)
//     再交 SheetJS 解析字段。adm-zip 解压(直接取 Buffer 不落临时文件)。
// 写:复用现有 exportToExcel(exceljs,union 列),不重写写盘逻辑。
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import iconv from 'iconv-lite';
import type { PostProcessSpec, PostProcessResult, ExtractRow } from '../macro-types';
import { exportToExcel } from '../excel-exporter';
import { logInfo, logError } from '../logger';
import { registerPostProcessor, type PostProcessContext, type PostProcessHandler } from './index';

/** 来源文件列名(options.addSourceColumn 为真时追加) */
const SOURCE_COLUMN = '来源文件';
/** 可识别为「表格」的扩展名(小写,含点) */
const SUPPORTED_EXT = ['.xlsx', '.xls', '.xlsm', '.csv'];

/** 取小写扩展名(含点),如 '.csv';无扩展名返回 '' */
function lowerExt(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * CSV 文本解码:UTF-8 为主、GBK 兜底。
 * 先按 UTF-8 解;若出现替换符 U+FFFD(多半是 GBK 字节被错当 UTF-8)则改用 GBK 重解。
 * 最后去掉开头可能的 BOM。
 */
function decodeCsv(buf: Buffer): string {
    let s = buf.toString('utf8');
    if (s.includes('�')) {
        try {
            s = iconv.decode(buf, 'gbk');
        } catch {
            // GBK 解码失败则沿用 UTF-8 结果
        }
    }
    // 去掉开头 BOM(UTF-8 BOM 解出为 U+FEFF)
    if (s.charCodeAt(0) === 0xfeff) {
        s = s.slice(1);
    }
    return s;
}

/**
 * 读取一个表格文件(csv/xls/xlsx)的首个工作表,转成 ExtractRow[]。
 * 以首行表头为键、空单元格填空串、值转字符串;无数据返回 []。
 * 不支持的扩展名返回 null(由调用方告警跳过)。
 */
function readTable(name: string, buf: Buffer): ExtractRow[] | null {
    const ext = lowerExt(name);
    if (!SUPPORTED_EXT.includes(ext)) {
        return null;
    }
    const wb =
        ext === '.csv'
            ? XLSX.read(decodeCsv(buf), { type: 'string' })
            : XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
        return [];
    }
    const ws = wb.Sheets[sheetName];
    // defval:'' 缺省填空串、raw:false 值统一转字符串 → 直接得 Record<string,string>[]
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, {
        defval: '',
        raw: false,
    });
    return rows;
}

const handler: PostProcessHandler = async (
    spec: PostProcessSpec,
    ctx: PostProcessContext
): Promise<PostProcessResult> => {
    const addSourceColumn = spec.options?.addSourceColumn === true;
    const allRows: ExtractRow[] = [];
    let mergedTableCount = 0;

    /** 读一个表格 Buffer,成功则并入 allRows;来源名 sourceLabel 用于日志/来源列 */
    const ingest = (name: string, buf: Buffer, sourceLabel: string): void => {
        try {
            const rows = readTable(name, buf);
            if (rows === null) {
                return; // 不支持的扩展名,由外层决定是否告警
            }
            if (addSourceColumn) {
                for (const row of rows) {
                    row[SOURCE_COLUMN] = sourceLabel;
                }
            }
            allRows.push(...rows);
            mergedTableCount += 1;
            logInfo(`已读取 ${sourceLabel}:${rows.length} 行。`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`读取 ${sourceLabel} 失败(跳过):${message}`);
        }
    };

    for (const filePath of ctx.downloads) {
        const baseName = path.basename(filePath);
        const ext = lowerExt(baseName);
        if (ext === '.zip') {
            // zip:解压,合并其中所有可识别表格条目
            let zip: AdmZip;
            try {
                zip = new AdmZip(filePath);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logError(`打开 zip 失败(跳过):${baseName} —— ${message}`);
                continue;
            }
            const tableEntries = zip
                .getEntries()
                .filter((e) => !e.isDirectory && SUPPORTED_EXT.includes(lowerExt(e.entryName)));
            if (tableEntries.length === 0) {
                logError(`zip ${baseName} 内未找到可识别表格(csv/xls/xlsx),已跳过。`);
                continue;
            }
            for (const entry of tableEntries) {
                ingest(entry.entryName, entry.getData(), `${baseName} → ${entry.entryName}`);
            }
        } else if (SUPPORTED_EXT.includes(ext)) {
            // 裸表格文件(站点直接下载 csv/xls/xlsx,非 zip)
            ingest(baseName, fs.readFileSync(filePath), baseName);
        } else {
            logError(`下载文件 ${baseName} 不是 zip 或表格(csv/xls/xlsx),已跳过。`);
        }
    }

    if (mergedTableCount === 0) {
        return { type: spec.type, message: '本次下载中没有可合并的表格(csv/xls/xlsx)。' };
    }

    const output = path.join(ctx.exportsDir, `merged-${ctx.stamp}.xlsx`);
    await exportToExcel(allRows, output);
    const fileName = path.basename(output);
    return {
        type: spec.type,
        output,
        message: `已合并 ${mergedTableCount} 个表格 / 共 ${allRows.length} 行 → ${fileName}`,
    };
};

registerPostProcessor(
    {
        type: 'merge-zip-excel',
        label: '批量下载表格合并',
        description: '解压 zip 取内部表格(csv/xls/xlsx),或直接下载的表格,堆叠为一张总表(产出 exports/merged-*.xlsx)',
    },
    handler
);

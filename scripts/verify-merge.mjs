// 离线自检脚本:验证 merge-zip-excel 后处理器的多格式合并。
// 不需网络:本地造多种来源喂给 runPostProcessors,断言合并产物正确——
//   ① zip 内 xlsx(exceljs 造)② zip 内 UTF-8 带 BOM 的 csv ③ 裸 csv(不打 zip)
//   ④ zip 内 GBK 编码 csv(iconv-lite 编码,验证编码兜底,中文不乱码)。
// 断言:产出 merged-*.xlsx 行数 = 各来源数据行之和、列为各文件列并集、GBK 中文正确。
// 用法:npm run build && node scripts/verify-merge.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');

const tmpDir = path.join(os.tmpdir(), `macro-merge-verify-${process.pid}`);
const downloadDir = path.join(tmpDir, 'downloads');
const exportsDir = path.join(tmpDir, 'exports');
mkdirSync(downloadDir, { recursive: true });
mkdirSync(exportsDir, { recursive: true });

/** 造一个 xlsx Buffer:首行表头,其余为数据行 */
async function buildXlsx(header, rows) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('数据');
    sheet.addRow(header);
    for (const r of rows) {
        sheet.addRow(r);
    }
    return wb.xlsx.writeBuffer();
}

/** 表头 + 数据行 → CSV 文本 */
function toCsvText(header, rows) {
    return [header, ...rows].map((cols) => cols.join(',')).join('\r\n');
}

/** 把任意 Buffer 作为某文件名打进 zip,落盘 downloadDir,返回 zip 路径 */
function zipFile(zipName, innerName, buf) {
    const zip = new AdmZip();
    zip.addFile(innerName, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    const zipPath = path.join(downloadDir, zipName);
    zip.writeZip(zipPath);
    return zipPath;
}

// ① zip 内 xlsx:名称/价格
const xlsxBuf = await buildXlsx(['名称', '价格'], [['苹果', '3'], ['香蕉', '2']]);
// ② zip 内 UTF-8 带 BOM 的 csv:名称/价格(1 行)
const csvUtf8Bom = Buffer.concat([
    Buffer.from('﻿', 'utf8'),
    Buffer.from(toCsvText(['名称', '价格'], [['橙子', '5']]), 'utf8'),
]);
// ③ 裸 csv(不打 zip):名称/产地(2 行)
const bareCsv = Buffer.from(toCsvText(['名称', '产地'], [['葡萄', '新疆'], ['西瓜', '海南']]), 'utf8');
const bareCsvPath = path.join(downloadDir, 'bare.csv');
writeFileSync(bareCsvPath, bareCsv);
// ④ zip 内 GBK 编码 csv:名称/状态(1 行,中文值「已通知」验证兜底)
const gbkCsv = iconv.encode(toCsvText(['名称', '状态'], [['梨', '已通知']]), 'gbk');

const downloads = [
    zipFile('a.zip', 'sheet-a.xlsx', xlsxBuf),
    zipFile('b.zip', 'sheet-b.csv', csvUtf8Bom),
    bareCsvPath,
    zipFile('d.zip', 'sheet-d.csv', gbkCsv),
];
const expectedRows = 2 + 1 + 2 + 1; // 各来源数据行之和 = 6

const results = await runPostProcessors([{ type: 'merge-zip-excel' }], {
    downloads,
    downloadDir,
    exportsDir,
    stamp: 'verify',
});

console.log('\n========== 多格式合并自检结果 ==========');
const r = results[0];
console.log('后处理 message =', r.message);
console.log('产出文件 =', r.output);

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) {
        failed = true;
    }
}

check(!!r.output && existsSync(r.output), '产出文件存在');

if (r.output && existsSync(r.output)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.output);
    const sheet = wb.worksheets[0];
    const header = sheet.getRow(1).values.slice(1).map((v) => String(v ?? ''));
    const dataRowCount = sheet.rowCount - 1; // 减表头
    check(dataRowCount === expectedRows, `合并行数 = ${expectedRows}(实际 ${dataRowCount})`);
    const expectedCols = ['名称', '价格', '产地', '状态']; // union,保持首次出现顺序
    check(
        JSON.stringify(header) === JSON.stringify(expectedCols),
        `列为并集 ${JSON.stringify(expectedCols)}(实际 ${JSON.stringify(header)})`,
    );
    // 收集所有单元格文本,断言 GBK 中文「已通知」正确进表(未乱码)
    const allText = [];
    sheet.eachRow((row) => row.eachCell((cell) => allText.push(String(cell.value ?? ''))));
    check(allText.includes('已通知'), 'GBK csv 中文「已通知」正确解码并入表');
    check(allText.includes('橙子'), 'UTF-8/BOM csv 中文「橙子」正确并入表');
    check(allText.includes('葡萄'), '裸 csv 中文「葡萄」正确并入表');
    check(allText.includes('苹果'), 'zip 内 xlsx 中文「苹果」正确并入表');
}

// 清理临时目录
try {
    rmSync(tmpDir, { recursive: true, force: true });
} catch {
    // 忽略清理失败
}

if (failed) {
    console.log('\n自检未通过。');
    process.exit(1);
}
console.log('\n自检通过。');

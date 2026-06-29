// 离线自检脚本:验证 merge-zip-excel 后处理器「解压 zip → 读内部 xlsx → 堆叠合并」整链。
// 不需网络:本地用 exceljs 造 3 个 xlsx、adm-zip 各打成 zip,再喂给 runPostProcessors,
// 断言产出 merged-*.xlsx 行数 = 各文件数据行之和、列为各文件列并集。
// 用法:npm run build && node scripts/verify-merge.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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

/** 把 xlsx Buffer 打进一个 zip,落盘到 downloadDir,返回 zip 绝对路径 */
function zipXlsx(zipName, innerName, xlsxBuffer) {
    const zip = new AdmZip();
    zip.addFile(innerName, xlsxBuffer);
    const zipPath = path.join(downloadDir, zipName);
    zip.writeZip(zipPath);
    return zipPath;
}

// 三个文件:前两个表头一致,第三个多一列(验证 union 列、缺列填空)
const buf1 = await buildXlsx(['名称', '价格'], [['苹果', '3'], ['香蕉', '2']]);
const buf2 = await buildXlsx(['名称', '价格'], [['橙子', '5']]);
const buf3 = await buildXlsx(['名称', '产地'], [['葡萄', '新疆'], ['西瓜', '海南'], ['梨', '河北']]);

const downloads = [
    zipXlsx('a.zip', 'sheet-a.xlsx', buf1),
    zipXlsx('b.zip', 'sheet-b.xlsx', buf2),
    zipXlsx('c.zip', 'sheet-c.xlsx', buf3),
];
const expectedRows = 2 + 1 + 3; // 各文件数据行之和

const results = await runPostProcessors([{ type: 'merge-zip-excel' }], {
    downloads,
    downloadDir,
    exportsDir,
    stamp: 'verify',
});

console.log('\n========== 合并自检结果 ==========');
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

// 回读产出,核对行数与列并集
if (r.output && existsSync(r.output)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.output);
    const sheet = wb.worksheets[0];
    const header = sheet.getRow(1).values.slice(1).map((v) => String(v ?? ''));
    const dataRowCount = sheet.rowCount - 1; // 减表头
    check(dataRowCount === expectedRows, `合并行数 = ${expectedRows}(实际 ${dataRowCount})`);
    const expectedCols = ['名称', '价格', '产地']; // union,保持首次出现顺序
    check(
        JSON.stringify(header) === JSON.stringify(expectedCols),
        `列为并集 ${JSON.stringify(expectedCols)}(实际 ${JSON.stringify(header)})`,
    );
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

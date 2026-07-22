// 离线自检:验证 merge-config.json「配置驱动」的结构化裸表格合并(不需网络)。
// 造一份复刻 Binance Pay Payout 模板布局的 .xls(行1标题、行2真表头 A-D、行3数据、右侧 F 列说明面板),
// 覆盖四个场景:
//   ① 默认(rules:[]、headerRow=1)→ 表头变 __EMPTY 的乱表(证明不配就是历史行为)
//   ② matchSheet 规则(headerRow=2、endColumn=D)→ 干净 4 列 1 行(按工作表名命中,文件名可任意)
//   ③ match 文件名 glob 规则 → 同样干净(证明文件名匹配也通)
//   ④ 全新空 dataRoot 首次运行 → 自动生成 merge-config.json(含 Binance 示例规则)且直接合出干净表
// 用法:npm run build && node scripts/verify-merge-config.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');

const tmpRoot = path.join(os.tmpdir(), `macro-mergecfg-verify-${process.pid}`);
mkdirSync(tmpRoot, { recursive: true });

const REAL_HEADERS = [
    'Account Type (Required)',
    "Recipient's Account information (Required)",
    'Crypto Currency (Required)',
    'Amount (Required)',
];

/** 造一份复刻 Binance payout 模板的 .xls Buffer(工作表名 = Binance Pay Payout Template) */
function buildBinanceXls() {
    // 行1=标题(F 列有 Instructions 说明)、行2=真表头(F 列有 Notes,靠 endColumn=D 裁掉)、行3=数据。
    // 不放人为空行:显式 '' 单元格会被 SheetJS 视为非空行(真实模板的尾部空行是「无单元格」故被自动剔除)。
    const aoa = [
        [
            "Binance Pay Send Multiple Template (Don't delete the first two rows)",
            '',
            '',
            '',
            '',
            'Instructions:',
        ],
        [...REAL_HEADERS, '', 'Notes'],
        ['Binance ID (BUID)', '1073528040', 'USDT', '0.5', '', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Binance Pay Payout Template');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

const xlsBuf = buildBinanceXls();

let caseNo = 0;
let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) failed = true;
}

/**
 * 跑一个场景:在独立 dataRoot 下(可选预写 merge-config.json)合并给定文件名的 fixture,
 * 返回 { headers, dataRowCount, cfgPath, output }。
 */
async function runCase(name, fileBaseName, configObj) {
    caseNo += 1;
    const dataRoot = path.join(tmpRoot, `case${caseNo}`);
    const downloadDir = path.join(dataRoot, 'downloads');
    const exportsDir = path.join(dataRoot, 'exports');
    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(exportsDir, { recursive: true });
    const cfgPath = path.join(dataRoot, 'merge-config.json');
    if (configObj !== null) {
        writeFileSync(cfgPath, JSON.stringify(configObj, null, 4), 'utf-8');
    }
    const filePath = path.join(downloadDir, fileBaseName);
    writeFileSync(filePath, xlsBuf);

    const results = await runPostProcessors([{ type: 'merge-zip-excel' }], {
        downloads: [filePath],
        downloadDir,
        exportsDir,
        stamp: `case${caseNo}`,
        dataRoot,
    });
    const r = results[0];
    let headers = [];
    let dataRowCount = 0;
    if (r.output && existsSync(r.output)) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(r.output);
        const sheet = wb.worksheets[0];
        headers = sheet.getRow(1).values.slice(1).map((v) => String(v ?? ''));
        dataRowCount = sheet.rowCount - 1;
    }
    console.log(`\n----- 场景:${name} (${fileBaseName}) -----`);
    console.log('message =', r.message);
    console.log('表头 =', JSON.stringify(headers));
    console.log('数据行数 =', dataRowCount);
    return { headers, dataRowCount, cfgPath, output: r.output };
}

function isClean(headers, dataRowCount) {
    const noEmpty = headers.every((h) => !h.startsWith('__EMPTY'));
    const exact = JSON.stringify(headers) === JSON.stringify(REAL_HEADERS);
    return noEmpty && exact && dataRowCount === 1;
}

// ① 默认:显式写 rules:[](headerRow 缺省 1)→ 应乱
const c1 = await runCase('默认无规则(应乱)', 'download-export.xls', {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false },
    rules: [],
});
check(
    !isClean(c1.headers, c1.dataRowCount),
    '① 默认(headerRow=1):非干净表——真表头未被识别、掉进数据(证明不配=历史行为)',
);

// ② matchSheet 规则:文件名与规则无关,靠工作表名命中
const c2 = await runCase('matchSheet 命中(应净)', 'download-export.xls', {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false },
    rules: [{ matchSheet: '*Payout Template*', headerRow: 2, endColumn: 'D' }],
});
check(isClean(c2.headers, c2.dataRowCount), '② matchSheet 规则:干净 4 列 1 行');

// ③ match 文件名 glob:*payout*.xls
const c3 = await runCase('match 文件名命中(应净)', 'monthly-payout.xls', {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false },
    rules: [{ match: '*payout*.xls', headerRow: 2, endColumn: 'D' }],
});
check(isClean(c3.headers, c3.dataRowCount), '③ match 文件名规则:干净 4 列 1 行');

// ④ 首次运行:不预写配置(configObj=null),loadMergeConfig 应生成模板并靠内置 Binance 规则命中
const c4 = await runCase('首次生成模板(应净)', 'anything.xls', null);
check(existsSync(c4.cfgPath), '④ 首次运行自动生成 merge-config.json');
let tplOk = false;
try {
    const tpl = JSON.parse(readFileSync(c4.cfgPath, 'utf-8'));
    tplOk = Array.isArray(tpl.rules) && tpl.rules.some((x) => x.matchSheet || x.match);
} catch {
    tplOk = false;
}
check(tplOk, '④ 生成的模板可解析且含示例规则');
check(isClean(c4.headers, c4.dataRowCount), '④ 首次模板经内置 Binance 规则直接合出干净表');

// 清理
try {
    rmSync(tmpRoot, { recursive: true, force: true });
} catch {
    // 忽略清理失败
}

if (failed) {
    console.log('\n自检未通过。');
    process.exit(1);
}
console.log('\n自检通过。');

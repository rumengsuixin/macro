// 离线自检:验证 merge-config.json「配置驱动」的结构化裸表格合并(不需网络)。
// 造一份复刻 Binance Pay Payout 模板布局的 .xls(行1标题、行2真表头 A-D、行3数据、右侧 F 列说明面板),
// 覆盖四个场景:
//   ① 默认(rules:[]、headerRow=1)→ 表头变 __EMPTY 的乱表(证明不配就是历史行为)
//   ② matchSheet 规则(headerRow=2、endColumn=D)→ 干净 4 列 1 行(按工作表名命中,文件名可任意)
//   ③ match 文件名 glob 规则 → 同样干净(证明文件名匹配也通)
//   ④ 全新空 dataRoot 首次运行 → 自动生成 merge-config.json(含 Binance 示例规则)且直接合出干净表
//   ⑤ 派生列 addColumns:两个带日期文件名的普通表 → 从文件名提日期作「日期」首列、逐文件不同值
//   ⑥ 对照:无 addColumns → 无「日期」列(证明由配置驱动)
//   ⑦ 结构+派生列复合:Binance 结构文件 + 文件名带日期,专属规则须排在通用 payout 规则前 → 净表且带日期首列
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

/** 造一份普通表 .xls Buffer(首行表头、其余数据行) */
function buildPlainXls(header, dataRows, sheetName) {
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

/**
 * 跑一个多文件合并场景,返回 { headers, rows(对象数组), output }。
 * files: [{ name, buf }]。用于验证派生列(逐文件不同取值)。
 */
async function runMultiCase(name, files, configObj) {
    caseNo += 1;
    const dataRoot = path.join(tmpRoot, `case${caseNo}`);
    const downloadDir = path.join(dataRoot, 'downloads');
    const exportsDir = path.join(dataRoot, 'exports');
    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(exportsDir, { recursive: true });
    if (configObj !== null) {
        writeFileSync(path.join(dataRoot, 'merge-config.json'), JSON.stringify(configObj, null, 4), 'utf-8');
    }
    const downloads = files.map((f) => {
        const p = path.join(downloadDir, f.name);
        writeFileSync(p, f.buf);
        return p;
    });
    const results = await runPostProcessors([{ type: 'merge-zip-excel' }], {
        downloads,
        downloadDir,
        exportsDir,
        stamp: `case${caseNo}`,
        dataRoot,
    });
    const r = results[0];
    let headers = [];
    const rows = [];
    if (r.output && existsSync(r.output)) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(r.output);
        const sheet = wb.worksheets[0];
        headers = sheet.getRow(1).values.slice(1).map((v) => String(v ?? ''));
        for (let i = 2; i <= sheet.rowCount; i++) {
            const vals = sheet.getRow(i).values;
            const obj = {};
            headers.forEach((h, idx) => (obj[h] = String(vals[idx + 1] ?? '')));
            rows.push(obj);
        }
    }
    console.log(`\n----- 场景:${name} -----`);
    console.log('message =', r.message);
    console.log('表头 =', JSON.stringify(headers));
    return { headers, rows, output: r.output };
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

// ⑤ 派生列:数据本身无日期,从文件名提 yyyy-mm-dd 作「日期」列(逐文件不同值、放最前)
const prize1 = buildPlainXls(['名称', '积分'], [['甲', '10'], ['乙', '20']], 'Sheet1');
const prize2 = buildPlainXls(['名称', '积分'], [['丙', '30']], 'Sheet1');
const prizeFiles = [
    { name: 'USDT奖品发放信息2026-07-01.xls', buf: prize1 },
    { name: 'USDT奖品发放信息2026-07-02.xls', buf: prize2 },
];
const dateRule = {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false, addColumns: [] },
    rules: [
        {
            match: '*奖品发放*',
            addColumns: [
                { name: '日期', from: 'fileName', pattern: '(\\d{4}-\\d{2}-\\d{2})', position: 'start' },
            ],
        },
    ],
};
const c5 = await runMultiCase('派生列日期(应有首列日期)', prizeFiles, dateRule);
check(c5.headers[0] === '日期', '⑤ 「日期」列出现在第一列');
check(c5.rows.length === 3, `⑤ 合并 3 行(实际 ${c5.rows.length})`);
check(
    c5.rows.filter((r) => ['甲', '乙'].includes(r['名称'])).every((r) => r['日期'] === '2026-07-01'),
    '⑤ 07-01 文件的行日期 = 2026-07-01',
);
check(
    c5.rows.filter((r) => r['名称'] === '丙').every((r) => r['日期'] === '2026-07-02'),
    '⑤ 07-02 文件的行日期 = 2026-07-02',
);

// ⑥ 对照:同两文件但无 addColumns → 不应有「日期」列(证明由配置驱动)
const c6 = await runMultiCase('派生列对照(应无日期列)', prizeFiles, {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false, addColumns: [] },
    rules: [],
});
check(!c6.headers.includes('日期'), '⑥ 无 addColumns 时无「日期」列');

// ⑦ 结构+派生列复合:Binance 结构文件(工作表名带 Payout Template),文件名带日期。
//    专属规则(headerRow=2+endColumn=D+日期)须排在通用 payout 规则之前,否则被后者抢先命中丢日期。
const structured = buildBinanceXls(); // 工作表名 Binance Pay Payout Template、行1标题、行2表头、行3数据
const c7 = await runMultiCase('结构+派生列复合(应净且带日期)', [{ name: '奖品发放2026-07-01.xls', buf: structured }], {
    defaults: { sheet: 0, headerRow: 1, endColumn: '', addSourceColumn: false, addColumns: [] },
    rules: [
        {
            match: '*奖品发放*',
            sheet: 0,
            headerRow: 2,
            endColumn: 'D',
            addColumns: [{ name: '日期', from: 'fileName', pattern: '(\\d{4}-\\d{2}-\\d{2})', position: 'start' }],
        },
        { matchSheet: '*Payout Template*', sheet: 0, headerRow: 2, endColumn: 'D' },
    ],
});
check(
    JSON.stringify(c7.headers) === JSON.stringify(['日期', ...REAL_HEADERS]),
    `⑦ 复合规则:表头 = 日期 + 4 真列(实际 ${JSON.stringify(c7.headers)})`,
);
check(
    c7.rows.length === 1 && c7.rows[0]['日期'] === '2026-07-01',
    '⑦ 复合规则:数据带正确日期 2026-07-01',
);

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

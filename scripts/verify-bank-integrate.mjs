// 端到端自检:bank-integrate-domestic 后处理器真跑 Python 整合。
// 需本机 xlsxIntgration 环境(venv + 样本),类同 test-ai.mjs 需 Gateway——前置缺失则跳过(非失败)。
// 流程:临时 dataRoot 写 bank-integrate.json(指向真实 venv/projectRoot)→ 从 xlsxIntgration
//   data/input/1 拷现成合规样本到临时 downloads → runPostProcessors 触发桥接 spawn Python
//   → 断言 exports/ 产出 国内银行汇总-verify.xlsx 且 exceljs 可读、至少 1 个工作表。
// 用法:npm run build && node scripts/verify-bank-integrate.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');

const XLSX_ROOT = 'D:\\git_object\\xlsxIntgration';
const PY = path.join(XLSX_ROOT, 'venv', 'Scripts', 'python.exe');
const SAMPLE_DIR = path.join(XLSX_ROOT, 'data', 'input', '1');
const SUPPORTED = ['.csv', '.xls', '.xlsx'];

function skip(msg) {
    console.log('跳过自检(前置未满足):' + msg);
    process.exit(0);
}

if (!existsSync(PY)) {
    skip('未找到 Python 可执行 ' + PY);
}
if (!existsSync(SAMPLE_DIR)) {
    skip('未找到样本目录 ' + SAMPLE_DIR);
}

const samples = readdirSync(SAMPLE_DIR)
    .filter((n) => SUPPORTED.includes(path.extname(n).toLowerCase()))
    .filter((n) => !n.startsWith('~$') && n !== '国内银行汇总.xlsx');
if (samples.length === 0) {
    skip('样本目录内无 csv/xls/xlsx');
}

const tmp = path.join(os.tmpdir(), `macro-bank-verify-${process.pid}`);
const dataRoot = path.join(tmp, 'dataRoot');
const downloadDir = path.join(tmp, 'downloads');
const exportsDir = path.join(tmp, 'exports');
mkdirSync(dataRoot, { recursive: true });
mkdirSync(downloadDir, { recursive: true });
mkdirSync(exportsDir, { recursive: true });

// 临时配置指向真实 venv/projectRoot(不落到项目根的 bank-integrate.json,自检隔离)
writeFileSync(
    path.join(dataRoot, 'bank-integrate.json'),
    JSON.stringify(
        {
            pythonExe: PY,
            projectRoot: XLSX_ROOT,
            timeoutMs: 300000,
            modes: {
                'bank-integrate-domestic': { entryScript: '整合1.py', summaryFile: '国内银行汇总.xlsx' },
            },
        },
        null,
        4,
    ),
    'utf-8',
);

const downloads = samples.map((n) => {
    const dst = path.join(downloadDir, n);
    copyFileSync(path.join(SAMPLE_DIR, n), dst);
    return dst;
});
console.log(`准备 ${downloads.length} 个银行样本:`, samples.join(', '));
console.log('调用 bank-integrate-domestic(真跑 Python,可能耗时若干秒)……\n');

const results = await runPostProcessors([{ type: 'bank-integrate-domestic' }], {
    downloads,
    downloadDir,
    exportsDir,
    stamp: 'verify',
    dataRoot,
});

const r = results[0];
console.log('\n========== 银行整合自检结果 ==========');
console.log('后处理 message =', r.message);
console.log('产出文件 =', r.output);

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '[OK]' : '[FAIL]'} ${label}`);
    if (!cond) {
        failed = true;
    }
}

check(!!r.output && existsSync(r.output), '产出汇总 xlsx 存在');
if (r.output && existsSync(r.output)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r.output);
    check(wb.worksheets.length >= 1, `产物至少含 1 个工作表(实际 ${wb.worksheets.length})`);
    console.log('工作表:', wb.worksheets.map((w) => w.name).join(' | '));
}
check(/已整合/.test(r.message || ''), 'message 表示整合成功');

try {
    rmSync(tmp, { recursive: true, force: true });
} catch {
    // 忽略清理失败
}

if (failed) {
    console.log('\n自检未通过。');
    process.exit(1);
}
console.log('\n自检通过。');

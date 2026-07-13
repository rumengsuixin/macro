// 端到端自检:bank-integrate-* 各代号真跑打包 exe。
// 覆盖 A 类"文件进→xlsx 出"对账/整合线:代号1/2/3/5/6。
// 需本机 xlsxIntgration 打包产物(dist/银行流水整合/*.exe)+ data/input/N 现成样本;
// 某代号 exe/样本缺失则跳过(非失败)。
// 流程:临时 dataRoot 写 bank-integrate.json(各 type 指向对应 exe)→ 各代号从 data/input/N
//   拷现成样本 → runPostProcessors([{type}], …)→ 断言 exports/ 产出 xlsx 可读。
// 用法:npm run build && node scripts/verify-bank-integrate.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');

const XLSX_ROOT = 'D:\\git_object\\xlsxIntgration';
const DIST = path.join(XLSX_ROOT, 'dist', '银行流水整合');
const SUPPORTED = ['.csv', '.xls', '.xlsx', '.pdf'];

// 各代号:type / Windows exe 名 / data/input 子目录
const CASES = [
    { type: 'bank-integrate-domestic', exe: '国内银行整合.exe', dir: '1' },
    { type: 'bank-integrate-overseas', exe: '海外银行整合.exe', dir: '2' },
    { type: 'bank-integrate-order-match', exe: '游戏订单匹配.exe', dir: '3' },
    { type: 'bank-integrate-payout', exe: '代付订单对账.exe', dir: '5' },
    { type: 'bank-integrate-collection-payout', exe: '代收代付对账.exe', dir: '6' },
];

const tmp = path.join(os.tmpdir(), `macro-bank-verify-${process.pid}`);
const dataRoot = path.join(tmp, 'dataRoot');
mkdirSync(dataRoot, { recursive: true });

// 临时 bank-integrate.json:5 个 type 各指向对应 exe
const modes = {};
for (const c of CASES) {
    modes[c.type] = { executable: path.join(DIST, c.exe) };
}
writeFileSync(
    path.join(dataRoot, 'bank-integrate.json'),
    JSON.stringify({ timeoutMs: 300000, modes }, null, 4),
    'utf-8',
);

let failed = false;
let ran = 0;
function check(cond, label) {
    console.log(`${cond ? '[OK]' : '[FAIL]'} ${label}`);
    if (!cond) {
        failed = true;
    }
}

for (const c of CASES) {
    console.log(`\n===== ${c.type}(代号目录 ${c.dir}) =====`);
    const exe = path.join(DIST, c.exe);
    const sampleDir = path.join(XLSX_ROOT, 'data', 'input', c.dir);
    if (!existsSync(exe)) {
        console.log(`跳过:未找到 exe ${exe}`);
        continue;
    }
    if (!existsSync(sampleDir)) {
        console.log(`跳过:未找到样本目录 ${sampleDir}`);
        continue;
    }
    const samples = readdirSync(sampleDir).filter(
        (n) => SUPPORTED.includes(path.extname(n).toLowerCase()) && !n.startsWith('~$'),
    );
    if (samples.length === 0) {
        console.log('跳过:样本目录无支持文件');
        continue;
    }

    const downloadDir = path.join(tmp, c.dir, 'downloads');
    const exportsDir = path.join(tmp, c.dir, 'exports');
    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(exportsDir, { recursive: true });
    const downloads = samples.map((n) => {
        const d = path.join(downloadDir, n);
        copyFileSync(path.join(sampleDir, n), d);
        return d;
    });
    console.log(`样本 ${downloads.length} 个,调用 ${c.exe}(真跑,可能耗时若干秒)……`);

    const results = await runPostProcessors([{ type: c.type }], {
        downloads,
        downloadDir,
        exportsDir,
        stamp: 'verify',
        dataRoot,
    });
    ran += 1;
    const r = results[0];
    console.log('message =', r.message);
    console.log('产物 =', r.output);
    check(!!r.output && existsSync(r.output), `${c.type} 产出 xlsx 存在`);
    if (r.output && existsSync(r.output)) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(r.output);
        check(wb.worksheets.length >= 1, `${c.type} 产物至少 1 工作表(实际 ${wb.worksheets.length})`);
    }
}

try {
    rmSync(tmp, { recursive: true, force: true });
} catch {
    // 忽略清理失败
}

console.log(`\n实跑代号数:${ran}/${CASES.length}`);
if (failed) {
    console.log('自检未通过。');
    process.exit(1);
}
console.log('自检通过。');

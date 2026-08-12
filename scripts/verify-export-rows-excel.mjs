// 离线自检脚本:验证 export-rows-excel 后处理器(宏级导出文件名)+ 共用文件名模板渲染器。
// 不需网络、不起浏览器:直接构造 PostProcessContext 喂 runPostProcessors,断言产物名与内容;
// 另单测 renderFileNameTemplate / sanitizeFilename / resolveOutputFileName 的纯逻辑。
// 覆盖:占位符渲染 · {date}/{time} 从 stamp 派生 · 未提供变量渲染空串 · 消毒防目录穿越 ·
//       空模板/纯非法字符回退 · 扩展名自动补(且不重复补) · 无数据行安全跳过 ·
//       ColumnSpec 驱动列名列序隐藏列 · merge 产物名优先级链(宏级 > 配置 > 内置)。
// 用法:npm run build && node scripts/verify-export-rows-excel.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
const { runPostProcessors } = require('../dist/core/post-processors/index.js');
const { renderFileNameTemplate, sanitizeFilename } = require('../dist/core/template-util.js');
const { resolveOutputFileName, DEFAULT_CONFIG } = require('../dist/core/post-processors/merge-config.js');

const tmpDir = path.join(os.tmpdir(), `macro-export-rows-verify-${process.pid}`);
const exportsDir = path.join(tmpDir, 'exports');
const downloadDir = path.join(tmpDir, 'downloads');
mkdirSync(exportsDir, { recursive: true });
mkdirSync(downloadDir, { recursive: true });

const STAMP = '20260812-143005';

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) {
        failed = true;
    }
}

/** 跑一次 export-rows-excel,返回单条结果 */
async function runExport(options, ctxExtra = {}) {
    const results = await runPostProcessors([{ type: 'export-rows-excel', options }], {
        downloads: [],
        downloadDir,
        exportsDir,
        stamp: STAMP,
        macroName: '1epin订单',
        rows: [
            { 订单号: 'A001', 金额: '12.50' },
            { 订单号: 'A002', 金额: '8.00' },
        ],
        ...ctxExtra,
    });
    return results[0];
}

console.log('\n========== ① 文件名模板渲染(纯逻辑) ==========');

check(
    renderFileNameTemplate('{macro}-{date}.xlsx', { stamp: STAMP, macro: '1epin订单' }, 'fb.xlsx') ===
        '1epin订单-2026-08-12.xlsx',
    '{macro} + {date} 渲染正确(date 从 stamp 前 8 位派生)'
);
check(
    renderFileNameTemplate('t-{time}.xlsx', { stamp: STAMP }, 'fb.xlsx') === 't-143005.xlsx',
    '{time} 从 stamp 末 6 位派生'
);
check(
    renderFileNameTemplate('s-{stamp}.xlsx', { stamp: STAMP }, 'fb.xlsx') === `s-${STAMP}.xlsx`,
    '{stamp} 原样渲染'
);
check(
    renderFileNameTemplate('{plugin}-{rows}.xlsx', { stamp: STAMP, plugin: 'p', rows: 7 }, 'fb.xlsx') ===
        'p-7.xlsx',
    '{plugin} + {rows} 渲染正确'
);
check(
    renderFileNameTemplate('x-{macro}{plugin}{rows}.xlsx', { stamp: STAMP }, 'fb.xlsx') === 'x-.xlsx',
    '未提供取值的变量渲染为空串(不留占位符字面量)'
);
check(
    renderFileNameTemplate('a-{unknown}.xlsx', { stamp: STAMP }, 'fb.xlsx') === 'a-{unknown}.xlsx',
    '未知占位符原样保留(是合法文件名字符)'
);
// stamp 不合 YYYYMMDD-HHMMSS 时的降级:{date} 整段回退 stamp、{time} 空串
check(
    renderFileNameTemplate('{date}-{time}.xlsx', { stamp: 'verify' }, 'fb.xlsx') === 'verify-.xlsx',
    'stamp 不合格式时 {date} 回退整段、{time} 为空'
);

console.log('\n========== ② 消毒 / 回退 / 扩展名 ==========');

check(sanitizeFilename('a\\b') === 'a_b', 'sanitizeFilename 消掉反斜杠(修正前漏网)');
check(sanitizeFilename('a/b:c*d?e"f<g>h|i') === 'a_b_c_d_e_f_g_h_i', 'sanitizeFilename 覆盖全部非法字符');

const evil = renderFileNameTemplate('../../evil.xlsx', { stamp: STAMP }, 'fb.xlsx');
check(!evil.includes('/') && !evil.includes('\\'), `目录穿越模板被消毒成单层名(${evil})`);
check(
    path.dirname(path.join(exportsDir, evil)) === exportsDir,
    'path.join 后仍在 exportsDir 内(无法逃逸)'
);
const winEvil = renderFileNameTemplate('a\\b/c.xlsx', { stamp: STAMP }, 'fb.xlsx');
check(winEvil === 'a_b_c.xlsx', `混合分隔符被消毒(${winEvil})`);

check(renderFileNameTemplate('', { stamp: STAMP }, 'fb.xlsx') === 'fb.xlsx', '空模板 → 回退 fallback');
check(
    renderFileNameTemplate('   ', { stamp: STAMP }, 'fb.xlsx') === 'fb.xlsx',
    '纯空白模板 → 回退 fallback'
);
check(
    renderFileNameTemplate(undefined, { stamp: STAMP }, 'fb.xlsx') === 'fb.xlsx',
    '未配模板 → 回退 fallback'
);
check(
    renderFileNameTemplate('***', { stamp: STAMP }, 'fb.xlsx') === '___.xlsx',
    '纯非法字符 → 消毒为下划线(非空,不回退)'
);
check(
    renderFileNameTemplate('数据', { stamp: STAMP }, 'fb.xlsx') === '数据.xlsx',
    '无扩展名 → 自动补 .xlsx'
);
check(
    renderFileNameTemplate('数据.XLSX', { stamp: STAMP }, 'fb.xlsx') === '数据.XLSX',
    '已有 .XLSX(大写)→ 不重复补'
);

console.log('\n========== ③ export-rows-excel 端到端 ==========');

const r1 = await runExport({ fileName: '{macro}-{date}.xlsx' });
console.log('message =', r1.message);
check(r1.output === path.join(exportsDir, '1epin订单-2026-08-12.xlsx'), '产物落在 exports/ 且用宏级文件名');
check(existsSync(r1.output), '产物文件确实存在');
check(/2 行/.test(r1.message), 'message 报告导出行数');

// 未配文件名 → 与手点导出按钮同口径的缺省名
const r2 = await runExport(undefined);
check(
    path.basename(r2.output ?? '') === `result-${STAMP}.xlsx`,
    `未配文件名 → 缺省 result-${STAMP}.xlsx(实际 ${path.basename(r2.output ?? '')})`
);

// 无数据行:安全跳过,不抛、不产生文件
const before = readdirSync(exportsDir).length;
const r3 = await runExport({ fileName: '不该生成.xlsx' }, { rows: [] });
check(!r3.output, '无数据行 → 不产出文件');
check(/跳过/.test(r3.message), `无数据行 → message 说明已跳过(${r3.message})`);
check(readdirSync(exportsDir).length === before, '无数据行 → exports/ 文件数未变');

// ColumnSpec 驱动:列名(label)、列序(order)、隐藏列(hidden)
const r4 = await runExport(
    { fileName: '列规格.xlsx' },
    {
        columns: [
            { key: '金额', label: '成交金额', order: 0, hidden: false, kind: 'number', numFmt: '0.00' },
            { key: '订单号', label: '单号', order: 1, hidden: false },
            { key: '内部备注', label: '内部备注', order: 2, hidden: true },
        ],
    }
);
if (r4.output && existsSync(r4.output)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(r4.output);
    const sheet = wb.worksheets[0];
    const header = sheet
        .getRow(1)
        .values.slice(1)
        .map((v) => String(v ?? ''));
    check(
        JSON.stringify(header) === JSON.stringify(['成交金额', '单号']),
        `列名用 label、按 order 排序、hidden 列不出表(实际 ${JSON.stringify(header)})`
    );
    check(typeof sheet.getRow(2).getCell(1).value === 'number', 'kind=number 写入 Excel 真数字类型');
} else {
    check(false, '列规格用例产出文件存在');
}

console.log('\n========== ④ merge 产物名优先级链 ==========');

check(
    resolveOutputFileName(DEFAULT_CONFIG, STAMP) === `merged-${STAMP}.xlsx`,
    '无配置无覆盖 → 内置 merged-{stamp}.xlsx(历史行为不变)'
);
const cfg = { ...DEFAULT_CONFIG, output: { fileName: '全局-{date}.xlsx' } };
check(resolveOutputFileName(cfg, STAMP) === '全局-2026-08-12.xlsx', '仅 merge-config → 用配置模板');
check(
    resolveOutputFileName(cfg, STAMP, { override: '本宏-{macro}.xlsx', macro: '宏A' }) === '本宏-宏A.xlsx',
    '宏级 override 优先于 merge-config'
);
check(
    resolveOutputFileName(cfg, STAMP, { override: '   ' }) === '全局-2026-08-12.xlsx',
    '宏级 override 为空白 → 回落 merge-config(留空即沿用全局)'
);

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

// 离线自检:配置中心 bank-integrate 表单的读写往返(saveJsonConfig ↔ loadBankIntegrateConfig)。
// 不需网络/Electron:直接调 dist 的 saveJsonConfig + loadBankIntegrateConfig,模拟「表单保存 → 重开预填」。
// 覆盖:① 有值的 executable/description/examples 往返一致 ② 空描述/空示例被归一丢弃(回退内置)
//       ③ 空 executable 读回时回退当前平台默认 ④ 5 个代号始终齐全(模板兜底)⑤ 写盘为 4 空格缩进。
// 用法:npm run build && node scripts/verify-config-center.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { saveJsonConfig } = require('../dist/core/json-config.js');
const { loadBankIntegrateConfig } = require('../dist/core/post-processors/bank-integrate-config.js');

const tmp = path.join(os.tmpdir(), `macro-config-center-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const cfgFile = path.join(tmp, 'bank-integrate.json');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed++;
    }
}

// 模拟「表单保存」写盘:domestic 全填;overseas 描述/示例留空(应被归一丢弃);payout 路径留空(应回退平台默认)。
const saved = {
    timeoutMs: 123456,
    modes: {
        'bank-integrate-domestic': {
            executable: 'D:\\x\\domestic.exe',
            description: 'CUSTOM 国内描述\n第二行',
            examples: ['我的公司-中信银行.xlsx', '我的公司-招商银行.xls'],
        },
        'bank-integrate-overseas': {
            executable: 'D:\\x\\overseas.exe',
            description: '   ',
            examples: [],
        },
        'bank-integrate-payout': {
            executable: '',
        },
    },
};
saveJsonConfig(cfgFile, saved);

console.log('⑤ saveJsonConfig 以 4 空格缩进写盘');
const rawText = readFileSync(cfgFile, 'utf-8');
assert(rawText.includes('\n    "timeoutMs"') || rawText.includes('\n    "modes"'), '文件为 4 空格缩进 JSON');

// 模拟「重开表单」读回预填(loadBankIntegrateConfig 顺带逐字段归一)
const back = loadBankIntegrateConfig(cfgFile);

console.log('① 有值字段往返一致(domestic)');
assert(back.timeoutMs === 123456, 'timeoutMs 往返一致(123456)');
assert(back.modes['bank-integrate-domestic'].executable === 'D:\\x\\domestic.exe', 'domestic 可执行路径往返一致');
assert(
    back.modes['bank-integrate-domestic'].description === 'CUSTOM 国内描述\n第二行',
    'domestic 描述往返一致(含换行)'
);
assert(
    JSON.stringify(back.modes['bank-integrate-domestic'].examples) ===
        JSON.stringify(['我的公司-中信银行.xlsx', '我的公司-招商银行.xls']),
    'domestic 示例往返一致'
);

console.log('② 空描述/空示例被归一丢弃(overseas),回退内置');
assert(back.modes['bank-integrate-overseas'].executable === 'D:\\x\\overseas.exe', 'overseas 可执行路径保留');
assert(back.modes['bank-integrate-overseas'].description === undefined, 'overseas 空描述被丢弃(→回退内置)');
assert(back.modes['bank-integrate-overseas'].examples === undefined, 'overseas 空示例被丢弃(→回退内置)');

console.log('③ 空 executable 读回时回退当前平台默认(payout)');
assert(
    typeof back.modes['bank-integrate-payout'].executable === 'string' &&
        back.modes['bank-integrate-payout'].executable.length > 0,
    'payout 空路径已回退平台默认(非空)'
);

console.log('④ 5 个代号始终齐全(模板兜底)');
for (const key of [
    'bank-integrate-domestic',
    'bank-integrate-overseas',
    'bank-integrate-order-match',
    'bank-integrate-payout',
    'bank-integrate-collection-payout',
]) {
    assert(!!back.modes[key], `含 ${key}`);
}

console.log('⑥ 文件不存在时首次生成 + 返回 5 代号默认');
const freshFile = path.join(tmp, 'fresh', 'bank-integrate.json');
mkdirSync(path.dirname(freshFile), { recursive: true });
const fresh = loadBankIntegrateConfig(freshFile);
assert(Object.keys(fresh.modes).length >= 5, '首次生成含至少 5 个代号');
assert(fresh.timeoutMs === 300000, '首次生成 timeoutMs 缺省 300000');

rmSync(tmp, { recursive: true, force: true });
if (failed) {
    console.error(`\n自检失败:${failed} 项`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

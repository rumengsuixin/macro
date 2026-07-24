// 离线自检:验证 bank-integrate.json 的可选 description/examples 覆盖 manifest 文案。
// 不需网络/Electron:直接调 dist 的 listPostProcessors + applyBankConfigToManifests。
// 覆盖:① 配了就覆盖 ② 空串/空数组视为未配、回退内置 ③ 未配的工具保留内置 ④ 非银行插件(merge)原样不动。
// 用法:npm run build && node scripts/verify-bank-config-override.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { listPostProcessors } = require('../dist/core/post-processors/index.js');
const { applyBankConfigToManifests } = require('../dist/core/post-processors/bank-integrate.js');

const tmp = path.join(os.tmpdir(), `macro-bank-override-${process.pid}`);
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

// 内置基准(应用覆盖前)
const base = listPostProcessors();
const builtin = Object.fromEntries(base.map((m) => [m.type, m]));
assert(!!builtin['bank-integrate-domestic'], '注册表含 bank-integrate-domestic(内置基准就位)');
assert(!!builtin['merge-zip-excel'], '注册表含 merge-zip-excel(非银行插件基准就位)');

// 写一份带覆盖的配置:domestic 全覆盖;overseas 用空串/空数组(应被忽略);payout 不配(应保留内置)
writeFileSync(
    cfgFile,
    JSON.stringify(
        {
            timeoutMs: 300000,
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
            },
        },
        null,
        4
    ),
    'utf-8'
);

const out = applyBankConfigToManifests(base, cfgFile);
const got = Object.fromEntries(out.map((m) => [m.type, m]));

console.log('① 配了 description/examples 就覆盖(domestic)');
assert(got['bank-integrate-domestic'].description === 'CUSTOM 国内描述\n第二行', 'domestic 描述被配置覆盖');
assert(
    JSON.stringify(got['bank-integrate-domestic'].examples) ===
        JSON.stringify(['我的公司-中信银行.xlsx', '我的公司-招商银行.xls']),
    'domestic 示例被配置覆盖'
);

console.log('② 空串/空数组视为未配置,回退内置(overseas)');
assert(
    got['bank-integrate-overseas'].description === builtin['bank-integrate-overseas'].description,
    'overseas 空描述被忽略、保留内置'
);
assert(
    JSON.stringify(got['bank-integrate-overseas'].examples) ===
        JSON.stringify(builtin['bank-integrate-overseas'].examples),
    'overseas 空示例被忽略、保留内置'
);

console.log('③ 未在配置里出现的工具保留内置(payout)');
assert(
    got['bank-integrate-payout'].description === builtin['bank-integrate-payout'].description,
    'payout 未配、保留内置描述'
);

console.log('④ 非银行插件原样不动(merge)');
assert(
    got['merge-zip-excel'].description === builtin['merge-zip-excel'].description,
    'merge 描述不受银行配置影响'
);
assert(out.length === base.length, 'manifest 数量不变(不增不删)');

console.log('⑤ 配置读失败/缺失时回退全部内置');
const fallback = applyBankConfigToManifests(base, path.join(tmp, 'nonexist', 'x.json'));
// 该路径父目录不存在 → loadBankIntegrateConfig 写盘失败但仍返回默认 cfg(modes 无 description/examples)→ 全回退内置
assert(
    fallback.find((m) => m.type === 'bank-integrate-domestic').description ===
        builtin['bank-integrate-domestic'].description,
    '无配置文件时 domestic 回退内置描述'
);

rmSync(tmp, { recursive: true, force: true });
if (failed) {
    console.error(`\n自检失败:${failed} 项`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

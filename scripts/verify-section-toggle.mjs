// 离线自检:验证「支路级分闸 sections」。不需网络、不启浏览器。
// 覆盖:
//   ① 显式关某支路:sections.resends=false → 归一化保留 false,helper 判 false,但 resends 数组不被删(规则保留)
//   ② 其余支路缺键 = 默认启用(true),helper 判 true
//   ③ 向后兼容:整份配置无 sections → 全 7 支路默认 true(旧配置零回归)
//   ④ 白名单归一化:非布尔值(如字符串 "no")被忽略回退默认;未知键被丢弃
//   ⑤ 显式 true 也生效
//   ⑥ 运行端分闸表达式仿真:sectionEnabled(cfg,name) ? arr : []——关 → 空数组(支路 inert),开 → 原样
// 用法:npm run build && node scripts/verify-section-toggle.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { loadRequestRules } = require('../dist/storage/request-rules-store.js');
const { sectionEnabled } = require('../dist/core/request-rewrite.js');

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'macro-sectiontoggle-'));

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) failed = true;
}

/** 把对象写成临时 request-rules.json 并加载归一化后的配置 */
function loadFrom(obj, name) {
    const p = path.join(tmpRoot, `${name}.json`);
    writeFileSync(p, JSON.stringify(obj, null, 4), 'utf-8');
    return loadRequestRules(p);
}

const SECTION_KEYS = [
    'rules',
    'resends',
    'responseRules',
    'requestHeaderRules',
    'blocks',
    'dumps',
    'bodyReplaces',
];

// ---------- ① 显式关 resends,其余缺键默认开 ----------
const cfg1 = loadFrom(
    {
        enabled: true,
        sections: { resends: false },
        resends: [{ urlPattern: '*/api/trigger*', delayMs: 100 }],
        blocks: [{ urlPattern: '*/api/track*' }],
    },
    'resends-off'
);
check(cfg1.sections.resends === false, '① sections.resends 归一化为 false');
check(sectionEnabled(cfg1, 'resends') === false, '① helper 判 resends 关闭');
check(Array.isArray(cfg1.resends) && cfg1.resends.length === 1, '① resends 规则保留、数组未被删');

// ---------- ② 其余支路缺键 = 默认启用 ----------
check(
    SECTION_KEYS.filter((k) => k !== 'resends').every((k) => cfg1.sections[k] === true),
    '② 其余 6 支路缺键默认 true'
);
check(sectionEnabled(cfg1, 'blocks') === true, '② helper 判 blocks(缺键)启用');

// ---------- ③ 向后兼容:无 sections → 全 true ----------
const cfg2 = loadFrom(
    { enabled: true, rules: [{ urlPattern: '*/api/x*', set: { a: 1 } }] },
    'no-sections'
);
check(
    SECTION_KEYS.every((k) => cfg2.sections[k] === true),
    '③ 无 sections 字段 → 全 7 支路默认 true(向后兼容)'
);
check(
    SECTION_KEYS.every((k) => sectionEnabled(cfg2, k) === true),
    '③ helper 对无 sections 配置一律判启用'
);

// ---------- ④ 白名单归一化:非布尔忽略 + 未知键丢弃 ----------
const cfg3 = loadFrom(
    { enabled: true, sections: { resends: 'no', dumps: 0, bogusKey: true, blocks: false } },
    'garbage'
);
check(cfg3.sections.resends === true, '④ 非布尔 "no" 被忽略,resends 回退默认 true');
check(cfg3.sections.dumps === true, '④ 非布尔 0 被忽略,dumps 回退默认 true');
check(cfg3.sections.bogusKey === undefined, '④ 未知键 bogusKey 被丢弃');
check(cfg3.sections.blocks === false, '④ 合法布尔 blocks:false 正常生效');

// ---------- ⑤ 显式 true ----------
const cfg4 = loadFrom({ enabled: true, sections: { rules: true } }, 'explicit-true');
check(cfg4.sections.rules === true && sectionEnabled(cfg4, 'rules') === true, '⑤ 显式 true 生效');

// ---------- ⑥ 运行端分闸表达式仿真 ----------
// 仿 macro-runner:this.xxxRules = sectionEnabled(cfg,name) ? cfg.xxx ?? [] : []
const gatedResends = sectionEnabled(cfg1, 'resends') ? cfg1.resends ?? [] : [];
const gatedBlocks = sectionEnabled(cfg1, 'blocks') ? cfg1.blocks ?? [] : [];
check(gatedResends.length === 0, '⑥ 关闭支路 → 运行端数组仿真为空(resends inert)');
check(gatedBlocks.length === 1, '⑥ 启用支路 → 运行端数组仿真原样(blocks 生效)');

rmSync(tmpRoot, { recursive: true, force: true });

console.log(failed ? '\n❌ 支路级分闸自检未通过' : '\n✅ 支路级分闸自检全部通过');
process.exit(failed ? 1 : 0);

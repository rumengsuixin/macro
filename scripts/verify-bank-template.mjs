// 离线自检:验证 bank-integrate 平台专属模板「首次生成 + {HOME} 展开 + 已存在不覆盖 + 无模板回退」。
// 不需网络/Electron:直接调 dist 里的 loadBankIntegrateConfig,喂 config-templates 里的平台模板。
// 用法:npm run build && node scripts/verify-bank-template.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadBankIntegrateConfig } = require('../dist/core/post-processors/bank-integrate-config.js');

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const winTpl = path.join(repoRoot, 'config-templates', 'bank-integrate.win.json');
const macTpl = path.join(repoRoot, 'config-templates', 'bank-integrate.mac.json');

const tmp = path.join(os.tmpdir(), `macro-bank-tpl-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed++;
    }
}

console.log('① win 模板首次生成');
const winFile = path.join(tmp, 'win', 'bank-integrate.json');
mkdirSync(path.dirname(winFile), { recursive: true });
const winCfg = loadBankIntegrateConfig(winFile, winTpl);
assert(existsSync(winFile), '首次生成写出 bank-integrate.json');
assert(Object.keys(winCfg.modes).length === 5, '5 代号齐全');
assert(
    winCfg.modes['bank-integrate-domestic'].executable.endsWith('国内银行整合.exe'),
    '国内 exe 路径来自 win 模板'
);
assert(!readFileSync(winFile, 'utf-8').includes('{HOME}'), '落地文件无 {HOME} 占位残留');

console.log('② mac 模板首次生成({HOME} 展开)');
const macFile = path.join(tmp, 'mac', 'bank-integrate.json');
mkdirSync(path.dirname(macFile), { recursive: true });
const macCfg = loadBankIntegrateConfig(macFile, macTpl);
const domes = macCfg.modes['bank-integrate-domestic'].executable;
assert(domes.startsWith(os.homedir()), '{HOME} 已展开为用户主目录');
assert(domes.endsWith('/bank-integration/domestic_bank_integration'), 'mac 二进制相对路径正确');
assert(!readFileSync(macFile, 'utf-8').includes('{HOME}'), '落地文件无 {HOME} 残留');

console.log('③ 已存在不覆盖(保留用户改动)');
const marker = 'D:\\CUSTOM\\my.exe';
const edited = JSON.parse(readFileSync(winFile, 'utf-8'));
edited.modes['bank-integrate-domestic'].executable = marker;
writeFileSync(winFile, JSON.stringify(edited, null, 4), 'utf-8');
const reloaded = loadBankIntegrateConfig(winFile, winTpl);
assert(
    reloaded.modes['bank-integrate-domestic'].executable === marker,
    '用户改动被保留、模板不覆盖'
);

console.log('④ 无模板路径回退代码内平台默认');
const noTplFile = path.join(tmp, 'notpl', 'bank-integrate.json');
mkdirSync(path.dirname(noTplFile), { recursive: true });
const noTplCfg = loadBankIntegrateConfig(noTplFile);
assert(Object.keys(noTplCfg.modes).length === 5, '回退代码内默认仍 5 代号');

rmSync(tmp, { recursive: true, force: true });
if (failed) {
    console.error(`\n自检失败:${failed} 项`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

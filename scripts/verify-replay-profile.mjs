// 离线自检:验证「回放行为档」(块二)。不需网络、不启浏览器。
// 两部分:
//   A. 存储层:loadReplayProfile 首次写模板(default=现状 / slow-site / anti-bot)、坏 JSON 回退现状、
//      normalize 归一非法字段、resolveActiveProfile 取当前档、setActiveProfile 切换与非法名拦截。
//   B. 运行接线:构造 MacroRunner(不启浏览器)后断言 timeoutMs / replay 由档驱动、env 优先级、
//      pickStepDelay / computeBackoff 计算正确(TS private 编译后即普通属性,可直接读)。
// 用法:npm run build && node scripts/verify-replay-profile.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const {
    loadReplayProfile,
    resolveActiveProfile,
    setActiveProfile,
    defaultProfile,
} = require('../dist/storage/replay-profile-store.js');
const { MacroRunner } = require('../dist/core/macro-runner.js');

const tmpRoot = path.join(os.tmpdir(), `macro-replayprofile-verify-${process.pid}`);
mkdirSync(tmpRoot, { recursive: true });
const errDir = path.join(tmpRoot, 'errors');
mkdirSync(errDir, { recursive: true });

let failed = false;
function check(cond, label) {
    console.log(`${cond ? '✅' : '❌'} ${label}`);
    if (!cond) failed = true;
}

// ========== A. 存储层 ==========
// ① 首次不存在 → 写模板并返回
const cfgPath = path.join(tmpRoot, 'replay-profile.json');
const first = loadReplayProfile(cfgPath);
check(existsSync(cfgPath), '首次加载写出 replay-profile.json 模板');
check(first.activeProfile === 'default', '模板默认档 = default');
check(
    !!first.profiles.default && !!first.profiles['slow-site'] && !!first.profiles['anti-bot'],
    '模板含 default / slow-site / anti-bot 三档'
);

// ② default 档 = 现状写死值(零回归基线)
const d = first.profiles.default;
check(d.globalTimeoutMs === 60000, 'default 全局超时 = 60000(现状)');
check(d.retry.count === 0 && d.onError === 'abort', 'default 无重试 + 出错中止(现状)');
check(d.stepDelay.min === 0 && d.stepDelay.max === 0, 'default 步骤间延时 = 0(现状)');
check(d.pagination.settleTimeoutMs === 30000 && d.scrollBottomWaitMs === 1000, 'default 翻页 30s + scroll 1000ms(现状)');

// ③ slow-site 档预设生效
const s = first.profiles['slow-site'];
check(s.globalTimeoutMs === 120000 && s.stepDelay.max === 2500 && s.retry.count === 2, 'slow-site 预设(120s/延时/重试2)');

// ④ resolveActiveProfile 取当前档
check(resolveActiveProfile(first).globalTimeoutMs === 60000, 'resolveActiveProfile 取 default');

// ⑤ setActiveProfile 切换 + 持久化;非法名拦截
check(setActiveProfile(cfgPath, 'slow-site') === true, 'setActiveProfile 切到 slow-site 成功');
check(loadReplayProfile(cfgPath).activeProfile === 'slow-site', '切换已持久化');
check(setActiveProfile(cfgPath, 'no-such') === false, '非法档名切换被拒');
check(loadReplayProfile(cfgPath).activeProfile === 'slow-site', '非法切换不改动当前档');

// ⑥ 坏 JSON → 回退现状(只含 default)
const badPath = path.join(tmpRoot, 'bad.json');
writeFileSync(badPath, '{ this is not json ', 'utf-8');
const bad = loadReplayProfile(badPath);
check(bad.activeProfile === 'default' && bad.profiles.default.globalTimeoutMs === 60000, '坏 JSON 回退现状 default');

// ⑦ normalize 归一非法字段:部分档 + 非法 onError + 非法数值 → 用默认补齐
const partialPath = path.join(tmpRoot, 'partial.json');
writeFileSync(
    partialPath,
    JSON.stringify({
        activeProfile: 'custom',
        profiles: {
            custom: { globalTimeoutMs: -5, onError: 'explode', retry: { count: 3 }, stepDelay: { min: 100, max: 'x' } },
        },
    }),
    'utf-8'
);
const partial = loadReplayProfile(partialPath);
const c = partial.profiles.custom;
check(c.globalTimeoutMs === 60000, '非法负超时 → 回退默认 60000');
check(c.onError === 'abort', '非法 onError → 回退 abort');
check(c.retry.count === 3 && c.retry.backoff === 'fixed', '合法 count 保留、缺 backoff 补 fixed');
check(c.stepDelay.min === 100 && c.stepDelay.max === 0, '合法 min 保留、非法 max 回退默认 0');
check(partial.profiles.default !== undefined, '缺 default 档自动补齐');

// ========== B. 运行接线(构造 MacroRunner,不启浏览器) ==========
const savedEnv = process.env.MACRO_TIMEOUT;
delete process.env.MACRO_TIMEOUT;

// ⑧ 无档(无头/单测) → 现状默认
const r0 = new MacroRunner(errDir);
check(r0.timeoutMs === 60000, '无档:timeoutMs 回退 60000');
check(r0.replay.onError === 'abort', '无档:replay = 现状默认');

// ⑨ 传入 slow-site 档 → 超时/延时由档驱动
const r1 = new MacroRunner(errDir, undefined, undefined, { replayProfile: s });
check(r1.timeoutMs === 120000, 'slow-site:timeoutMs 接线为 120000(接上那根线)');
check(r1.replay.stepDelay.max === 2500, 'slow-site:replay.stepDelay 生效');

// ⑩ env MACRO_TIMEOUT 优先于档(保留旧用法)
process.env.MACRO_TIMEOUT = '88000';
const r2 = new MacroRunner(errDir, undefined, undefined, { replayProfile: s });
check(r2.timeoutMs === 88000, 'env MACRO_TIMEOUT 优先于档 globalTimeoutMs');
if (savedEnv === undefined) delete process.env.MACRO_TIMEOUT;
else process.env.MACRO_TIMEOUT = savedEnv;

// ⑪ pickStepDelay:固定 / 区间随机 / 关闭
const rFixed = new MacroRunner(errDir, undefined, undefined, { replayProfile: { ...defaultProfile(), stepDelay: { min: 300, max: 300 } } });
check(rFixed.pickStepDelay() === 300, 'pickStepDelay 固定值 300');
const rRand = new MacroRunner(errDir, undefined, undefined, { replayProfile: { ...defaultProfile(), stepDelay: { min: 200, max: 500 } } });
const dv = rRand.pickStepDelay();
check(dv >= 200 && dv < 500, `pickStepDelay 区间随机落在 [200,500):${dv}`);
check(r0.pickStepDelay() === 0, 'pickStepDelay 关闭(max=0)返回 0');

// ⑫ computeBackoff:固定 / 指数 / 封顶
const rExp = new MacroRunner(errDir, undefined, undefined, {
    replayProfile: { ...defaultProfile(), retry: { count: 5, backoff: 'exponential', baseMs: 1000, factor: 2, maxMs: 5000 } },
});
check(rExp.computeBackoff(1) === 1000, '指数退避 attempt1 = 1000');
check(rExp.computeBackoff(2) === 2000, '指数退避 attempt2 = 2000');
check(rExp.computeBackoff(4) === 5000, '指数退避封顶 maxMs = 5000');
const rFix = new MacroRunner(errDir, undefined, undefined, {
    replayProfile: { ...defaultProfile(), retry: { count: 3, backoff: 'fixed', baseMs: 700, factor: 2, maxMs: 10000 } },
});
check(rFix.computeBackoff(3) === 700, '固定退避恒 = baseMs 700');

rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? '\n❌ 有用例未通过' : '\n✅ 回放行为档自检全部通过');
process.exit(failed ? 1 : 0);

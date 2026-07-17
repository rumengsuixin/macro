// 「重发响应条件触发」纯逻辑离线自检:断言 responseTriggerMet / getJsonByPath /
// triggerNeedsBody / headersAllEqual 行为正确(status/headers/bodyJson 三组 AND、
// JSON 嵌套路径取值、解析失败/路径缺失/读不到体 → 不命中、头名大小写不敏感)。
// 同时回归 responseConditionMet 重构后行为不变。
// 只测「触发判断」这一最易出错的纯逻辑;真实响应观察/重发发射由 E2E(verify-response-trigger-replay)覆盖。
// 需先 `npm run build`;不需网络、不启 Electron / Playwright。
// 用法:node scripts/verify-response-trigger.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    responseTriggerMet,
    getJsonByPath,
    triggerNeedsBody,
    headersAllEqual,
    responseConditionMet,
} = require('../dist/core/request-rewrite.js');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

console.log('1) getJsonByPath —— 点路径逐层取值');
{
    const obj = { data: { state: 'done', n: 3 }, ok: true, arr: [1, 2] };
    assert(getJsonByPath(obj, 'data.state') === 'done', '嵌套路径 data.state → "done"');
    assert(getJsonByPath(obj, 'data.n') === 3, '嵌套路径取到数字 3');
    assert(getJsonByPath(obj, 'ok') === true, '顶层路径 ok → true');
    assert(getJsonByPath(obj, 'data.missing') === undefined, '缺失叶子 → undefined');
    assert(getJsonByPath(obj, 'nope.deep.path') === undefined, '中途非对象 → undefined');
    assert(getJsonByPath(obj, 'data.state.x') === undefined, '在字符串上再取属性 → undefined(非对象守卫)');
    assert(getJsonByPath(null, 'a.b') === undefined, '根为 null → undefined');
}

console.log('2) headersAllEqual —— 头条件 AND / 大小写不敏感 / 缺省恒真');
assert(headersAllEqual({ 'x-ready': '1' }, { 'x-ready': '1' }), '单条件相等 → true');
assert(headersAllEqual({ 'X-Ready': '1' }, { 'x-ready': '1' }), '头名大小写不敏感(X-Ready vs x-ready)');
assert(!headersAllEqual({ 'x-ready': '0' }, { 'x-ready': '1' }), '值不等 → false(值大小写/精确敏感)');
assert(!headersAllEqual({}, { 'x-ready': '1' }), '头缺失 → false');
assert(headersAllEqual({ a: '1', b: '2' }, { a: '1', b: '2' }), '多条件全满足 → true(AND)');
assert(!headersAllEqual({ a: '1', b: '9' }, { a: '1', b: '2' }), '多条件有一个不满足 → false');
assert(headersAllEqual({ any: 'x' }, undefined), 'expected 缺省 → 恒真');

console.log('3) triggerNeedsBody —— 仅有 bodyJson 子条件才需读体');
assert(triggerNeedsBody({ bodyJson: { 'a.b': 'x' } }) === true, '有 bodyJson → 需读体');
assert(triggerNeedsBody({ headers: { x: '1' } }) === false, '只有 headers → 不需读体');
assert(triggerNeedsBody({ status: 200 }) === false, '只有 status → 不需读体');
assert(triggerNeedsBody({ bodyJson: {} }) === false, 'bodyJson 为空对象 → 不需读体');
assert(triggerNeedsBody({}) === false, '空触发器 → 不需读体');

console.log('4) responseTriggerMet —— status/headers/bodyJson 三组 AND');
const body = JSON.stringify({ data: { state: 'done' }, code: 0 });
assert(
    responseTriggerMet({ status: 200, headers: { 'x-ready': '1' }, bodyJson: { 'data.state': 'done' } }, 200, { 'x-ready': '1' }, body),
    '三组全满足 → true'
);
assert(
    !responseTriggerMet({ status: 200 }, 500, {}, null),
    'status 不等 → false'
);
assert(
    !responseTriggerMet({ headers: { 'x-ready': '1' } }, 200, { 'x-ready': '0' }, null),
    'headers 不满足 → false'
);
assert(
    !responseTriggerMet({ bodyJson: { 'data.state': 'done' } }, 200, {}, JSON.stringify({ data: { state: 'pending' } })),
    'bodyJson 路径值不等 → false'
);
assert(
    !responseTriggerMet({ bodyJson: { 'data.state': 'done' } }, 200, {}, null),
    '有 bodyJson 条件但 bodyText 为 null(读不到体) → false'
);
assert(
    !responseTriggerMet({ bodyJson: { 'data.state': 'done' } }, 200, {}, '这不是JSON{{'),
    'bodyText 非合法 JSON(解析失败) → false'
);
assert(
    !responseTriggerMet({ bodyJson: { 'data.missing': 'x' } }, 200, {}, body),
    'bodyJson 路径不存在 → false'
);
assert(
    responseTriggerMet({}, 200, { any: 'x' }, null),
    '空触发器(无任何子条件) → 恒真(该 URL 任意响应都触发)'
);
assert(
    responseTriggerMet({ bodyJson: { code: '0' } }, 200, {}, body),
    'bodyJson 值 String() 化比较:JSON 数字 0 vs 期望 "0" → true'
);
assert(
    !responseTriggerMet({ status: 200, bodyJson: { 'data.state': 'done' } }, 200, {}, JSON.stringify({ data: { state: 'x' } })),
    'AND:status 满足但 bodyJson 不满足 → 整体 false'
);

console.log('5) responseConditionMet —— 重构后行为回归(委托 headersAllEqual)');
assert(responseConditionMet({ xx: '1' }, { urlPattern: '*', when: { xx: '1' } }), 'when 相等 → true');
assert(!responseConditionMet({ xx: '2' }, { urlPattern: '*', when: { xx: '1' } }), 'when 不等 → false');
assert(responseConditionMet({ any: 'x' }, { urlPattern: '*' }), 'when 缺省 → 恒真');
assert(responseConditionMet({ XX: '1' }, { urlPattern: '*', when: { xx: '1' } }), '头名大小写不敏感');

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

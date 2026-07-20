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
    explainResponseTriggerMiss,
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

console.log('3) triggerNeedsBody —— 有 bodyJson 或 bodyContains 才需读体');
assert(triggerNeedsBody({ bodyJson: { 'a.b': 'x' } }) === true, '有 bodyJson → 需读体');
assert(triggerNeedsBody({ bodyContains: ['x'] }) === true, '有 bodyContains → 需读体');
assert(triggerNeedsBody({ headers: { x: '1' } }) === false, '只有 headers → 不需读体');
assert(triggerNeedsBody({ status: 200 }) === false, '只有 status → 不需读体');
assert(triggerNeedsBody({ bodyJson: {} }) === false, 'bodyJson 为空对象 → 不需读体');
assert(triggerNeedsBody({ bodyContains: [] }) === false, 'bodyContains 为空数组 → 不需读体');
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

console.log('5) responseTriggerMet —— bodyContains 原文子串(AND、免路径、适配嵌套数组)');
// 复刻用户结构:深层嵌套 + 异构数组,点路径难写,靠原文子串匹配
const nested = JSON.stringify({
    continuationContents: [
        {
            uploadFeedbackItemContinuation: {
                id: { a: 'innertube_studio:X:0' },
                contents: [
                    { transferProgressBar: { fractionCompleted: 1, progressMessage: { simpleText: '已上传 100%。' } } },
                ],
            },
        },
    ],
});
assert(
    responseTriggerMet({ bodyContains: ['"fractionCompleted":1'] }, 200, {}, nested),
    '单子串命中深层嵌套结构 → true(点路径写不出也能匹配)'
);
assert(
    responseTriggerMet({ bodyContains: ['uploadFeedbackItemContinuation', '"fractionCompleted":1'] }, 200, {}, nested),
    '多子串全含 → true(AND)'
);
assert(
    !responseTriggerMet({ bodyContains: ['uploadFeedbackItemContinuation', '"fractionCompleted":0.5'] }, 200, {}, nested),
    '多子串缺一个 → false'
);
assert(
    !responseTriggerMet({ bodyContains: ['"fractionCompleted":1'] }, 200, {}, null),
    '有 bodyContains 但 bodyText 为 null → false'
);
assert(
    responseTriggerMet({ bodyContains: ['已上传 100%'] }, 200, {}, nested),
    '中文子串(字面 UTF-8)也能命中 → true'
);
assert(
    responseTriggerMet({ status: 200, bodyContains: ['"fractionCompleted":1'], bodyJson: { 'continuationContents.0.uploadFeedbackItemContinuation.contents.0.transferProgressBar.fractionCompleted': '1' } }, 200, {}, nested),
    'bodyContains + bodyJson(数字下标点路径)+ status 组合全满足 → true(证 AND & 数字下标可走)'
);
assert(
    !responseTriggerMet({ bodyContains: ['"fractionCompleted":1', 'NOT_PRESENT'] }, 200, {}, nested),
    'AND:一个子串在、一个不在 → 整体 false'
);

console.log('6) responseConditionMet —— 重构后行为回归(委托 headersAllEqual)');
assert(responseConditionMet({ xx: '1' }, { urlPattern: '*', when: { xx: '1' } }), 'when 相等 → true');
assert(!responseConditionMet({ xx: '2' }, { urlPattern: '*', when: { xx: '1' } }), 'when 不等 → false');
assert(responseConditionMet({ any: 'x' }, { urlPattern: '*' }), 'when 缺省 → 恒真');
assert(responseConditionMet({ XX: '1' }, { urlPattern: '*', when: { xx: '1' } }), '头名大小写不敏感');

console.log('7) explainResponseTriggerMiss —— 未命中原因诊断');
{
    // 条件其实满足 → null(不该报)
    const ok = explainResponseTriggerMiss(
        { bodyContains: ['"fractionCompleted":1'] },
        200,
        {},
        '{"transferProgressBar":{"fractionCompleted":1}}'
    );
    assert(ok === null, '条件满足 → 返回 null(不报)');

    // 仅空白差异:规则写无空格,响应体冒号后有空格
    const ws = explainResponseTriggerMiss(
        { bodyContains: ['"fractionCompleted":1'] },
        200,
        {},
        '{"transferProgressBar":{"fractionCompleted": 1}}'
    );
    assert(ws !== null && /仅空白差异/.test(ws.message), '空格差异 → message 提示「仅空白差异」');
    assert(ws !== null && /bc:ws:/.test(ws.signature), '空格差异 → signature 标 bc:ws');

    // 真缺失(关键字在、值不同):展示实际片段
    const miss = explainResponseTriggerMiss(
        { bodyContains: ['"fractionCompleted":1'] },
        200,
        {},
        '{"transferProgressBar":{"fractionCompleted":0.5}}'
    );
    assert(miss !== null && /响应体实际/.test(miss.message), '值不同 → message 含「响应体实际」片段');
    assert(
        miss !== null && miss.message.includes('fractionCompleted":0.5'),
        '实际片段里能看到真实值 0.5'
    );
    // 空格差异与真缺失是不同 signature(各打一次)
    assert(ws.signature !== miss.signature, '空格差异与真缺失 signature 不同(各自去重)');

    // 关键字都没出现
    const nokey = explainResponseTriggerMiss(
        { bodyContains: ['"fractionCompleted":1'] },
        200,
        {},
        '{"other":123}'
    );
    assert(nokey !== null && /未出现在响应体/.test(nokey.message), '关键字缺失 → 「未出现在响应体」');

    // 响应体读不到
    const nullBody = explainResponseTriggerMiss({ bodyContains: ['x'] }, 200, {}, null);
    assert(nullBody !== null && /读不到/.test(nullBody.message), 'bodyText=null → 「响应体读不到」');

    // status 不等
    const st = explainResponseTriggerMiss({ status: 200 }, 500, {}, null);
    assert(st !== null && /status 期望 200 实际 500/.test(st.message), 'status 不等 → 说清期望/实际');

    // 同输入两次 signature 相同(可去重)
    const a = explainResponseTriggerMiss({ bodyContains: ['"fractionCompleted":1'] }, 200, {}, '{"fractionCompleted":0.5}');
    const b = explainResponseTriggerMiss({ bodyContains: ['"fractionCompleted":1'] }, 200, {}, '{"fractionCompleted":0.5}');
    assert(a.signature === b.signature, '同一失败模式 signature 稳定(可去重)');

    // bodyJson 路径值不等
    const bj = explainResponseTriggerMiss(
        { bodyJson: { 'data.state': 'done' } },
        200,
        {},
        '{"data":{"state":"pending"}}'
    );
    assert(bj !== null && /data\.state 期望 "done" 实际 "pending"/.test(bj.message), 'bodyJson 值不等 → 说清路径/期望/实际');
}

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

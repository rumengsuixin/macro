// blocks「真拦截」复合匹配纯逻辑离线自检:断言 blockRuleMatches / matchBlockRule /
// queryValue / queryAllEqual / bodyConditionsMet 行为正确——
// urlPattern + method + requestHeaders + query + bodyJson + bodyContains + when 各组 AND、
// 缺省不校验、旧配置(仅 urlPattern)向后兼容、when 失败即安全(不拦)、
// 且 matchBlockRule 遍历取「首个全条件命中」不被仅 URL 命中却条件不符的前序规则遮蔽。
// 只测「命中判断」这一最易出错的纯逻辑;真实 route.abort/hold 由 E2E(verify-block-intercept/verify-block-hold)覆盖。
// 需先 `npm run build`;不需网络、不启 Electron / Playwright。
// 用法:node scripts/verify-block-match.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    blockRuleMatches,
    matchBlockRule,
    queryValue,
    queryAllEqual,
    bodyConditionsMet,
    isResendOrigin,
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

// 便捷:blockRuleMatches(rule, url, method, headers, bodyText)
const hit = (rule, { url = 'https://h/api/confirm?a=1', method = 'POST', headers = {}, body = null } = {}) =>
    blockRuleMatches(rule, url, method, headers, body);

console.log('1) queryValue —— 取 query 参数(名大小写敏感,缺失/非法 URL → "")');
assert(queryValue('https://h/p?a=1&b=2', 'a') === '1', 'a → "1"');
assert(queryValue('https://h/p?a=1&b=2', 'b') === '2', 'b → "2"');
assert(queryValue('https://h/p?a=1', 'A') === '', '参数名大小写敏感(A 无值)');
assert(queryValue('https://h/p?a=1', 'z') === '', '缺失参数 → ""');
assert(queryValue('https://h/p?a=', 'a') === '', '空值参数 → ""');
assert(queryValue('not a url', 'a') === '', '非法 URL → ""(不抛)');

console.log('2) queryAllEqual —— query 参数 AND / 缺省恒真 / 非法 URL 有条件即 false');
assert(queryAllEqual('https://h/p?a=1&b=2', { a: '1' }), '单参相等 → true');
assert(queryAllEqual('https://h/p?a=1&b=2', { a: '1', b: '2' }), '多参全等 → true(AND)');
assert(!queryAllEqual('https://h/p?a=1&b=2', { a: '1', b: '9' }), '一参不等 → false');
assert(!queryAllEqual('https://h/p?a=1', { c: '3' }), '参数缺失 → false');
assert(queryAllEqual('https://h/p?a=1', undefined), 'expected 缺省 → 恒真');
assert(queryAllEqual('https://h/p?a=1', {}), 'expected 空对象 → 恒真');
assert(!queryAllEqual('not a url', { a: '1' }), '非法 URL 且有条件 → false(失败即安全)');

console.log('3) bodyConditionsMet —— bodyContains 子串 + bodyJson 点路径 AND / 缺省恒真');
const jbody = JSON.stringify({ action: 'delete', force: true, meta: { n: 3 } });
assert(bodyConditionsMet(jbody, undefined, undefined), '两组缺省 → 恒真');
assert(bodyConditionsMet(jbody, ['"action":"delete"'], undefined), 'bodyContains 命中 → true');
assert(!bodyConditionsMet(jbody, ['"action":"keep"'], undefined), 'bodyContains 不含 → false');
assert(!bodyConditionsMet(null, ['x'], undefined), '有 bodyContains 但 body=null → false');
assert(bodyConditionsMet(jbody, undefined, { action: 'delete' }), 'bodyJson 点路径命中 → true');
assert(bodyConditionsMet(jbody, undefined, { 'meta.n': '3' }), 'bodyJson 嵌套点路径 + String() 化 → true');
assert(!bodyConditionsMet(jbody, undefined, { action: 'keep' }), 'bodyJson 值不等 → false');
assert(!bodyConditionsMet(jbody, undefined, { 'meta.missing': 'x' }), 'bodyJson 路径缺失 → false');
assert(!bodyConditionsMet('不是JSON{{', undefined, { action: 'delete' }), 'bodyJson 但 body 非法 JSON → false');
assert(!bodyConditionsMet(null, undefined, { action: 'delete' }), 'bodyJson 但 body=null → false');
assert(bodyConditionsMet(jbody, ['"force":true'], { action: 'delete' }), 'bodyContains + bodyJson 组合全满足 → true(AND)');

console.log('4) blockRuleMatches —— 仅 urlPattern(向后兼容)+ method 大小写不敏感');
assert(hit({ urlPattern: '*/api/confirm*' }), '仅 urlPattern 命中(旧配置向后兼容)');
assert(!hit({ urlPattern: '*/api/other*' }), 'urlPattern 不匹配 → 不命中');
assert(!hit({ urlPattern: '[' }), '非法 glob pattern → 不命中(不抛)');
assert(hit({ urlPattern: '*/api/confirm*', method: 'post' }, { method: 'POST' }), 'method 大小写不敏感(post vs POST)');
assert(!hit({ urlPattern: '*/api/confirm*', method: 'GET' }, { method: 'POST' }), 'method 不符 → 不命中');
assert(hit({ urlPattern: '*/api/confirm*' }, { method: 'GET' }), 'method 缺省 → 任意方法命中');

console.log('5) blockRuleMatches —— requestHeaders 请求头 AND(名大小写不敏感)');
const rh = { 'x-env': 'prod', 'content-type': 'application/json' };
assert(hit({ urlPattern: '*', requestHeaders: { 'x-env': 'prod' } }, { headers: rh }), '请求头相等 → 命中');
assert(hit({ urlPattern: '*', requestHeaders: { 'X-Env': 'prod' } }, { headers: rh }), '头名大小写不敏感 → 命中');
assert(!hit({ urlPattern: '*', requestHeaders: { 'x-env': 'dev' } }, { headers: rh }), '头值不等 → 不命中');
assert(!hit({ urlPattern: '*', requestHeaders: { 'x-abs': '1' } }, { headers: rh }), '头缺失 → 不命中');
assert(hit({ urlPattern: '*', requestHeaders: { 'x-env': 'prod', 'content-type': 'application/json' } }, { headers: rh }), '多头全等 → 命中(AND)');
assert(!hit({ urlPattern: '*', requestHeaders: { 'x-env': 'prod', 'content-type': 'text/plain' } }, { headers: rh }), '多头有一不符 → 不命中');

console.log('6) blockRuleMatches —— query 参数 AND');
assert(hit({ urlPattern: '*', query: { a: '1' } }, { url: 'https://h/api/confirm?a=1&b=2' }), 'query 相等 → 命中');
assert(!hit({ urlPattern: '*', query: { a: '9' } }, { url: 'https://h/api/confirm?a=1' }), 'query 值不符 → 不命中');
assert(!hit({ urlPattern: '*', query: { z: '1' } }, { url: 'https://h/api/confirm?a=1' }), 'query 缺失 → 不命中');

console.log('7) blockRuleMatches —— body(bodyJson / bodyContains)');
assert(hit({ urlPattern: '*', bodyJson: { action: 'delete' } }, { body: jbody }), 'bodyJson 命中 → 命中');
assert(!hit({ urlPattern: '*', bodyJson: { action: 'keep' } }, { body: jbody }), 'bodyJson 不符 → 不命中');
assert(hit({ urlPattern: '*', bodyContains: ['"force":true'] }, { body: jbody }), 'bodyContains 命中 → 命中');
assert(!hit({ urlPattern: '*', bodyContains: ['nope'] }, { body: jbody }), 'bodyContains 不含 → 不命中');
assert(!hit({ urlPattern: '*', bodyJson: { action: 'delete' } }, { body: null }), '有 body 条件但 body=null → 不命中');

console.log('8) blockRuleMatches —— when 表达式(读请求侧 header/reqHeader/query/body/method/url)');
const wctx = { url: 'https://h/api/confirm?confirm=1', method: 'POST', headers: rh, body: jbody };
assert(hit({ urlPattern: '*', when: `reqHeader('x-env') == 'prod'` }, wctx), 'when reqHeader 命中');
assert(hit({ urlPattern: '*', when: `header('x-env') == 'prod'` }, wctx), 'when header(=请求头别名) 命中');
assert(hit({ urlPattern: '*', when: `query('confirm') == '1'` }, wctx), 'when query 命中');
assert(hit({ urlPattern: '*', when: `body.action == 'delete'` }, wctx), 'when body 点取 命中');
assert(hit({ urlPattern: '*', when: `method == 'POST'` }, wctx), 'when method 命中');
assert(hit({ urlPattern: '*', when: `contains(url, '/api/confirm')` }, wctx), 'when url contains 命中');
assert(!hit({ urlPattern: '*', when: `reqHeader('x-env') == 'dev'` }, wctx), 'when 结果为假 → 不命中');
assert(!hit({ urlPattern: '*', when: `body && body.action == 'delete'` }, { ...wctx, body: null }), 'body=null 时 body && … 安全短路 → 结果 falsy → 不命中');
assert(!hit({ urlPattern: '*', when: `body.action == 'delete'` }, { ...wctx, body: null }), 'body=null 直接点取 → 求值异常 → 失败即安全不命中');
assert(!hit({ urlPattern: '*', when: 'status ==' }, wctx), 'when 语法错 → 失败即安全不命中(fail-open)');
assert(!hit({ urlPattern: '*', when: 'process' }, wctx), 'when 逃逸标识符 → 失败即安全不命中');
assert(hit({ urlPattern: '*', when: '   ' }, wctx), 'when 纯空白 → 无条件(视为不校验)');

console.log('9) blockRuleMatches —— 全组 AND(任一不符即不命中)');
const full = {
    urlPattern: '*/api/confirm*',
    method: 'POST',
    requestHeaders: { 'x-env': 'prod' },
    query: { confirm: '1' },
    bodyJson: { action: 'delete' },
    when: `body.force == true`,
};
const fctx = { url: 'https://h/api/confirm?confirm=1', method: 'POST', headers: rh, body: jbody };
assert(hit(full, fctx), '全组条件都满足 → 命中');
assert(!hit(full, { ...fctx, method: 'GET' }), 'method 拖后腿 → 不命中');
assert(!hit(full, { ...fctx, headers: { 'x-env': 'dev' } }), 'requestHeaders 拖后腿 → 不命中');
assert(!hit(full, { ...fctx, url: 'https://h/api/confirm?confirm=0' }), 'query 拖后腿 → 不命中');
assert(!hit(full, { ...fctx, body: JSON.stringify({ action: 'delete', force: false }) }), 'when(body.force) 拖后腿 → 不命中');

console.log('10) matchBlockRule —— 遍历取首个全条件命中,不被仅 URL 命中却条件不符的前序规则遮蔽');
{
    // rule[0] 仅 URL 命中但请求头不符;rule[1] URL + 请求头全命中 → 应返回 rule[1]
    const rules = [
        { urlPattern: '*/api/confirm*', requestHeaders: { 'x-env': 'staging' }, mode: 'abort' },
        { urlPattern: '*/api/confirm*', requestHeaders: { 'x-env': 'prod' }, mode: 'hold' },
    ];
    const m = matchBlockRule(rules, 'https://h/api/confirm?a=1', 'POST', rh, null);
    assert(m !== null && m.mode === 'hold', '前序仅 URL 命中但条件不符 → 跳过,命中后续 rule[1](mode=hold)');

    // 都不满足条件 → null(URL 命中但头都不符)
    const none = matchBlockRule(
        [
            { urlPattern: '*/api/confirm*', requestHeaders: { 'x-env': 'a' } },
            { urlPattern: '*/api/confirm*', requestHeaders: { 'x-env': 'b' } },
        ],
        'https://h/api/confirm?a=1',
        'POST',
        rh,
        null
    );
    assert(none === null, '所有规则 URL 命中但条件都不符 → 返回 null(不拦)');

    // 首个即全命中 → 返回首个
    const first = matchBlockRule(
        [
            { urlPattern: '*/api/confirm*', mode: 'abort' },
            { urlPattern: '*/api/confirm*', mode: 'hold' },
        ],
        'https://h/api/confirm?a=1',
        'POST',
        {},
        null
    );
    assert(first !== null && first.mode === 'abort', '首个即命中(仅 URL) → 返回首个(mode=abort)');

    // 空规则表 → null
    assert(matchBlockRule([], 'https://h/x', 'GET', {}, null) === null, '空规则表 → null');
}

console.log('11) includeResend —— 重发请求仅被 includeResend 的 block 拦(runner 分支仿真)');
{
    const url = 'https://studio.youtube.com/youtubei/v1/upload/createvideo?alt=json';
    const RESEND = { 'x-macro-resend': '1', 'x-macro': '3' }; // 工具重发请求头(带标记 + 业务标记)
    const REAL = {}; // 真实请求(无标记头)

    // isResendOrigin 正确识别重发 vs 真实
    assert(isResendOrigin(RESEND) === true, 'isResendOrigin:带 x-macro-resend → true(重发)');
    assert(isResendOrigin(REAL) === false, 'isResendOrigin:无标记头 → false(真实)');

    // 两条规则:一条普通(不拦重发)、一条 includeResend(拦重发)
    const rules = [
        { urlPattern: '*/upload/createvideo*', mode: 'hold' },
        { urlPattern: '*/upload/createvideo*', mode: 'hold', includeResend: true },
    ];
    // 仿 macro-runner:重发请求只用 includeResend 子集判定
    const resendSubset = rules.filter((r) => r.includeResend);
    assert(resendSubset.length === 1, 'includeResend 子集正确过滤出 1 条');
    const rbHit = matchBlockRule(resendSubset, url, 'POST', RESEND, null);
    assert(!!rbHit && rbHit.includeResend === true, '重发请求 → 命中 includeResend 的 block');

    // 全是普通规则时,重发子集为空 → 重发不被拦(现状:重发免疫)
    const plainOnly = [{ urlPattern: '*/upload/createvideo*', mode: 'hold' }];
    assert(
        matchBlockRule(plainOnly.filter((r) => r.includeResend), url, 'POST', RESEND, null) === null,
        '无 includeResend 规则 → 重发子集空 → 重发不被拦(向后兼容)'
    );

    // 真实请求:用全量规则,命中首个(不受 includeResend 影响)
    const realHit = matchBlockRule(rules, url, 'POST', REAL, null);
    assert(!!realHit, '真实请求 → 命中全量 block(首个)');
}

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

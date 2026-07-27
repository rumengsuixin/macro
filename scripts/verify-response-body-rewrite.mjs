// 响应体/状态码/mock 改写(P0-1)离线自检:断言纯逻辑 responseRuleHasBodyAction /
// normalizeStatusOverride / resolveResponseOverride / resolveMockStatus 行为正确
// (动作探测、状态码 clamp、when 门槛、setBody 优先与空串、mock 状态缺省)。
// 只测「决策逻辑」这一最易错的部分;文件读取 / Playwright route.fulfill 属机械管线,由 E2E / 运行的 app 观察。
// 需先 `npm run build`;不需网络、不启 Electron / Playwright。
// 用法:node scripts/verify-response-body-rewrite.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    responseRuleHasBodyAction,
    normalizeStatusOverride,
    resolveResponseOverride,
    resolveMockStatus,
    rewriteResponseHeaderRecord,
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

console.log('1) responseRuleHasBodyAction —— 是否含 响应体/状态码/mock 动作(决定是否在 fulfill 阶段介入)');
assert(!responseRuleHasBodyAction({ urlPattern: '*' }), '纯 urlPattern → 无 body 动作');
assert(!responseRuleHasBodyAction({ urlPattern: '*', setHeaders: { cc: '1' } }), '只改头 → 无 body 动作(走原路径)');
assert(responseRuleHasBodyAction({ urlPattern: '*', setStatus: 500 }), 'setStatus → 有动作');
assert(responseRuleHasBodyAction({ urlPattern: '*', setBody: '' }), "setBody='' (空体覆盖) → 有动作");
assert(responseRuleHasBodyAction({ urlPattern: '*', bodyReplaceFile: 'x.json' }), 'bodyReplaceFile → 有动作');
assert(!responseRuleHasBodyAction({ urlPattern: '*', bodyReplaceFile: '   ' }), 'bodyReplaceFile 纯空白 → 无动作');
assert(responseRuleHasBodyAction({ urlPattern: '*', mock: true }), 'mock:true → 有动作');
assert(!responseRuleHasBodyAction({ urlPattern: '*', mock: false }), 'mock:false → 无动作');

console.log('2) normalizeStatusOverride —— 取整 + clamp [100,599],非法 → null');
assert(normalizeStatusOverride(200) === 200, '200 → 200');
assert(normalizeStatusOverride(404.9) === 404, '404.9 取整 → 404');
assert(normalizeStatusOverride(99) === null, '99 越界 → null');
assert(normalizeStatusOverride(600) === null, '600 越界 → null');
assert(normalizeStatusOverride(100) === 100 && normalizeStatusOverride(599) === 599, '边界 100/599 → 保留');
assert(normalizeStatusOverride('500') === null, "字符串 '500' → null(非数字)");
assert(normalizeStatusOverride(NaN) === null, 'NaN → null');
assert(normalizeStatusOverride(undefined) === null, 'undefined → null');

console.log('3) resolveResponseOverride —— when 门槛 + status/body 覆盖决策');
{
    // when 不满足 → 不覆盖(condMet=false,status/body 均 null)
    const ov = resolveResponseOverride({ xx: '2' }, { urlPattern: '*', when: { xx: '1' }, setStatus: 500, setBody: 'X' });
    assert(ov.condMet === false && ov.status === null && ov.body === null, 'when 不满足 → condMet=false、不覆盖任何维度');
}
{
    // when 满足 → status/body 均覆盖
    const ov = resolveResponseOverride({ xx: '1' }, { urlPattern: '*', when: { xx: '1' }, setStatus: 403, setBody: '{"ok":false}' });
    assert(ov.condMet === true && ov.status === 403 && ov.body === '{"ok":false}', 'when 满足 → status=403、body 覆盖');
}
{
    // 无 when → 无条件生效
    const ov = resolveResponseOverride({ any: 'x' }, { urlPattern: '*', setStatus: 200 });
    assert(ov.condMet === true && ov.status === 200 && ov.body === null, '无 when → 恒生效;只设 status 时 body=null');
}
{
    // setBody='' 是合法空体覆盖(不能被当成"未设置")
    const ov = resolveResponseOverride({}, { urlPattern: '*', setBody: '' });
    assert(ov.condMet === true && ov.body === '', "setBody='' → body='' (空体覆盖,非 null)");
}
{
    // 非法 setStatus 在 override 里也归一化为 null
    const ov = resolveResponseOverride({}, { urlPattern: '*', setStatus: 999 });
    assert(ov.status === null, 'setStatus 越界(999)→ status=null(不覆盖)');
}

console.log('4) resolveMockStatus —— mock 状态码缺省 200、非法回退 200');
assert(resolveMockStatus({ urlPattern: '*' }) === 200, 'mock 无 setStatus → 200');
assert(resolveMockStatus({ urlPattern: '*', setStatus: 503 }) === 503, 'mock setStatus=503 → 503');
assert(resolveMockStatus({ urlPattern: '*', setStatus: 99 }) === 200, 'mock setStatus 越界 → 回退 200');

console.log('5) 向后兼容 —— 旧「只改头」规则不受 P0-1 影响(rewriteResponseHeaderRecord 行为不变)');
{
    const out = rewriteResponseHeaderRecord({ 'Content-Type': 'text/html' }, { urlPattern: '*', setHeaders: { cc: '1' } });
    assert(out !== null && out.cc === '1' && out['Content-Type'] === 'text/html', '只改头规则:set cc、原头保留(与今天一致)');
    assert(rewriteResponseHeaderRecord({ a: '1' }, { urlPattern: '*' }) === null, '无头动作 → null(与今天一致)');
    // 只有 body/status 动作、无头动作的规则:改头函数仍返回 null(头不动),body/status 由另一路径处理
    assert(rewriteResponseHeaderRecord({ a: '1' }, { urlPattern: '*', setStatus: 500 }) === null, '仅 setStatus 规则:改头函数返回 null(不误改头)');
}

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

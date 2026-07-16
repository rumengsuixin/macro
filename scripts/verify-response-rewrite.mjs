// 响应头条件改写离线自检:断言纯函数 responseConditionMet / rewriteResponseHeaderRecord /
// rewriteResponseHeaderEntries 行为正确(条件判断、大小写不敏感、保留重复头、无动作返回 null)。
// 只测「改写逻辑」这一最易出错的部分(CDP continueResponse / Playwright route.fulfill 属机械管线,
// 由 E2E / 运行的 app 观察)。需先 `npm run build`;不需网络、不启 Electron / Playwright。
// 用法:node scripts/verify-response-rewrite.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    responseConditionMet,
    rewriteResponseHeaderRecord,
    rewriteResponseHeaderEntries,
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

console.log('1) responseConditionMet —— 条件判断(AND、大小写不敏感、缺省恒真)');
assert(responseConditionMet({ xx: '1' }, { urlPattern: '*', when: { xx: '1' } }), 'when 单条件相等 → true');
assert(!responseConditionMet({ xx: '2' }, { urlPattern: '*', when: { xx: '1' } }), 'when 值不等 → false');
assert(!responseConditionMet({}, { urlPattern: '*', when: { xx: '1' } }), 'when 头缺失 → false');
assert(responseConditionMet({ XX: '1' }, { urlPattern: '*', when: { xx: '1' } }), 'when 头名大小写不敏感(XX vs xx)');
assert(responseConditionMet({ xx: '1', yy: '2' }, { urlPattern: '*', when: { xx: '1', yy: '2' } }), 'when 多条件全满足 → true(AND)');
assert(!responseConditionMet({ xx: '1', yy: '9' }, { urlPattern: '*', when: { xx: '1', yy: '2' } }), 'when 多条件有一个不满足 → false');
assert(responseConditionMet({ anything: 'x' }, { urlPattern: '*' }), 'when 缺省 → 无条件恒真');

console.log('2) rewriteResponseHeaderRecord —— set 设置/覆盖(含大小写不产生重复键)');
{
    const out = rewriteResponseHeaderRecord(
        { 'Content-Type': 'text/html', xx: '1' },
        { urlPattern: '*', when: { xx: '1' }, setHeaders: { cc: '1' } }
    );
    assert(out !== null && out.cc === '1', '条件满足 → 新增 cc=1');
    assert(out['Content-Type'] === 'text/html', '未涉及的头原样保留');
}
{
    // 原头 'Content-Type'(大写),set 用 'content-type'(小写):应覆盖、只留一个键
    const out = rewriteResponseHeaderRecord(
        { 'Content-Type': 'text/html' },
        { urlPattern: '*', setHeaders: { 'content-type': 'application/json' } }
    );
    const ctKeys = Object.keys(out).filter((k) => k.toLowerCase() === 'content-type');
    assert(ctKeys.length === 1, 'set 大小写不同的同名头 → 只剩一个键(不产生重复)');
    assert(out[ctKeys[0]] === 'application/json', '同名头值被覆盖为新值');
}

console.log('3) rewriteResponseHeaderRecord —— remove(大小写不敏感)');
{
    const out = rewriteResponseHeaderRecord(
        { 'X-Drop': 'yes', keep: '1' },
        { urlPattern: '*', removeHeaders: ['x-drop'] }
    );
    assert(out !== null && !('X-Drop' in out), 'remove 用小写名删掉大写的原头');
    assert(out.keep === '1', '未涉及的头保留');
}

console.log('4) rewriteResponseHeaderRecord —— 条件门槛 & 无动作 → null');
assert(
    rewriteResponseHeaderRecord({ xx: '2' }, { urlPattern: '*', when: { xx: '1' }, setHeaders: { cc: '1' } }) === null,
    'when 不满足 → null(不改)'
);
assert(rewriteResponseHeaderRecord({ a: '1' }, { urlPattern: '*' }) === null, '无 setHeaders/removeHeaders → null');
assert(
    rewriteResponseHeaderRecord({ a: '1' }, { urlPattern: '*', setHeaders: {}, removeHeaders: [] }) === null,
    '空 setHeaders/removeHeaders → null'
);

console.log('5) rewriteResponseHeaderEntries —— 保留重复头 + set/remove(CDP HeaderEntry[])');
{
    const entries = [
        { name: 'set-cookie', value: 'a=1' },
        { name: 'set-cookie', value: 'b=2' },
        { name: 'CC', value: '0' },
        { name: 'X-Drop', value: 'yes' },
        { name: 'xx', value: '1' },
    ];
    const out = rewriteResponseHeaderEntries(entries, {
        urlPattern: '*',
        when: { xx: '1' },
        setHeaders: { cc: '1' },
        removeHeaders: ['x-drop'],
    });
    assert(out !== null, '条件满足 → 返回改写后的数组');
    const cookies = out.filter((e) => e.name.toLowerCase() === 'set-cookie');
    assert(cookies.length === 2, '不在名单内的重复头(两条 set-cookie)全部保留');
    const cc = out.filter((e) => e.name.toLowerCase() === 'cc');
    assert(cc.length === 1 && cc[0].value === '1', 'set 覆盖同名(大小写)头 → 只剩一条 cc=1');
    assert(!out.some((e) => e.name.toLowerCase() === 'x-drop'), 'remove 大小写不敏感删掉 X-Drop');
}

console.log('6) rewriteResponseHeaderEntries —— 条件不满足 / 无动作 → null');
assert(
    rewriteResponseHeaderEntries([{ name: 'xx', value: '2' }], {
        urlPattern: '*',
        when: { xx: '1' },
        setHeaders: { cc: '1' },
    }) === null,
    'when 不满足 → null'
);
assert(
    rewriteResponseHeaderEntries([{ name: 'a', value: '1' }], { urlPattern: '*' }) === null,
    '无 setHeaders/removeHeaders → null'
);

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

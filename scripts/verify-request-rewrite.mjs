// 录制端请求改写离线自检:断言纯函数 globToRegExp / decideBodyType / rewritePostBody 行为正确。
// 只测「改写逻辑」这一最易出错的部分(CDP 挂载/放行属机械管线,在运行的 app 里手动观察)。
// 需先 `npm run build`(编译出 dist/main/request-interceptor.js,CommonJS);不需网络、不启 Electron。
// 用法:node scripts/verify-request-rewrite.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { globToRegExp, decideBodyType, rewritePostBody } = require('../dist/main/request-interceptor.js');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

console.log('1) globToRegExp —— CDP glob 匹配');
assert(globToRegExp('*/api/search*').test('https://x.com/api/search?q=1'), '尾部通配命中查询串');
assert(globToRegExp('*/api/search*').test('https://x.com/v2/api/search'), '前缀通配命中路径');
assert(!globToRegExp('*/api/search*').test('https://x.com/api/list'), '不匹配的路径不命中');
assert(globToRegExp('https://a.com/x?y').test('https://a.com/x1y'), '? 匹配单字符');
assert(!globToRegExp('https://a.com/x?y').test('https://a.com/xABy'), '? 不匹配多字符');
assert(globToRegExp('*/p.php').test('https://a.com/p.php') && !globToRegExp('*/p.php').test('https://a.com/pXphp'), '. 被当字面量转义');

console.log('2) decideBodyType —— 类型判定优先级');
assert(decideBodyType({ urlPattern: '*', bodyType: 'form' }, 'application/json', '{}') === 'form', '规则显式 bodyType 优先');
assert(decideBodyType({ urlPattern: '*' }, 'application/json; charset=utf-8', 'x') === 'json', 'Content-Type=json → json');
assert(decideBodyType({ urlPattern: '*' }, 'application/x-www-form-urlencoded', 'a=1') === 'form', 'Content-Type=urlencoded → form');
assert(decideBodyType({ urlPattern: '*' }, '', '  {"a":1}') === 'json', '无 CT 时按内容首字符 { 判 json');
assert(decideBodyType({ urlPattern: '*' }, '', 'a=1&b=2') === 'form', '无 CT 且非 { 开头 → form');

console.log('3) rewritePostBody —— JSON 改写');
{
    const out = rewritePostBody('{"page":1,"size":20,"debug":true}', 'json', {
        urlPattern: '*',
        set: { size: 100, keyword: '关键词' },
        remove: ['debug'],
    });
    const obj = JSON.parse(out);
    assert(obj.size === 100, 'set 覆盖数值字段 size=100');
    assert(obj.keyword === '关键词', 'set 新增字符串字段(含中文)');
    assert(obj.page === 1, '未涉及的字段保持不变');
    assert(!('debug' in obj), 'remove 删除字段 debug');
    assert(typeof obj.size === 'number', 'JSON 保留原始类型(数值不被字符串化)');
}
{
    const out = rewritePostBody('', 'json', { urlPattern: '*', set: { a: 1 } });
    assert(JSON.parse(out).a === 1, '空 body 也能 set(视为 {})');
}

console.log('4) rewritePostBody —— 表单改写');
{
    const out = rewritePostBody('page=1&size=20&debug=1', 'form', {
        urlPattern: '*',
        set: { size: 100, keyword: 'k v' },
        remove: ['debug'],
    });
    const p = new URLSearchParams(out);
    assert(p.get('size') === '100', 'set 覆盖 size=100');
    assert(p.get('keyword') === 'k v', 'set 新增字段(空格正确编码)');
    assert(p.get('page') === '1', '未涉及字段保持不变');
    assert(!p.has('debug'), 'remove 删除 debug');
}

console.log('5) rewritePostBody —— 无动作规则返回 null');
assert(rewritePostBody('a=1', 'form', { urlPattern: '*' }) === null, '无 set/remove → null(不改写)');
assert(rewritePostBody('a=1', 'form', { urlPattern: '*', set: {}, remove: [] }) === null, '空 set/remove → null');

if (failed > 0) {
    console.error(`\n自检失败:${failed} 项未通过。`);
    process.exit(1);
}
console.log('\n全部通过 ✅');

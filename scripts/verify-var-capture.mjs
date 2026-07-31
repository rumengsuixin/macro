// 「被动变量捕获(captures)+ 变量池」纯逻辑离线自检:断言
//   extractVarsFrom / extractResendVars(委托回归)/ captureWhenMet / captureNeedsBody 行为正确,
//   合并优先级(变量池 < 本次 trigger.extract)仿真,renderResendActions 端到端注入(含嵌套结构),
//   以及 loadRequestRules 对 captures 支路的归一化(缺 urlPattern/extract 丢弃、sections.captures 分闸、缺键兼容)。
// 只测纯逻辑;真实响应观察/入池/重发由(可选)E2E 覆盖。
// 需先 `npm run build`;不需网络、不启 Electron / Playwright。
// 用法:node scripts/verify-var-capture.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
    extractVarsFrom,
    extractResendVars,
    captureWhenMet,
    captureNeedsBody,
    renderResendActions,
} = require('../dist/core/request-rewrite.js');
const { loadRequestRules } = require('../dist/storage/request-rules-store.js');

let failed = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        console.error(`  ❌ ${msg}`);
        failed += 1;
    }
}

console.log('1) extractVarsFrom —— 从一组 extract 定义提取变量(与 trigger 解耦)');
{
    const headers = { 'x-goog-upload-header-scotty-resource-id': 'ACK-376chars', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ data: { uploadToken: 'tok-123', list: [1, 2, 3] }, n: 7 });
    const extract = {
        scotty: { fromHeader: 'x-goog-upload-header-scotty-resource-id' },
        caseHdr: { fromHeader: 'X-GOOG-UPLOAD-HEADER-SCOTTY-RESOURCE-ID' },
        token: { fromBody: 'data.uploadToken' },
        num: { fromBody: 'n' },
        nested: { fromBody: 'data.list' },
        missBody: { fromBody: 'data.nope', default: 'DEF' },
        missHdr: { fromHeader: 'x-absent' },
    };
    const vars = extractVarsFrom(extract, headers, body);
    assert(vars.scotty === 'ACK-376chars', 'fromHeader 取响应头值');
    assert(vars.caseHdr === 'ACK-376chars', 'fromHeader 头名大小写不敏感');
    assert(vars.token === 'tok-123', 'fromBody 点路径取值');
    assert(vars.num === '7', 'fromBody 数字 → String()「7」');
    assert(vars.nested === '[1,2,3]', 'fromBody 命中数组 → JSON.stringify');
    assert(vars.missBody === 'DEF', 'fromBody 路径缺失 → default');
    assert(vars.missHdr === '', 'fromHeader 缺失且无 default → 空串');
    // 非法 JSON → fromBody 走缺省,fromHeader 不受影响
    const bad = extractVarsFrom(extract, headers, '不是JSON{{');
    assert(bad.token === '' && bad.missBody === 'DEF' && bad.scotty === 'ACK-376chars', '响应体非 JSON → fromBody 缺省/兜底、fromHeader 正常');
    // bodyText=null
    const nul = extractVarsFrom(extract, headers, null);
    assert(nul.token === '' && nul.scotty === 'ACK-376chars', 'bodyText=null → fromBody 空、fromHeader 正常');
    // 空 extract → {}
    assert(Object.keys(extractVarsFrom({}, headers, body)).length === 0, '空 extract → 空对象');
}

console.log('2) extractResendVars —— 委托 extractVarsFrom 后行为回归(向后兼容)');
{
    const headers = { 'x-sid': 'sid-abc' };
    const body = JSON.stringify({ a: { b: 'B' } });
    const trig = { triggerUrl: '*', extract: { sid: { fromHeader: 'x-sid' }, b: { fromBody: 'a.b' } } };
    const via = extractResendVars(trig, headers, body);
    const direct = extractVarsFrom(trig.extract, headers, body);
    assert(JSON.stringify(via) === JSON.stringify(direct), 'extractResendVars 结果 === extractVarsFrom(trigger.extract,…)');
    assert(Object.keys(extractResendVars({ triggerUrl: '*' }, headers, body)).length === 0, '无 extract → 空对象(旧行为)');
}

console.log('3) captureWhenMet —— when 门槛(复用响应触发求值上下文)');
{
    const reqH = { 'x-macro': '1' };
    assert(captureWhenMet(undefined, 200, {}, null, reqH) === true, '无 when → 恒真');
    assert(captureWhenMet('   ', 200, {}, null, reqH) === true, '空白 when → 恒真');
    assert(captureWhenMet("reqHeader('x-macro') == '1'", 200, {}, null, reqH) === true, 'reqHeader 命中 → true');
    assert(captureWhenMet("reqHeader('x-macro') == '1'", 200, {}, null, { 'x-macro': '2' }) === false, 'reqHeader 不命中 → false');
    assert(captureWhenMet('status == 200', 200, {}, null, reqH) === true, 'status 命中 → true');
    assert(captureWhenMet('body.state == "done"', 200, {}, '{"state":"done"}', reqH) === true, 'body 读体命中 → true');
    assert(captureWhenMet('body.state == "done"', 200, {}, null, reqH) === false, 'body=null 短路 → false(失败即安全)');
    assert(captureWhenMet('status ===== 1', 200, {}, null, reqH) === false, '语法错 → false(失败即安全)');
    assert(captureWhenMet('process.exit(1)', 200, {}, null, reqH) === false, '逃逸(process)→ false');
}

console.log('4) captureNeedsBody —— 是否需读响应体门控');
{
    assert(captureNeedsBody({ extract: { s: { fromHeader: 'x' } } }) === false, '仅 fromHeader → 不读体');
    assert(captureNeedsBody({ extract: { s: { fromBody: 'a.b' } } }) === true, '有 fromBody → 读体');
    assert(captureNeedsBody({ extract: { s: { fromHeader: 'x' } }, when: 'body.x == 1' }) === true, 'when 引用 body → 读体');
    assert(captureNeedsBody({ extract: { s: { fromHeader: 'x' } }, when: 'text != null' }) === true, 'when 引用 text → 读体');
    assert(captureNeedsBody({ extract: { s: { fromHeader: 'x' } }, when: "reqHeader('x-macro')=='1'" }) === false, 'when 仅 reqHeader → 不读体');
}

console.log('5) 合并优先级仿真 —— 变量池 < 本次 trigger.extract(同名后者胜)');
{
    // 复刻 macro-runner handleResponseTrigger 合并点:{ ...pool, ...extractResendVars(trigger,…) }
    const pool = { scottyResourceId: 'from-pool', shared: 'pool-val' };
    // 情形 A:trigger 无 extract → 注入池值
    const trigNone = { triggerUrl: '*' };
    const varsA = { ...pool, ...extractResendVars(trigNone, {}, null) };
    assert(varsA.scottyResourceId === 'from-pool', '池有变量、trigger 无 extract → 注入池值');
    // 情形 B:trigger.extract 同名 → 覆盖池值
    const trigOverride = { triggerUrl: '*', extract: { shared: { fromHeader: 'x-shared' } } };
    const varsB = { ...pool, ...extractResendVars(trigOverride, { 'x-shared': 'trigger-val' }, null) };
    assert(varsB.shared === 'trigger-val', 'trigger.extract 同名 → 覆盖池值');
    assert(varsB.scottyResourceId === 'from-pool', '非同名变量仍取池值');
    // 情形 C:两者都无该变量 → 未定义(渲染时兜底为空串,见第 6 节)
    const varsC = { ...{}, ...extractResendVars(trigNone, {}, null) };
    assert(varsC.scottyResourceId === undefined, '池空、trigger 无 → 变量缺失(undefined)');
}

console.log('6) renderResendActions 端到端 —— 嵌套 resourceId.scottyResourceId.id 注入 + 缺失渲染空串');
{
    const rr = {
        urlPattern: '*/createvideo*',
        setHeaders: { 'x-macro': '3' },
        set: { resourceId: { scottyResourceId: { id: '{{scottyResourceId}}' } }, title: 'keep' },
    };
    // 命中:池提供 scottyResourceId
    const eff = renderResendActions(rr, { scottyResourceId: 'ACK-real-id' });
    assert(eff.set.resourceId.scottyResourceId.id === 'ACK-real-id', '深层嵌套 id 注入真实值');
    assert(eff.set.title === 'keep' && eff.setHeaders['x-macro'] === '3', '非模板字段原样保留');
    assert(rr.set.resourceId.scottyResourceId.id === '{{scottyResourceId}}', '原规则未被就地修改(返回副本)');
    // 缺失:变量未就绪 → 渲染空串(不发字面占位符)
    const effMiss = renderResendActions(rr, { other: 'x' });
    assert(effMiss.set.resourceId.scottyResourceId.id === '', '变量缺失 → 渲染空串(不发字面 {{}})');
}

console.log('7) loadRequestRules —— captures 支路归一化');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varcap-'));
    const write = (obj) => {
        const fp = path.join(dir, `rules-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(fp, JSON.stringify(obj), 'utf-8');
        return fp;
    };
    // 有效 capture 保留;缺 urlPattern / 缺 extract 的丢弃
    const cfg1 = loadRequestRules(write({
        enabled: true,
        rules: [],
        captures: [
            { urlPattern: '*/start*', when: "reqHeader('x-macro')=='1'", extract: { scotty: { fromHeader: 'x-scotty' } } },
            { when: 'true', extract: { a: { fromHeader: 'x' } } }, // 缺 urlPattern → 丢
            { urlPattern: '*/noextract*' }, // 缺 extract → 丢
            { urlPattern: '*/emptyextract*', extract: { bad: { nothing: 1 } } }, // extract 归一化后为空 → 丢
        ],
    }));
    assert(Array.isArray(cfg1.captures) && cfg1.captures.length === 1, '4 条只保留 1 条有效(缺 urlPattern/extract 丢弃)');
    assert(cfg1.captures[0].urlPattern === '*/start*' && cfg1.captures[0].when && cfg1.captures[0].extract.scotty.fromHeader === 'x-scotty', '有效 capture 字段完整保留(urlPattern/when/extract)');

    // sections.captures:false 分闸(仍归一化保留数组,由运行端 sectionEnabled 决定是否生效)
    const cfg2 = loadRequestRules(write({
        enabled: true,
        rules: [],
        sections: { captures: false },
        captures: [{ urlPattern: '*/start*', extract: { s: { fromHeader: 'x' } } }],
    }));
    assert(cfg2.sections.captures === false, 'sections.captures:false 被归一化保留(运行端据此分闸)');
    assert(cfg2.sections.rules === true && cfg2.sections.resends === true, '其它支路缺键 → 默认 true(白名单)');

    // 缺 captures 键 → 向后兼容(无该字段)
    const cfg3 = loadRequestRules(write({ enabled: true, rules: [] }));
    assert(cfg3.captures === undefined, '缺 captures 键 → 不含该字段(向后兼容)');
    assert(cfg3.sections.captures === true, 'sections 缺 captures 键 → 默认 true');

    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failed === 0) {
    console.log('✅ 全部通过');
    process.exit(0);
} else {
    console.error(`❌ ${failed} 项断言失败`);
    process.exit(1);
}

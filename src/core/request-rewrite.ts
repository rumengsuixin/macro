// 请求改写纯逻辑(零 IO / 零 Electron 依赖):供录制端(CDP Fetch)与回放端(Playwright route)共用。
//
// 从原录制端 request-interceptor.ts 抽出——两端用同一套 glob 匹配与 body 改写函数,
// 保证「录的什么、放的什么」逐字一致(尤其 CDP glob 方言:回放端也用 globToRegExp 判断,
// 不走 Playwright 自带的 route glob,避免命中集漂移)。
import type {
    RequestRule,
    ResponseHeaderRule,
    RequestHeaderRule,
    ResendRule,
    ResendResponseTrigger,
} from './macro-types';

/** 把 CDP glob(`*` 任意串、`?` 单字符、`\` 转义)编译为整串匹配的正则 */
export function globToRegExp(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i += 1) {
        const c = glob[i];
        if (c === '\\' && i + 1 < glob.length) {
            out += glob[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            i += 1;
        } else if (c === '*') {
            out += '.*';
        } else if (c === '?') {
            out += '.';
        } else {
            out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

/**
 * 找到首个匹配该 URL 的规则;无则返回 null。非法 pattern 跳过。
 * 泛型:只依赖 urlPattern,故改写规则(RequestRule)与重发规则(ResendRule)都可用,返回原类型。
 */
export function matchRule<T extends { urlPattern: string }>(rules: T[], url: string): T | null {
    for (const rule of rules) {
        try {
            if (globToRegExp(rule.urlPattern).test(url)) {
                return rule;
            }
        } catch {
            /* 非法 pattern 跳过 */
        }
    }
    return null;
}

/** 判定 body 类型:规则显式 > Content-Type 嗅探 > 内容嗅探(兜底 form) */
export function decideBodyType(
    rule: RequestRule,
    contentType: string,
    body: string
): 'json' | 'form' {
    if (rule.bodyType) {
        return rule.bodyType;
    }
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('application/json')) {
        return 'json';
    }
    if (ct.includes('x-www-form-urlencoded')) {
        return 'form';
    }
    return body.trim().startsWith('{') ? 'json' : 'form';
}

/**
 * 纯函数:按规则改写 body,返回新 body 字符串;无 set/append/remove 动作返回 null。
 * 不做任何 IO,便于离线自检;解析失败(如非法 JSON)会抛错,由调用方兜底放行。
 */
export function rewritePostBody(
    original: string,
    bodyType: 'json' | 'form',
    rule: RequestRule
): string | null {
    const setEntries = rule.set ? Object.entries(rule.set) : [];
    const appendEntries = rule.append ? Object.entries(rule.append) : [];
    const removeKeys = rule.remove ?? [];
    if (setEntries.length === 0 && appendEntries.length === 0 && removeKeys.length === 0) {
        return null; // 规则没定义任何改写动作
    }
    // 执行顺序:set(整体覆盖)→ append(追加到数组)→ remove(删除)
    if (bodyType === 'json') {
        const obj = original ? (JSON.parse(original) as Record<string, unknown>) : {};
        for (const [k, v] of setEntries) {
            obj[k] = v;
        }
        for (const [k, v] of appendEntries) {
            appendJsonField(obj, k, v);
        }
        for (const k of removeKeys) {
            delete obj[k];
        }
        return JSON.stringify(obj);
    }
    // form-urlencoded
    const params = new URLSearchParams(original);
    for (const [k, v] of setEntries) {
        params.set(k, String(v));
    }
    for (const [k, v] of appendEntries) {
        appendFormField(params, k, v);
    }
    for (const k of removeKeys) {
        params.delete(k);
    }
    return params.toString();
}

/**
 * 往 JSON 对象的顶层字段追加(去重):
 * - value 为数组则逐元素追加,否则追加单个值;
 * - obj[key] 不存在→新建 []、原为数组→在其上追加、原为单值→先包成 [原值];
 * - 用 JSON 序列化比对去重,已存在的值跳过(基本类型/对象/数组均适用)。
 */
function appendJsonField(obj: Record<string, unknown>, key: string, value: unknown): void {
    const items = Array.isArray(value) ? value : [value];
    const current = obj[key];
    const base: unknown[] = Array.isArray(current)
        ? current.slice()
        : current === undefined
          ? []
          : [current];
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    for (const item of items) {
        const sig = JSON.stringify(item);
        if (!seen.has(sig)) {
            base.push(item);
            seen.add(sig);
        }
    }
    obj[key] = base;
}

/**
 * 往 form 参数追加为重复参数(去重):
 * - value 为数组则逐元素,否则单个;各元素 String 化;
 * - 已存在同名同值的参数跳过(按当前该 key 的全部取值去重)。
 */
function appendFormField(params: URLSearchParams, key: string, value: unknown): void {
    const items = Array.isArray(value) ? value : [value];
    const existing = new Set(params.getAll(key));
    for (const item of items) {
        const s = String(item);
        if (!existing.has(s)) {
            params.append(key, s);
            existing.add(s);
        }
    }
}

/** 从头对象里不分大小写取值(headers 键名大小写不敏感) */
export function headerValue(headers: Record<string, string>, name: string): string {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers || {})) {
        if (k.toLowerCase() === lower) {
            return v;
        }
    }
    return '';
}

// ── 「响应头条件改写」支路的共享纯逻辑(录制端 CDP 与回放端 Playwright 共用) ──

/**
 * 判断一组响应头是否**全部相等**(AND,头名大小写不敏感、值精确相等);expected 缺省 → 恒真。
 * 被 responseConditionMet(响应头改写 when)与 responseTriggerMet(重发响应触发 headers)共用。
 */
export function headersAllEqual(
    headers: Record<string, string>,
    expected?: Record<string, string>
): boolean {
    if (!expected) {
        return true;
    }
    for (const [name, val] of Object.entries(expected)) {
        if (headerValue(headers, name) !== val) {
            return false;
        }
    }
    return true;
}

/**
 * 判断响应头是否满足规则的 when 条件:when 里所有头需**全部相等**(AND,头名大小写不敏感);
 * when 缺省 → 恒真(无条件)。条件读的是**响应头**,复用 headerValue 大小写不敏感取值。
 */
export function responseConditionMet(
    headers: Record<string, string>,
    rule: ResponseHeaderRule
): boolean {
    return headersAllEqual(headers, rule.when);
}

/**
 * 判断请求头是否满足规则的 when 条件:when 里所有头需**全部相等**(AND,头名大小写不敏感);
 * when 缺省 → 恒真(无条件)。读的是**原始请求头**(改写前),复用 headersAllEqual。
 */
export function requestConditionMet(
    headers: Record<string, string>,
    rule: RequestHeaderRule
): boolean {
    return headersAllEqual(headers, rule.when);
}

// ── 「重发型」响应条件触发的共享纯逻辑(仅回放端调用) ──

/** 按点路径(`a.b.c`)逐层从 JSON 对象取值;遇非对象/缺失返回 undefined */
export function getJsonByPath(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
        if (cur === null || typeof cur !== 'object') {
            return undefined;
        }
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

/**
 * 该触发条件是否需要读响应体,用于门控异步读体。三种情况需要:
 * 有 bodyJson 子条件、有 bodyContains 子条件、或 extract 里存在任一 fromBody 取值源(要从响应体取值注入)。
 */
export function triggerNeedsBody(trigger: ResendResponseTrigger): boolean {
    return (
        (!!trigger.bodyJson && Object.keys(trigger.bodyJson).length > 0) ||
        (!!trigger.bodyContains && trigger.bodyContains.length > 0) ||
        (!!trigger.extract &&
            Object.values(trigger.extract).some((s) => s.fromBody !== undefined))
    );
}

/**
 * 判断一条响应是否满足重发的响应触发条件:status / headers / requestHeaders / bodyContains / bodyJson 各组**全部满足(AND)**。
 * - status:给定则须严格等值;
 * - headers:响应头,复用 headersAllEqual(AND,头名大小写不敏感);
 * - requestHeaders:triggerUrl 那条**请求**的头,复用 headersAllEqual(AND,头名大小写不敏感);缺省=不校验;
 * - bodyContains:bodyText 为 null → 不命中;否则每个子串都须 includes(AND,大小写敏感);不解析 JSON;
 * - bodyJson:bodyText 为 null 或 JSON.parse 失败 → 不命中;否则逐点路径 String(取值)===期望值(AND)。
 * 各组均可选;都不给 → 恒真(该 URL 任意响应都触发)。requestHeaders 缺省 {} 便于纯逻辑/离线自检按需省略。
 */
export function responseTriggerMet(
    trigger: ResendResponseTrigger,
    status: number,
    headers: Record<string, string>,
    bodyText: string | null,
    requestHeaders: Record<string, string> = {}
): boolean {
    if (trigger.status !== undefined && status !== trigger.status) {
        return false;
    }
    if (!headersAllEqual(headers, trigger.headers)) {
        return false;
    }
    // requestHeaders:判 triggerUrl 请求侧的头(便宜、无需读体,放在响应体读取前提前短路)
    if (!headersAllEqual(requestHeaders, trigger.requestHeaders)) {
        return false;
    }
    // bodyContains 先判(纯子串,免不必要的 JSON.parse)
    if (trigger.bodyContains && trigger.bodyContains.length > 0) {
        if (bodyText === null) {
            return false;
        }
        for (const sub of trigger.bodyContains) {
            if (!bodyText.includes(sub)) {
                return false;
            }
        }
    }
    if (trigger.bodyJson && Object.keys(trigger.bodyJson).length > 0) {
        if (bodyText === null) {
            return false;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(bodyText);
        } catch {
            return false;
        }
        for (const [path, expected] of Object.entries(trigger.bodyJson)) {
            const val = getJsonByPath(parsed, path);
            if (val === undefined || String(val) !== expected) {
                return false;
            }
        }
    }
    return true;
}

/** 从子串里取最长的 [A-Za-z0-9_] 关键字(用于在响应体里定位实际片段);无则返回 '' */
function longestWordToken(s: string): string {
    const m = s.match(/[A-Za-z0-9_]+/g);
    if (!m) {
        return '';
    }
    return m.reduce((a, b) => (b.length > a.length ? b : a), '');
}

/**
 * 解释「响应触发为什么没命中」:与 responseTriggerMet 同判定顺序,返回 null 表示其实满足(不该报)。
 * 否则返回 { signature, message }:
 *  - message:人读原因(含响应体实际片段),给日志用;
 *  - signature:稳定去重键(不含实际片段),调用端按它限流,同一失败模式只打一次。
 * 只做展示性截断(仅日志可读性),不参与任何数据处理。
 */
export function explainResponseTriggerMiss(
    trigger: ResendResponseTrigger,
    status: number,
    headers: Record<string, string>,
    bodyText: string | null,
    requestHeaders: Record<string, string> = {}
): { signature: string; message: string } | null {
    const parts: string[] = [];
    const sig: string[] = [];

    if (trigger.status !== undefined && status !== trigger.status) {
        parts.push(`status 期望 ${trigger.status} 实际 ${status}`);
        sig.push(`status:${trigger.status}!=${status}`);
    }

    if (trigger.headers) {
        for (const [name, expected] of Object.entries(trigger.headers)) {
            const actual = headerValue(headers, name);
            if (actual !== expected) {
                parts.push(`响应头 ${name} 期望 "${expected}" 实际 "${actual}"`);
                sig.push(`h:${name.toLowerCase()}`);
            }
        }
    }

    if (trigger.requestHeaders) {
        for (const [name, expected] of Object.entries(trigger.requestHeaders)) {
            const actual = headerValue(requestHeaders, name);
            if (actual !== expected) {
                parts.push(`请求头 ${name} 期望 "${expected}" 实际 "${actual}"`);
                sig.push(`rh:${name.toLowerCase()}`);
            }
        }
    }

    if (trigger.bodyContains && trigger.bodyContains.length > 0) {
        if (bodyText === null) {
            parts.push('响应体读不到(可能已中断)');
            sig.push('bc:null');
        } else {
            const bodyNoWs = bodyText.replace(/\s+/g, '');
            for (const sub of trigger.bodyContains) {
                if (bodyText.includes(sub)) {
                    continue;
                }
                if (bodyNoWs.includes(sub.replace(/\s+/g, ''))) {
                    parts.push(
                        `bodyContains 缺 [${sub}](仅空白差异,原文里冒号后可能有空格,请按原文写)`
                    );
                    sig.push(`bc:ws:${sub}`);
                } else {
                    const key = longestWordToken(sub);
                    const at = key ? bodyText.indexOf(key) : -1;
                    if (at >= 0) {
                        const snippet = bodyText.slice(Math.max(0, at - 30), at + key.length + 40);
                        parts.push(`bodyContains 缺 [${sub}];响应体实际: …${snippet}…`);
                    } else if (key) {
                        parts.push(`bodyContains 缺 [${sub}];关键字 "${key}" 未出现在响应体`);
                    } else {
                        parts.push(`bodyContains 缺 [${sub}]`);
                    }
                    sig.push(`bc:miss:${sub}`);
                }
            }
        }
    }

    if (trigger.bodyJson && Object.keys(trigger.bodyJson).length > 0) {
        if (bodyText === null) {
            parts.push('响应体读不到(可能已中断)');
            sig.push('bj:null');
        } else {
            let parsed: unknown;
            try {
                parsed = JSON.parse(bodyText);
            } catch {
                parts.push('bodyJson 条件:响应体不是合法 JSON');
                sig.push('bj:parse');
                parsed = undefined;
            }
            if (parsed !== undefined) {
                for (const [path, expected] of Object.entries(trigger.bodyJson)) {
                    const val = getJsonByPath(parsed, path);
                    if (val === undefined) {
                        parts.push(`bodyJson 路径 ${path} 不存在`);
                        sig.push(`bj:missing:${path}`);
                    } else if (String(val) !== expected) {
                        parts.push(`bodyJson 路径 ${path} 期望 "${expected}" 实际 "${String(val)}"`);
                        sig.push(`bj:ne:${path}`);
                    }
                }
            }
        }
    }

    if (parts.length === 0) {
        return null; // 其实满足,不该报
    }
    return { signature: sig.join('|'), message: parts.join(';') };
}

// ── 「重发型」响应值提取 → 占位符注入的共享纯逻辑(仅回放端调用) ──

/**
 * 从触发响应提取命名变量:遍历 trigger.extract,每个变量按 fromBody(响应体点路径)或 fromHeader(响应头名)取值。
 * - fromBody:bodyText 只 JSON.parse 一次(复用),按点路径取值;命中对象/数组→JSON.stringify,基本类型→String();
 * - fromHeader:headerValue 大小写不敏感取值;
 * - 两者都取不到(缺失/读不到体/路径不存在/头为空)→ 用该源 default(缺省空串)。
 * 无 extract → 返回 {}。纯逻辑、零 IO,便于离线自检。
 */
export function extractResendVars(
    trigger: ResendResponseTrigger,
    headers: Record<string, string>,
    bodyText: string | null
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!trigger.extract) {
        return out;
    }
    let parsed: unknown;
    let parsedTried = false;
    for (const [name, src] of Object.entries(trigger.extract)) {
        let val: string | undefined;
        if (src.fromBody !== undefined) {
            if (!parsedTried) {
                parsedTried = true;
                try {
                    parsed = bodyText ? JSON.parse(bodyText) : undefined;
                } catch {
                    parsed = undefined; // 响应体非合法 JSON → fromBody 取不到,走 default
                }
            }
            const v = parsed !== undefined ? getJsonByPath(parsed, src.fromBody) : undefined;
            if (v !== undefined && v !== null) {
                val = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
        } else if (src.fromHeader !== undefined) {
            const hv = headerValue(headers, src.fromHeader);
            if (hv) {
                val = hv;
            }
        }
        out[name] = val !== undefined ? val : src.default ?? '';
    }
    return out;
}

/** 占位符正则:`{{name}}`(允许两侧空白),变量名限 [A-Za-z0-9_] */
const RESEND_VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** 把字符串里的 `{{name}}` 占位符替换为 vars[name];未知变量渲染为空串 */
export function renderTemplate(value: string, vars: Record<string, string>): string {
    return value.replace(RESEND_VAR_RE, (_m, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : ''
    );
}

/** 深度渲染任意 JSON 值里的字符串叶子(递归对象/数组);非字符串原样返回 */
function renderDeep(value: unknown, vars: Record<string, string>): unknown {
    if (typeof value === 'string') {
        return renderTemplate(value, vars);
    }
    if (Array.isArray(value)) {
        return value.map((v) => renderDeep(v, vars));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = renderDeep(v, vars);
        }
        return out;
    }
    return value;
}

/**
 * 用提取到的变量渲染一条重发规则的动作字段(set/append 的字符串叶子、setHeaders 的值、setUrl 模板),返回渲染后的副本。
 * vars 为空 → 直接返回原规则(不拷贝、不动;静态 setUrl 无占位符时原样透传即正确)。
 * 其余字段(replaceWithFile/repeat/delayMs/bodyType…)原样保留。
 * 渲染后照旧交给现有 rewritePostBody / buildResendHeaders,两者无需改动。
 */
export function renderResendActions(rr: ResendRule, vars: Record<string, string>): ResendRule {
    if (!vars || Object.keys(vars).length === 0) {
        return rr;
    }
    const out: ResendRule = { ...rr };
    if (rr.set) {
        out.set = renderDeep(rr.set, vars) as Record<string, unknown>;
    }
    if (rr.append) {
        out.append = renderDeep(rr.append, vars) as Record<string, unknown>;
    }
    if (rr.setHeaders) {
        const sh: Record<string, string> = {};
        for (const [k, v] of Object.entries(rr.setHeaders)) {
            sh[k] = renderTemplate(v, vars);
        }
        out.setHeaders = sh;
    }
    if (rr.setUrl) {
        out.setUrl = renderTemplate(rr.setUrl, vars);
    }
    return out;
}

/**
 * 回放端(Playwright)用:按规则改写响应头 Record,返回新 Record;
 * 无 setHeaders/removeHeaders 动作、或 when 条件不满足 → 返回 null(表示不改)。
 * 大小写不敏感:setHeaders/removeHeaders 命中的键先从原 headers 里删掉(不论大小写),
 * 再写入 setHeaders 的新值,保证不出现大小写不同的重复键。
 */
export function rewriteResponseHeaderRecord(
    headers: Record<string, string>,
    rule: ResponseHeaderRule
): Record<string, string> | null {
    const setEntries = rule.setHeaders ? Object.entries(rule.setHeaders) : [];
    const removeNames = rule.removeHeaders ?? [];
    if (setEntries.length === 0 && removeNames.length === 0) {
        return null; // 规则没定义任何动作
    }
    if (!responseConditionMet(headers, rule)) {
        return null; // 条件不满足,不改
    }
    const dropLower = new Set(
        [...removeNames, ...setEntries.map(([k]) => k)].map((n) => n.toLowerCase())
    );
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
        if (!dropLower.has(k.toLowerCase())) {
            out[k] = v;
        }
    }
    for (const [k, v] of setEntries) {
        out[k] = String(v);
    }
    return out;
}

/**
 * 回放端(Playwright)用:按规则改写**请求头** Record,返回新 Record(全量,供 route.continue({headers})
 * / route.fetch({headers}) 整体替换请求头);无 setHeaders/removeHeaders 动作、或 when 不满足 → 返回 null。
 * 大小写不敏感:命中键先删(不论大小写)再写新值,不产生大小写重复键。
 * **与响应头版唯一不同**:输出统一剥离 content-length —— 同一请求的 body 可能被 rules 改写,
 * 让浏览器/网络栈按真实 body 重算长度,避免传入过期 content-length 造成「声明长度≠实际 body」。
 */
export function rewriteRequestHeaderRecord(
    headers: Record<string, string>,
    rule: RequestHeaderRule
): Record<string, string> | null {
    const setEntries = rule.setHeaders ? Object.entries(rule.setHeaders) : [];
    const removeNames = rule.removeHeaders ?? [];
    if (setEntries.length === 0 && removeNames.length === 0) {
        return null; // 规则没定义任何动作
    }
    if (!requestConditionMet(headers, rule)) {
        return null; // 条件不满足,不改
    }
    // content-length 一并剥离(只删不加):body 若被 rules 改写,旧长度会与新 body 不符,交给网络栈重算
    const dropLower = new Set(
        [...removeNames, ...setEntries.map(([k]) => k), 'content-length'].map((n) =>
            n.toLowerCase()
        )
    );
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers || {})) {
        if (!dropLower.has(k.toLowerCase())) {
            out[k] = v;
        }
    }
    for (const [k, v] of setEntries) {
        out[k] = String(v);
    }
    return out;
}

/**
 * 录制端(CDP)用:入参是 CDP 的 HeaderEntry[](name/value,允许重复名如多个 set-cookie)。
 * 逻辑同 rewriteResponseHeaderRecord,但保留**数组形态**——仅删除/覆盖 remove/set 名单内的头,
 * 名单外的头(含合法重复头)原样保留。返回新数组;无动作/条件不满足 → 返回 null。
 */
export function rewriteResponseHeaderEntries(
    entries: Array<{ name: string; value: string }>,
    rule: ResponseHeaderRule
): Array<{ name: string; value: string }> | null {
    const setEntries = rule.setHeaders ? Object.entries(rule.setHeaders) : [];
    const removeNames = rule.removeHeaders ?? [];
    if (setEntries.length === 0 && removeNames.length === 0) {
        return null;
    }
    // 由 entries 拼一个 Record 判条件(重复名时后者覆盖,判条件足够)
    const asRecord: Record<string, string> = {};
    for (const e of entries || []) {
        asRecord[e.name] = e.value;
    }
    if (!responseConditionMet(asRecord, rule)) {
        return null;
    }
    const dropLower = new Set(
        [...removeNames, ...setEntries.map(([k]) => k)].map((n) => n.toLowerCase())
    );
    const out = (entries || []).filter((e) => !dropLower.has(e.name.toLowerCase()));
    for (const [k, v] of setEntries) {
        out.push({ name: k, value: String(v) });
    }
    return out;
}

// ── 「重发型」拦截支路的共享纯逻辑(录制端 CDP 与回放端 Playwright 共用) ──

/**
 * 重发请求的标记头名:带此头即为本工具主动发出的重发请求。
 * 头**值 = 该请求在重发链上的跳数(hop)**:真实浏览器请求不带此头(视为第 0 跳),
 * 第 k 次重发带值 "k"。用于两件事:
 *  - 是否重发来源(isResendOrigin):route 改写 / dump / 请求捕获三处据此「不再加工重发请求」;
 *  - 链式熔断(resendHop + 上限判定):响应触发放开对重发响应的观察,但按跳数封顶防无限。
 */
export const RESEND_MARK_HEADER = 'x-macro-resend';

/** 判断一个请求是否是我们自己发出的重发请求(大小写不敏感判标记头存在与否) */
export function isResendOrigin(headers: Record<string, string>): boolean {
    return headerValue(headers, RESEND_MARK_HEADER) !== '';
}

/**
 * 读取一个请求在重发链上的跳数:标记头值 parseInt。
 * 缺失 / 非法 / 负数一律归 0(真实浏览器请求即第 0 跳)。供响应触发的链式熔断判定用。
 */
export function resendHop(headers: Record<string, string>): number {
    const raw = headerValue(headers, RESEND_MARK_HEADER);
    if (!raw) {
        return 0;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 组装重发请求头:拷贝触发请求头(保留 Authorization / X-CSRF-Token 等业务头),
 * 排除浏览器会自置或禁止手动设置的头(host/content-length/connection/cookie/origin/referer/
 * content-type——cookie 由发送端凭据自动带,content-type 统一用参数值避免大小写重复键),
 * 补 Content-Type,再应用用户 override(setHeaders 覆盖 / removeHeaders 删除,均大小写不敏感),
 * 最后补重发标记头。标记头放在最后无条件写入,确保不被 override 破坏(防递归核心)。
 * hop = 本次重发在链上的跳数(标记头的值);缺省 1(由真实请求点燃的第一跳)。链式触发时由调用方传
 * 「触发源跳数 + 1」,配合 resendHop + 上限判定实现「支持连环、按跳数封顶防无限」。
 */
export function buildResendHeaders(
    triggerHeaders: Record<string, string>,
    contentType: string,
    overrides?: { setHeaders?: Record<string, string>; removeHeaders?: string[] },
    hop = 1
): Record<string, string> {
    const forbidden = new Set([
        'host',
        'content-length',
        'connection',
        'cookie',
        'origin',
        'referer',
        'content-type',
    ]);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(triggerHeaders || {})) {
        if (!forbidden.has(k.toLowerCase())) {
            out[k] = v;
        }
    }
    if (contentType) {
        out['Content-Type'] = contentType;
    }
    // 用户请求头改写:大小写不敏感,先删掉 remove∪set 命中的键(允许覆盖 Content-Type),再写 set 新值。
    // 借鉴 rewriteResponseHeaderRecord 的 dropLower 写法,保证不出现大小写不同的重复键。
    if (overrides) {
        const setEntries = overrides.setHeaders ? Object.entries(overrides.setHeaders) : [];
        const removeNames = overrides.removeHeaders ?? [];
        if (setEntries.length || removeNames.length) {
            const dropLower = new Set(
                [...removeNames, ...setEntries.map(([k]) => k)].map((n) => n.toLowerCase())
            );
            for (const k of Object.keys(out)) {
                if (dropLower.has(k.toLowerCase())) {
                    delete out[k];
                }
            }
            for (const [k, v] of setEntries) {
                out[k] = String(v);
            }
        }
    }
    // 放最后,保护标记不被 override 覆盖/删除;值=跳数(>=1),供链式熔断按 resendHop 判定
    out[RESEND_MARK_HEADER] = String(hop >= 1 ? Math.floor(hop) : 1);
    return out;
}

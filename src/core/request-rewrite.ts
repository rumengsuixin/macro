// 请求改写纯逻辑(零 IO / 零 Electron 依赖):供录制端(CDP Fetch)与回放端(Playwright route)共用。
//
// 从原录制端 request-interceptor.ts 抽出——两端用同一套 glob 匹配与 body 改写函数,
// 保证「录的什么、放的什么」逐字一致(尤其 CDP glob 方言:回放端也用 globToRegExp 判断,
// 不走 Playwright 自带的 route glob,避免命中集漂移)。
import type { RequestRule, ResponseHeaderRule, ResendResponseTrigger } from './macro-types';

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

/** 该触发条件是否需要读响应体(有 bodyJson 子条件才需要),用于门控异步读体 */
export function triggerNeedsBody(trigger: ResendResponseTrigger): boolean {
    return !!trigger.bodyJson && Object.keys(trigger.bodyJson).length > 0;
}

/**
 * 判断一条响应是否满足重发的响应触发条件:status / headers / bodyJson 三组**全部满足(AND)**。
 * - status:给定则须严格等值;
 * - headers:复用 headersAllEqual(AND,头名大小写不敏感);
 * - bodyJson:bodyText 为 null 或 JSON.parse 失败 → 不命中;否则逐点路径 String(取值)===期望值(AND)。
 * 三组均可选;都不给 → 恒真(该 URL 任意响应都触发)。
 */
export function responseTriggerMet(
    trigger: ResendResponseTrigger,
    status: number,
    headers: Record<string, string>,
    bodyText: string | null
): boolean {
    if (trigger.status !== undefined && status !== trigger.status) {
        return false;
    }
    if (!headersAllEqual(headers, trigger.headers)) {
        return false;
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

/** 重发请求的标记头名:带此头即为本工具主动发出的重发请求,观察路径识别到应整体跳过(防递归自触发) */
export const RESEND_MARK_HEADER = 'x-macro-resend';

/** 判断一个请求是否是我们自己发出的重发请求(大小写不敏感判标记头) */
export function isResendOrigin(headers: Record<string, string>): boolean {
    return headerValue(headers, RESEND_MARK_HEADER) !== '';
}

/**
 * 计算重发目标 URL:
 * - targetUrl 空 → 用触发请求 URL 本身;
 * - targetUrl 相对 → 相对触发请求 URL 绝对化;
 * - 解析失败 → 原样返回 targetUrl(交由发送端处理)。
 */
export function resolveResendTarget(targetUrl: string | undefined, triggerUrl: string): string {
    if (!targetUrl || !targetUrl.trim()) {
        return triggerUrl;
    }
    try {
        return new URL(targetUrl, triggerUrl).toString();
    } catch {
        return targetUrl;
    }
}

/**
 * 组装重发请求头:拷贝触发请求头(保留 Authorization / X-CSRF-Token 等业务头),
 * 排除浏览器会自置或禁止手动设置的头(host/content-length/connection/cookie/origin/referer/
 * content-type——cookie 由发送端凭据自动带,content-type 统一用参数值避免大小写重复键),
 * 补 Content-Type,再应用用户 override(setHeaders 覆盖 / removeHeaders 删除,均大小写不敏感),
 * 最后补重发标记头。标记头放在最后无条件写入,确保不被 override 破坏(防递归核心)。
 */
export function buildResendHeaders(
    triggerHeaders: Record<string, string>,
    contentType: string,
    overrides?: { setHeaders?: Record<string, string>; removeHeaders?: string[] }
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
    out[RESEND_MARK_HEADER] = '1'; // 放最后,保护防递归标记不被 override 覆盖/删除
    return out;
}

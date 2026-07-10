// 请求改写纯逻辑(零 IO / 零 Electron 依赖):供录制端(CDP Fetch)与回放端(Playwright route)共用。
//
// 从原录制端 request-interceptor.ts 抽出——两端用同一套 glob 匹配与 body 改写函数,
// 保证「录的什么、放的什么」逐字一致(尤其 CDP glob 方言:回放端也用 globToRegExp 判断,
// 不走 Playwright 自带的 route glob,避免命中集漂移)。
import type { RequestRule } from './macro-types';

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

/** 找到首个匹配该 URL 的规则;无则返回 null。非法 pattern 跳过。 */
export function matchRule(rules: RequestRule[], url: string): RequestRule | null {
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

// 录制端请求改写规则存储:以 JSON 文件保存 / 加载 RequestRulesConfig。
// 首次不存在时自动生成 inert 模板(enabled=false),既安全又自文档化。
import fs from 'node:fs';
import type {
    RequestRule,
    ResendRule,
    ResendResponseTrigger,
    ResendVarSource,
    ResponseHeaderRule,
    RequestHeaderRule,
    BlockRule,
    DumpRule,
    BodyReplaceRule,
    BodySaveRule,
    RequestRulesConfig,
    RequestSectionToggles,
    TimelineRecordConfig,
    JsHookConfig,
    JsHookRule,
} from '../core/macro-types';

/** 支路级分闸的默认值:全部启用(缺省 = 开)。 */
function defaultSections(): Required<RequestSectionToggles> {
    return {
        rules: true,
        resends: true,
        responseRules: true,
        requestHeaderRules: true,
        blocks: true,
        dumps: true,
        bodyReplaces: true,
    };
}

/**
 * 归一化「支路级分闸」:返回全 7 键对象,默认全 true,仅当 raw 里对应键是显式布尔时才覆盖。
 * 白名单式——忽略未知键 / 非布尔值。缺 raw / raw 非对象 → 全 true(向后兼容)。
 */
function normalizeSections(raw: unknown): Required<RequestSectionToggles> {
    const out = defaultSections();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const r = raw as Record<string, unknown>;
        for (const k of Object.keys(out) as (keyof RequestSectionToggles)[]) {
            if (typeof r[k] === 'boolean') {
                out[k] = r[k] as boolean;
            }
        }
    }
    return out;
}

/** 空配置:不启用、无规则(加载失败或字段缺失时的兜底) */
function emptyConfig(): RequestRulesConfig {
    return { enabled: false, rules: [], sections: defaultSections() };
}

/**
 * inert 模板:默认关闭 + 一条示例规则,供用户照着改。
 * 写成合法 JSON(JSON 无注释),字段名即说明。
 */
function templateConfig(): RequestRulesConfig {
    return {
        enabled: false,
        // sections:「支路级分闸」。enabled 是总闸,这里逐支路再启停(两者 AND)。缺某键 = 该支路启用。
        // 想临时只关某一支路(如重发)而保留其规则、又不影响其它支路,把对应键设为 false 即可。
        // record 支路不在此列——它用自己的 record.enabled(独立于 enabled 与 sections)。
        sections: {
            rules: true,
            resends: true,
            responseRules: true,
            requestHeaderRules: true,
            blocks: true,
            dumps: true,
            bodyReplaces: true,
        },
        rules: [
            {
                urlPattern: '*/api/example*',
                bodyType: 'json',
                // set:整体覆盖顶层字段。数组值直接写真 JSON 数组(勿加引号),会保留为数组
                set: { pageSize: 100, keyword: '替换成你要的值', videoIds: ['id-1', 'id-2'] },
                // append:往顶层数组字段追加(字段不存在则新建,已存在的值去重)
                append: { videoIds: ['要追加的-id'] },
                remove: [],
            },
        ],
        // resends:「重发型」支路(受 enabled 总开关管)。命中 urlPattern 的 POST 后,延时 delayMs
        // 取原 body 改参(set/append/remove),主动重发一个新请求;repeat 次、间隔 intervalMs。
        // 重发请求带 x-macro-resend 标记头防递归。默认示例仅占位说明,enabled=false 时不触发。
        // 某条 resends 项还可配 replaceWithFile=本地文件绝对路径,整体用文件字节作重发体(忽略 set/append/remove)。
        // 某条 resends 项还可配 responseTrigger(仅回放端):改由**响应**触发——回放中捕获命中 urlPattern 的请求,
        // 当 responseTrigger.triggerUrl 的响应满足 status/headers/bodyJson(点路径→值)条件(AND)时,重发捕获的请求。
        // 即「监听 triggerUrl 的响应 → 重发 urlPattern 捕获的请求」(见第 2 条示例)。triggerUrl 必填。
        resends: [
            {
                urlPattern: '*/api/trigger*',
                delayMs: 5000,
                bodyType: 'json',
                set: { retry: true },
                repeat: 1,
            },
            {
                // 响应触发示例:捕获命中 */api/submit* 的请求;当 */api/status* 的响应 status=200、
                // 响应头 x-ready=1、响应体 JSON 的 data.state=done 且响应体原文含子串 "done" 时(全部 AND),
                // 延时 800ms 重发捕获的 submit 请求。bodyContains=免路径的原文子串匹配(适配深层嵌套/数组)。
                urlPattern: '*/api/submit*',
                responseTrigger: {
                    triggerUrl: '*/api/status*',
                    status: 200,
                    headers: { 'x-ready': '1' },
                    bodyJson: { 'data.state': 'done' },
                    bodyContains: ['"state":"done"'],
                },
                delayMs: 800,
                repeat: 1,
            },
        ],
        // responseRules:「响应头条件改写」支路(受 enabled 总开关管)。命中 urlPattern 的响应,
        // 当其响应头满足 when 条件(所有键相等、大小写不敏感;缺省则无条件)时,按 setHeaders 设置/
        // 覆盖、removeHeaders 删除响应头。示例=响应头 xx=1 时把 cc 设为 1 并删掉 x-drop。enabled=false 不触发。
        responseRules: [
            {
                urlPattern: '*/api/example*',
                when: { xx: '1' },
                setHeaders: { cc: '1' },
                removeHeaders: [],
            },
        ],
        // requestHeaderRules:「请求头条件改写」支路(受 enabled 总开关管,仅回放端)。命中 urlPattern 的
        // 请求,当其**原始请求头**满足 when 条件时,在发出前按 setHeaders 设置/覆盖、removeHeaders 删除请求头。
        // 对称于 responseRules 但改的是请求侧;与 rules(改 body)、resends[].setHeaders(改重发副本头)不同。
        // 注:cookie/host 由浏览器管理,无法经此覆盖/删除(改 cookie 用登录态注入)。示例=注入 Authorization。
        requestHeaderRules: [
            {
                urlPattern: '*/api/example*',
                when: { 'x-flag': '1' },
                setHeaders: { authorization: 'Bearer 替换成你要的 token' },
                removeHeaders: [],
            },
        ],
        // blocks:「真拦截」支路(受 enabled 总开关管)。命中 urlPattern 的请求被拦在发送阶段,按 mode 处置:
        // - mode 缺省 / 'abort':**直接阻断、不发出**(回放端 route.abort(),页面 fetch/XHR 收到网络错误);
        // - mode:'hold':**挂起等人工放行**(仅回放端)——请求悬在半空(pending,不发也不失败),同时在暂停
        //   模态框的「被拦截的请求」列表里列出,人工逐条选「继续」放行(route.continue)或「阻断」丢弃(route.abort)。
        // method 可选,只拦指定方法;缺省拦所有。与 rules/resends/responseRules 物理分开。enabled=false 时不生效。
        blocks: [
            { urlPattern: '*/api/track*' },
            { urlPattern: '*/api/confirm*', mode: 'hold' },
        ],
        // dumps:「请求体落盘」支路(受 enabled 总开关管,仅回放端)。命中 urlPattern 的请求,把其
        // **完整二进制请求体**(从第一字节到最后一字节)写成一个文件到 dumps/(缺省 .mp4)。用于抓取
        // 上传型接口的字节体(如把视频上传请求体存成 mp4)。method 可选只落指定方法;缺省落所有方法。
        // 每命中一个请求落一个文件。与 rules/resends/responseRules/blocks 物理分开。enabled=false 时不生效。
        dumps: [{ urlPattern: '*upload.youtube.com*', extension: 'mp4' }],
        // bodyReplaces:「请求体整体替换(拦截替换)」支路(受 enabled 总开关管,仅回放端)。命中 urlPattern
        // 的请求,在拦截点把其**整个**请求体替换成 replaceWithFile(本地文件绝对路径)的完整字节再放行;
        // 能替换 File/Blob 上传体(走 CDP)。method 可选只替换指定方法;缺省替换所有方法。读文件失败则原样放行。
        bodyReplaces: [
            { urlPattern: '*upload.youtube.com*', replaceWithFile: 'D:\\path\\to\\replacement.mp4' },
        ],
        // record:「只记录不修改」支路(独立于 enabled)。改成 enabled:true 即拦截并记录所有请求
        // (不限 method)+ 响应到 timelines/timeline-*.jsonl,供事后分析;不改写任何请求。
        record: { enabled: false, urlPattern: '*', includeBody: true },
        // jsHooks:「JS Hook 探针」支路(独立于 enabled,仅回放端)。改成 enabled:true 即向页面主世界注入 hook 脚本,
        // 拦截网络出口(fetch/XHR)、标准加密库(btoa/crypto.subtle,可选 JSON.stringify/CryptoJS)与**平台自定义
        // 签名/加密函数**(rules[].hookPaths 指定的全局点路径,如 byted_acrawler.sign),抓「明文入参↔密文出参+调用栈」,
        // 落 dumps/jshook-index-<戳>.jsonl(大体旁落独立文件)。网络层只看得到密文,这里看得到明文——用于逆向前端签名/加密。
        // apis 取值:fetch|xhr|btoa|subtle|json|cryptojs(全局并集;缺省=fetch/xhr/btoa/subtle,json 高频/cryptojs 按需须显式开);
        // urlPattern 缺省=所有页面;maxInline=明文/密文内联进索引的字节阈值(超则旁落文件、完整不截断),缺省 2048。
        jsHooks: {
            enabled: false,
            rules: [
                {
                    urlPattern: '*',
                    apis: ['fetch', 'xhr', 'btoa', 'subtle', 'json', 'cryptojs'],
                    hookPaths: ['byted_acrawler.sign'],
                    maxInline: 2048,
                },
            ],
        },
        // maxResendHops:响应触发重发的「链式跳数上限」。允许一条重发的响应再触发下一条规则(连环触发),
        // 真实请求算第 0 跳、每重发一次 +1;当触发源已达此跳数就熔断,不再继续——兜底防无限自环/互环。
        // 缺省 5(clamp 到 [1,100])。想让 A→B→C… 更长的连环走通就调大;只想单发把它设成 1。
        maxResendHops: 5,
    };
}

/** 共用的「动作字段」校验:bodyType/set/append/remove(改写规则与重发规则复用,DRY) */
function applyActionFields(
    r: Record<string, unknown>,
    target: {
        bodyType?: 'json' | 'form';
        set?: Record<string, unknown>;
        append?: Record<string, unknown>;
        remove?: string[];
    }
): void {
    if (r.bodyType === 'json' || r.bodyType === 'form') {
        target.bodyType = r.bodyType;
    }
    if (r.set && typeof r.set === 'object' && !Array.isArray(r.set)) {
        target.set = r.set as Record<string, unknown>;
    }
    if (r.append && typeof r.append === 'object' && !Array.isArray(r.append)) {
        target.append = r.append as Record<string, unknown>;
    }
    if (Array.isArray(r.remove)) {
        target.remove = r.remove.filter((x): x is string => typeof x === 'string');
    }
}

/** 校验并归一化单条改写规则;非法返回 null(过滤掉) */
function normalizeRule(raw: unknown): RequestRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: RequestRule = { urlPattern: r.urlPattern };
    applyActionFields(r, rule);
    return rule;
}

/** 校验并归一化单条重发规则;非法返回 null(过滤掉) */
function normalizeResendRule(raw: unknown): ResendRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: ResendRule = { urlPattern: r.urlPattern };
    applyActionFields(r, rule);
    // 可选:整体用本地文件字节作重发体(存在则运行端忽略 set/append/remove);非空 string 才收
    if (typeof r.replaceWithFile === 'string' && r.replaceWithFile.trim()) {
        rule.replaceWithFile = r.replaceWithFile;
    }
    // 可选:重发目标 URL 模板(设了则覆盖捕获请求原 URL;值支持 {{占位符}} 注入 extract 变量);非空 string 才收
    if (typeof r.setUrl === 'string' && r.setUrl.trim()) {
        rule.setUrl = r.setUrl;
    }
    if (r.method === 'POST' || r.method === 'GET') {
        rule.method = r.method;
    }
    // 非负数值字段:非法/缺省则不写(运行端各有默认)
    const nonNegNum = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    const delayMs = nonNegNum(r.delayMs);
    if (delayMs !== undefined) rule.delayMs = delayMs;
    const intervalMs = nonNegNum(r.intervalMs);
    if (intervalMs !== undefined) rule.intervalMs = intervalMs;
    const dedupeMs = nonNegNum(r.dedupeMs);
    if (dedupeMs !== undefined) rule.dedupeMs = dedupeMs;
    // repeat:>=1 的整数,clamp 到 [1,100](上限防误配爆量)
    if (typeof r.repeat === 'number' && Number.isFinite(r.repeat) && r.repeat >= 1) {
        rule.repeat = Math.min(Math.floor(r.repeat), 100);
    }
    // 可选:改重发请求头(与 responseRules 的 setHeaders/removeHeaders 同款校验,复用 normalizeStringMap)
    const setHeaders = normalizeStringMap(r.setHeaders);
    if (setHeaders) {
        rule.setHeaders = setHeaders;
    }
    if (Array.isArray(r.removeHeaders)) {
        rule.removeHeaders = r.removeHeaders.filter((x): x is string => typeof x === 'string');
    }
    // 可选:响应条件触发器(设了则改由响应观察器触发,见 macro-runner.handleResponseTrigger)。
    // 若提供了 responseTrigger 但归一化失败(缺必填 triggerUrl)→ 整条规则丢弃,避免误当请求触发发出。
    if (r.responseTrigger != null) {
        const trigger = normalizeResponseTrigger(r.responseTrigger);
        if (!trigger) {
            return null;
        }
        rule.responseTrigger = trigger;
    }
    return rule;
}

/**
 * 校验并归一化重发规则的 responseTrigger。**triggerUrl 必填**(非空 string,否则返回 null → 整条规则被丢弃)。
 * status 取有限 number;headers/requestHeaders/bodyJson 复用 normalizeStringMap(路径→字符串);各组子条件均可选。
 */
function normalizeResponseTrigger(raw: unknown): ResendResponseTrigger | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.triggerUrl !== 'string' || !t.triggerUrl.trim()) {
        return null; // triggerUrl 必填
    }
    const out: ResendResponseTrigger = { triggerUrl: t.triggerUrl };
    if (typeof t.status === 'number' && Number.isFinite(t.status)) {
        out.status = t.status;
    }
    const headers = normalizeStringMap(t.headers);
    if (headers) {
        out.headers = headers;
    }
    const requestHeaders = normalizeStringMap(t.requestHeaders);
    if (requestHeaders) {
        out.requestHeaders = requestHeaders;
    }
    const bodyJson = normalizeStringMap(t.bodyJson);
    if (bodyJson) {
        out.bodyJson = bodyJson;
    }
    if (Array.isArray(t.bodyContains)) {
        // 只保留非空字符串子串(空串 includes 恒真、无意义故剔除);结果非空才写
        const subs = t.bodyContains.filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (subs.length) {
            out.bodyContains = subs;
        }
    }
    const extract = normalizeResendExtract(t.extract);
    if (extract) {
        out.extract = extract;
    }
    // when:原样保留字符串(不在此解析);非法表达式不丢规则、不剥字段 —— 运行期解析失败会安全判不命中 +
    // 显式诊断,比静默剥掉更安全(剥掉会悄悄放开连环)。
    if (typeof t.when === 'string' && t.when.trim()) {
        out.when = t.when;
    }
    return out;
}

/**
 * 校验并归一化 responseTrigger.extract(变量名 → 取值源)。每个源保留 fromBody/fromHeader/default(仅 string);
 * 既无 fromBody 也无 fromHeader 的条目丢弃(无从取值);结果空返回 undefined。
 */
function normalizeResendExtract(
    raw: unknown
): Record<string, ResendVarSource> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const out: Record<string, ResendVarSource> = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            continue;
        }
        const s = v as Record<string, unknown>;
        const src: ResendVarSource = {};
        if (typeof s.fromBody === 'string' && s.fromBody.trim()) {
            src.fromBody = s.fromBody;
        }
        if (typeof s.fromHeader === 'string' && s.fromHeader.trim()) {
            src.fromHeader = s.fromHeader;
        }
        if (src.fromBody === undefined && src.fromHeader === undefined) {
            continue; // 无取值源,丢弃该条
        }
        if (typeof s.default === 'string') {
            src.default = s.default;
        }
        out[name] = src;
    }
    return Object.keys(out).length ? out : undefined;
}

/** 归一化响应状态码覆盖值:取整并要求落在 [100,599];非法(NaN/越界/非数字)返回 null。 */
function normalizeStatusField(raw: unknown): number | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return null;
    }
    const s = Math.trunc(raw);
    return s >= 100 && s <= 599 ? s : null;
}

/** 把原始对象归一化成 string→string 映射(仅保留值为 string 的键);空/非对象返回 undefined */
function normalizeStringMap(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') {
            out[k] = v;
        }
    }
    return Object.keys(out).length ? out : undefined;
}

/** 校验并归一化单条响应头改写规则;非法返回 null(过滤掉) */
function normalizeResponseHeaderRule(raw: unknown): ResponseHeaderRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: ResponseHeaderRule = { urlPattern: r.urlPattern };
    const when = normalizeStringMap(r.when);
    if (when) {
        rule.when = when;
    }
    const setHeaders = normalizeStringMap(r.setHeaders);
    if (setHeaders) {
        rule.setHeaders = setHeaders;
    }
    if (Array.isArray(r.removeHeaders)) {
        rule.removeHeaders = r.removeHeaders.filter((x): x is string => typeof x === 'string');
    }
    // ── 响应体/状态码/mock 动作(P0-1;均可选,缺则该维度不介入,行为与旧配置一致)──
    const status = normalizeStatusField(r.setStatus);
    if (status !== null) {
        rule.setStatus = status;
    }
    if (typeof r.setBody === 'string') {
        rule.setBody = r.setBody; // 空串是合法的「空体覆盖」,保留
    }
    if (typeof r.bodyReplaceFile === 'string' && r.bodyReplaceFile.trim()) {
        rule.bodyReplaceFile = r.bodyReplaceFile.trim();
    }
    if (r.mock === true) {
        rule.mock = true;
    }
    return rule;
}

/** 校验并归一化单条请求头改写规则;非法返回 null(过滤掉)。校验与响应头版一致 */
function normalizeRequestHeaderRule(raw: unknown): RequestHeaderRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: RequestHeaderRule = { urlPattern: r.urlPattern };
    const when = normalizeStringMap(r.when);
    if (when) {
        rule.when = when;
    }
    const setHeaders = normalizeStringMap(r.setHeaders);
    if (setHeaders) {
        rule.setHeaders = setHeaders;
    }
    if (Array.isArray(r.removeHeaders)) {
        rule.removeHeaders = r.removeHeaders.filter((x): x is string => typeof x === 'string');
    }
    return rule;
}

/** 校验并归一化单条真拦截规则;非法返回 null(过滤掉) */
function normalizeBlockRule(raw: unknown): BlockRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: BlockRule = { urlPattern: r.urlPattern };
    if (typeof r.method === 'string' && r.method.trim()) {
        rule.method = r.method;
    }
    // 复合触发条件(各组可选、缺省不校验、全组 AND):照 normalizeResponseTrigger 同款归一化
    const requestHeaders = normalizeStringMap(r.requestHeaders);
    if (requestHeaders) {
        rule.requestHeaders = requestHeaders;
    }
    const query = normalizeStringMap(r.query);
    if (query) {
        rule.query = query;
    }
    const bodyJson = normalizeStringMap(r.bodyJson);
    if (bodyJson) {
        rule.bodyJson = bodyJson;
    }
    if (Array.isArray(r.bodyContains)) {
        // 只保留非空字符串子串(空串 includes 恒真、无意义故剔除);结果非空才写
        const subs = r.bodyContains.filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (subs.length) {
            rule.bodyContains = subs;
        }
    }
    // when:原样保留字符串(不在此解析);非法表达式不丢规则、不剥字段——运行期 fail-open(判不命中=不拦)+ 诊断
    if (typeof r.when === 'string' && r.when.trim()) {
        rule.when = r.when;
    }
    // mode 白名单:仅 'hold' 显式生效,其余(含缺省 / 非法值)一律视作 'abort'(向后兼容旧配置)
    if (r.mode === 'hold') {
        rule.mode = 'hold';
    }
    return rule;
}

/** 校验并归一化单条请求体落盘规则;非法返回 null(过滤掉) */
function normalizeDumpRule(raw: unknown): DumpRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: DumpRule = { urlPattern: r.urlPattern };
    if (typeof r.method === 'string' && r.method.trim()) {
        rule.method = r.method;
    }
    if (typeof r.extension === 'string' && r.extension.trim()) {
        rule.extension = r.extension;
    }
    return rule;
}

/** 校验并归一化单条请求体整体替换规则;非法(含缺 replaceWithFile)返回 null(过滤掉) */
function normalizeBodyReplaceRule(raw: unknown): BodyReplaceRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    if (typeof r.replaceWithFile !== 'string' || !r.replaceWithFile.trim()) {
        return null; // 没有替换文件的规则无意义
    }
    const rule: BodyReplaceRule = {
        urlPattern: r.urlPattern,
        replaceWithFile: r.replaceWithFile,
    };
    if (typeof r.method === 'string' && r.method.trim()) {
        rule.method = r.method;
    }
    return rule;
}

/** 校验并归一化单条「请求/响应体独立落盘」规则;非法(缺 urlPattern)返回 null(过滤掉) */
function normalizeBodySaveRule(raw: unknown): BodySaveRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: BodySaveRule = { urlPattern: r.urlPattern };
    if (typeof r.method === 'string' && r.method.trim()) {
        rule.method = r.method;
    }
    if (typeof r.request === 'boolean') {
        rule.request = r.request;
    }
    if (typeof r.response === 'boolean') {
        rule.response = r.response;
    }
    if (typeof r.requestExt === 'string' && r.requestExt.trim()) {
        rule.requestExt = r.requestExt;
    }
    if (typeof r.responseExt === 'string' && r.responseExt.trim()) {
        rule.responseExt = r.responseExt;
    }
    return rule;
}

/** 校验并归一化 record 段(config 级,非 per-rule);非对象/缺省返回 undefined */
function normalizeRecord(raw: unknown): TimelineRecordConfig | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const r = raw as Record<string, unknown>;
    const record: TimelineRecordConfig = {
        enabled: r.enabled === true,
    };
    if (typeof r.urlPattern === 'string' && r.urlPattern.trim()) {
        record.urlPattern = r.urlPattern;
    }
    if (typeof r.includeBody === 'boolean') {
        record.includeBody = r.includeBody;
    }
    if (Array.isArray(r.saveBodies)) {
        const saveBodies = r.saveBodies
            .map(normalizeBodySaveRule)
            .filter((x): x is BodySaveRule => x !== null);
        if (saveBodies.length) {
            record.saveBodies = saveBodies;
        }
    }
    return record;
}

/** 校验并归一化单条 jsHooks 规则;非对象返回 null(过滤掉);字段全可选,全空也保留(=默认基础集全抓) */
function normalizeJsHookRule(raw: unknown): JsHookRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    const rule: JsHookRule = {};
    if (typeof r.urlPattern === 'string' && r.urlPattern.trim()) {
        rule.urlPattern = r.urlPattern;
    }
    if (Array.isArray(r.apis)) {
        const apis = r.apis.filter(
            (a): a is string => typeof a === 'string' && a.trim().length > 0
        );
        if (apis.length) {
            rule.apis = apis;
        }
    }
    if (Array.isArray(r.hookPaths)) {
        const hookPaths = r.hookPaths.filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0
        );
        if (hookPaths.length) {
            rule.hookPaths = hookPaths;
        }
    }
    if (typeof r.maxInline === 'number' && Number.isFinite(r.maxInline) && r.maxInline >= 0) {
        rule.maxInline = Math.floor(r.maxInline);
    }
    return rule;
}

/** 校验并归一化 jsHooks 段(config 级,像 record 自带 enabled);非对象/缺省返回 undefined */
function normalizeJsHookConfig(raw: unknown): JsHookConfig | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const r = raw as Record<string, unknown>;
    const cfg: JsHookConfig = { enabled: r.enabled === true };
    if (Array.isArray(r.rules)) {
        const rules = r.rules
            .map(normalizeJsHookRule)
            .filter((x): x is JsHookRule => x !== null);
        if (rules.length) {
            cfg.rules = rules;
        }
    }
    if (typeof r.maxEntries === 'number' && Number.isFinite(r.maxEntries) && r.maxEntries > 0) {
        cfg.maxEntries = Math.floor(r.maxEntries);
    }
    return cfg;
}

/**
 * 加载请求改写配置。
 * - 文件不存在:写入 inert 模板并返回它(enabled=false,不干预录制)。
 * - 坏 JSON / 字段非法:回退空配置,不阻断启动。
 * @param filePath 配置文件路径(dataRoot/request-rules.json)
 */
export function loadRequestRules(filePath: string): RequestRulesConfig {
    try {
        if (!fs.existsSync(filePath)) {
            const tpl = templateConfig();
            try {
                fs.writeFileSync(filePath, JSON.stringify(tpl, null, 4), 'utf-8');
            } catch {
                /* 写模板失败(如只读目录)不致命 */
            }
            return tpl;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<RequestRulesConfig>;
        const rules = Array.isArray(raw.rules)
            ? raw.rules.map(normalizeRule).filter((x): x is RequestRule => x !== null)
            : [];
        const record = normalizeRecord(raw.record);
        const jsHooks = normalizeJsHookConfig(raw.jsHooks);
        const resends = Array.isArray(raw.resends)
            ? raw.resends.map(normalizeResendRule).filter((x): x is ResendRule => x !== null)
            : [];
        const responseRules = Array.isArray(raw.responseRules)
            ? raw.responseRules
                  .map(normalizeResponseHeaderRule)
                  .filter((x): x is ResponseHeaderRule => x !== null)
            : [];
        const requestHeaderRules = Array.isArray(raw.requestHeaderRules)
            ? raw.requestHeaderRules
                  .map(normalizeRequestHeaderRule)
                  .filter((x): x is RequestHeaderRule => x !== null)
            : [];
        const blocks = Array.isArray(raw.blocks)
            ? raw.blocks.map(normalizeBlockRule).filter((x): x is BlockRule => x !== null)
            : [];
        const dumps = Array.isArray(raw.dumps)
            ? raw.dumps.map(normalizeDumpRule).filter((x): x is DumpRule => x !== null)
            : [];
        const bodyReplaces = Array.isArray(raw.bodyReplaces)
            ? raw.bodyReplaces
                  .map(normalizeBodyReplaceRule)
                  .filter((x): x is BodyReplaceRule => x !== null)
            : [];
        // 响应触发链式跳数上限:有效正整数才写(clamp [1,100]);缺省/非法则不写,运行端用默认 5
        const maxResendHops =
            typeof raw.maxResendHops === 'number' &&
            Number.isFinite(raw.maxResendHops) &&
            raw.maxResendHops >= 1
                ? Math.min(Math.floor(raw.maxResendHops), 100)
                : undefined;
        return {
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
            sections: normalizeSections(raw.sections),
            rules,
            ...(resends.length ? { resends } : {}),
            ...(responseRules.length ? { responseRules } : {}),
            ...(requestHeaderRules.length ? { requestHeaderRules } : {}),
            ...(blocks.length ? { blocks } : {}),
            ...(dumps.length ? { dumps } : {}),
            ...(bodyReplaces.length ? { bodyReplaces } : {}),
            ...(record ? { record } : {}),
            ...(jsHooks ? { jsHooks } : {}),
            ...(maxResendHops !== undefined ? { maxResendHops } : {}),
        };
    } catch {
        // 坏 JSON 等异常:回退空配置
        return emptyConfig();
    }
}

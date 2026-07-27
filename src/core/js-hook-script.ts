// JS Hook 探针:注入页面**主世界**的抓取脚本 + Node 侧的配置聚合纯逻辑。
//
// 探针源码以**字符串**导出(而非函数):它运行在页面主世界、document-start,整段是「另一个世界」的
// 代码,用字符串可绕过 TS 对 DOM 全局 / this 的类型检查,也避免 addInitScript 序列化函数的边界坑。
// runner 用 buildJsHookInitScript(cfg) 拼出 `(工厂)(配置)` 直接 addInitScript({content})。
//
// 铁律(探针自身):**全透传原行为**——原 this / 原参数 / 原返回值 / 原异常一律不改,hook 只旁路观察;
// 上报与序列化全包 try/catch,探针自身报错绝不外抛、绝不影响页面功能。禁止截断数据:页面侧序列化不设
// 上限(超大 payload 完整回传,内联还是旁落由 Node 侧按 maxInline 决定)。
import type { JsHookRule } from './macro-types';

/** 注入侧静态配置(runner 从 jsHooks 规则聚合后 JSON 注入脚本;装载时一次性决定包裹哪些目标) */
export interface JsHookInjectConfig {
    /** 要包裹的基础集 api:'fetch'|'xhr'|'json'|'btoa'|'subtle'|'cryptojs' */
    apis: string[];
    /** 自定义全局函数点路径(如 'byted_acrawler.sign') */
    hookPaths: string[];
    /** 页面侧上报的软信息(内联/旁落最终由 Node 定;此值仅透传备用) */
    maxInline: number;
    /** exposeBinding 暴露到 window 上的回传函数名 */
    bindingName: string;
}

/** 页面 → Node 每次 hook 命中回传的 payload 形状 */
export interface JsHookProbePayload {
    api?: string;
    url?: string;
    input?: string;
    inputEnc?: 'base64';
    output?: string;
    outputEnc?: 'base64';
    stack?: string;
}

/**
 * 主世界注入的 hook 探针「工厂源码」(IIFE 之前的函数体)。接收一个 cfg 参数,按 cfg.apis / cfg.hookPaths
 * 包裹目标。以字符串形式维护——内部**不得使用反引号或 ${},否则会破坏外层模板串**。
 */
export const JS_HOOK_PROBE_FACTORY = `function (cfg) {
    try {
        var send = window[cfg.bindingName];
        if (typeof send !== 'function') { return; }
        var apis = cfg.apis || [];
        var has = function (a) { return apis.indexOf(a) !== -1; };

        // 原始 btoa / JSON.stringify 引用(在可能 hook 它们之前保存,供探针内部序列化用,**防递归自触发**:
        // ser 对 object 会序列化,若用被 hook 的 JSON.stringify 则 hook→report→ser→JSON.stringify 无限递归卡死页面)
        var btoaOrig = (typeof window.btoa === 'function') ? window.btoa.bind(window) : function () { return ''; };
        var jsonStringifyOrig = (JSON && typeof JSON.stringify === 'function') ? JSON.stringify : null;

        function b64(u8) {
            try {
                var bin = '';
                var CH = 8192;
                for (var i = 0; i < u8.length; i += CH) {
                    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
                }
                return { s: btoaOrig(bin), enc: 'base64' };
            } catch (e) { return { s: '[binary]' }; }
        }

        // 任意值 → { s: 字符串, enc?: 'base64' };完整不截断
        function ser(v) {
            try {
                if (v === null || v === undefined) { return { s: String(v) }; }
                var t = typeof v;
                if (t === 'string') { return { s: v }; }
                if (t === 'number' || t === 'boolean') { return { s: String(v) }; }
                if (v instanceof ArrayBuffer) { return b64(new Uint8Array(v)); }
                if (ArrayBuffer.isView(v)) { return b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); }
                if (typeof Blob !== 'undefined' && v instanceof Blob) { return { s: '[Blob ' + v.size + ' bytes]' }; }
                if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) { return { s: v.toString() }; }
                if (typeof FormData !== 'undefined' && v instanceof FormData) {
                    var parts = [];
                    v.forEach(function (val, key) { parts.push(key + '=' + (typeof val === 'string' ? val : '[file]')); });
                    return { s: parts.join('&') };
                }
                if (t === 'object') {
                    try { if (jsonStringifyOrig) { return { s: jsonStringifyOrig.call(JSON, v) }; } } catch (e1) {}
                    try { return { s: String(v) }; } catch (e2) {}
                    return { s: '[object]' };
                }
                return { s: String(v) };
            } catch (e) { return { s: '[unserializable]' }; }
        }

        function stackNow() {
            try {
                var s = (new Error()).stack || '';
                // 剥掉前两帧(Error 行 + 本 stackNow / report),尽量留业务帧
                return s.split('\\n').slice(3).join('\\n');
            } catch (e) { return ''; }
        }

        // 重入守卫:send() 触发 Playwright binding 在页面侧序列化参数(内部会调 JSON.stringify),
        // 若此时正 hook JSON.stringify,则 report→send→JSON.stringify→json hook→report… 无限递归卡死页面。
        // inProbe 期间(含 send 的同步内部序列化)一律跳过上报,原函数仍透传、业务不受影响。
        var inProbe = false;
        function report(api, inp, out) {
            if (inProbe) { return; }
            inProbe = true;
            try {
                var pr = send({
                    api: api,
                    url: location.href,
                    input: inp ? inp.s : undefined,
                    inputEnc: inp ? inp.enc : undefined,
                    output: out ? out.s : undefined,
                    outputEnc: out ? out.enc : undefined,
                    stack: stackNow()
                });
                if (pr && typeof pr.catch === 'function') { pr.catch(function () {}); }
            } catch (e) { /* 探针上报错误绝不外抛 */ } finally { inProbe = false; }
        }

        // 惰性属性包裹:已有值直接 transform;否则 defineProperty 拦首次赋值(供后加载的 CryptoJS / 自定义函数)
        function defineLazy(obj, key, transform) {
            var existing;
            try { existing = obj[key]; } catch (e0) { existing = undefined; }
            if (existing !== undefined && existing !== null) {
                try { var t0 = transform(existing); if (t0 !== undefined) { obj[key] = t0; } } catch (e1) {}
                return;
            }
            var stored;
            try {
                Object.defineProperty(obj, key, {
                    configurable: true,
                    enumerable: true,
                    get: function () { return stored; },
                    set: function (nv) {
                        try { var t = transform(nv); stored = (t !== undefined) ? t : nv; }
                        catch (e) { stored = nv; }
                    }
                });
            } catch (e2) { /* 不可配置属性,放弃包裹 */ }
        }

        // —— fetch:抓发出前的最终请求参数(签名的汇合点)——
        if (has('fetch') && typeof window.fetch === 'function') {
            var origFetch = window.fetch;
            window.fetch = function (input, init) {
                try {
                    var url = (typeof input === 'string') ? input : (input && input.url) || '';
                    var method = (init && init.method) || (input && input.method) || 'GET';
                    var headers = (init && init.headers) || (input && input.headers) || undefined;
                    var body = init && init.body;
                    report('fetch', ser({ url: url, method: method, headers: headers, body: body === undefined ? undefined : ser(body).s }), undefined);
                } catch (e) {}
                return origFetch.apply(this, arguments);
            };
        }

        // —— XMLHttpRequest:open 记 method/url,send 抓 body ——
        if (has('xhr') && window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
            var XP = window.XMLHttpRequest.prototype;
            var origOpen = XP.open;
            var origSend = XP.send;
            XP.open = function (method, url) {
                try { this.__macro_m = method; this.__macro_u = url; } catch (e) {}
                return origOpen.apply(this, arguments);
            };
            XP.send = function (body) {
                try { report('xhr', ser({ url: this.__macro_u, method: this.__macro_m, body: body === undefined ? undefined : ser(body).s }), undefined); } catch (e) {}
                return origSend.apply(this, arguments);
            };
        }

        // —— JSON.stringify(高频,需显式开):抓序列化前的明文对象 → 字符串 ——
        if (has('json') && JSON && typeof JSON.stringify === 'function') {
            var origStr = JSON.stringify;
            JSON.stringify = function (value) {
                var out = origStr.apply(this, arguments);
                try { report('json', ser(value), (out === undefined ? undefined : { s: String(out) })); } catch (e) {}
                return out;
            };
        }

        // —— btoa:抓 base64 编码前后 ——
        if (has('btoa') && typeof window.btoa === 'function') {
            var origBtoa = window.btoa;
            window.btoa = function (s) {
                var out = origBtoa.apply(this, arguments);
                try { report('btoa', ser(s), { s: out }); } catch (e) {}
                return out;
            };
        }

        // —— crypto.subtle(异步):digest/sign/encrypt,明文一般是末参 ——
        if (has('subtle') && window.crypto && window.crypto.subtle) {
            var subtle = window.crypto.subtle;
            ['digest', 'sign', 'encrypt'].forEach(function (m) {
                if (typeof subtle[m] !== 'function') { return; }
                var orig = subtle[m];
                subtle[m] = function () {
                    var args = arguments;
                    var plain = args.length ? args[args.length - 1] : undefined;
                    var p = orig.apply(subtle, args);
                    try {
                        if (p && typeof p.then === 'function') {
                            p.then(function (res) { try { report('subtle.' + m, ser(plain), ser(res)); } catch (e) {} }, function () {});
                        }
                    } catch (e) {}
                    return p;
                };
            });
        }

        // —— CryptoJS(存在才包;可能后加载 → 惰性拦赋值)——
        if (has('cryptojs')) {
            defineLazy(window, 'CryptoJS', function (cj) {
                try {
                    if (!cj) { return cj; }
                    ['MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512', 'SHA3', 'RIPEMD160', 'HmacMD5', 'HmacSHA1', 'HmacSHA256', 'HmacSHA512'].forEach(function (name) {
                        if (typeof cj[name] !== 'function') { return; }
                        var orig = cj[name];
                        cj[name] = function () {
                            var out = orig.apply(this, arguments);
                            try { report('cryptojs.' + name, ser(arguments[0]), ser(out)); } catch (e) {}
                            return out;
                        };
                    });
                    ['AES', 'DES', 'TripleDES', 'RC4', 'RC4Drop', 'Rabbit', 'RabbitLegacy'].forEach(function (algo) {
                        if (!cj[algo] || typeof cj[algo].encrypt !== 'function') { return; }
                        var origEnc = cj[algo].encrypt;
                        cj[algo].encrypt = function () {
                            var out = origEnc.apply(this, arguments);
                            try { report('cryptojs.' + algo + '.encrypt', ser(arguments[0]), ser(out)); } catch (e) {}
                            return out;
                        };
                    });
                } catch (e) {}
                return cj;
            });
        }

        // —— 自定义全局函数路径(如 byted_acrawler.sign):按点路径惰性包裹叶子函数 ——
        var paths = cfg.hookPaths || [];
        for (var pi = 0; pi < paths.length; pi++) {
            (function (dotted) {
                try {
                    var segs = dotted.split('.');
                    var leaf = segs.pop();
                    var parent = window;
                    for (var j = 0; j < segs.length; j++) {
                        if (parent === null || parent === undefined) { parent = undefined; break; }
                        parent = parent[segs[j]];
                    }
                    if (parent === null || parent === undefined) { return; }
                    defineLazy(parent, leaf, function (fn) {
                        if (typeof fn !== 'function') { return fn; }
                        var wrapped = function () {
                            var out = fn.apply(this, arguments);
                            try {
                                var inp = (arguments.length === 1) ? ser(arguments[0]) : ser(Array.prototype.slice.call(arguments));
                                report('custom:' + dotted, inp, ser(out));
                            } catch (e) {}
                            return out;
                        };
                        try { for (var k in fn) { wrapped[k] = fn[k]; } } catch (e) {}
                        return wrapped;
                    });
                } catch (e) {}
            })(paths[pi]);
        }
    } catch (e) {
        /* 探针初始化失败绝不影响页面 */
    }
}`;

/** 拼出可直接 addInitScript({content}) 的完整源码:(工厂)(配置) */
export function buildJsHookInitScript(cfg: JsHookInjectConfig): string {
    return `(${JS_HOOK_PROBE_FACTORY})(${JSON.stringify(cfg)});`;
}

/** 默认基础集(所有规则都未显式写 apis 时用):高频的 json、按需的 cryptojs 不默认开 */
const DEFAULT_APIS = ['fetch', 'xhr', 'btoa', 'subtle'];

/** 取内联阈值:首个显式且有效的 maxInline,否则默认 2048 */
export function pickMaxInline(rules: JsHookRule[]): number {
    for (const r of rules) {
        if (typeof r.maxInline === 'number' && r.maxInline >= 0) {
            return r.maxInline;
        }
    }
    return 2048;
}

/**
 * 把 jsHooks 规则聚合成注入侧静态配置:apis / hookPaths 取**全局并集**(注入脚本一次性装载、
 * 决定包裹哪些目标);任一规则显式写了 apis 则用其并集,全都没写则用默认基础集。
 */
export function buildInjectConfig(rules: JsHookRule[]): JsHookInjectConfig {
    const apiSet = new Set<string>();
    const pathSet = new Set<string>();
    let anyApis = false;
    for (const r of rules) {
        if (Array.isArray(r.apis) && r.apis.length > 0) {
            anyApis = true;
            for (const a of r.apis) {
                apiSet.add(String(a));
            }
        }
        if (Array.isArray(r.hookPaths)) {
            for (const p of r.hookPaths) {
                if (p) {
                    pathSet.add(String(p));
                }
            }
        }
    }
    return {
        apis: anyApis ? [...apiSet] : [...DEFAULT_APIS],
        hookPaths: [...pathSet],
        maxInline: pickMaxInline(rules),
        bindingName: '__macroProbe',
    };
}

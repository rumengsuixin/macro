/**
 * 零依赖迷你表达式引擎(仅供回放端「响应触发器 when」使用)。
 *
 * 设计目标:让 resends[].responseTrigger.when 能写一句 JS 风格的布尔表达式,
 * 表达「不等 / 正则 / OR / 跳数(hop)」等静态值匹配做不到的判断——尤其 `hop == 0`
 * 只在真实浏览器响应触发,从根切断连环重发。
 *
 * 安全边界(头号约束):这是一个**受限**求值器,绝不等价于 eval。
 *  - 标识符只认注入的白名单变量(status/hop/body/text),裸写 process/require/globalThis/this → 报错;
 *  - 成员 / 下标统一走 safeGet:仅对象/数组可下钻,黑名单 __proto__/constructor/prototype,只读自有属性
 *    → 拿不到 Function、无法沿原型链逃逸;
 *  - 调用只允许「裸标识符 + 白名单函数名」,从语法层杜绝 body.foo() / f()() 这类逃逸;
 *  - 词法只识别白名单算子,+ * / % = ; { } ? : 反引号 等一律语法错(无算术 / 赋值 / 对象字面量 / 模板串后门)。
 *
 * 失败即安全:解析失败 / 求值异常一律经调用方判「不命中」(不重发),绝不因表达式坏了而误开连环。
 * 纯逻辑、零 IO,便于离线自检。不 import 本目录其它模块(避免循环依赖);
 * header()/reqHeader() 的实现由调用方注入 ExprContext。
 */

// ── 对外类型 ──

/** 表达式求值上下文:引擎按名读取的变量与可调用的内置函数(header/reqHeader 由调用方注入实现) */
export interface ExprContext {
    /** 触发响应的 HTTP 状态码 */
    status: number;
    /** 触发响应对应请求的重发跳数:真实浏览器请求=0,工具重发=1/2/…(核心:写 hop==0 断连环) */
    hop: number;
    /** 响应体 JSON.parse 后的对象;解析失败 / 无体 = undefined */
    body: unknown;
    /** 响应体原文;无体 = null */
    text: string | null;
    /** 取响应头(大小写不敏感,缺失返回 '') */
    header(name: string): string;
    /** 取 triggerUrl 那条请求的头(大小写不敏感,缺失返回 '') */
    reqHeader(name: string): string;
}

/** 求值结果:成功带原始值(顶层由调用方真值化);失败区分解析期 / 求值期,message 为中文供诊断 */
export type ExprEvalResult =
    | { ok: true; value: unknown }
    | { ok: false; phase: 'parse'; message: string }
    | { ok: false; phase: 'eval'; message: string };

// ── 内部:AST 节点 ──

type ExprNode =
    | { type: 'lit'; value: string | number | boolean | null }
    | { type: 'ident'; name: string }
    | { type: 'member'; obj: ExprNode; prop: string }
    | { type: 'index'; obj: ExprNode; index: ExprNode }
    | { type: 'call'; name: string; args: ExprNode[] }
    | { type: 'unary'; op: '!' | '-'; arg: ExprNode }
    | {
          type: 'binary';
          op: '==' | '!=' | '===' | '!==' | '>' | '<' | '>=' | '<=';
          left: ExprNode;
          right: ExprNode;
      }
    | { type: 'logical'; op: '&&' | '||'; left: ExprNode; right: ExprNode };

/** 解析产物:成功缓存 AST,失败也缓存(避免坏表达式每条响应重复解析) */
type ParseResult = { ok: true; ast: ExprNode } | { ok: false; message: string };

class ParseError extends Error {}
class EvalError extends Error {}

// ── 词法 ──

interface Token {
    kind: 'num' | 'str' | 'ident' | 'punct';
    value: string; // punct=算子文本;num=数字文本;str=已解转义的字符串内容;ident=标识符
}

/** 算子按长度降序,最长匹配优先(=== 先于 ==) */
const PUNCTS = [
    '===',
    '!==',
    '==',
    '!=',
    '>=',
    '<=',
    '&&',
    '||',
    '>',
    '<',
    '!',
    '(',
    ')',
    '[',
    ']',
    '.',
    ',',
    '-',
];

const MAX_TOKENS = 2000;
const MAX_DEPTH = 64;

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        // 空白
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        // 字符串(单 / 双引号)
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            let out = '';
            while (j < n && src[j] !== quote) {
                if (src[j] === '\\') {
                    const e = src[j + 1];
                    if (e === undefined) {
                        throw new ParseError('字符串未闭合(转义符后缺字符)');
                    }
                    out +=
                        e === 'n'
                            ? '\n'
                            : e === 't'
                              ? '\t'
                              : e === 'r'
                                ? '\r'
                                : e; // \\ \' \" \/ 及其它 → 原字符
                    j += 2;
                } else {
                    out += src[j];
                    j++;
                }
            }
            if (j >= n) {
                throw new ParseError('字符串未闭合(缺右引号)');
            }
            tokens.push({ kind: 'str', value: out });
            i = j + 1;
            continue;
        }
        // 数字(整 / 小数;负号交给一元 -)
        if (c >= '0' && c <= '9') {
            let j = i;
            while (j < n && src[j] >= '0' && src[j] <= '9') {
                j++;
            }
            if (j < n && src[j] === '.') {
                j++;
                while (j < n && src[j] >= '0' && src[j] <= '9') {
                    j++;
                }
            }
            tokens.push({ kind: 'num', value: src.slice(i, j) });
            i = j;
            continue;
        }
        // 标识符
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
            let j = i;
            while (j < n) {
                const d = src[j];
                if (
                    (d >= 'A' && d <= 'Z') ||
                    (d >= 'a' && d <= 'z') ||
                    (d >= '0' && d <= '9') ||
                    d === '_'
                ) {
                    j++;
                } else {
                    break;
                }
            }
            tokens.push({ kind: 'ident', value: src.slice(i, j) });
            i = j;
            continue;
        }
        // 算子 / 标点(最长匹配)
        const p = PUNCTS.find((op) => src.startsWith(op, i));
        if (p) {
            tokens.push({ kind: 'punct', value: p });
            i += p.length;
            continue;
        }
        throw new ParseError(`非法字符 "${c}"(不支持的运算符或符号)`);
    }
    if (tokens.length > MAX_TOKENS) {
        throw new ParseError('表达式过长');
    }
    return tokens;
}

// ── 语法(递归下降 + 精度分层) ──

class Parser {
    private pos = 0;
    private depth = 0;

    constructor(private readonly tokens: Token[]) {}

    parse(): ExprNode {
        if (this.tokens.length === 0) {
            throw new ParseError('空表达式');
        }
        const node = this.parseOr();
        if (this.pos < this.tokens.length) {
            throw new ParseError(`多余的记号 "${this.tokens[this.pos].value}"`);
        }
        return node;
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private isPunct(v: string): boolean {
        const t = this.tokens[this.pos];
        return t !== undefined && t.kind === 'punct' && t.value === v;
    }

    private expectPunct(v: string): void {
        if (!this.isPunct(v)) {
            const got = this.peek();
            throw new ParseError(`期望 "${v}"${got ? `,实际 "${got.value}"` : ',但已到末尾'}`);
        }
        this.pos++;
    }

    private parseOr(): ExprNode {
        this.depth++;
        if (this.depth > MAX_DEPTH) {
            throw new ParseError('表达式嵌套过深');
        }
        let left = this.parseAnd();
        while (this.isPunct('||')) {
            this.pos++;
            const right = this.parseAnd();
            left = { type: 'logical', op: '||', left, right };
        }
        this.depth--;
        return left;
    }

    private parseAnd(): ExprNode {
        let left = this.parseEquality();
        while (this.isPunct('&&')) {
            this.pos++;
            const right = this.parseEquality();
            left = { type: 'logical', op: '&&', left, right };
        }
        return left;
    }

    private parseEquality(): ExprNode {
        let left = this.parseRelational();
        while (this.isPunct('===') || this.isPunct('!==') || this.isPunct('==') || this.isPunct('!=')) {
            const op = this.tokens[this.pos].value as '==' | '!=' | '===' | '!==';
            this.pos++;
            const right = this.parseRelational();
            left = { type: 'binary', op, left, right };
        }
        return left;
    }

    private parseRelational(): ExprNode {
        let left = this.parseUnary();
        while (this.isPunct('>=') || this.isPunct('<=') || this.isPunct('>') || this.isPunct('<')) {
            const op = this.tokens[this.pos].value as '>' | '<' | '>=' | '<=';
            this.pos++;
            const right = this.parseUnary();
            left = { type: 'binary', op, left, right };
        }
        return left;
    }

    private parseUnary(): ExprNode {
        if (this.isPunct('!') || this.isPunct('-')) {
            const op = this.tokens[this.pos].value as '!' | '-';
            this.pos++;
            const arg = this.parseUnary();
            return { type: 'unary', op, arg };
        }
        return this.parsePostfix();
    }

    private parsePostfix(): ExprNode {
        let node = this.parseAtom();
        for (;;) {
            if (this.isPunct('.')) {
                this.pos++;
                const t = this.peek();
                if (!t || t.kind !== 'ident') {
                    throw new ParseError('"." 后应为属性名');
                }
                this.pos++;
                node = { type: 'member', obj: node, prop: t.value };
            } else if (this.isPunct('[')) {
                this.pos++;
                const index = this.parseOr();
                this.expectPunct(']');
                node = { type: 'index', obj: node, index };
            } else if (this.isPunct('(')) {
                // 只允许调用裸标识符(白名单函数),杜绝 body.foo() / f()() 逃逸
                if (node.type !== 'ident') {
                    throw new ParseError('只能调用具名内置函数,不能调用表达式结果');
                }
                this.pos++;
                const args: ExprNode[] = [];
                if (!this.isPunct(')')) {
                    args.push(this.parseOr());
                    while (this.isPunct(',')) {
                        this.pos++;
                        args.push(this.parseOr());
                    }
                }
                this.expectPunct(')');
                node = { type: 'call', name: node.name, args };
            } else {
                break;
            }
        }
        return node;
    }

    private parseAtom(): ExprNode {
        const t = this.peek();
        if (!t) {
            throw new ParseError('表达式意外结束');
        }
        if (t.kind === 'num') {
            this.pos++;
            return { type: 'lit', value: Number(t.value) };
        }
        if (t.kind === 'str') {
            this.pos++;
            return { type: 'lit', value: t.value };
        }
        if (t.kind === 'ident') {
            this.pos++;
            if (t.value === 'true') {
                return { type: 'lit', value: true };
            }
            if (t.value === 'false') {
                return { type: 'lit', value: false };
            }
            if (t.value === 'null') {
                return { type: 'lit', value: null };
            }
            return { type: 'ident', name: t.value };
        }
        if (t.value === '(') {
            this.pos++;
            const node = this.parseOr();
            this.expectPunct(')');
            return node;
        }
        throw new ParseError(`意外的记号 "${t.value}"`);
    }
}

// ── 求值 ──

/** 安全取属性:仅对象 / 数组可下钻;黑名单原型键;只读自有属性(继承方法 / 原型一律 undefined) */
function safeGet(obj: unknown, key: string): unknown {
    if (obj === null || typeof obj !== 'object') {
        return undefined; // 字符串 / 数字 / 布尔:不暴露其原型方法(text.constructor → undefined)
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        return undefined; // 数组 length / 数字下标是自有属性,正常返回
    }
    return (obj as Record<string, unknown>)[key];
}

/** `==` / `!=` 的松散相等:严格相等 或 字符串化相等(对齐既有 bodyJson 的 String() 约定) */
function looseEq(a: unknown, b: unknown): boolean {
    return a === b || String(a) === String(b);
}

/** 关系比较:数值比较,任一为 NaN → false(可预测) */
function numCmp(a: unknown, b: unknown, f: (x: number, y: number) => boolean): boolean {
    const x = Number(a);
    const y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y)) {
        return false;
    }
    return f(x, y);
}

/** 内置纯函数(不依赖上下文,可模块级常量);header/reqHeader 每次按 ctx 注入 */
const PURE_FNS: Record<string, (...a: unknown[]) => unknown> = {
    /** 正则测试:match(str, pattern, flags?);非法正则 → 抛错落到求值期(安全不命中) */
    match: (str, pattern, flags) =>
        new RegExp(String(pattern), flags === undefined ? undefined : String(flags)).test(String(str)),
    /** 子串包含:contains(a, b) = String(a).includes(String(b)) */
    contains: (a, b) => String(a).includes(String(b)),
};

function evalNode(
    node: ExprNode,
    vars: Record<string, unknown>,
    fns: Record<string, (...a: unknown[]) => unknown>
): unknown {
    switch (node.type) {
        case 'lit':
            return node.value;
        case 'ident':
            if (Object.prototype.hasOwnProperty.call(vars, node.name)) {
                return vars[node.name];
            }
            throw new EvalError(`未知标识符 "${node.name}"`);
        case 'member':
            return safeGet(evalNode(node.obj, vars, fns), node.prop);
        case 'index': {
            const key = evalNode(node.index, vars, fns);
            return safeGet(evalNode(node.obj, vars, fns), String(key));
        }
        case 'call': {
            const fn = fns[node.name];
            if (typeof fn !== 'function') {
                throw new EvalError(`未知函数 "${node.name}"`);
            }
            const args = node.args.map((a) => evalNode(a, vars, fns));
            return fn(...args);
        }
        case 'unary': {
            const v = evalNode(node.arg, vars, fns);
            return node.op === '!' ? !v : -Number(v);
        }
        case 'binary': {
            const l = evalNode(node.left, vars, fns);
            const r = evalNode(node.right, vars, fns);
            switch (node.op) {
                case '===':
                    return l === r;
                case '!==':
                    return l !== r;
                case '==':
                    return looseEq(l, r);
                case '!=':
                    return !looseEq(l, r);
                case '>':
                    return numCmp(l, r, (x, y) => x > y);
                case '<':
                    return numCmp(l, r, (x, y) => x < y);
                case '>=':
                    return numCmp(l, r, (x, y) => x >= y);
                case '<=':
                    return numCmp(l, r, (x, y) => x <= y);
            }
            return false;
        }
        case 'logical': {
            const l = evalNode(node.left, vars, fns);
            if (node.op === '&&') {
                return l ? evalNode(node.right, vars, fns) : l; // 短路:保留原值,支持 body && body.x
            }
            return l ? l : evalNode(node.right, vars, fns);
        }
    }
}

// ── 缓存 + 对外 API ──

const PARSE_CACHE = new Map<string, ParseResult>();
const MAX_CACHE = 500;

function parseCached(expr: string): ParseResult {
    const hit = PARSE_CACHE.get(expr);
    if (hit) {
        return hit;
    }
    let result: ParseResult;
    try {
        const ast = new Parser(tokenize(expr)).parse();
        result = { ok: true, ast };
    } catch (e) {
        result = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (PARSE_CACHE.size >= MAX_CACHE) {
        PARSE_CACHE.clear(); // 配置表达式少而静态,基本不触发;触发即整清,简单可靠
    }
    PARSE_CACHE.set(expr, result);
    return result;
}

/**
 * 解析(带缓存)+ 求值一句触发表达式;不抛异常,用判别联合返回。
 * 空 / 纯空白 → { ok:true, value:true }(无条件通过,与其余可选子条件「不给即满足」的 AND 语义一致)。
 */
export function tryEvalTriggerWhen(expr: string, ctx: ExprContext): ExprEvalResult {
    if (!expr || !expr.trim()) {
        return { ok: true, value: true };
    }
    const parsed = parseCached(expr);
    if (!parsed.ok) {
        return { ok: false, phase: 'parse', message: parsed.message };
    }
    const vars: Record<string, unknown> = {
        status: ctx.status,
        hop: ctx.hop,
        body: ctx.body,
        text: ctx.text,
    };
    const fns: Record<string, (...a: unknown[]) => unknown> = {
        ...PURE_FNS,
        header: (...a) => ctx.header(String(a[0])),
        reqHeader: (...a) => ctx.reqHeader(String(a[0])),
    };
    try {
        return { ok: true, value: evalNode(parsed.ast, vars, fns) };
    } catch (e) {
        return { ok: false, phase: 'eval', message: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * 纯语法体检(供加载期告警):合法返回 null,非法返回中文错误信息。
 * 空 / 纯空白视为合法(= 无条件)。不求值、不需要上下文。
 */
export function checkExprSyntax(expr: string): string | null {
    if (!expr || !expr.trim()) {
        return null;
    }
    const parsed = parseCached(expr);
    return parsed.ok ? null : parsed.message;
}

// AI 提取规则生成 / 选择器校正:**双后端**,按配置切换。
//
//   runtime  —— HTTP 提交 + 轮询 mcp-agent-runtime worker(主线;判定规格在其域包里)
//   openclaw —— WebSocket + Ed25519 连 OpenClaw Gateway(存量;判定规格在工作区 SOUL.md)
//
// 本文件只管「配置 + 任务组装 + 结果解析」,两条后端路径的差异全在 ai-executor.ts 里。
//
// 设计要点:
// - profile 列表式:每个 profile 指定一个 agent 目标,可配多个,按 profileId 选用,UI 下拉展示;
//   每档可单独指定 backend(不填走顶层 defaultBackend),便于灰度与回滚。
// - 单次请求即用即走:两个后端都不持久连接。
import fs from 'node:fs';
import path from 'node:path';
import type { ExtractConfig } from './macro-types';
import type { OpenclawConnConfig } from './openclaw-client';
import type { RuntimeConnConfig } from './runtime-client';
import {
    getExecutor,
    type AiBackend,
    type AiProfile,
    type ExecutorConfig,
    type ExtractFields,
    type FixFields,
} from './ai-executor';

export type { AiBackend, AiProfile } from './ai-executor';

/** AI 提取整体配置 */
export interface AiConfig {
    /** 默认使用的配置档 id */
    defaultProfile: string;
    /** 配置档列表 */
    profiles: AiProfile[];
    /** 默认后端;各 profile 可用自己的 backend 覆盖 */
    defaultBackend: AiBackend;
    /** openclaw 连接覆盖(默认自动读 ~/.openclaw) */
    openclaw?: OpenclawConnConfig;
    /** runtime worker 连接参数 */
    runtime?: RuntimeConnConfig;
    /** 系统提示词(**仅 openclaw 路径**拼进 message) */
    systemPrompt: string;
    /** 提示词模板,支持占位符 {requirement} 与 {html}(**仅 openclaw 路径**) */
    promptTemplate: string;
    /** 是否在发送前清洗 HTML(去 script/style/注释降噪),默认 true */
    cleanHtml?: boolean;
}

/** 配置档摘要(给渲染进程下拉用) */
export interface ProfileSummary {
    id: string;
    label: string;
    agentId: string;
    /** 本档实际生效的后端(已回落顶层默认) */
    backend: AiBackend;
}

/** 生成结果 */
export interface GenerateResult {
    ok: boolean;
    profileId: string;
    profileLabel: string;
    /** 解析成功的提取规则 */
    rules?: ExtractConfig;
    /** 模型原始回复(便于排查) */
    raw?: string;
    /** 失败原因 */
    error?: string;
    /** 本次实际使用的会话 key(调用方可在自检回路重生成时回传以复用同一 agent 会话) */
    sessionKey?: string;
    /** 耗时(毫秒) */
    elapsedMs: number;
    /** 本次实际走的后端(排障用) */
    backend?: AiBackend;
    /** runtime 会话 id(可在会话观察台复盘);openclaw 路径为空 */
    sessionId?: string;
    /** token 用量(runtime 路径有) */
    usage?: Record<string, number>;
}

// ===== 默认配置(首次运行自动写入 <dataRoot>/config/ai-config.json) =====
// 注:详细的提取规则结构(list/single、type 含义)由 agent 侧持有 ——
//   runtime 路径在域包 domains/webextract、domains/selector_fix;openclaw 路径在工作区 SOUL.md。
//   本地只保留一句「只输出 JSON」的安全兜底(openclaw 路径用),提示词尽量精简。

const DEFAULT_SYSTEM_PROMPT =
    '只输出一个 JSON 对象作为网页提取规则,不要任何解释、前言或 Markdown 代码块标记。';

const DEFAULT_PROMPT_TEMPLATE = [
    '采集需求:{requirement}',
    '',
    '网页 HTML:',
    '{html}',
].join('\n');

/** runtime worker 默认地址。刻意用 IPv4 字面量:某些机器上 localhost 先解析到 ::1,
 *  而 Docker 端口发布在 IPv4,写 localhost 会连不上。 */
const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:8080';

const DEFAULT_CONFIG: AiConfig = {
    defaultProfile: 'webextract',
    profiles: [
        {
            id: 'webextract',
            label: '网页提取 Agent(webextract)',
            agentId: 'webextract',
            sessionKeyPrefix: 'agent:webextract:macro:extract',
            timeout: 120000,
            domain: 'webextract',
        },
        {
            id: 'selector-fix',
            label: '选择器校正 Agent(selector-fix)',
            agentId: 'selector-fix',
            sessionKeyPrefix: 'agent:selector-fix:macro:selector',
            timeout: 90000,
            domain: 'selector_fix',
        },
    ],
    defaultBackend: 'runtime',
    openclaw: {},
    runtime: { url: DEFAULT_RUNTIME_URL },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    cleanHtml: true,
};

/** 本档实际生效的后端:档内 backend 优先,回落顶层 defaultBackend,再回落 runtime */
export function resolveBackend(cfg: AiConfig, profile: AiProfile): AiBackend {
    return profile.backend ?? cfg.defaultBackend ?? 'runtime';
}

// ===== 配置读写 =====
/** ai-config.json 的绝对路径(统一收在 <dataRoot>/config/ 下,与其它运行时配置对齐) */
export function getConfigPath(): string {
    // 打包后主进程会设 MACRO_DATA_DIR 指向用户可写目录;开发时回退项目根。均落到 config/ 子目录。
    const base = process.env.MACRO_DATA_DIR;
    if (base) return path.join(base, 'config', 'ai-config.json');
    return path.resolve(__dirname, '..', '..', 'config', 'ai-config.json');
}

/** 读取配置;不存在则写入默认配置(先建 config/ 目录,避免首次写失败) */
export function loadAiConfig(): AiConfig {
    const file = getConfigPath();
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 4), 'utf8');
        return DEFAULT_CONFIG;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AiConfig>;
        // 老配置(迁 runtime 之前生成的)没有 defaultBackend / runtime 段 —— 在这里回填默认值,
        // 于是升级后默认走 runtime。连不上时 runtime-client 会给出可操作的中文提示。
        return {
            defaultProfile: raw.defaultProfile || DEFAULT_CONFIG.defaultProfile,
            profiles:
                Array.isArray(raw.profiles) && raw.profiles.length > 0
                    ? (raw.profiles as AiProfile[])
                    : DEFAULT_CONFIG.profiles,
            defaultBackend: raw.defaultBackend ?? DEFAULT_CONFIG.defaultBackend,
            openclaw: raw.openclaw ?? DEFAULT_CONFIG.openclaw,
            runtime: raw.runtime ?? DEFAULT_CONFIG.runtime,
            systemPrompt: raw.systemPrompt ?? DEFAULT_CONFIG.systemPrompt,
            promptTemplate: raw.promptTemplate ?? DEFAULT_CONFIG.promptTemplate,
            cleanHtml: raw.cleanHtml !== false,
        };
    } catch {
        return DEFAULT_CONFIG;
    }
}

/** 列出配置档摘要,供下拉选择 */
export function listProfiles(): { profiles: ProfileSummary[]; defaultProfile: string } {
    const cfg = loadAiConfig();
    return {
        profiles: cfg.profiles.map((p) => ({
            id: p.id,
            label: p.label,
            agentId: p.agentId,
            backend: resolveBackend(cfg, p),
        })),
        defaultProfile: cfg.defaultProfile,
    };
}

/** 按 id 解析配置档(找不到回退默认/首个) */
export function resolveProfile(cfg: AiConfig, id?: string): AiProfile | null {
    const target = id || cfg.defaultProfile;
    return cfg.profiles.find((p) => p.id === target) ?? cfg.profiles[0] ?? null;
}

// ===== 上传配置:格式校验 + 导入生效 =====
/** 校验结果 */
export interface ValidateResult {
    ok: boolean;
    /** 失败原因(中文,直接展示给用户) */
    error?: string;
    /** 校验通过后规范化的配置 */
    config?: AiConfig;
}

/** 导入结果 */
export interface ImportResult {
    ok: boolean;
    error?: string;
    /** 成功时:导入的配置档数量 */
    profileCount?: number;
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 严格校验上传的 ai-config 内容(已 JSON.parse 后的对象)。
 * 通过则返回规范化的 AiConfig(回填默认值,与 loadAiConfig 一致);否则返回中文错误。
 */
export function validateAiConfig(raw: unknown): ValidateResult {
    if (!isPlainObject(raw)) {
        return { ok: false, error: '配置根必须是一个 JSON 对象。' };
    }

    // profiles:非空数组,每项字段齐全且类型正确,id 不重复
    if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
        return { ok: false, error: 'profiles 必须是非空数组(至少配置一个 AI 配置档)。' };
    }
    const ids = new Set<string>();
    const profiles: AiProfile[] = [];
    for (let i = 0; i < raw.profiles.length; i++) {
        const p = raw.profiles[i] as Record<string, unknown>;
        const at = `profiles[${i}]`;
        if (!isPlainObject(p)) {
            return { ok: false, error: `${at} 必须是对象。` };
        }
        for (const key of ['id', 'label', 'agentId', 'sessionKeyPrefix'] as const) {
            if (!isNonEmptyString(p[key])) {
                return { ok: false, error: `${at}.${key} 必须是非空字符串。` };
            }
        }
        if (p.timeout !== undefined && (typeof p.timeout !== 'number' || !(p.timeout > 0))) {
            return { ok: false, error: `${at}.timeout 必须是正数(毫秒)。` };
        }
        // 双后端字段(均可选)
        if (p.backend !== undefined && p.backend !== 'openclaw' && p.backend !== 'runtime') {
            return { ok: false, error: `${at}.backend 只能是 "openclaw" 或 "runtime"。` };
        }
        for (const key of ['domain', 'promptOverride'] as const) {
            if (p[key] !== undefined && !isNonEmptyString(p[key])) {
                return { ok: false, error: `${at}.${key} 必须是非空字符串。` };
            }
        }
        const id = (p.id as string).trim();
        if (ids.has(id)) {
            return { ok: false, error: `profiles 中存在重复的 id:「${id}」。` };
        }
        ids.add(id);
        profiles.push({
            id,
            label: (p.label as string).trim(),
            agentId: (p.agentId as string).trim(),
            sessionKeyPrefix: (p.sessionKeyPrefix as string).trim(),
            ...(p.timeout !== undefined ? { timeout: p.timeout as number } : {}),
            ...(p.backend !== undefined ? { backend: p.backend as AiBackend } : {}),
            ...(p.domain !== undefined ? { domain: (p.domain as string).trim() } : {}),
            ...(p.promptOverride !== undefined
                ? { promptOverride: (p.promptOverride as string).trim() }
                : {}),
        });
    }

    // defaultProfile:字符串且存在于 profiles
    if (!isNonEmptyString(raw.defaultProfile)) {
        return { ok: false, error: 'defaultProfile 必须是非空字符串。' };
    }
    const defaultProfile = (raw.defaultProfile as string).trim();
    if (!ids.has(defaultProfile)) {
        return { ok: false, error: `defaultProfile「${defaultProfile}」不在 profiles 的 id 列表中。` };
    }

    // 提示词
    if (!isNonEmptyString(raw.systemPrompt)) {
        return { ok: false, error: 'systemPrompt 必须是非空字符串。' };
    }
    if (!isNonEmptyString(raw.promptTemplate)) {
        return { ok: false, error: 'promptTemplate 必须是非空字符串。' };
    }

    // openclaw:可选;若存在须为对象,identity 三字段齐全,url/token 为字符串
    let openclaw: OpenclawConnConfig | undefined;
    if (raw.openclaw !== undefined) {
        if (!isPlainObject(raw.openclaw)) {
            return { ok: false, error: 'openclaw 必须是对象。' };
        }
        const oc = raw.openclaw;
        if (oc.url !== undefined && typeof oc.url !== 'string') {
            return { ok: false, error: 'openclaw.url 必须是字符串。' };
        }
        if (oc.token !== undefined && typeof oc.token !== 'string') {
            return { ok: false, error: 'openclaw.token 必须是字符串。' };
        }
        if (oc.identity !== undefined) {
            if (!isPlainObject(oc.identity)) {
                return { ok: false, error: 'openclaw.identity 必须是对象。' };
            }
            for (const key of ['deviceId', 'publicKeyPem', 'privateKeyPem'] as const) {
                if (!isNonEmptyString(oc.identity[key])) {
                    return { ok: false, error: `openclaw.identity.${key} 必须是非空字符串。` };
                }
            }
        }
        openclaw = oc as OpenclawConnConfig;
    }

    // defaultBackend:可选;若存在须是两个枚举值之一
    if (
        raw.defaultBackend !== undefined &&
        raw.defaultBackend !== 'openclaw' &&
        raw.defaultBackend !== 'runtime'
    ) {
        return { ok: false, error: 'defaultBackend 只能是 "openclaw" 或 "runtime"。' };
    }

    // runtime:可选;若存在须为对象,url 为非空字符串,两个时长为正数,headers 为字符串字典
    let runtime: RuntimeConnConfig | undefined;
    if (raw.runtime !== undefined) {
        if (!isPlainObject(raw.runtime)) {
            return { ok: false, error: 'runtime 必须是对象。' };
        }
        const rt = raw.runtime;
        if (rt.url !== undefined && !isNonEmptyString(rt.url)) {
            return { ok: false, error: 'runtime.url 必须是非空字符串(如 http://127.0.0.1:8080)。' };
        }
        for (const key of ['pollMs', 'reqTimeoutMs'] as const) {
            if (rt[key] !== undefined && (typeof rt[key] !== 'number' || !((rt[key] as number) > 0))) {
                return { ok: false, error: `runtime.${key} 必须是正数(毫秒)。` };
            }
        }
        if (rt.headers !== undefined) {
            if (!isPlainObject(rt.headers)) {
                return { ok: false, error: 'runtime.headers 必须是对象。' };
            }
            for (const [k, v] of Object.entries(rt.headers)) {
                if (typeof v !== 'string') {
                    return { ok: false, error: `runtime.headers.${k} 必须是字符串。` };
                }
            }
        }
        runtime = rt as RuntimeConnConfig;
    }

    // cleanHtml:可选;若存在须为布尔
    if (raw.cleanHtml !== undefined && typeof raw.cleanHtml !== 'boolean') {
        return { ok: false, error: 'cleanHtml 必须是布尔值。' };
    }

    const config: AiConfig = {
        defaultProfile,
        profiles,
        defaultBackend: (raw.defaultBackend as AiBackend) ?? DEFAULT_CONFIG.defaultBackend,
        openclaw: openclaw ?? {},
        runtime: runtime ?? DEFAULT_CONFIG.runtime,
        systemPrompt: (raw.systemPrompt as string),
        promptTemplate: (raw.promptTemplate as string),
        cleanHtml: raw.cleanHtml !== false,
    };
    return { ok: true, config };
}

/**
 * 导入上传的 ai-config.json:读取 → 校验 → 通过则覆盖写入生效路径。
 * 覆盖前把旧文件备份为同目录下 ai-config.json.bak。
 */
export function importAiConfig(srcPath: string): ImportResult {
    let text: string;
    try {
        text = fs.readFileSync(srcPath, 'utf8');
    } catch (err) {
        return { ok: false, error: `读取文件失败:${(err as Error).message}` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `不是合法的 JSON 文件:${(err as Error).message}` };
    }
    const v = validateAiConfig(parsed);
    if (!v.ok || !v.config) {
        return { ok: false, error: v.error || '配置校验未通过。' };
    }
    const dest = getConfigPath();
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true }); // 先建 config/ 目录
        // 覆盖前备份旧配置(若存在),便于回滚
        if (fs.existsSync(dest)) {
            fs.copyFileSync(dest, `${dest}.bak`);
        }
        fs.writeFileSync(dest, JSON.stringify(v.config, null, 4), 'utf8');
    } catch (err) {
        return { ok: false, error: `写入生效配置失败:${(err as Error).message}` };
    }
    return { ok: true, profileCount: v.config.profiles.length };
}

// ===== HTML 清洗(降噪,不做长度截断,保证数据完整) =====
export function cleanHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '') // 去掉内联事件属性
        .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

// 注:提示词拼装(fillTemplate / buildModeHint / 选择器质量准则)已下沉到 ai-executor.ts。
//     那是**后端相关**的事:openclaw 路径要拼整段 message,runtime 路径只发结构化 inputs。

/** 从模型回复中剥出 JSON(处理 ```json 围栏与前后噪声) */
export function extractJson(text: string): unknown {
    if (!text) {
        return null;
    }
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        t = fence[1].trim();
    }
    try {
        return JSON.parse(t);
    } catch {
        // 继续尝试截取首尾大括号
    }
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try {
            return JSON.parse(t.slice(first, last + 1));
        } catch {
            // 解析失败
        }
    }
    return null;
}

// ===== 对外主入口 =====
export interface GenerateInput {
    requirement: string;
    html: string;
    profileId?: string;
    /** 目标提取模式;不传则维持现状(由 agent 自行判断结构) */
    mode?: 'single' | 'list' | 'list-detail' | 'list-action';
    /** mode=list-detail 时携带的现有 list 规则,作为补全 detail 的基础 */
    baseRules?: ExtractConfig;
    /** 上一轮选择器实测反馈(自检回路重生成时附带,告知 agent 哪些选择器 0 命中需修正) */
    feedback?: string;
    /** 指定会话 key(多轮修复复用同一 agent 会话以保留上下文);不传则新建一次性会话 */
    sessionKey?: string;
}

/** 从 AiConfig 取执行器需要的配置切片 */
function toExecutorConfig(cfg: AiConfig): ExecutorConfig {
    return {
        openclaw: cfg.openclaw,
        runtime: cfg.runtime,
        systemPrompt: cfg.systemPrompt,
        promptTemplate: cfg.promptTemplate,
    };
}

/** 调用 AI agent 生成提取规则(后端由配置决定) */
export async function generateExtract(input: GenerateInput): Promise<GenerateResult> {
    const start = Date.now();
    const cfg = loadAiConfig();
    const profile = resolveProfile(cfg, input.profileId);
    if (!profile) {
        return {
            ok: false,
            profileId: input.profileId ?? '',
            profileLabel: '',
            error: '未找到任何可用的 AI 配置档,请检查 ai-config.json',
            elapsedMs: Date.now() - start,
        };
    }

    const backend = resolveBackend(cfg, profile);
    const fields: ExtractFields = {
        requirement: input.requirement,
        html: cfg.cleanHtml === false ? input.html : cleanHtml(input.html),
        mode: input.mode,
        baseRules: input.baseRules,
        feedback: input.feedback,
    };

    try {
        const reply = await getExecutor(backend).request(
            {
                kind: 'extract',
                profile,
                fields,
                sessionKey: input.sessionKey,
                timeoutMs: profile.timeout ?? 120000,
            },
            toExecutorConfig(cfg)
        );
        const rules = extractJson(reply.text);
        if (!rules || typeof rules !== 'object') {
            return {
                ok: false,
                profileId: profile.id,
                profileLabel: profile.label,
                raw: reply.text,
                error: '模型未返回可解析的 JSON 规则',
                sessionKey: reply.sessionKey,
                elapsedMs: Date.now() - start,
                backend,
                sessionId: reply.sessionId,
                usage: reply.usage,
            };
        }
        return {
            ok: true,
            profileId: profile.id,
            profileLabel: profile.label,
            rules: rules as ExtractConfig,
            raw: reply.text,
            sessionKey: reply.sessionKey,
            elapsedMs: Date.now() - start,
            backend,
            sessionId: reply.sessionId,
            usage: reply.usage,
        };
    } catch (err) {
        return {
            ok: false,
            profileId: profile.id,
            profileLabel: profile.label,
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - start,
            backend,
        };
    }
}

// ===== 选择器校正 =====
// 与 generateExtract 同链路(同一套双后端执行器),但目标不同:
// 给某个已录制步骤的脆弱选择器重挑一个更稳定、更通用的选择器。
// 由 renderer 在真实录制 webview 里定位元素、取上下文,发到这里;agent 只输出 {"selector":"..."}。

/** 选择器校正入参 */
export interface FixSelectorInput {
    /** 指定配置档;不传默认用 selector-fix(见下方回退逻辑) */
    profileId?: string;
    /** 当前(脆弱)选择器 */
    current: string;
    /** 失效/脆弱原因的简短说明(如「含疑似随机 id / 框架动态类名」) */
    reason?: string;
    /** 目标元素的 outerHTML(已截断,不含临时标记) */
    elementHtml: string;
    /** 目标元素的祖先链摘要(各级 tag+id+稳定属性+class,从近到远) */
    ancestors?: string;
    /** 上一轮实测反馈(命中 K 个 / 命中错误元素),复用同会话重挑 */
    feedback?: string;
    /** 会话 key:多轮修复复用以保留上下文;不传则新建 */
    sessionKey?: string;
}

/** 选择器校正结果 */
export interface FixSelectorResult {
    ok: boolean;
    profileId: string;
    profileLabel: string;
    /** 校正后的选择器(CSS 或 xpath= 前缀) */
    selector?: string;
    /** 模型原始回复(便于排查) */
    raw?: string;
    error?: string;
    /** 本次会话 key(供多轮修复复用) */
    sessionKey?: string;
    elapsedMs: number;
    /** 本次实际走的后端(排障用) */
    backend?: AiBackend;
    /** runtime 会话 id(可在会话观察台复盘);openclaw 路径为空 */
    sessionId?: string;
    /** token 用量(runtime 路径有) */
    usage?: Record<string, number>;
}

/** selector-fix 找不到时的默认档回退顺序 */
function resolveFixProfile(cfg: AiConfig, id?: string): AiProfile | null {
    const target = id || 'selector-fix';
    return (
        cfg.profiles.find((p) => p.id === target) ??
        cfg.profiles.find((p) => p.id === 'selector-fix') ??
        resolveProfile(cfg, undefined)
    );
}

/** 调用 selector-fix agent 为单个脆弱选择器重挑稳定选择器 */
export async function fixSelector(input: FixSelectorInput): Promise<FixSelectorResult> {
    const start = Date.now();
    const cfg = loadAiConfig();
    const profile = resolveFixProfile(cfg, input.profileId);
    if (!profile) {
        return {
            ok: false,
            profileId: input.profileId ?? '',
            profileLabel: '',
            error: '未找到任何可用的 AI 配置档,请检查 ai-config.json',
            elapsedMs: Date.now() - start,
        };
    }

    const backend = resolveBackend(cfg, profile);
    const fields: FixFields = {
        current: input.current,
        elementHtml: input.elementHtml,
        reason: input.reason,
        ancestors: input.ancestors,
        feedback: input.feedback,
    };

    try {
        const reply = await getExecutor(backend).request(
            {
                kind: 'fix-selector',
                profile,
                fields,
                sessionKey: input.sessionKey,
                timeoutMs: profile.timeout ?? 90000,
            },
            toExecutorConfig(cfg)
        );
        const parsed = extractJson(reply.text) as { selector?: unknown } | null;
        const selector =
            parsed && typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
        if (!selector) {
            return {
                ok: false,
                profileId: profile.id,
                profileLabel: profile.label,
                raw: reply.text,
                error: '模型未返回可解析的 { "selector": "..." }',
                sessionKey: reply.sessionKey,
                elapsedMs: Date.now() - start,
                backend,
                sessionId: reply.sessionId,
                usage: reply.usage,
            };
        }
        return {
            ok: true,
            profileId: profile.id,
            profileLabel: profile.label,
            selector,
            raw: reply.text,
            sessionKey: reply.sessionKey,
            elapsedMs: Date.now() - start,
            backend,
            sessionId: reply.sessionId,
            usage: reply.usage,
        };
    } catch (err) {
        return {
            ok: false,
            profileId: profile.id,
            profileLabel: profile.label,
            error: err instanceof Error ? err.message : String(err),
            sessionKey: input.sessionKey,
            elapsedMs: Date.now() - start,
            backend,
        };
    }
}

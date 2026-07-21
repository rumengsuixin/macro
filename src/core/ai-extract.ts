// AI 提取规则生成:对接 openclaw agent。
// macro 作为客户端连本机 OpenClaw Gateway(WebSocket + Ed25519,见 openclaw-client.ts),
// 把「采集需求 + 网页 HTML」发给指定 agent,收回提取规则 JSON。
//
// 设计要点:
// - profile 列表式:每个 profile 指定一个 openclaw agent 目标(agentId + sessionKey 前缀)。
//   可配多个,对接时按 profileId 选用,UI 下拉展示。
// - 单次请求即用即走:连接 → 认证 → chat.send(deliver:false) → 收草稿 → 关闭。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtractConfig } from './macro-types';
import { OpenclawClient, type OpenclawConnConfig } from './openclaw-client';

/** 单个 AI 配置档(= 一个 openclaw agent 目标) */
export interface AiProfile {
    /** 唯一标识,UI/IPC 用它选择 */
    id: string;
    /** 显示名称 */
    label: string;
    /** openclaw agent id(sessionKey 第二段) */
    agentId: string;
    /** sessionKey 前缀;实际 key = `${sessionKeyPrefix}:${uuid}` */
    sessionKeyPrefix: string;
    /** 请求超时(毫秒) */
    timeout?: number;
}

/** AI 提取整体配置 */
export interface AiConfig {
    /** 默认使用的配置档 id */
    defaultProfile: string;
    /** 配置档列表 */
    profiles: AiProfile[];
    /** openclaw 连接覆盖(默认自动读 ~/.openclaw) */
    openclaw?: OpenclawConnConfig;
    /** 系统提示词(拼进发给 agent 的 message) */
    systemPrompt: string;
    /** 提示词模板,支持占位符 {requirement} 与 {html} */
    promptTemplate: string;
    /** 是否在发送前清洗 HTML(去 script/style/注释降噪),默认 true */
    cleanHtml?: boolean;
}

/** 配置档摘要(给渲染进程下拉用) */
export interface ProfileSummary {
    id: string;
    label: string;
    agentId: string;
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
}

// ===== 默认配置(首次运行自动写入项目根 ai-config.json) =====
// 注:详细的提取规则结构(list/single、type 含义)由专用 agent 的 SOUL.md 持有,
// 这里只负责传入「需求 + HTML」并保留一句「只输出 JSON」的安全兜底,提示词尽量精简。
// 通用选择器质量准则:与具体框架无关,凡生成规则一律注入,从源头降低「选错选择器」概率。
// 不专项 hack 某个组件库——下面的框架名只作举例,核心是「避免动态/脆弱选择器、注意克隆 DOM」。
// 极简指针:完整选择器质量规范在 agent 侧 SOUL.md〈选择器质量准则〉(单一可信源);
// 客户端仅注入这一行核心红线作兜底,防 agent 侧准则缺失/被改坏时质量失守。
const SELECTOR_QUALITY_GUIDE =
    '【选择器质量准则(完整规范见你的〈选择器质量准则〉)】选择器务必稳定可命中:优先用 ' +
    'data-*/id/aria-label/语义 class/可见文本等稳定锚点,避免框架运行时动态类名、结构性伪类与隐藏的' +
    '克隆 DOM;actionSelector 须能在每个列表项内点中。严禁把随用户交互/表单校验实时变化的**状态属性**' +
    '作为选择条件(如 aria-invalid/aria-expanded/aria-selected/aria-checked/aria-pressed/aria-busy/' +
    'aria-disabled/aria-current 及元素 value)——录制那一刻的状态回放时往往不存在,会命中 0 个导致超时。';

const DEFAULT_SYSTEM_PROMPT =
    '只输出一个 JSON 对象作为网页提取规则,不要任何解释、前言或 Markdown 代码块标记。';

const DEFAULT_PROMPT_TEMPLATE = [
    '采集需求:{requirement}',
    '',
    '网页 HTML:',
    '{html}',
].join('\n');

const DEFAULT_CONFIG: AiConfig = {
    defaultProfile: 'webextract',
    profiles: [
        {
            id: 'webextract',
            label: '网页提取 Agent(webextract)',
            agentId: 'webextract',
            sessionKeyPrefix: 'agent:webextract:macro:extract',
            timeout: 120000,
        },
        {
            id: 'selector-fix',
            label: '选择器校正 Agent(selector-fix)',
            agentId: 'selector-fix',
            sessionKeyPrefix: 'agent:selector-fix:macro:selector',
            timeout: 90000,
        },
    ],
    openclaw: {},
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    cleanHtml: true,
};

// ===== 配置读写 =====
/** ai-config.json 的绝对路径(项目根目录) */
export function getConfigPath(): string {
    // 打包后主进程会设 MACRO_DATA_DIR 指向用户可写目录;开发时回退项目根
    const base = process.env.MACRO_DATA_DIR;
    if (base) return path.join(base, 'ai-config.json');
    return path.resolve(__dirname, '..', '..', 'ai-config.json');
}

/** 读取配置;不存在则写入默认配置 */
export function loadAiConfig(): AiConfig {
    const file = getConfigPath();
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 4), 'utf8');
        return DEFAULT_CONFIG;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AiConfig>;
        return {
            defaultProfile: raw.defaultProfile || DEFAULT_CONFIG.defaultProfile,
            profiles:
                Array.isArray(raw.profiles) && raw.profiles.length > 0
                    ? (raw.profiles as AiProfile[])
                    : DEFAULT_CONFIG.profiles,
            openclaw: raw.openclaw ?? DEFAULT_CONFIG.openclaw,
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
        profiles: cfg.profiles.map((p) => ({ id: p.id, label: p.label, agentId: p.agentId })),
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

    // cleanHtml:可选;若存在须为布尔
    if (raw.cleanHtml !== undefined && typeof raw.cleanHtml !== 'boolean') {
        return { ok: false, error: 'cleanHtml 必须是布尔值。' };
    }

    const config: AiConfig = {
        defaultProfile,
        profiles,
        openclaw: openclaw ?? {},
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

// ===== 提示词拼装 =====
function fillTemplate(template: string, requirement: string, html: string): string {
    const req = requirement.trim() || '(未填写,请根据页面主要内容自动判断要采集的字段)';
    return template.split('{requirement}').join(req).split('{html}').join(html);
}

/**
 * 按目标 mode 动态构造一段「模式前提」,拼进发给 agent 的 message。
 * 不传 mode 时返回空串(旧路径行为不变);list-detail 时完整内嵌作为基础的 list 规则(不截断)。
 */
function buildModeHint(
    mode?: 'single' | 'list' | 'list-detail' | 'list-action',
    baseRules?: ExtractConfig
): string {
    if (mode === 'list-action') {
        return [
            '【目标模式前提】请输出 mode="list-action" 的「列表逐项动作」规则:',
            '结构为 { "mode": "list-action", "listSelector": "...", "actionSelector": ... }。',
            'listSelector 是页面上重复出现的列表项容器选择器;',
            'actionSelector 是每项要依次执行的点击动作,可为:',
            '  · 单个字符串(相对列表项查找的按钮选择器,如 "button.download");',
            '  · 或字符串/对象数组表示多个动作依次点击,如',
            '    ["a.expand", "button.download"] 或 [{"selector":"button.dl","scope":"item"},{"selector":"#global-confirm","scope":"page"}]。',
            '每个动作可带 scope:"item"(缺省,相对列表项查找)或 "page"(全局页面查找,用于按钮挂在页面别处)。',
            '通常一个下载按钮用单字符串即可;仅当每项需要多步点击时才用数组。',
            '只输出 listSelector 与 actionSelector,不要 fields、不要详情结构、不要其它字段。',
            '适用场景:列表每一项都有按钮需要逐项点击(如每点一次触发一次文件下载)。',
        ].join('\n');
    }
    if (mode === 'single') {
        return [
            '【目标模式前提】请输出 mode="single" 的整页提取规则:',
            '结构为 { "mode": "single", "fields": [...] },对整页只取一组字段,不要列表或详情结构。',
        ].join('\n');
    }
    if (mode === 'list') {
        return [
            '【目标模式前提】请输出 mode="list" 的列表提取规则:',
            '结构为 { "mode": "list", "listSelector": "...", "fields": [...] }。',
            '只采集列表页本身的重复项字段,不要包含任何详情页字段。',
        ].join('\n');
    }
    if (mode === 'list-detail') {
        const base = baseRules ? JSON.stringify(baseRules, null, 4) : '(未提供)';
        return [
            '【目标模式前提】请输出 mode="list-detail" 的「列表+详情」提取规则:',
            '结构为 { "mode": "list-detail", "listSelector": "...", "fields": [...], "detailFields": [...] }。',
            '以下是已有的 list 规则,请以它为基础,保留其 listSelector 与 fields 完全不变,',
            '只补充 detailFields(进入详情页后要抓取的字段,字段名勿与 fields 重名)。',
            '现有 list 规则:',
            base,
        ].join('\n');
    }
    return '';
}

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

/** 调用 openclaw agent 生成提取规则 */
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

    const html = cfg.cleanHtml === false ? input.html : cleanHtml(input.html);
    const body = fillTemplate(cfg.promptTemplate, input.requirement, html);
    const modeHint = buildModeHint(input.mode, input.baseRules);
    // 选择器质量准则无条件注入(不依赖用户既有 ai-config.json,老装机也即时生效)。
    // 现为极简指针:完整规范在 agent 侧 SOUL.md,客户端仅注入核心红线作兜底,避免与 SOUL.md 全文重复。
    // feedback 段放最后:重生成时把「上一轮哪些选择器 0 命中」直接喂回,要求据此修正。
    const feedbackBlock = input.feedback
        ? '【上一轮选择器实测反馈】以下选择器在当前页未命中,请据此修正后重新输出完整规则:\n' +
          input.feedback
        : '';
    const message =
        (cfg.systemPrompt ? cfg.systemPrompt + '\n\n' : '') +
        SELECTOR_QUALITY_GUIDE + '\n\n' +
        (modeHint ? modeHint + '\n\n' : '') +
        body +
        (feedbackBlock ? '\n\n' + feedbackBlock : '');
    // 多轮修复复用同一会话以保留上下文;首轮不传则新建一次性会话
    const sessionKey = input.sessionKey ?? `${profile.sessionKeyPrefix}:${randomUUID()}`;
    const timeout = profile.timeout ?? 120000;

    let client: OpenclawClient | null = null;
    try {
        client = new OpenclawClient(cfg.openclaw ?? {});
        await client.connect();
        const reply = await client.requestDraft(sessionKey, message, timeout);
        const rules = extractJson(reply);
        if (!rules || typeof rules !== 'object') {
            return {
                ok: false,
                profileId: profile.id,
                profileLabel: profile.label,
                raw: reply,
                error: '模型未返回可解析的 JSON 规则',
                sessionKey,
                elapsedMs: Date.now() - start,
            };
        }
        return {
            ok: true,
            profileId: profile.id,
            profileLabel: profile.label,
            rules: rules as ExtractConfig,
            raw: reply,
            sessionKey,
            elapsedMs: Date.now() - start,
        };
    } catch (err) {
        return {
            ok: false,
            profileId: profile.id,
            profileLabel: profile.label,
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - start,
        };
    } finally {
        client?.close();
    }
}

// ===== 选择器校正(对接 selector-fix agent)=====
// 与 generateExtract 同链路(连接→认证→chat.send(deliver:false)→收草稿→关闭),
// 但目标不同:给某个已录制步骤的脆弱选择器重挑一个更稳定、更通用的选择器。
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

    // 组装 message:系统兜底 + 选择器质量红线 + 任务说明 + 元素上下文 + 可选反馈。
    // 完整〈选择器质量准则〉在 selector-fix agent 侧 SOUL.md(单一可信源),此处只注入核心红线兜底。
    const taskHint = [
        '【任务:选择器校正】下面给你一个网页元素的 DOM 上下文,以及它当前那个不稳定的选择器。',
        '请为【这个元素】重挑一个唯一命中它、且尽量稳定通用的选择器。',
        '只输出一个 JSON 对象:{ "selector": "..." },不要任何解释、前言或 Markdown 代码块标记。',
        'selector 可以是 CSS,若用文本/属性锚定更稳可用 xpath=// 前缀。',
    ].join('\n');
    const contextBlock = [
        '当前选择器:' + input.current,
        input.reason ? '判定原因:' + input.reason : '',
        '目标元素 outerHTML:',
        input.elementHtml,
        input.ancestors ? '祖先链(从近到远):\n' + input.ancestors : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    const feedbackBlock = input.feedback
        ? '【上一轮实测反馈】你上次给的选择器未通过,请据此修正后重新只输出 {"selector":"..."}:\n' +
          input.feedback
        : '';
    const message =
        (cfg.systemPrompt ? cfg.systemPrompt + '\n\n' : '') +
        SELECTOR_QUALITY_GUIDE + '\n\n' +
        taskHint + '\n\n' +
        contextBlock +
        (feedbackBlock ? '\n\n' + feedbackBlock : '');

    const sessionKey = input.sessionKey ?? `${profile.sessionKeyPrefix}:${randomUUID()}`;
    const timeout = profile.timeout ?? 90000;

    let client: OpenclawClient | null = null;
    try {
        client = new OpenclawClient(cfg.openclaw ?? {});
        await client.connect();
        const reply = await client.requestDraft(sessionKey, message, timeout);
        const parsed = extractJson(reply) as { selector?: unknown } | null;
        const selector =
            parsed && typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
        if (!selector) {
            return {
                ok: false,
                profileId: profile.id,
                profileLabel: profile.label,
                raw: reply,
                error: '模型未返回可解析的 { "selector": "..." }',
                sessionKey,
                elapsedMs: Date.now() - start,
            };
        }
        return {
            ok: true,
            profileId: profile.id,
            profileLabel: profile.label,
            selector,
            raw: reply,
            sessionKey,
            elapsedMs: Date.now() - start,
        };
    } catch (err) {
        return {
            ok: false,
            profileId: profile.id,
            profileLabel: profile.label,
            error: err instanceof Error ? err.message : String(err),
            sessionKey,
            elapsedMs: Date.now() - start,
        };
    } finally {
        client?.close();
    }
}

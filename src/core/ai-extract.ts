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
    /** 耗时(毫秒) */
    elapsedMs: number;
}

// ===== 默认配置(首次运行自动写入项目根 ai-config.json) =====
// 注:详细的提取规则结构(list/single、type 含义)由专用 agent 的 SOUL.md 持有,
// 这里只负责传入「需求 + HTML」并保留一句「只输出 JSON」的安全兜底,提示词尽量精简。
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
    ],
    openclaw: {},
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    cleanHtml: true,
};

// ===== 配置读写 =====
/** ai-config.json 的绝对路径(项目根目录) */
export function getConfigPath(): string {
    // 编译后位于 dist/core/ai-extract.js,向上两级即项目根
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
function buildModeHint(mode?: 'single' | 'list' | 'list-detail', baseRules?: ExtractConfig): string {
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
            '结构为 { "mode": "list-detail", "listSelector": "...", "fields": [...], "detailLinkSelector": "...", "detailFields": [...] }。',
            '以下是已有的 list 规则,请以它为基础,保留其 listSelector 与 fields 完全不变,',
            '只补充详情相关信息:detailLinkSelector(列表项内指向详情页的链接选择器,取其 href)与 detailFields(进入详情页后要抓取的字段,字段名勿与 fields 重名)。',
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
    mode?: 'single' | 'list' | 'list-detail';
    /** mode=list-detail 时携带的现有 list 规则,作为补全 detail 的基础 */
    baseRules?: ExtractConfig;
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
    const message =
        (cfg.systemPrompt ? cfg.systemPrompt + '\n\n' : '') +
        (modeHint ? modeHint + '\n\n' : '') +
        body;
    const sessionKey = `${profile.sessionKeyPrefix}:${randomUUID()}`;
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
                elapsedMs: Date.now() - start,
            };
        }
        return {
            ok: true,
            profileId: profile.id,
            profileLabel: profile.label,
            rules: rules as ExtractConfig,
            raw: reply,
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

// AI 后端执行器抽象:同一个任务,两条后端路径,任选其一。
//
//   openclaw —— WebSocket + Ed25519 连本机/远端 OpenClaw Gateway(存量路径,行为逐字不变)
//   runtime  —— HTTP 提交 + 轮询 mcp-agent-runtime worker(主线路径)
//
// 关键差异(决定了抽象长这样):两个后端**吃的形态不同**。
//   OpenClaw 侧的判定规格在工作区 SOUL.md,客户端要把「系统提示 + 质量准则 + 模式前提 + 需求 + HTML
//   + 反馈」拼成一整段话发过去;
//   runtime 侧的规格已收进域包(domains/webextract、domains/selector_fix),客户端只要发结构化 inputs。
// 所以 AiTask 只携带**与后端无关的语义字段**,拼装 / 映射各自在执行器内部完成。
//
// 参照范式:apk-compliance-client 的 app/services/agent_executor.py(同一套双后端思路,已跑通)。
import { randomUUID } from 'node:crypto';
import type { ExtractConfig } from './macro-types';
import { OpenclawClient, type OpenclawConnConfig } from './openclaw-client';
import { runDomain, type RuntimeConnConfig } from './runtime-client';

/** 后端名 */
export type AiBackend = 'openclaw' | 'runtime';

/** 单个 AI 配置档(= 一个 agent 目标)。runtime 路径只用到 domain / timeout */
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
    /** 本档走哪个后端;不填则用顶层 defaultBackend */
    backend?: AiBackend;
    /** runtime 域名(runtime 后端专用);不填则按 kind 取内置默认域 */
    domain?: string;
    /**
     * runtime 路径的一次性任务指令覆盖(应急通道,默认不填)。
     * 填了就作为 `prompt` 下发,替代域包的 task_directive;不填 = 以域包为准。
     * 存在理由:域包烘进 runtime 镜像,改提示词要 rebuild;线上急救时可从这里临时改口径。
     * ⚠️ 不复用顶层 systemPrompt —— 那是**全局一条**、措辞偏「提取规则」,
     *    拿它当 selector_fix 的收尾指令会把 agent 带偏。故按档单配。
     */
    promptOverride?: string;
}

/** 执行器需要的配置切片(由 ai-extract 从 AiConfig 里取) */
export interface ExecutorConfig {
    openclaw?: OpenclawConnConfig;
    runtime?: RuntimeConnConfig;
    /** 系统提示词(**仅 openclaw 路径**拼进 message;runtime 路径的规格在域包里) */
    systemPrompt: string;
    /** 提示词模板,支持占位符 {requirement} 与 {html}(**仅 openclaw 路径**用) */
    promptTemplate: string;
}

/** 与后端无关的任务描述 */
export interface AiTask {
    kind: 'extract' | 'fix-selector';
    profile: AiProfile;
    /** 语义字段:extract 用 requirement/html/…;fix-selector 用 current/elementHtml/… */
    fields: ExtractFields | FixFields;
    /** 会话 key(openclaw 复用会话用;runtime 无会话续接,仅作标识回传) */
    sessionKey?: string;
    timeoutMs: number;
}

/** 提取规则生成的语义字段 */
export interface ExtractFields {
    requirement: string;
    html: string;
    mode?: 'single' | 'list' | 'list-detail' | 'list-action';
    baseRules?: ExtractConfig;
    feedback?: string;
}

/** 选择器校正的语义字段 */
export interface FixFields {
    current: string;
    elementHtml: string;
    reason?: string;
    ancestors?: string;
    feedback?: string;
}

/** 一次请求的回复 */
export interface AiReply {
    /** 模型最终文本,交给调用方的 extractJson() 剥 JSON */
    text: string;
    /** 本次实际使用的会话 key(调用方回传可复用) */
    sessionKey?: string;
    /** runtime 会话 id(可在会话观察台复盘);openclaw 路径为空 */
    sessionId?: string;
    /** token 用量(runtime 路径有;openclaw 路径为空) */
    usage?: Record<string, number>;
}

/** 后端执行器 */
export interface AiExecutor {
    readonly name: AiBackend;
    request(task: AiTask, cfg: ExecutorConfig): Promise<AiReply>;
}

// ===== OpenClaw 路径:客户端拼整段 message(与迁移前逐字一致)=====

// 通用选择器质量准则:与具体框架无关,凡生成规则一律注入,从源头降低「选错选择器」概率。
// 极简指针:完整规范在 agent 侧 SOUL.md〈选择器质量准则〉(该路径的单一可信源);
// 客户端仅注入这一行核心红线作兜底,防 agent 侧准则缺失/被改坏时质量失守。
// ⚠️ 仅 openclaw 路径注入 —— runtime 路径的准则由域包 _shared/selector-quality.md 权威持有,
//    再注入一遍只是重复占上下文。
const SELECTOR_QUALITY_GUIDE =
    '【选择器质量准则(完整规范见你的〈选择器质量准则〉)】选择器务必稳定可命中:优先用 ' +
    'data-*/id/aria-label/语义 class/可见文本等稳定锚点,避免框架运行时动态类名、结构性伪类与隐藏的' +
    '克隆 DOM;actionSelector 须能在每个列表项内点中。严禁把随用户交互/表单校验实时变化的**状态属性**' +
    '作为选择条件(如 aria-invalid/aria-expanded/aria-selected/aria-checked/aria-pressed/aria-busy/' +
    'aria-disabled/aria-current 及元素 value)——录制那一刻的状态回放时往往不存在,会命中 0 个导致超时。';

/** 填充提示词模板占位符 */
function fillTemplate(template: string, requirement: string, html: string): string {
    const req = requirement.trim() || '(未填写,请根据页面主要内容自动判断要采集的字段)';
    return template.split('{requirement}').join(req).split('{html}').join(html);
}

/**
 * 按目标 mode 动态构造一段「模式前提」,拼进发给 agent 的 message。
 * 不传 mode 时返回空串;list-detail 时完整内嵌作为基础的 list 规则(不截断)。
 */
function buildModeHint(mode?: ExtractFields['mode'], baseRules?: ExtractConfig): string {
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

/** 选择器校正任务的说明段 */
const FIX_TASK_HINT = [
    '【任务:选择器校正】下面给你一个网页元素的 DOM 上下文,以及它当前那个不稳定的选择器。',
    '请为【这个元素】重挑一个唯一命中它、且尽量稳定通用的选择器。',
    '只输出一个 JSON 对象:{ "selector": "..." },不要任何解释、前言或 Markdown 代码块标记。',
    'selector 可以是 CSS,若用文本/属性锚定更稳可用 xpath=// 前缀。',
].join('\n');

/** 把语义字段拼成 OpenClaw 侧那一整段 message(与迁移前逐字一致) */
function buildOpenclawMessage(task: AiTask, cfg: ExecutorConfig): string {
    const head = (cfg.systemPrompt ? cfg.systemPrompt + '\n\n' : '') + SELECTOR_QUALITY_GUIDE + '\n\n';

    if (task.kind === 'extract') {
        const f = task.fields as ExtractFields;
        const body = fillTemplate(cfg.promptTemplate, f.requirement, f.html);
        const modeHint = buildModeHint(f.mode, f.baseRules);
        const feedbackBlock = f.feedback
            ? '【上一轮选择器实测反馈】以下选择器在当前页未命中,请据此修正后重新输出完整规则:\n' + f.feedback
            : '';
        return head + (modeHint ? modeHint + '\n\n' : '') + body + (feedbackBlock ? '\n\n' + feedbackBlock : '');
    }

    const f = task.fields as FixFields;
    const contextBlock = [
        '当前选择器:' + f.current,
        f.reason ? '判定原因:' + f.reason : '',
        '目标元素 outerHTML:',
        f.elementHtml,
        f.ancestors ? '祖先链(从近到远):\n' + f.ancestors : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    const feedbackBlock = f.feedback
        ? '【上一轮实测反馈】你上次给的选择器未通过,请据此修正后重新只输出 {"selector":"..."}:\n' + f.feedback
        : '';
    return head + FIX_TASK_HINT + '\n\n' + contextBlock + (feedbackBlock ? '\n\n' + feedbackBlock : '');
}

/** OpenClaw Gateway 执行器(存量后端) */
class OpenclawExecutor implements AiExecutor {
    readonly name = 'openclaw' as const;

    async request(task: AiTask, cfg: ExecutorConfig): Promise<AiReply> {
        const message = buildOpenclawMessage(task, cfg);
        // 多轮修复复用同一会话以保留上下文;首轮不传则新建一次性会话
        const sessionKey = task.sessionKey ?? `${task.profile.sessionKeyPrefix}:${randomUUID()}`;
        let client: OpenclawClient | null = null;
        try {
            client = new OpenclawClient(cfg.openclaw ?? {});
            await client.connect();
            const text = await client.requestDraft(sessionKey, message, task.timeoutMs);
            return { text, sessionKey };
        } finally {
            client?.close();
        }
    }
}

// ===== runtime 路径:发结构化 inputs 给域包 =====

/** kind → runtime 默认域名(profile.domain 可覆盖) */
const DEFAULT_DOMAINS: Record<AiTask['kind'], string> = {
    extract: 'webextract',
    'fix-selector': 'selector_fix',
};

/**
 * 语义字段 → runtime inputs 键名。
 * 键名必须与域包 workflow.md 里写明的一致 —— runtime 侧**没有 schema、传错不报错**,
 * 只会让 agent 拿不到它期待的信息、静默降级。改键名务必两边同步。
 * 顺序也有意义:inputs 按插入序拼成 `k=v` 逐行,大块素材(html / element_html)放靠后。
 */
function buildRuntimeInputs(task: AiTask): Record<string, string> {
    const out: Record<string, string> = {};
    /** 只塞有值的键 —— 空值会变成 `mode=` 这种噪声行 */
    const put = (k: string, v: string | undefined): void => {
        if (v && v.trim()) {
            out[k] = v;
        }
    };

    if (task.kind === 'extract') {
        const f = task.fields as ExtractFields;
        put('requirement', f.requirement.trim() || '(未填写,请根据页面主要内容自动判断要采集的字段)');
        put('mode', f.mode);
        put('base_rules', f.baseRules ? JSON.stringify(f.baseRules) : undefined);
        put('html', f.html);
        put('feedback', f.feedback);
        return out;
    }

    const f = task.fields as FixFields;
    put('current', f.current);
    put('reason', f.reason);
    put('ancestors', f.ancestors);
    put('element_html', f.elementHtml);
    put('feedback', f.feedback);
    return out;
}

/** mcp-agent-runtime worker 执行器(主线后端) */
class RuntimeExecutor implements AiExecutor {
    readonly name = 'runtime' as const;

    async request(task: AiTask, cfg: ExecutorConfig): Promise<AiReply> {
        const domain = task.profile.domain?.trim() || DEFAULT_DOMAINS[task.kind];
        // 判定规格(身份 / 输出契约 / 选择器质量准则 / 模式结构)全在域包里,
        // 这里**不再**注入 SELECTOR_QUALITY_GUIDE 与模式前提 —— 再拼一遍只是重复占上下文。
        // 只有本档显式配了 promptOverride 才覆盖域的 task_directive(应急通道,默认不发)。
        const override = task.profile.promptOverride?.trim() || undefined;
        const res = await runDomain(
            {
                domain,
                inputs: buildRuntimeInputs(task),
                prompt: override,
                timeoutMs: task.timeoutMs,
            },
            cfg.runtime ?? {}
        );
        return {
            text: res.content,
            // runtime 无会话续接:原样回传调用方给的 key(没有就不回),不伪造"可复用"的假象
            sessionKey: task.sessionKey,
            sessionId: res.sessionId,
            usage: res.usage,
        };
    }
}

/** 按后端名取执行器实例('runtime' → RuntimeExecutor,否则 OpenClawExecutor) */
export function getExecutor(name: AiBackend): AiExecutor {
    return name === 'runtime' ? new RuntimeExecutor() : new OpenclawExecutor();
}

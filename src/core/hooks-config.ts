// 事件钩子配置:加载 / 校验 hooks.json。沿用 json-config 通用套路。
// 默认 enabled:false(inert 模板,含四事件示例、自文档),不显式开则零对外。坏 JSON 回退 {enabled:false}。
import type { HooksConfig, HookAction, HookEvent } from './macro-types';
import { loadJsonConfig, saveJsonConfig } from './json-config';

const EVENTS: readonly HookEvent[] = ['on-start', 'on-progress', 'on-complete', 'on-failure'];

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 归一单个动作;非法(缺必填/未知 action)返回 null 剔除 */
function normAction(v: unknown): HookAction | null {
    if (!v || typeof v !== 'object') {
        return null;
    }
    const r = v as Record<string, unknown>;
    switch (r.action) {
        case 'webhook': {
            const url = str(r.url);
            if (!url) return null;
            const headers =
                r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)
                    ? (r.headers as Record<string, string>)
                    : undefined;
            return {
                action: 'webhook',
                url,
                method: str(r.method),
                headers,
                bodyTemplate: str(r.bodyTemplate),
                timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined,
            };
        }
        case 'command': {
            const exe = str(r.exe);
            if (!exe) return null;
            const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : undefined;
            return {
                action: 'command',
                exe,
                args,
                cwd: str(r.cwd),
                timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined,
            };
        }
        case 'status-file': {
            const p = str(r.path);
            if (!p) return null;
            return { action: 'status-file', path: p, template: str(r.template) };
        }
        case 'notify': {
            const title = str(r.title);
            if (!title) return null;
            return { action: 'notify', title, body: str(r.body) };
        }
        default:
            return null;
    }
}

function normalize(raw: unknown): HooksConfig {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const events: HooksConfig['events'] = {};
    const evRaw =
        r.events && typeof r.events === 'object' && !Array.isArray(r.events)
            ? (r.events as Record<string, unknown>)
            : {};
    for (const ev of EVENTS) {
        const list = evRaw[ev];
        if (Array.isArray(list)) {
            const actions = list.map(normAction).filter((a): a is HookAction => a !== null);
            if (actions.length > 0) {
                events[ev] = actions;
            }
        }
    }
    return { enabled: r.enabled === true, events };
}

/** inert 模板:enabled:false + 四事件示例,字段名即文档 */
function templateConfig(): HooksConfig {
    return {
        enabled: false,
        events: {
            'on-start': [{ action: 'notify', title: '开始回放 {{macroName}}', body: '' }],
            'on-complete': [
                {
                    action: 'webhook',
                    url: 'https://hooks.example.com/replace-me',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    bodyTemplate: '{"text":"宏 {{macroName}} 完成:{{rowCount}} 行,耗时 {{elapsedMs}}ms"}',
                    timeoutMs: 10000,
                },
                {
                    action: 'status-file',
                    path: '{{dataRoot}}/status/last-run.json',
                    template: '{"status":"{{status}}","rows":{{rowCount}},"at":"{{finishedAt}}"}',
                },
            ],
            'on-failure': [
                { action: 'notify', title: '回放失败:{{macroName}}', body: '{{error.stepType}} @ {{error.url}}' },
            ],
        },
    };
}

/** 坏 JSON / 读失败兜底:全关 */
const FALLBACK: HooksConfig = { enabled: false, events: {} };

/** 加载 hooks.json(首次写 inert 模板、逐动作归一剔非法、坏 JSON 回退全关) */
export function loadHooksConfig(filePath: string): HooksConfig {
    return loadJsonConfig<HooksConfig>({
        filePath,
        buildTemplate: templateConfig,
        normalize,
        fallback: FALLBACK,
    });
}

/** 仅切换总开关并写回(UI 开关用),返回最新配置 */
export function setHooksEnabled(filePath: string, enabled: boolean): HooksConfig {
    const cfg = loadHooksConfig(filePath);
    cfg.enabled = enabled === true;
    saveJsonConfig(filePath, cfg);
    return cfg;
}

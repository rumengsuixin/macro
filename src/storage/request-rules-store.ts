// 录制端请求改写规则存储:以 JSON 文件保存 / 加载 RequestRulesConfig。
// 首次不存在时自动生成 inert 模板(enabled=false),既安全又自文档化。
import fs from 'node:fs';
import type {
    RequestRule,
    ResendRule,
    RequestRulesConfig,
    TimelineRecordConfig,
} from '../core/macro-types';

/** 空配置:不启用、无规则(加载失败或字段缺失时的兜底) */
function emptyConfig(): RequestRulesConfig {
    return { enabled: false, rules: [] };
}

/**
 * inert 模板:默认关闭 + 一条示例规则,供用户照着改。
 * 写成合法 JSON(JSON 无注释),字段名即说明。
 */
function templateConfig(): RequestRulesConfig {
    return {
        enabled: false,
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
        resends: [
            {
                urlPattern: '*/api/trigger*',
                delayMs: 5000,
                bodyType: 'json',
                set: { retry: true },
                repeat: 1,
            },
        ],
        // record:「只记录不修改」支路(独立于 enabled)。改成 enabled:true 即拦截并记录所有请求
        // (不限 method)+ 响应到 timelines/timeline-*.jsonl,供事后分析;不改写任何请求。
        record: { enabled: false, urlPattern: '*', includeBody: true },
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
    if (typeof r.targetUrl === 'string' && r.targetUrl.trim()) {
        rule.targetUrl = r.targetUrl;
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
    return record;
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
        const resends = Array.isArray(raw.resends)
            ? raw.resends.map(normalizeResendRule).filter((x): x is ResendRule => x !== null)
            : [];
        return {
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
            rules,
            ...(resends.length ? { resends } : {}),
            ...(record ? { record } : {}),
        };
    } catch {
        // 坏 JSON 等异常:回退空配置
        return emptyConfig();
    }
}

// 录制端请求改写规则存储:以 JSON 文件保存 / 加载 RequestRulesConfig。
// 首次不存在时自动生成 inert 模板(enabled=false),既安全又自文档化。
import fs from 'node:fs';
import type { RequestRule, RequestRulesConfig } from '../core/macro-types';

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
                set: { pageSize: 100, keyword: '替换成你要的值' },
                remove: [],
            },
        ],
    };
}

/** 校验并归一化单条规则;非法返回 null(过滤掉) */
function normalizeRule(raw: unknown): RequestRule | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || !r.urlPattern.trim()) {
        return null; // 无匹配模式的规则无意义
    }
    const rule: RequestRule = { urlPattern: r.urlPattern };
    if (r.bodyType === 'json' || r.bodyType === 'form') {
        rule.bodyType = r.bodyType;
    }
    if (r.set && typeof r.set === 'object' && !Array.isArray(r.set)) {
        rule.set = r.set as Record<string, unknown>;
    }
    if (Array.isArray(r.remove)) {
        rule.remove = r.remove.filter((x): x is string => typeof x === 'string');
    }
    return rule;
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
        return {
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
            rules,
        };
    } catch {
        // 坏 JSON 等异常:回退空配置
        return emptyConfig();
    }
}

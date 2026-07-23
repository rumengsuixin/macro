// 回放行为档存储:以 JSON 文件保存 / 加载 ReplayProfileConfig(多档可切换)。
// 沿用 json-config 通用套路:首次写内联模板(含 default/slow-site/anti-bot 三档自文档)、逐字段归一、坏 JSON 回退现状。
import type {
    ReplayProfile,
    ReplayProfileConfig,
    RetryPolicy,
    StepDelay,
    PaginationPacing,
    OnErrorPolicy,
} from '../core/macro-types';
import { loadJsonConfig, saveJsonConfig } from '../core/json-config';

/** default 档 = 现状写死值,保证「配置缺失/未切档 = 现有行为」 */
export function defaultProfile(): ReplayProfile {
    return {
        globalTimeoutMs: 60000,
        stepTimeoutMs: {},
        retry: { count: 0, backoff: 'fixed', baseMs: 500, factor: 2, maxMs: 10000 },
        stepDelay: { min: 0, max: 0 },
        onError: 'abort',
        onErrorByType: {},
        pagination: { settleTimeoutMs: 30000, perPageDelayMs: 0 },
        scrollBottomWaitMs: 1000,
    };
}

const VALID_ON_ERROR: readonly OnErrorPolicy[] = ['abort', 'skip', 'continue', 'retry'];

function normOnError(v: unknown, fallback: OnErrorPolicy): OnErrorPolicy {
    return typeof v === 'string' && (VALID_ON_ERROR as readonly string[]).includes(v)
        ? (v as OnErrorPolicy)
        : fallback;
}

function normPosNum(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 归一 Record<string, number>(如 stepTimeoutMs):仅保留合法非负数值项 */
function normNumMap(v: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
                out[k] = val;
            }
        }
    }
    return out;
}

/** 归一 Record<string, OnErrorPolicy>(如 onErrorByType):仅保留合法策略项 */
function normOnErrorMap(v: unknown): Record<string, OnErrorPolicy> {
    const out: Record<string, OnErrorPolicy> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (typeof val === 'string' && (VALID_ON_ERROR as readonly string[]).includes(val)) {
                out[k] = val as OnErrorPolicy;
            }
        }
    }
    return out;
}

function normRetry(v: unknown, base: RetryPolicy): RetryPolicy {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        count: normPosNum(r.count, base.count),
        backoff: r.backoff === 'exponential' ? 'exponential' : 'fixed',
        baseMs: normPosNum(r.baseMs, base.baseMs),
        factor: normPosNum(r.factor, base.factor),
        maxMs: normPosNum(r.maxMs, base.maxMs),
    };
}

function normDelay(v: unknown, base: StepDelay): StepDelay {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return { min: normPosNum(r.min, base.min), max: normPosNum(r.max, base.max) };
}

function normPacing(v: unknown, base: PaginationPacing): PaginationPacing {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        settleTimeoutMs: normPosNum(r.settleTimeoutMs, base.settleTimeoutMs),
        perPageDelayMs: normPosNum(r.perPageDelayMs, base.perPageDelayMs),
    };
}

/** 归一单个档:缺字段用 default 档补齐,保证拿到完整 ReplayProfile */
function normProfile(v: unknown): ReplayProfile {
    const base = defaultProfile();
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        globalTimeoutMs: normPosNum(r.globalTimeoutMs, base.globalTimeoutMs),
        stepTimeoutMs: normNumMap(r.stepTimeoutMs),
        retry: normRetry(r.retry, base.retry),
        stepDelay: normDelay(r.stepDelay, base.stepDelay),
        onError: normOnError(r.onError, base.onError),
        onErrorByType: normOnErrorMap(r.onErrorByType),
        pagination: normPacing(r.pagination, base.pagination),
        scrollBottomWaitMs: normPosNum(r.scrollBottomWaitMs, base.scrollBottomWaitMs),
    };
}

/** 内联模板:default(=现状)+ 两档常用预设(慢站 / 防风控),字段名即文档 */
function templateConfig(): ReplayProfileConfig {
    return {
        activeProfile: 'default',
        profiles: {
            default: defaultProfile(),
            'slow-site': {
                ...defaultProfile(),
                globalTimeoutMs: 120000,
                stepDelay: { min: 800, max: 2500 },
                retry: { count: 2, backoff: 'exponential', baseMs: 1000, factor: 2, maxMs: 10000 },
                pagination: { settleTimeoutMs: 60000, perPageDelayMs: 500 },
            },
            'anti-bot': {
                ...defaultProfile(),
                stepDelay: { min: 1200, max: 4000 },
                retry: { count: 3, backoff: 'exponential', baseMs: 1000, factor: 2, maxMs: 15000 },
            },
        },
    };
}

/** 坏 JSON 兜底 = 只含 default 档(现状行为) */
function fallbackConfig(): ReplayProfileConfig {
    return { activeProfile: 'default', profiles: { default: defaultProfile() } };
}

function normalize(raw: unknown): ReplayProfileConfig {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const profilesRaw =
        r.profiles && typeof r.profiles === 'object' && !Array.isArray(r.profiles)
            ? (r.profiles as Record<string, unknown>)
            : {};
    const profiles: Record<string, ReplayProfile> = {};
    for (const [name, p] of Object.entries(profilesRaw)) {
        profiles[name] = normProfile(p);
    }
    // 至少保证有 default 档
    if (!profiles.default) {
        profiles.default = defaultProfile();
    }
    const active = typeof r.activeProfile === 'string' && profiles[r.activeProfile] ? r.activeProfile : 'default';
    return { activeProfile: active, profiles };
}

/** 加载 replay-profile.json(首次写模板、逐字段归一、坏 JSON 回退现状) */
export function loadReplayProfile(filePath: string): ReplayProfileConfig {
    return loadJsonConfig<ReplayProfileConfig>({
        filePath,
        buildTemplate: templateConfig,
        normalize,
        fallback: fallbackConfig(),
    });
}

/** 取当前生效档(activeProfile 指向的档;不存在则 default;再不济现状默认) */
export function resolveActiveProfile(config: ReplayProfileConfig): ReplayProfile {
    return config.profiles[config.activeProfile] ?? config.profiles.default ?? defaultProfile();
}

/** 切换当前生效档并写回(UI 下拉用);档名非法则不改。返回是否切换成功 */
export function setActiveProfile(filePath: string, name: string): boolean {
    const config = loadReplayProfile(filePath);
    if (!config.profiles[name]) {
        return false;
    }
    config.activeProfile = name;
    saveJsonConfig(filePath, config);
    return true;
}

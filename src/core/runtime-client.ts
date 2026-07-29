// mcp-agent-runtime worker 对接客户端(HTTP 异步任务:提交 + 轮询)。
// 契约见该项目 docs/对接指南.html;逐条对齐其 §4「正确的轮询范式」:
//   POST /tasks → 202 拿 task_id → 短轮询 GET /tasks/<id> 直到 done / error。
//
// 三个反直觉点(踩过就知道):
//   ① 异步任务失败时 HTTP 仍是 200 —— 必须判 body 的 status,不能判状态码;
//   ② max_turns 触顶是「软失败」:status 仍是 done,但 content 是固定串,要显式检测;
//   ③ 404 = 任务丢了(worker 重启 / TTL 清理),直接失败,**不重投**(盲目重投会让活干两遍)。
//
// 零新依赖:Electron 33 → Node 20,fetch / AbortSignal.timeout 均为内置。
import { logInfo } from './logger';

/** runtime worker 连接参数(来自 ai-config.json 的 runtime 段) */
export interface RuntimeConnConfig {
    /** worker 基址。默认 http://127.0.0.1:8080 —— 刻意写 IPv4 字面量:
     *  某些机器上 localhost 先解析到 ::1,而 Docker 端口发布在 IPv4,会连不上。 */
    url?: string;
    /** 轮询间隔(毫秒)。交互式 UI 用 1s(比编排层的 5s 快),任务本身是秒级 */
    pollMs?: number;
    /** 单次 HTTP 请求超时(毫秒) */
    reqTimeoutMs?: number;
    /** 自定义请求头。runtime worker 本身零鉴权,挂反代做 token 校验时用这里带凭据 */
    headers?: Record<string, string>;
}

/** 一次域任务的提交入参 */
export interface RunDomainInput {
    /** 域名(= runtime 侧 domains/ 的目录名,如 webextract / selector_fix) */
    domain: string;
    /** 自由键值,会被拼成 `k=v` 逐行塞进 user prompt。值一律扁平字符串 */
    inputs: Record<string, string>;
    /** 一次性任务指令,覆盖域默认收尾句;不传 = 用域的 task_directive */
    prompt?: string;
    /** 总时限(墙钟,毫秒);runtime 自身无墙钟超时,只能由调用方兜 */
    timeoutMs: number;
}

/** 域任务终态结果 */
export interface RunDomainResult {
    /** 模型最后一轮的文本(注意:不是业务产物,本场景恰好产物就是它) */
    content: string;
    /** runtime 会话 id,可在会话观察台(:8800 / 容器 :8801)复盘 */
    sessionId: string;
    turns: number;
    toolCalls: number;
    usage: Record<string, number>;
}

const DEFAULT_URL = 'http://127.0.0.1:8080';
const DEFAULT_POLL_MS = 1000;
const DEFAULT_REQ_TIMEOUT_MS = 30000;

/** max_turns 触顶时 runtime 回的固定串(软失败信号,逐字来自 agent_loop.py) */
const TOPPED_OUT = '[运行时] 达到最大轮次未自然收尾';

/** 归一连接配置(填默认值,去掉 url 末尾斜杠) */
function resolveConn(cfg: RuntimeConnConfig = {}): Required<Omit<RuntimeConnConfig, 'headers'>> & {
    headers: Record<string, string>;
} {
    const url = (cfg.url || DEFAULT_URL).replace(/\/+$/, '');
    return {
        url,
        pollMs: cfg.pollMs && cfg.pollMs > 0 ? cfg.pollMs : DEFAULT_POLL_MS,
        reqTimeoutMs: cfg.reqTimeoutMs && cfg.reqTimeoutMs > 0 ? cfg.reqTimeoutMs : DEFAULT_REQ_TIMEOUT_MS,
        headers: cfg.headers ?? {},
    };
}

/** 把连接失败翻译成可操作的中文提示(而不是干巴巴的 fetch failed) */
function describeConnError(url: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return (
        `连不上 runtime worker(${url}):${msg}。` +
        '请确认 worker 已启动(docker compose up -d worker-http),' +
        '或在 ai-config.json 的 runtime.url 填写正确地址,' +
        '或把 defaultBackend 改回 openclaw。'
    );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 提交一个域任务并轮询到终态。
 * 成功返回结果;域运行失败 / 超时 / 任务丢失 / 触顶未收尾 一律抛 Error(中文可读)。
 */
export async function runDomain(
    input: RunDomainInput,
    conn: RuntimeConnConfig = {}
): Promise<RunDomainResult> {
    const { url, pollMs, reqTimeoutMs, headers } = resolveConn(conn);
    const deadline = Date.now() + input.timeoutMs;

    // ① 提交 —— 成功是 202(不是 200)
    const body: Record<string, unknown> = { domain: input.domain, inputs: input.inputs };
    if (input.prompt) {
        body.prompt = input.prompt;
    }
    let submitted: any;
    try {
        const res = await fetch(`${url}/tasks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(reqTimeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
            // 400 的 5 种校验错误在这里冒泡(域名写错 / body 非法)
            throw new Error(`提交任务失败(HTTP ${res.status}):${text.slice(0, 300)}`);
        }
        submitted = JSON.parse(text);
    } catch (err) {
        if (err instanceof Error && err.message.startsWith('提交任务失败')) {
            throw err;
        }
        throw new Error(describeConnError(url, err));
    }
    const taskId = submitted?.task_id;
    if (!taskId) {
        throw new Error(`提交任务未返回 task_id:${JSON.stringify(submitted).slice(0, 300)}`);
    }

    // ② 轮询到终态。先 sleep 再查,避免刚提交就空查一次
    for (;;) {
        await sleep(pollMs);
        if (Date.now() > deadline) {
            throw new Error(`域 ${input.domain} 轮询超时(${input.timeoutMs}ms,task=${taskId})`);
        }
        let res: Response;
        try {
            res = await fetch(`${url}/tasks/${taskId}`, {
                headers,
                signal: AbortSignal.timeout(reqTimeoutMs),
            });
        } catch (err) {
            // 单次网络抖动不代表任务挂了 —— 任务在服务端照跑,续轮询
            logInfo(`runtime 轮询单次失败(task=${taskId}),续轮询:${(err as Error).message}`);
            continue;
        }
        if (res.status === 404) {
            // worker 重启,或任务活过了 TTL(3600s)。不重投:那会让同一份活跑两遍
            throw new Error(`runtime 任务丢失(worker 重启?task=${taskId})`);
        }
        if (!res.ok) {
            throw new Error(`查询任务失败(HTTP ${res.status},task=${taskId})`);
        }
        const data: any = await res.json();

        // ⚠️ 判 body 的 status,不判 HTTP 状态码 —— 异步失败也是 200
        const status = data?.status;
        if (status === 'running') {
            continue;
        }
        if (status === 'error') {
            throw new Error(`域 ${input.domain} 运行失败:${data?.error ?? '(无错误信息)'}`);
        }
        if (status !== 'done') {
            throw new Error(`域 ${input.domain} 未知 status=${status}`);
        }

        // ③ 软失败检测:触顶 max_turns 时 status 仍是 done,但 content 是固定串
        const content: string = data?.content ?? '';
        if (content === TOPPED_OUT) {
            throw new Error(
                `域 ${input.domain} 达到最大轮次仍未自然收尾(产物不完整);` +
                `可在会话观察台查 session=${data?.session_id ?? '?'} 复盘。`
            );
        }
        return {
            content,
            sessionId: data?.session_id ?? '',
            turns: data?.turns ?? 0,
            toolCalls: data?.tool_calls ?? 0,
            usage: (data?.usage ?? {}) as Record<string, number>,
        };
    }
}

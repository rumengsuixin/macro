// 事件钩子派发器:一次任务生命周期各阶段触发配置好的对外动作。
// 铁律:fire-and-forget、永不抛、永不阻断回放——任何单个动作失败只记日志。
// 安全:webhook 的 url/headers 只取静态配置(禁注入页面变量,防 SSRF);
//       command 的 exe 静态、args 经模板但 spawn array 无 shell(无 shell 注入);
//       status-file 路径限定在 dataRoot 内(防目录穿越);payload 变量注入 JSON 时按 JSON 转义。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { HooksConfig, HookAction, HookEvent, RunHookPayload } from './macro-types';
import { renderTemplate } from './template-util';
import { httpSend } from './http-out';
import { logInfo, logError } from './logger';

/** 派发依赖(依赖倒置:core 不直接依赖 Electron 的 Notification) */
export interface HookDeps {
    /** 桌面通知(由主进程注入 Electron Notification);缺省则 notify 动作仅记日志 */
    notify?: (title: string, body: string) => void;
    /** 数据根目录:限定 status-file 只能写在其内 */
    dataRoot?: string;
}

/** 把 payload 摊平成模板变量表(供 renderTemplate 取 {{macroName}} / {{error.message}} 等) */
function buildVars(payload: RunHookPayload, dataRoot?: string): Record<string, unknown> {
    return { ...payload, dataRoot: dataRoot ?? payload.dataRoot ?? '' };
}

/** webhook:仅注入 bodyTemplate 变量(JSON 转义);url/headers 原样静态 */
async function runWebhook(a: Extract<HookAction, { action: 'webhook' }>, vars: Record<string, unknown>): Promise<void> {
    const body = a.bodyTemplate ? renderTemplate(a.bodyTemplate, vars, { jsonEscape: true }) : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(a.headers ?? {}) };
    if (body) {
        headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const res = await httpSend(a.url, a.method ?? 'POST', headers, body, a.timeoutMs ?? 10000);
    logInfo(`钩子 webhook 已发送:${a.url} → HTTP ${res.status}`);
}

/** command:exe 静态,args 经模板渲染;spawn array 无 shell */
function runCommand(a: Extract<HookAction, { action: 'command' }>, vars: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
        const args = (a.args ?? []).map((arg) => renderTemplate(arg, vars));
        let settled = false;
        const done = (): void => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        try {
            const child = spawn(a.exe, args, { cwd: a.cwd || undefined, shell: false });
            const timer = setTimeout(() => child.kill(), a.timeoutMs && a.timeoutMs > 0 ? a.timeoutMs : 60000);
            child.on('error', (e) => {
                clearTimeout(timer);
                logError(`钩子 command 启动失败(${a.exe}):${e.message}`);
                done();
            });
            child.on('exit', (code) => {
                clearTimeout(timer);
                logInfo(`钩子 command 结束(${a.exe}),退出码 ${code}`);
                done();
            });
        } catch (e) {
            logError(`钩子 command 异常(${a.exe}):${e instanceof Error ? e.message : String(e)}`);
            done();
        }
    });
}

/** status-file:路径渲染后限定在 dataRoot 内,防目录穿越 */
function runStatusFile(a: Extract<HookAction, { action: 'status-file' }>, vars: Record<string, unknown>, dataRoot?: string): void {
    const rendered = renderTemplate(a.path, vars); // 路径不做 JSON 转义
    const root = path.resolve(dataRoot ?? process.cwd());
    const resolved = path.resolve(root, rendered);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`status-file 路径越界 dataRoot,已拒写:${resolved}`);
    }
    const content = a.template ? renderTemplate(a.template, vars, { jsonEscape: true }) : JSON.stringify(vars);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    logInfo(`钩子 status-file 已写:${resolved}`);
}

/** notify:标题/正文渲染后交注入的桌面通知回调 */
function runNotify(a: Extract<HookAction, { action: 'notify' }>, vars: Record<string, unknown>, deps: HookDeps): void {
    const title = renderTemplate(a.title, vars);
    const body = a.body ? renderTemplate(a.body, vars) : '';
    if (deps.notify) {
        deps.notify(title, body);
    } else {
        logInfo(`钩子 notify(无桌面通知通道,仅记录):${title} ${body}`);
    }
}

/** 执行单个动作;任何异常在此吞掉、只记日志(绝不冒泡影响回放) */
async function runAction(a: HookAction, vars: Record<string, unknown>, deps: HookDeps): Promise<void> {
    try {
        switch (a.action) {
            case 'webhook':
                await runWebhook(a, vars);
                break;
            case 'command':
                await runCommand(a, vars);
                break;
            case 'status-file':
                runStatusFile(a, vars, deps.dataRoot);
                break;
            case 'notify':
                runNotify(a, vars, deps);
                break;
        }
    } catch (e) {
        logError(`钩子动作(${a.action})失败:${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * 派发某事件的所有钩子动作。enabled=false 或该事件无动作时直接返回(零对外)。
 * 并发执行、全部 settle 后返回;整体永不抛。
 */
export async function dispatchHooks(
    config: HooksConfig,
    event: HookEvent,
    payload: RunHookPayload,
    deps: HookDeps = {}
): Promise<void> {
    if (!config.enabled) {
        return;
    }
    const actions = config.events[event];
    if (!actions || actions.length === 0) {
        return;
    }
    const vars = buildVars(payload, deps.dataRoot);
    await Promise.allSettled(actions.map((a) => runAction(a, vars, deps)));
}

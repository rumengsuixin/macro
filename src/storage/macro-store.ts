// 宏存储:以 JSON 文件保存 / 加载宏。
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Macro, MacroCaptures, MacroSummary } from '../core/macro-types';

/** 由宏文件路径派生旁车文件路径 `<同名>.captures.json` */
export function captureSidecarPath(macroPath: string): string {
    return macroPath.replace(/\.json$/i, '') + '.captures.json';
}

/**
 * 列出目录下所有宏文件的摘要(用于宏库面板)。
 * 排除 `*.captures.json` 旁车;单个文件损坏则跳过(不致命);按修改时间倒序返回。
 */
export async function listMacros(dir: string): Promise<MacroSummary[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        // 目录不存在等:视为空库
        return [];
    }
    const summaries: MacroSummary[] = [];
    for (const entry of entries) {
        // 只认 .json,排除旁车 .captures.json
        if (!/\.json$/i.test(entry) || /\.captures\.json$/i.test(entry)) {
            continue;
        }
        const filePath = path.join(dir, entry);
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) {
                continue;
            }
            const content = await fs.readFile(filePath, 'utf-8');
            const macro = JSON.parse(content) as Macro;
            if (!macro || !Array.isArray(macro.steps)) {
                continue; // 非宏文件,跳过
            }
            const name = typeof macro.name === 'string' && macro.name.trim() ? macro.name : entry.replace(/\.json$/i, '');
            summaries.push({ filePath, name, stepCount: macro.steps.length, modifiedMs: stat.mtimeMs });
        } catch {
            // 损坏 / 非法 JSON / 读取失败:跳过该文件
        }
    }
    summaries.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return summaries;
}

/**
 * 保存宏到指定 JSON 文件。
 * @returns 实际写入的文件路径
 */
export async function saveMacro(macro: Macro, filePath: string): Promise<string> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const json = JSON.stringify(macro, null, 4);
    await fs.writeFile(filePath, json, 'utf-8');
    return filePath;
}

/**
 * 从 JSON 文件加载宏,并做基本校验。
 */
export async function loadMacro(filePath: string): Promise<Macro> {
    const content = await fs.readFile(filePath, 'utf-8');
    let macro: Macro;
    try {
        macro = JSON.parse(content) as Macro;
    } catch {
        throw new Error('宏文件不是合法的 JSON。');
    }
    validateMacro(macro);
    return macro;
}

/**
 * 保存宏的旁车上下文文件(`<宏名>.captures.json`),供离线 AI 校正选择器。
 * captures 为空(无任何上下文)时不写文件并清掉旧旁车,避免留空壳。
 */
export async function saveMacroCaptures(macroPath: string, captures?: MacroCaptures | null): Promise<void> {
    const sidecar = captureSidecarPath(macroPath);
    const hasAny = !!captures && Array.isArray(captures.steps) && captures.steps.some((s) => s);
    if (!hasAny) {
        // 无上下文:若存在旧旁车则删除(与宏保持一致),忽略不存在
        try {
            await fs.unlink(sidecar);
        } catch {
            // 文件不存在等,忽略
        }
        return;
    }
    await fs.writeFile(sidecar, JSON.stringify(captures, null, 4), 'utf-8');
}

/** 读取宏的旁车上下文文件;不存在或损坏返回 null(不致命) */
export async function loadMacroCaptures(macroPath: string): Promise<MacroCaptures | null> {
    const sidecar = captureSidecarPath(macroPath);
    try {
        const content = await fs.readFile(sidecar, 'utf-8');
        const parsed = JSON.parse(content) as MacroCaptures;
        if (parsed && Array.isArray(parsed.steps)) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/** 基本结构校验 */
function validateMacro(macro: Macro): void {
    if (!macro || typeof macro !== 'object') {
        throw new Error('宏文件格式错误:根对象无效。');
    }
    if (!Array.isArray(macro.steps)) {
        throw new Error('宏文件格式错误:steps 必须是数组。');
    }
}

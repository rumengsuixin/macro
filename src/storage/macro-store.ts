// 宏存储:以 JSON 文件保存 / 加载宏。
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Macro } from '../core/macro-types';

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

/** 基本结构校验 */
function validateMacro(macro: Macro): void {
    if (!macro || typeof macro !== 'object') {
        throw new Error('宏文件格式错误:根对象无效。');
    }
    if (!Array.isArray(macro.steps)) {
        throw new Error('宏文件格式错误:steps 必须是数组。');
    }
}

// 通用 JSON 配置加载骨架:抽取项目里多个 loader 手搓的同一副套路——
// 「existsSync 不存在→写模板 / 存在→readFileSync+normalize / 坏 JSON→fallback」,写模板与读取失败均不致命。
// 纯 node:fs,无 Electron 依赖;主进程侧(storage/core loader)复用,保证行为与老配置一字不差。
import fs from 'node:fs';

/** 一份 JSON 配置的加载规格 */
export interface JsonConfigSpec<T> {
    /** 配置文件绝对路径(dataRoot/<name>.json) */
    filePath: string;
    /** 代码内联模板(首次不存在且无平台模板时写入并返回) */
    buildTemplate: () => T;
    /** 逐字段归一/校验:把任意 raw 收敛为合法 T */
    normalize: (raw: unknown) => T;
    /** 坏 JSON / 读失败时的兜底值(通常 = 现有行为) */
    fallback: T;
    /** 可选平台预置模板路径;提供且可读时优先作首次生成内容(照 bank-integrate) */
    templatePath?: string;
    /** 读平台模板文件(自定义解析/占位符展开);返回 null 表示不可用、回退 buildTemplate */
    loadTemplateFile?: (templatePath: string) => T | null;
}

/**
 * 加载一份 JSON 配置。
 * - 不存在:优先平台模板(templatePath+loadTemplateFile),否则写内联模板,再返回它;写失败不致命。
 * - 存在:JSON.parse 后交 normalize 归一。
 * - 坏 JSON / 任意异常:返回 fallback,永不抛、不阻断启动。
 */
export function loadJsonConfig<T>(spec: JsonConfigSpec<T>): T {
    const { filePath, buildTemplate, normalize, fallback, templatePath, loadTemplateFile } = spec;
    try {
        if (!fs.existsSync(filePath)) {
            const generated =
                (templatePath && loadTemplateFile ? loadTemplateFile(templatePath) : null) ??
                buildTemplate();
            try {
                fs.writeFileSync(filePath, JSON.stringify(generated, null, 4), 'utf-8');
            } catch {
                /* 只读目录等写失败不致命 */
            }
            return generated;
        }
        const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return normalize(raw);
    } catch {
        return fallback;
    }
}

/** 保存一份 JSON 配置(4 空格缩进写回,统一约定) */
export function saveJsonConfig<T>(filePath: string, config: T): void {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 4), 'utf-8');
}

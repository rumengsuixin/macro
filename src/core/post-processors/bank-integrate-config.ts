// bank-integrate 插件的桥接配置:指向本机 xlsxIntgration(Python 银行整合工具)的
// 可执行 / 项目根 / 各业务线入口。仿 storage/request-rules-store:不存在写 inert 模板 + 坏 JSON 兜底。
// 放在 core 内(只用 node:fs,不依赖 Electron / storage),供后处理器 handler 直接读。
import fs from 'node:fs';

/** 单条业务线(mode)的入口:Python 脚本名 + 产物文件名 */
export interface BankIntegrateMode {
    /** xlsxIntgration 里的入口脚本,如 '整合1.py' */
    entryScript: string;
    /** 该模式产出的汇总文件名(位于 BANK_OUTPUT_DIR),如 '国内银行汇总.xlsx' */
    summaryFile: string;
}

/** bank-integrate 桥接配置 */
export interface BankIntegrateConfig {
    /** Python 可执行(开发态=venv python;分发态=打包二进制) */
    pythonExe: string;
    /** xlsxIntgration 项目根(spawn 的 cwd) */
    projectRoot: string;
    /** 单次整合超时(毫秒),缺省 300000 */
    timeoutMs?: number;
    /** 插件 type → 业务线入口 */
    modes: Record<string, BankIntegrateMode>;
}

/** 默认/模板配置:指向本机常见安装位置,首次自动写出供用户按需改路径 */
function templateConfig(): BankIntegrateConfig {
    return {
        pythonExe: 'D:\\git_object\\xlsxIntgration\\venv\\Scripts\\python.exe',
        projectRoot: 'D:\\git_object\\xlsxIntgration',
        timeoutMs: 300000,
        modes: {
            'bank-integrate-domestic': {
                entryScript: '整合1.py',
                summaryFile: '国内银行汇总.xlsx',
            },
        },
    };
}

/**
 * 加载 bank-integrate 配置。
 * - 不存在:写模板并返回(便于用户改路径,首次运行不致命)。
 * - 坏 JSON / 字段缺失:逐字段回退模板默认(保证 handler 有可用字段)。
 * @param filePath 配置文件路径(dataRoot/bank-integrate.json)
 */
export function loadBankIntegrateConfig(filePath: string): BankIntegrateConfig {
    const tpl = templateConfig();
    try {
        if (!fs.existsSync(filePath)) {
            try {
                fs.writeFileSync(filePath, JSON.stringify(tpl, null, 4), 'utf-8');
            } catch {
                /* 写模板失败(如只读目录)不致命 */
            }
            return tpl;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<BankIntegrateConfig>;
        return {
            pythonExe:
                typeof raw.pythonExe === 'string' && raw.pythonExe.trim()
                    ? raw.pythonExe
                    : tpl.pythonExe,
            projectRoot:
                typeof raw.projectRoot === 'string' && raw.projectRoot.trim()
                    ? raw.projectRoot
                    : tpl.projectRoot,
            timeoutMs:
                typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : tpl.timeoutMs,
            // 合并:保底带上模板里的默认 mode,用户可覆盖/新增
            modes:
                raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes)
                    ? { ...tpl.modes, ...raw.modes }
                    : tpl.modes,
        };
    } catch {
        // 坏 JSON 等异常:回退模板默认
        return tpl;
    }
}

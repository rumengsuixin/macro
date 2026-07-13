// bank-integrate 插件的桥接配置:按平台指向 xlsxIntgration 的打包可执行文件(不再依赖 Python 脚本+venv)。
// 仿 storage/request-rules-store:不存在写模板 + 坏 JSON 兜底。放 core 内(只用 node:fs/path,不依赖 Electron)。
import fs from 'node:fs';
import path from 'node:path';

/** 单条业务线(mode):当前平台可执行文件 + 产物文件名 */
export interface BankIntegrateMode {
    /** 当前平台可执行文件绝对路径(Windows exe / Mac 二进制) */
    executable: string;
    /** 该模式产出的汇总文件名(位于 BANK_OUTPUT_DIR),如 '国内银行汇总.xlsx' */
    summaryFile: string;
}

/** bank-integrate 桥接配置 */
export interface BankIntegrateConfig {
    /** 单次整合超时(毫秒),缺省 300000 */
    timeoutMs?: number;
    /** 插件 type → 业务线可执行文件入口 */
    modes: Record<string, BankIntegrateMode>;
}

/** 本机 xlsxIntgration 项目根默认值(用户可在配置里改路径) */
const DEFAULT_XLSX_ROOT = 'D:\\git_object\\xlsxIntgration';

/**
 * 按平台给出某 mode 的默认可执行文件路径(仅支持 win32/darwin,其它留空)。
 * - win32:PyInstaller onedir 产物 dist/银行流水整合/国内银行整合.exe
 * - darwin:需在 Mac 上跑 build_mac.sh 打出 dist/bank-integration/domestic_bank_integration
 */
function defaultExecutable(type: string, xlsxRoot: string): string {
    if (type !== 'bank-integrate-domestic') {
        return '';
    }
    if (process.platform === 'win32') {
        return path.join(xlsxRoot, 'dist', '银行流水整合', '国内银行整合.exe');
    }
    if (process.platform === 'darwin') {
        return path.join(xlsxRoot, 'dist', 'bank-integration', 'domestic_bank_integration');
    }
    return '';
}

/** 默认/模板配置:按当前平台生成默认可执行文件路径 */
function templateConfig(): BankIntegrateConfig {
    return {
        timeoutMs: 300000,
        modes: {
            'bank-integrate-domestic': {
                executable: defaultExecutable('bank-integrate-domestic', DEFAULT_XLSX_ROOT),
                summaryFile: '国内银行汇总.xlsx',
            },
        },
    };
}

/**
 * 加载 bank-integrate 配置。
 * - 不存在:写模板并返回(便于用户改路径)。
 * - 坏 JSON:回退模板默认。
 * - 某 mode 缺 executable:回退当前平台默认(兼容旧格式配置、不阻塞)。
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
        const rawModes =
            raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? raw.modes : {};
        // 以模板 modes 为底(保证默认 domestic 在),再并入用户配置;逐字段校验/回退
        const modes: Record<string, BankIntegrateMode> = { ...tpl.modes };
        for (const [type, m] of Object.entries(rawModes)) {
            const mm = (m && typeof m === 'object' ? m : {}) as Partial<BankIntegrateMode>;
            modes[type] = {
                executable:
                    typeof mm.executable === 'string' && mm.executable.trim()
                        ? mm.executable
                        : defaultExecutable(type, DEFAULT_XLSX_ROOT),
                summaryFile:
                    typeof mm.summaryFile === 'string' && mm.summaryFile.trim()
                        ? mm.summaryFile
                        : (tpl.modes[type]?.summaryFile ?? '国内银行汇总.xlsx'),
            };
        }
        return {
            timeoutMs:
                typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : tpl.timeoutMs,
            modes,
        };
    } catch {
        // 坏 JSON 等异常:回退模板默认
        return tpl;
    }
}

// bank-integrate 插件的桥接配置:按平台指向 xlsxIntgration 的打包可执行文件(不再依赖 Python 脚本+venv)。
// 仿 storage/request-rules-store:不存在写模板 + 坏 JSON 兜底。放 core 内(只用 node:fs/path,不依赖 Electron)。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 单条业务线(mode):当前平台可执行文件路径 + 可选 UI 文案覆盖 */
export interface BankIntegrateMode {
    /** 当前平台可执行文件绝对路径(Windows exe / Mac 二进制) */
    executable: string;
    /** 可选:覆盖该工具在「独立工具」面板的描述文案(缺省用代码内置描述) */
    description?: string;
    /** 可选:覆盖该工具的示例文件名列表(缺省用代码内置示例) */
    examples?: string[];
}

/** bank-integrate 桥接配置 */
export interface BankIntegrateConfig {
    /** 单次整合超时(毫秒),缺省 300000 */
    timeoutMs?: number;
    /** 插件 type → 业务线可执行文件入口 */
    modes: Record<string, BankIntegrateMode>;
}

/**
 * 本机 xlsxIntgration 产物根默认值(用户可在 bank-integrate.json 改路径),按平台分叉:
 * - win32:xlsxIntgration 项目根(其下 dist/银行流水整合/<中文名>.exe)——保持原值不变。
 * - darwin:约定放解压后的 Mac 产物(其下 bank-integration/<英文名>),默认取用户主目录,
 *   即产物解压到 ~/bank-integration;用户也可在配置里改成任意绝对路径。
 * - 其它平台:留空,完全靠用户配置。
 */
function defaultXlsxRoot(): string {
    if (process.platform === 'win32') {
        return 'D:\\git_object\\xlsxIntgration';
    }
    if (process.platform === 'darwin') {
        return os.homedir();
    }
    return '';
}
const DEFAULT_XLSX_ROOT = defaultXlsxRoot();

/**
 * 各 mode(插件 type)在 win32/darwin 下的可执行文件名(不含目录)。
 * 覆盖 5 个代号:1 国内 / 2 海外 / 3 订单匹配 / 5 代付对账 / 6 代收代付对账。
 * - win32 名取自 bank_integration.spec(中文名)
 * - darwin 名取自 bank_integration_mac.spec(英文名,需在 Mac 上打包后才有实体)
 */
const EXE_NAMES: Record<string, { win32: string; darwin: string }> = {
    'bank-integrate-domestic': { win32: '国内银行整合.exe', darwin: 'domestic_bank_integration' },
    'bank-integrate-overseas': { win32: '海外银行整合.exe', darwin: 'overseas_bank_integration' },
    'bank-integrate-order-match': { win32: '游戏订单匹配.exe', darwin: 'order_payment_match' },
    'bank-integrate-payout': { win32: '代付订单对账.exe', darwin: 'payout_order_reconcile' },
    'bank-integrate-collection-payout': {
        win32: '代收代付对账.exe',
        darwin: 'collection_payout_reconcile',
    },
};

/**
 * 按平台给出某 mode 的默认可执行文件路径(仅支持 win32/darwin,未知 type 或其它平台留空)。
 * - win32:PyInstaller onedir 产物 dist/银行流水整合/<中文名>.exe
 * - darwin:Mac 产物(GitHub Actions artifact,从 bank-integration 目录起打包,无 dist 前缀),
 *   即 <root>/bank-integration/<英文名>;root 默认取用户主目录(见 defaultXlsxRoot)。
 */
function defaultExecutable(type: string, xlsxRoot: string): string {
    const names = EXE_NAMES[type];
    if (!names) {
        return '';
    }
    if (process.platform === 'win32') {
        return path.join(xlsxRoot, 'dist', '银行流水整合', names.win32);
    }
    if (process.platform === 'darwin') {
        return path.join(xlsxRoot, 'bank-integration', names.darwin);
    }
    return '';
}

/** 默认/模板配置:按当前平台为 5 个代号各生成默认可执行文件路径 */
function templateConfig(): BankIntegrateConfig {
    const modes: Record<string, BankIntegrateMode> = {};
    for (const type of Object.keys(EXE_NAMES)) {
        modes[type] = { executable: defaultExecutable(type, DEFAULT_XLSX_ROOT) };
    }
    return { timeoutMs: 300000, modes };
}

/** 展开模板占位符:{HOME} → 用户主目录(mac 家目录随用户名变化,故模板不写死绝对家目录) */
function expandPlaceholders(s: string): string {
    return s.replace(/\{HOME\}/g, os.homedir());
}

/** 归一化配置里可选的描述覆盖:非空字符串才算数,否则 undefined(交调用方回退内置) */
function normDescription(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
}

/** 归一化配置里可选的示例覆盖:字符串数组、逐项去空,空数组视为未配置 */
function normExamples(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) {
        return undefined;
    }
    const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    return arr.length ? arr : undefined;
}

/**
 * 读平台专属模板文件(打包 resources 或仓库 config-templates 里的 bank-integrate.<平台>.json),
 * 展开 {HOME} 占位符后作为首次生成内容。缺路径/文件不存在/坏 JSON/无 modes 返回 null,
 * 交调用方回退代码内默认(templateConfig)。
 */
function loadTemplateFile(templatePath?: string): BankIntegrateConfig | null {
    if (!templatePath) {
        return null;
    }
    try {
        if (!fs.existsSync(templatePath)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as Partial<BankIntegrateConfig>;
        if (!raw.modes || typeof raw.modes !== 'object' || Array.isArray(raw.modes)) {
            return null;
        }
        const modes: Record<string, BankIntegrateMode> = {};
        for (const [type, m] of Object.entries(raw.modes)) {
            const mm = (m && typeof m === 'object' ? m : {}) as Partial<BankIntegrateMode>;
            modes[type] = {
                executable:
                    typeof mm.executable === 'string' ? expandPlaceholders(mm.executable) : '',
            };
            const d = normDescription(mm.description);
            if (d) {
                modes[type].description = d;
            }
            const ex = normExamples(mm.examples);
            if (ex) {
                modes[type].examples = ex;
            }
        }
        return {
            timeoutMs:
                typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : 300000,
            modes,
        };
    } catch {
        return null;
    }
}

/**
 * 加载 bank-integrate 配置。
 * - 不存在:优先用平台专属模板(templatePath)首次生成并返回;模板不可用时回退代码内默认。
 * - 已存在:只读不覆盖(升级/重装保留用户改动)。
 * - 坏 JSON:回退模板默认。
 * - 某 mode 缺 executable:回退当前平台默认(兼容旧格式配置、不阻塞)。
 * @param filePath 配置文件路径(dataRoot/bank-integrate.json)
 * @param templatePath 平台专属模板绝对路径(主进程按 process.platform 解析后传入),用于首次生成
 */
export function loadBankIntegrateConfig(
    filePath: string,
    templatePath?: string
): BankIntegrateConfig {
    const tpl = templateConfig();
    try {
        if (!fs.existsSync(filePath)) {
            // 首次生成:平台专属模板优先(打包时预置、可控),读不到再回退代码内平台默认
            const generated = loadTemplateFile(templatePath) ?? tpl;
            try {
                fs.writeFileSync(filePath, JSON.stringify(generated, null, 4), 'utf-8');
            } catch {
                /* 写模板失败(如只读目录)不致命 */
            }
            return generated;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<BankIntegrateConfig>;
        const rawModes =
            raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? raw.modes : {};
        // 以模板 modes 为底(保证 5 个代号默认都在),再并入用户配置;逐字段校验/回退
        const modes: Record<string, BankIntegrateMode> = { ...tpl.modes };
        for (const [type, m] of Object.entries(rawModes)) {
            const mm = (m && typeof m === 'object' ? m : {}) as Partial<BankIntegrateMode>;
            modes[type] = {
                executable:
                    typeof mm.executable === 'string' && mm.executable.trim()
                        ? mm.executable
                        : defaultExecutable(type, DEFAULT_XLSX_ROOT),
            };
            const d = normDescription(mm.description);
            if (d) {
                modes[type].description = d;
            }
            const ex = normExamples(mm.examples);
            if (ex) {
                modes[type].examples = ex;
            }
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

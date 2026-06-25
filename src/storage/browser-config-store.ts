// 浏览器登录态复用配置存储:以 JSON 文件保存 / 加载 BrowserConfig。
import fs from 'node:fs';
import type { BrowserConfig } from '../core/macro-types';

/** 返回默认配置(全部开关关闭,profile 目录取传入的默认目录) */
function defaultConfig(defaultDir: string): BrowserConfig {
    return {
        persistProfile: false,
        userDataDir: defaultDir,
        injectRecordingSession: false,
    };
}

/**
 * 加载浏览器配置;文件不存在或损坏时回退到默认值。
 * @param filePath   配置文件路径(项目根 browser-config.json)
 * @param defaultDir 默认 profile 目录(<projectRoot>/browser-profile)
 */
export function loadBrowserConfig(filePath: string, defaultDir: string): BrowserConfig {
    const fallback = defaultConfig(defaultDir);
    try {
        if (!fs.existsSync(filePath)) {
            return fallback;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<BrowserConfig>;
        // 合并:缺字段用默认补齐,类型不对时回退默认,保证后续逻辑拿到合法值
        return {
            persistProfile: typeof raw.persistProfile === 'boolean' ? raw.persistProfile : fallback.persistProfile,
            userDataDir:
                typeof raw.userDataDir === 'string' && raw.userDataDir.trim()
                    ? raw.userDataDir
                    : fallback.userDataDir,
            injectRecordingSession:
                typeof raw.injectRecordingSession === 'boolean'
                    ? raw.injectRecordingSession
                    : fallback.injectRecordingSession,
        };
    } catch {
        // 坏 JSON 等异常:回退默认,不阻断启动
        return fallback;
    }
}

/** 保存浏览器配置(4 空格缩进写回) */
export function saveBrowserConfig(filePath: string, config: BrowserConfig): void {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 4), 'utf-8');
}

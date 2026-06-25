// 候选图标预览生成:把 assets/candidates/*.svg 各渲染成 256px(看细节)与 48px(看小尺寸辨识度)PNG。
// 用法:node scripts/gen-candidates.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'assets', 'candidates');
const SIZES = [256, 48];

async function main() {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'));
    const browser = await chromium.launch();
    try {
        for (const f of files) {
            const svg = fs.readFileSync(path.join(dir, f), 'utf8');
            for (const size of SIZES) {
                const page = await browser.newPage({ viewport: { width: size, height: size } });
                const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`;
                await page.setContent(html, { waitUntil: 'networkidle' });
                const out = path.join(dir, f.replace(/\.svg$/, `-${size}.png`));
                await page.screenshot({ path: out, omitBackground: true, type: 'png' });
                await page.close();
            }
            console.log('已渲染预览:', f, '→ 256/48');
        }
    } finally {
        await browser.close();
    }
}
main().catch((e) => { console.error('预览生成失败:', e); process.exit(1); });

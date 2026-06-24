// 将渲染进程的静态资源(html / css)拷贝到 dist/renderer,供 Electron 加载。
// 使用 Node 原生 fs,跨平台,无需额外依赖。
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const srcDir = join(projectRoot, 'src', 'renderer');
const outDir = join(projectRoot, 'dist', 'renderer');

if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
}

const assetExts = ['.html', '.css'];
let copied = 0;
for (const file of readdirSync(srcDir)) {
    if (assetExts.some((ext) => file.endsWith(ext))) {
        copyFileSync(join(srcDir, file), join(outDir, file));
        console.log(`已拷贝静态资源:${file}`);
        copied += 1;
    }
}
console.log(`静态资源拷贝完成,共 ${copied} 个文件。`);

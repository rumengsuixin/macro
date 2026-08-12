// 「翻页总页数 = 0 → 不限页数」端到端自检(离线,起本机 http 服务,不依赖外网)。
//
// 本地服 3 页列表(每页 3 项,项文本带页号以便确认换页),分三场景:
//   ① 不限 + 末页无「下一页」按钮:翻页点击超时抛错 → 判为到底 → 采满 9 行、回放 ok。
//   ② 有界回归 pageCount:2:仍只采 2 页 6 行(证明无界改造未动有界路径)。
//   ③ 不限 + 末页「下一页」是死链(href="#",点了内容不变):靠首行文本未变判到底 → 9 行。
//
// 用法:MACRO_HEADLESS=1 node scripts/verify-pagination-unlimited.mjs
//   本机缺 headless_shell 时前置 PLAYWRIGHT_BROWSERS_PATH=<repo>/build/ms-playwright
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MacroRunner } = require('../dist/core/macro-runner.js');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let failed = false;
const check = (cond, okMsg, badMsg) => {
    if (cond) {
        console.log('  ✅', okMsg);
    } else {
        console.log('  ❌', badMsg);
        failed = true;
    }
};

const TOTAL_PAGES = 3;
const PER_PAGE = 3;

// ========== 本地列表服务 ==========
// /list?page=N[&dead=1]:第 N 页 3 项;N<3 给真「下一页」链接;
// N=3 时:dead=1 → 给死链(href="#"),否则整个按钮不存在。
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/list') {
        res.writeHead(404);
        res.end('not found');
        return;
    }
    const page = Math.max(1, Math.min(TOTAL_PAGES, Number(url.searchParams.get('page')) || 1));
    const dead = url.searchParams.get('dead') === '1';
    const items = Array.from(
        { length: PER_PAGE },
        (_, i) => `<div class="item"><span class="t">第${page}页-第${i + 1}项</span></div>`
    ).join('\n');
    let next = '';
    if (page < TOTAL_PAGES) {
        const q = dead ? `?page=${page + 1}&dead=1` : `?page=${page + 1}`;
        next = `<a id="next" href="/list${q}">下一页</a>`;
    } else if (dead) {
        next = '<a id="next" href="#">下一页</a>'; // 死链:点了不换页
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
        `<!doctype html><meta charset="utf-8"><title>分页 ${page}</title>\n${items}\n${next}`
    );
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`\n本地列表服务已启动:http://127.0.0.1:${port}/list?page=1`);

// 短 settle,避免场景③ 等满默认 30s
const replayProfile = {
    globalTimeoutMs: 6000,
    stepTimeoutMs: {},
    retry: { count: 0, backoff: 'fixed', baseMs: 500, factor: 2, maxMs: 10000 },
    stepDelay: { min: 0, max: 0 },
    onError: 'abort',
    onErrorByType: {},
    pagination: { settleTimeoutMs: 4000, perPageDelayMs: 0 },
    scrollBottomWaitMs: 200,
};

const makeMacro = (pageCount, dead) => ({
    name: `pagination-unlimited-${pageCount}${dead ? '-dead' : ''}`,
    version: 1,
    steps: [
        { type: 'goto', url: `http://127.0.0.1:${port}/list?page=1${dead ? '&dead=1' : ''}` },
        { type: 'click', selector: '#next', pagination: true, pageCount },
    ],
    extract: {
        mode: 'list',
        listSelector: '.item',
        fields: [{ name: 'text', selector: '.t', type: 'text' }],
    },
});

fs.mkdirSync(path.join(root, 'errors'), { recursive: true });

async function runOnce(pageCount, dead) {
    const runner = new MacroRunner(path.join(root, 'errors'), 6000, undefined, { replayProfile });
    const result = await Promise.race([
        runner.run(makeMacro(pageCount, dead)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('自检硬超时(90s)')), 90000)),
    ]);
    return { result };
}

// ========== ① 不限 + 末页无按钮 ==========
console.log('\n[1] pageCount:0(不限)+ 末页无「下一页」:翻不动即止');
try {
    const { result } = await runOnce(0, false);
    check(result?.ok === true, '回放成功完成(末页翻页失败被判为到底,非错误)', `回放未成功:${result?.error?.message}`);
    check(
        result?.rows?.length === TOTAL_PAGES * PER_PAGE,
        `采满 ${TOTAL_PAGES * PER_PAGE} 行(3 页 × 3 项)`,
        `行数期望 ${TOTAL_PAGES * PER_PAGE},实际 ${result?.rows?.length}`
    );
    const texts = (result?.rows || []).map((r) => r.text);
    check(
        texts.includes('第3页-第1项') && new Set(texts).size === TOTAL_PAGES * PER_PAGE,
        '三页内容各不相同(确实逐页换页,未重复采同一页)',
        `行内容异常:${JSON.stringify(texts)}`
    );
} catch (err) {
    console.log('  ❌ 回放异常:', err.message);
    failed = true;
}

// ========== ② 有界回归 ==========
console.log('\n[2] pageCount:2(有界回归):只采 2 页');
try {
    const { result } = await runOnce(2, false);
    check(result?.ok === true, '回放成功完成', `回放未成功:${result?.error?.message}`);
    check(
        result?.rows?.length === 2 * PER_PAGE,
        `只采 ${2 * PER_PAGE} 行(2 页 × 3 项),未越界`,
        `行数期望 ${2 * PER_PAGE},实际 ${result?.rows?.length}`
    );
} catch (err) {
    console.log('  ❌ 回放异常:', err.message);
    failed = true;
}

// ========== ③ 不限 + 末页死链 ==========
console.log('\n[3] pageCount:0(不限)+ 末页「下一页」是死链:内容未变即止');
try {
    const { result } = await runOnce(0, true);
    check(result?.ok === true, '回放成功完成', `回放未成功:${result?.error?.message}`);
    check(
        result?.rows?.length === TOTAL_PAGES * PER_PAGE,
        `采满 ${TOTAL_PAGES * PER_PAGE} 行后停止(未在末页无限重采)`,
        `行数期望 ${TOTAL_PAGES * PER_PAGE},实际 ${result?.rows?.length}`
    );
} catch (err) {
    console.log('  ❌ 回放异常:', err.message);
    failed = true;
}

server.close();
console.log(failed ? '\n❌ 自检未通过\n' : '\n✅ 全部通过:总页数 0 = 不限页数,翻不动即止\n');
process.exit(failed ? 2 : 0);

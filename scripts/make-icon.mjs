// 生成「二爪鱼」应用图标(与主页 🐟 品牌一致):海洋青底 + 白色小鱼 + 珊瑚色鱼鳍/鱼尾。
// 纯 Node 内置能力(zlib 编码 PNG + 手工封装 ICO/ICNS),无需任何图像依赖。
// 产物:assets/icon.png(256)、assets/icon.ico(Windows 多尺寸)、assets/icon.icns(macOS 多尺寸)。
// 用法:node scripts/make-icon.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '..', 'assets');

// ---------- 颜色 ----------
const TEAL_A = [0x17, 0xbe, 0xc6]; // 渐变左上(亮青)
const TEAL_B = [0x0a, 0x82, 0x88]; // 渐变右下(深青)
const WHITE = [0xff, 0xff, 0xff];
const CORAL = [0xff, 0x7a, 0x59];
const CORAL_D = [0xff, 0x66, 0x45];
const PUPIL = [0x0e, 0x2a, 0x33];

// ---------- 几何判定(全部在 256 基准坐标系里定义,渲染时按比例缩放) ----------
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c0, c1, t) => [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];

function inRoundRect(x, y, w, h, r) {
    const cx = Math.min(Math.max(x, r), w - r);
    const cy = Math.min(Math.max(y, r), h - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
}
function inEllipse(x, y, cx, cy, rx, ry) {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
}
function inCircle(x, y, cx, cy, r) {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
}
function sign(ax, ay, bx, by, cx, cy) {
    return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
}
function inTriangle(x, y, t) {
    const d1 = sign(x, y, t[0], t[1], t[2], t[3]);
    const d2 = sign(x, y, t[2], t[3], t[4], t[5]);
    const d3 = sign(x, y, t[4], t[5], t[0], t[1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

// 鱼身/鱼尾/鱼鳍(256 基准)
const BODY = { cx: 140, cy: 134, rx: 72, ry: 48 };
const TAIL = [96, 134, 30, 92, 30, 176]; // 尾巴三角(在鱼身左侧,珊瑚色)
const DORSAL = [118, 92, 156, 56, 172, 98]; // 背鳍(鱼身上方,珊瑚色)
const BELLY = [126, 176, 150, 208, 168, 178]; // 腹鳍(鱼身下方,珊瑚色)
const EYE = { cx: 180, cy: 120, r: 12 };
const EYE_HL = { cx: 184, cy: 116, r: 4 };
const BUBBLES = [
    [214, 94, 8],
    [232, 76, 5],
    [242, 60, 3],
];

/** 返回 256 基准坐标 (x,y) 处的像素颜色 [r,g,b,a](a: 0~255) */
function colorAt(x, y) {
    let px = [0, 0, 0, 0];
    // 背景圆角矩形 + 对角渐变
    if (inRoundRect(x, y, 256, 256, 50)) {
        const t = (x + y) / (256 + 256);
        const c = mix(TEAL_A, TEAL_B, t);
        px = [c[0], c[1], c[2], 255];
    }
    // 珊瑚:尾 → 腹鳍(在鱼身之下先画)
    if (inTriangle(x, y, TAIL)) px = [...CORAL, 255];
    if (inTriangle(x, y, BELLY)) px = [...CORAL_D, 255];
    // 白色鱼身
    if (inEllipse(x, y, BODY.cx, BODY.cy, BODY.rx, BODY.ry)) px = [...WHITE, 255];
    // 背鳍盖在鱼身之上
    if (inTriangle(x, y, DORSAL)) px = [...CORAL, 255];
    // 眼睛
    if (inCircle(x, y, EYE.cx, EYE.cy, EYE.r)) px = [...PUPIL, 255];
    if (inCircle(x, y, EYE_HL.cx, EYE_HL.cy, EYE_HL.r)) px = [...WHITE, 255];
    // 气泡(半透明白,叠在背景上)
    for (const [bx, by, br] of BUBBLES) {
        if (inCircle(x, y, bx, by, br)) {
            const a = 0.82;
            px = [lerp(px[0], 255, a), lerp(px[1], 255, a), lerp(px[2], 255, a), Math.max(px[3], 210)];
        }
    }
    return px;
}

/** 渲染指定尺寸的 RGBA 像素(ss 超采样抗锯齿) */
function renderRGBA(size, ss = 4) {
    const big = size * ss;
    const scale = 256 / big; // big 像素 → 256 基准坐标
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const bx = (x * ss + sx + 0.5) * scale;
                    const by = (y * ss + sy + 0.5) * scale;
                    const c = colorAt(bx, by);
                    // 预乘 alpha 累加,保证半透明边缘正确
                    const af = c[3] / 255;
                    r += c[0] * af;
                    g += c[1] * af;
                    b += c[2] * af;
                    a += c[3];
                }
            }
            const n = ss * ss;
            const aAvg = a / n;
            const idx = (y * size + x) * 4;
            if (aAvg <= 0) {
                out[idx] = out[idx + 1] = out[idx + 2] = out[idx + 3] = 0;
            } else {
                // 还原直通 alpha:累加的是预乘值,除以 alpha 覆盖率
                const cover = a / 255; // 有效不透明采样量
                out[idx] = Math.round(r / cover);
                out[idx + 1] = Math.round(g / cover);
                out[idx + 2] = Math.round(b / cover);
                out[idx + 3] = Math.round(aAvg);
            }
        }
    }
    return out;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(size, rgba) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    // 每行加 filter 字节 0
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- ICO 封装(每个尺寸存一张 PNG,Windows Vista+ 支持) ----------
function encodeICO(entries) {
    const count = entries.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(count, 4);
    const dir = Buffer.alloc(16 * count);
    let offset = 6 + 16 * count;
    entries.forEach((e, i) => {
        const o = i * 16;
        dir[o] = e.size >= 256 ? 0 : e.size; // 0 表示 256
        dir[o + 1] = e.size >= 256 ? 0 : e.size;
        dir[o + 2] = 0; // 调色板
        dir[o + 3] = 0; // reserved
        dir.writeUInt16LE(1, o + 4); // planes
        dir.writeUInt16LE(32, o + 6); // bpp
        dir.writeUInt32LE(e.png.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += e.png.length;
    });
    return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ---------- ICNS 封装(macOS,PNG-based;每个 OSType 存一张对应尺寸的 PNG) ----------
// OSType → 尺寸(仅用 PNG-based 现代类型,electron-builder/Finder 均接受;含 512/1024 满足打包要求)
const ICNS_TYPES = [
    ['ic11', 32], // 16pt@2x
    ['ic12', 64], // 32pt@2x
    ['ic07', 128], // 128×128
    ['ic08', 256], // 256×256
    ['ic09', 512], // 512×512
    ['ic10', 1024], // 512pt@2x
];
function encodeICNS(pngBySize) {
    const blocks = ICNS_TYPES.map(([osType, size]) => {
        const png = pngBySize.get(size);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(png.length + 8, 0); // 块长含 8 字节块头(4 类型 + 4 长度)
        return Buffer.concat([Buffer.from(osType, 'ascii'), len, png]);
    });
    const body = Buffer.concat(blocks);
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'ascii');
    header.writeUInt32BE(body.length + 8, 4); // 总长含 8 字节文件头
    return Buffer.concat([header, body]);
}

// ---------- 主流程 ----------
function main() {
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    // 渲染并缓存各尺寸 PNG(ICO 与 ICNS 复用,避免重复渲染)
    const pngCache = new Map();
    const pngFor = (size) => {
        if (!pngCache.has(size)) pngCache.set(size, encodePNG(size, renderRGBA(size)));
        return pngCache.get(size);
    };

    // Windows ICO(原样:16/32/48/64/128/256)
    const icoSizes = [16, 32, 48, 64, 128, 256];
    const entries = icoSizes.map((size) => ({ size, png: pngFor(size) }));
    fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngFor(256));
    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), encodeICO(entries));

    // macOS ICNS(32/64/128/256/512/1024)
    const icnsSizes = ICNS_TYPES.map(([, s]) => s);
    const pngBySize = new Map(icnsSizes.map((s) => [s, pngFor(s)]));
    fs.writeFileSync(path.join(assetsDir, 'icon.icns'), encodeICNS(pngBySize));

    console.log(
        '已生成图标:assets/icon.png(256)、assets/icon.ico(' +
            icoSizes.join('/') +
            ')、assets/icon.icns(' +
            icnsSizes.join('/') +
            ')'
    );
}

main();

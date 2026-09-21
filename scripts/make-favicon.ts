/**
 * 生成粉色史莱姆图标。
 *
 *   npx tsx scripts/make-favicon.ts
 *
 * 产出：
 *   app/favicon.ico      多尺寸（16/32/48/64）—— 浏览器标签页
 *   app/icon.png         256×256 —— Next.js 自动挂上 <link rel="icon">
 *   app/apple-icon.png   180×180，带底色 —— iOS 会给图标加蒙版，
 *                        透明底会被填成黑色，所以这一张必须有背景
 *
 * 把生成器留在仓库里，是因为图标本来是二进制黑盒：想调个眼色或改个形状
 * 就得重画。有脚本就能改一行数字重新生成。
 *
 * 手写 PNG + ICO 编码，依赖只有 node:zlib。现代 ICO 允许直接内嵌 PNG，
 * 所以不需要 BMP 那套调色板与 AND 掩码。
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素缓冲 → PNG */
function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* ICO 打包                                                            */
/* ------------------------------------------------------------------ */

function encodeICO(images: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const e = Buffer.alloc(16);
    // 256 在这里要写成 0 —— 一个字节存不下 256
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ------------------------------------------------------------------ */
/* 画史莱姆                                                            */
/* ------------------------------------------------------------------ */

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const hex = (s: string): RGBA => ({
  r: parseInt(s.slice(1, 3), 16),
  g: parseInt(s.slice(3, 5), 16),
  b: parseInt(s.slice(5, 7), 16),
  a: 255,
});

// 粉色系。顶部偏亮、底部偏深，做出果冻的体积感。
const PINK_TOP = hex("#FFB3DB");
const PINK_MID = hex("#FF7EC0");
const PINK_BOTTOM = hex("#E7569B");
const PINK_RIM = hex("#C2407F");
const EYE = hex("#43202F");
const GLINT = hex("#FFFFFF");

const mix = (a: RGBA, b: RGBA, t: number): RGBA => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});

/** 史莱姆身体：圆顶 + 底部铺开 */
const TOP = 0.20;
const BOTTOM = 0.88;
const CX = 0.5;
const MAX_HALF_WIDTH = 0.405;

/**
 * 半宽 = f(高度)。单一实现，bodyCoverage 与 edgeDistance 共用。
 *
 * 曾经这里有两条各自独立的公式，一改形状轮廓就跟身体对不上 ——
 * 勾边会浮在身体外面。
 *
 * 形状要点：
 *   - 顶部收成**四分之一圆弧**（dome），所以是圆脑袋而不是尖顶
 *   - 底部**保持最宽**，不是收成尖 —— 史莱姆是趴在桌面上的，
 *     两头都收就成了心形
 *   - 越靠下越往外铺一点，做出"摊开"的感觉
 */
function halfWidthAt(t: number): number {
  // 上方 arcFrac 高度是一段正圆弧（圆脑袋），下方是几乎直立的侧壁。
  // 若让半宽从 0 一路线性涨到底，得到的是"土丘"不是"史莱姆"。
  const arcFrac = 0.62;
  const dome =
    t < arcFrac
      ? Math.sqrt(Math.max(0, 1 - Math.pow(1 - t / arcFrac, 2)))
      : 1;

  const flare = 1 + 0.07 * Math.pow(t, 2.5);
  // 最底部收一点，给底面与侧壁之间一个小圆角，免得像切口
  const corner = t > 0.93 ? Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.93) / 0.07, 2) * 0.5)) : 1;

  return MAX_HALF_WIDTH * dome * flare * corner;
}

function bodyCoverage(x: number, y: number): boolean {
  if (y < TOP || y > BOTTOM) return false;
  const t = (y - TOP) / (BOTTOM - TOP);
  return Math.abs(x - CX) <= halfWidthAt(t);
}

/** 到轮廓边缘的距离（用于勾边） */
function edgeDistance(x: number, y: number): number {
  const t = (y - TOP) / (BOTTOM - TOP);
  const dEdge = halfWidthAt(t) - Math.abs(x - CX);
  const dTopBottom = Math.min(y - TOP, BOTTOM - y);
  return Math.min(dEdge, dTopBottom);
}

/** 柔和的圆形光斑，返回 0..1 的强度（边缘平滑过渡，不是硬边椭圆） */
function softSpot(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d >= 1 ? 0 : Math.pow(1 - d, 1.7);
}

/** 椭圆，返回是否在内部 */
function insideEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function render(size: number, opts: { background?: RGBA; detail: boolean }): Buffer {
  const SS = 4; // 超采样，边缘才不会锯齿
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc: RGBA = { r: 0, g: 0, b: 0, a: 0 };

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = sample(x, y, opts);
          acc = { r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b, a: acc.a + c.a };
        }
      }

      const n = SS * SS;
      const i = (py * size + px) * 4;
      out[i] = Math.round(acc.r / n);
      out[i + 1] = Math.round(acc.g / n);
      out[i + 2] = Math.round(acc.b / n);
      out[i + 3] = Math.round(acc.a / n);
    }
  }

  return out;
}

function sample(x: number, y: number, opts: { background?: RGBA; detail: boolean }): RGBA {
  const bg = opts.background ?? { r: 0, g: 0, b: 0, a: 0 };

  if (!bodyCoverage(x, y)) {
    return bg;
  }

  const t = (y - TOP) / (BOTTOM - TOP);

  // 纵向渐变：上亮下深
  let c = t < 0.55 ? mix(PINK_TOP, PINK_MID, t / 0.55) : mix(PINK_MID, PINK_BOTTOM, (t - 0.55) / 0.45);

  // 边缘压深，勾出轮廓 —— 图标在深色浏览器栏上也需要分得清边界
  const edge = edgeDistance(x, y);
  const rimWidth = 0.11;
  if (edge < rimWidth) {
    const k = 1 - edge / rimWidth; // 越靠边越大
    c = mix(c, PINK_RIM, 0.7 * Math.pow(k, 1.6));
  }

  // 头顶偏左一大一小两块柔光，做出果冻的通透感。
  // 用平滑衰减而不是硬边椭圆 —— 硬边会看起来像贴了张白纸。
  if (opts.detail) {
    const white: RGBA = { r: 255, g: 255, b: 255, a: 255 };
    const big = softSpot(x, y, 0.37, 0.40, 0.24, 0.15);
    if (big > 0) c = mix(c, white, 0.5 * big);
    const small = softSpot(x, y, 0.33, 0.35, 0.085, 0.055);
    if (small > 0) c = mix(c, white, 0.75 * small);
  }

  // 眼睛。小尺寸下放大一点，否则 16px 会糊成一团
  const eyeRx = opts.detail ? 0.052 : 0.070;
  const eyeRy = opts.detail ? 0.070 : 0.086;
  const eyeY = 0.60;
  const eyeDx = opts.detail ? 0.145 : 0.155;

  for (const ex of [CX - eyeDx, CX + eyeDx]) {
    if (insideEllipse(x, y, ex, eyeY, eyeRx, eyeRy)) {
      c = EYE;
      // 眼中的高光
      if (opts.detail && insideEllipse(x, y, ex - eyeRx * 0.35, eyeY - eyeRy * 0.34, eyeRx * 0.34, eyeRy * 0.30)) {
        c = GLINT;
      }
    }
  }

  // 背景不透明时，身体边缘要和背景做过渡，否则会有一圈硬边
  if (opts.background && opts.background.a > 0) {
    return c;
  }

  return c;
}

/* ------------------------------------------------------------------ */

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // 标签页图标：透明底，多尺寸打包
  const icoSizes = [16, 32, 48, 64];
  const icoImages = icoSizes.map((size) => ({
    size,
    png: encodePNG(size, size, render(size, { detail: size >= 32 })),
  }));

  const favicon = encodeICO(icoImages);
  fs.writeFileSync(path.join(repoRoot, "app/favicon.ico"), favicon);

  // Next.js 会自动为 app/icon.png 注入 <link rel="icon">
  const icon256 = encodePNG(256, 256, render(256, { detail: true }));
  fs.writeFileSync(path.join(repoRoot, "app/icon.png"), icon256);

  // iOS 会给主屏图标套蒙版且不保留透明 —— 透明底会变成黑的，所以这一张要带底
  const bg = hex("#FFF1F8");
  const appleSize = 180;
  const apple = Buffer.alloc(appleSize * appleSize * 4);
  const slime = render(appleSize, { detail: true });
  const inset = Math.round(appleSize * 0.08);
  const inner = appleSize - inset * 2;
  for (let y = 0; y < appleSize; y++) {
    for (let x = 0; x < appleSize; x++) {
      const i = (y * appleSize + x) * 4;
      // 先把整张填成浅粉底
      apple[i] = bg.r;
      apple[i + 1] = bg.g;
      apple[i + 2] = bg.b;
      apple[i + 3] = 255;

      // 再把史莱姆缩放贴进去
      const sx = Math.round(((x - inset) / inner) * appleSize);
      const sy = Math.round(((y - inset) / inner) * appleSize);
      if (sx < 0 || sy < 0 || sx >= appleSize || sy >= appleSize) continue;
      const j = (sy * appleSize + sx) * 4;
      const a = slime[j + 3] / 255;
      if (a <= 0) continue;
      apple[i] = Math.round(bg.r * (1 - a) + slime[j] * a);
      apple[i + 1] = Math.round(bg.g * (1 - a) + slime[j + 1] * a);
      apple[i + 2] = Math.round(bg.b * (1 - a) + slime[j + 2] * a);
    }
  }
  fs.writeFileSync(path.join(repoRoot, "app/apple-icon.png"), encodePNG(appleSize, appleSize, apple));

  // 顺手导两张预览，方便肉眼检查
  fs.writeFileSync(path.join(os.tmpdir(), "slime-preview.png"), encodePNG(256, 256, render(256, { detail: true })));

  // 把 16/32/48 按实际像素渲染再放大 8 倍（最近邻），
  // 这样看到的就是标签页里真实的清晰度，而不是被浏览器缩放过的假象
  const strip = [16, 32, 48];
  const SCALE = 8;
  const PAD = 8;
  const stripW = strip.reduce((a, sz) => a + sz * SCALE + PAD, PAD);
  const stripH = 48 * SCALE + PAD * 2;
  const canvas = Buffer.alloc(stripW * stripH * 4);
  // 浅灰底，模拟浅色浏览器栏
  for (let i = 0; i < canvas.length; i += 4) {
    canvas[i] = 244; canvas[i + 1] = 244; canvas[i + 2] = 246; canvas[i + 3] = 255;
  }
  let ox = PAD;
  for (const sz of strip) {
    const px = render(sz, { detail: sz >= 32 });
    for (let y = 0; y < sz * SCALE; y++) {
      for (let x = 0; x < sz * SCALE; x++) {
        const src = (Math.floor(y / SCALE) * sz + Math.floor(x / SCALE)) * 4;
        const dst = ((y + PAD) * stripW + (x + ox)) * 4;
        const a = px[src + 3] / 255;
        canvas[dst] = Math.round(canvas[dst] * (1 - a) + px[src] * a);
        canvas[dst + 1] = Math.round(canvas[dst + 1] * (1 - a) + px[src + 1] * a);
        canvas[dst + 2] = Math.round(canvas[dst + 2] * (1 - a) + px[src + 2] * a);
      }
    }
    ox += sz * SCALE + PAD;
  }
  fs.writeFileSync(path.join(os.tmpdir(), "slime-sizes.png"), encodePNG(stripW, stripH, canvas));

  console.log(`app/favicon.ico      ${favicon.length} 字节（${icoSizes.join("/")}）`);
  console.log(`app/icon.png         ${icon256.length} 字节（256×256）`);
  console.log(`app/apple-icon.png   ${apple.length ? "" : ""}（180×180，带底）`);
  const tmp = os.tmpdir();
  console.log(`预览：${path.join(tmp, "slime-preview.png")}（256）`);
  console.log(`      ${path.join(tmp, "slime-sizes.png")}（16/32/48 实际像素放大）`);
}

main();

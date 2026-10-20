// Optional art-build utility; not needed to run/build Guildmaster.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER_EXECUTABLE=/path/to/chromium
//   node scripts/build-guildhall-assets.mjs ~/downloads/gm-assets
// Reads originals only. Requires an existing Playwright/browser installation.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Provide the source asset directory');
const destination = new URL('../public/themes/guildhall/', import.meta.url);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true });
try {
  const page = await browser.newPage();
  const vellum = (await readFile(resolve(source, 'vellum.png'))).toString('base64');
  for (const [name, size, crop] of [
    ['vellum', 768], ['leather', 768], ['desk-background', 1536],
    ['parchment-frame-1', 768], ['parchment-frame-2', 768],
    ['brass-frame', 1024, [24, 56, 1488, 900]], ['wax-seal', 128],
    ['action-button', 768, [45, 100, 2075, 510]],
    ['quest-card-main', 768], ['brass-pin', 96, 'alpha'],
    ['wooden-board', 1536],
  ]) {
    const data = (await readFile(resolve(source, `${name}.png`))).toString('base64');
    const result = await page.evaluate(async ({ data, size, crop, name, vellum }) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const original = document.createElement('canvas'); original.width = image.width; original.height = image.height;
      const originalContext = original.getContext('2d'); originalContext.drawImage(image, 0, 0);
      const pixels = originalContext.getImageData(0, 0, image.width, image.height).data;
      let transparent = 0, partial = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (!pixels[i]) transparent++; else if (pixels[i] < 255) partial++; }
      const sample = (x, y) => Array.from(pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
      // Fill only the enclosed interior, preserving the source's irregular outer alpha.
      // Flood-fill from the canvas boundary to distinguish outside from the centre hole.
      if (name.startsWith('parchment-frame')) {
        const w = image.width, h = image.height;
        const outside = new Uint8Array(w * h), queue = new Int32Array(w * h);
        let head = 0, tail = 0;
        const visit = p => { if (!outside[p] && pixels[p * 4 + 3] < 128) { outside[p] = 1; queue[tail++] = p; } };
        for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
        while (head < tail) {
          const p = queue[head++], x = p % w;
          if (x) visit(p - 1); if (x < w - 1) visit(p + 1);
          if (p >= w) visit(p - w); if (p < w * (h - 1)) visit(p + w);
        }
        if (outside[Math.floor(h / 2) * w + Math.floor(w / 2)]) throw new Error('Frame outline is not closed');
        const paper = new Image(); paper.src = `data:image/png;base64,${vellum}`; await paper.decode();
        originalContext.clearRect(0, 0, w, h);
        originalContext.drawImage(paper, 0, 0, w, h);
        // Original edge fades naturally into the paper, rather than a square backing.
        originalContext.drawImage(image, 0, 0);
        const filled = originalContext.getImageData(0, 0, w, h);
        for (let p = 0; p < outside.length; p++) {
          if (outside[p]) {
            for (let c = 0; c < 4; c++) filled.data[p * 4 + c] = pixels[p * 4 + c];
          } else filled.data[p * 4 + 3] = 255;
        }
        originalContext.putImageData(filled, 0, 0);
      }
      // The separate tack has generous transparent margins. Trim a runtime copy,
      // ignoring near-invisible export specks and leaving an alpha gutter for
      // filtering; never rewrite the original.
      let bounds = crop;
      if (crop === 'alpha') {
        let left = image.width, top = image.height, right = -1, bottom = -1;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          if (pixels[(y * image.width + x) * 4 + 3] >= 32) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
        }
        if (right < left) throw new Error(`${name} has no visible artwork`);
        left = Math.max(0, left - 4); top = Math.max(0, top - 4);
        bounds = [left, top, Math.min(image.width, right + 5) - left, Math.min(image.height, bottom + 5) - top];
      }
      const [x, y, w, h] = bounds || [0, 0, image.width, image.height];
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = Math.round(h / w * size);
      const context = canvas.getContext('2d'); context.imageSmoothingQuality = 'high';
      context.drawImage(original, x, y, w, h, 0, 0, canvas.width, canvas.height);
      return { encoded: canvas.toDataURL('image/webp', .86).split(',')[1], width: image.width, height: image.height, transparent, partial,
        corner: sample(0, 0), centre: sample(Math.floor(image.width / 2), Math.floor(image.height / 2)), crop: bounds, output: [canvas.width, canvas.height] };
    }, { data, size, crop, name, vellum });
    const { encoded, ...audit } = result;
    const bytes = Buffer.from(encoded, 'base64');
    await writeFile(new URL(`${name}.webp`, destination), bytes);
    console.log(name, JSON.stringify({ ...audit, bytes: bytes.length }));
  }
  // The supplied board gets an independent grain tile so its metal corners and
  // rails can stay fixed-scale while rows grow without stretching the planks.
  const boardData = (await readFile(resolve(source, 'wooden-board.png'))).toString('base64');
  const boardCentre = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1024;
    const w = image.width - 380, h = image.height - 320;
    canvas.height = Math.round(h / w * 1024);
    canvas.getContext('2d').drawImage(image, 190, 160, w, h, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', .86).split(',')[1];
  }, boardData);
  const boardCentreBytes = Buffer.from(boardCentre, 'base64');
  await writeFile(new URL('wooden-board-centre.webp', destination), boardCentreBytes);
  console.log('wooden-board-centre', { inset: [190, 160], bytes: boardCentreBytes.length });
  // Legacy derivative retained for existing previews; the actual noticeboard now
  // uses wooden-board and its matching centre, not this desk crop.
  // Noticeboard: reuse a prop-free area of the supplied walnut desk, rotated
  // so the grain reads as a separate object. Mirroring joins the repeat edges.
  const deskData = (await readFile(resolve(source, 'desk-background.png'))).toString('base64');
  const walnut = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    if (image.width !== 1536 || image.height !== 1024) throw new Error('Walnut crop expects 1536 × 1024 desk');
    const tile = document.createElement('canvas'); tile.width = 500; tile.height = 860;
    const t = tile.getContext('2d'); t.translate(500, 0); t.rotate(Math.PI / 2);
    t.drawImage(image, 400, 280, 860, 500, 0, 0, 860, 500);
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 1720;
    const ctx = canvas.getContext('2d');
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      ctx.save(); ctx.translate(col ? 1000 : 0, row ? 1720 : 0); ctx.scale(col ? -1 : 1, row ? -1 : 1);
      ctx.drawImage(tile, 0, 0); ctx.restore();
    }
    return canvas.toDataURL('image/webp', .86).split(',')[1];
  }, deskData);
  const walnutBytes = Buffer.from(walnut, 'base64');
  await writeFile(new URL('walnut.webp', destination), walnutBytes);
  console.log('walnut', { crop: [400, 280, 860, 500], rotation: 90, output: [1000, 1720], bytes: walnutBytes.length });
  // Main sheet: independent proportional corners, mirrored edge strips and grain.
  // Only the repeating direction is mirrored; the outside alpha stays intact.
  const mainData = (await readFile(resolve(source, 'parchment-main.png'))).toString('base64');
  const pieces = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    if (image.width !== 1536 || image.height !== 1024) throw new Error('Main parchment slicing expects 1536 × 1024');
    const cuts = [
      ['tl', 0, 0, 320, 240], ['top', 320, 0, 896, 240, 'x'], ['tr', 1216, 0, 320, 240],
      ['left', 0, 240, 320, 424, 'y'], ['centre', 320, 240, 896, 424, 'xy'], ['right', 1216, 240, 320, 424, 'y'],
      ['bl', 0, 664, 320, 360], ['bottom', 320, 664, 896, 360, 'x'], ['br', 1216, 664, 320, 360],
    ];
    return cuts.map(([name, x, y, w, h, mirror = '']) => {
      const c = document.createElement('canvas'); c.width = w * (mirror.includes('x') ? 2 : 1); c.height = h * (mirror.includes('y') ? 2 : 1);
      const ctx = c.getContext('2d');
      for (let row = 0; row < c.height / h; row++) for (let col = 0; col < c.width / w; col++) {
        ctx.save(); ctx.translate(col ? 2 * w : 0, row ? 2 * h : 0); ctx.scale(col ? -1 : 1, row ? -1 : 1);
        ctx.drawImage(image, x, y, w, h, 0, 0, w, h); ctx.restore();
      }
      return { name, encoded: c.toDataURL('image/webp', .86).split(',')[1], cornerAlpha: ctx.getImageData(0, 0, 1, 1).data[3] };
    });
  }, mainData);
  for (const { name, encoded, cornerAlpha } of pieces) {
    const bytes = Buffer.from(encoded, 'base64');
    await writeFile(new URL(`main-${name}.webp`, destination), bytes);
    console.log(`main-${name}`, { bytes: bytes.length, cornerAlpha });
  }
  // Inspect the unused card frame too: an alpha channel alone does not guarantee a clean cutout.
  const data = (await readFile(resolve(source, 'quest-card-frame.png'))).toString('base64');
  console.log('quest-card-frame', await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { corner: Array.from(ctx.getImageData(0, 0, 1, 1).data), centre: Array.from(ctx.getImageData(768, 512, 1, 1).data) };
  }, data));
} finally { await browser.close(); }

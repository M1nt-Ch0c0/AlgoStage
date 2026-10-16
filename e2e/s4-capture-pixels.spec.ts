import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Pixel checks on the image attached to the ask request.
 * Dump tests write PNGs and run only when S4_PIXELS=1. The 390 opacity
 * assertion always runs and writes nothing. Scene helpers are copied from
 * e2e/s4-capture-perf.spec.ts and are not imported.
 */

const CACHE_KEY = "a".repeat(40);
const SCRIPT_VERSION = "b".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

type StepOpts = { id?: string; narration?: string; viz?: boolean };

function step(opts: StepOpts = {}) {
  const id = opts.id ?? "s1";
  return {
    id,
    narration: opts.narration ?? "开局把词按字母分组",
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    ...(opts.viz === false
      ? {}
      : { viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } } }),
  };
}

function lectureNdjson(options: {
  steps?: ReturnType<typeof step>[];
  askDisabledStepIds?: string[];
  withResult?: boolean;
}) {
  const steps = options.steps ?? [step(), step({ id: "s2", narration: "再写回结果" }), step({ id: "s3", narration: "返回分组" })];
  const lines = steps.map((item) => JSON.stringify({ type: "step", step: item }));
  if (options.withResult !== false) {
    lines.push(
      JSON.stringify({
        type: "result",
        script: {
          problemSlug: "group-anagrams",
          mode: "lecture",
          language: "zh",
          solutionLanguage: "typescript",
          steps,
        },
        cacheKey: CACHE_KEY,
        scriptVersion: SCRIPT_VERSION,
        answers: {},
        askDisabledStepIds: options.askDisabledStepIds ?? [],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function askStream(stepId: string) {
  const segment = { id: "seg1", narration: ANSWER_NARRATION };
  const answer = {
    v: 1,
    id: "ans-e2e-sel",
    stepId,
    question: QUESTION,
    selection: {
      mode: "region",
      bbox: { x: 0, y: 0, width: 40, height: 40 },
      targets: [{ kind: "viz", id: `viz:${stepId}`, stepId, text: "可视化" }],
    },
    segments: [segment],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
  return [
    JSON.stringify({ type: "start", answerId: answer.id, stepId, imageUsed: false }),
    JSON.stringify({ type: "segment", segment }),
    JSON.stringify({ type: "result", answer }),
  ].join("\n") + "\n";
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockSettings(page: Page) {
  await page.route("**/api/settings", (route) => fulfillJson(route, { serverKeyDisabled: false, keySource: "env" }));
}

async function mockLecture(page: Page, body: string) {
  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body,
    });
  });
}

async function startGenerated(page: Page) {
  await mockSettings(page);
  await mockLecture(page, lectureNdjson({}));
  await page.goto("/problem/group-anagrams");
  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
}

async function pauseLecture(page: Page) {
  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();
  await expect(resume).toBeVisible();
}

async function enterSelection(page: Page) {
  const button = page.locator("[data-ask-entry]");
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function dragOnStage(page: Page) {
  const stage = page.locator("[data-ask-stage]");
  const viz = stage.locator('[data-ask-id="viz:s1"]').first();
  await expect(viz).toBeVisible();
  const box = await viz.boundingBox();
  if (!box) throw new Error("viz target has no box");
  const startX = box.x + 8;
  const startY = box.y + 8;
  const endX = box.x + Math.max(box.width - 8, 40);
  const endY = box.y + Math.max(Math.min(box.height - 8, 80), 36);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
}

async function dragOnSubtitle(page: Page) {
  const subtitleBody = page.locator('[data-ask-target="subtitle"] p').filter({ hasNotText: "字幕" }).first();
  await subtitleBody.scrollIntoViewIfNeeded();
  const box = await subtitleBody.boundingBox();
  if (!box) throw new Error("subtitle body has no box");
  const startX = box.x + 20;
  const startY = box.y + 5;
  const endX = box.x + box.width - 20;
  const endY = box.y + box.height + 30;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-ask-panel]")).toBeVisible();
}

type AskImage = { mime: string; dataBase64: string };

type CropBox = { x: number; y: number; width: number; height: number };

const OUT_DIR = process.env.S4_OUT_DIR ?? path.join("test-results", "s4-pixels");
const LABEL = process.env.S4_LABEL ?? "pixels";
/** board-950. The flattened dump is composited onto this opaque base. */
const BOARD_950 = { r: 12, g: 19, b: 17 };

type PngPixel = { r: number; g: number; b: number; a: number };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

/** Decode an 8-bit PNG (color types 2 and 6) without writing it. */
function decodePngPixels(png: Buffer): { width: number; height: number; pixels: PngPixel[] } {
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("not a png");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = readU32(png, offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      const bitDepth = data[8];
      colorType = data[9] ?? 0;
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported png ${bitDepth}/${colorType}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels: PngPixel[] = [];
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos];
    pos += 1;
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = prev[i]!;
      const upLeft = i >= channels ? prev[i - channels]! : 0;
      const byte = row[i]!;
      if (filter === 1) row[i] = (byte + left) & 255;
      else if (filter === 2) row[i] = (byte + up) & 255;
      else if (filter === 3) row[i] = (byte + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[i] = (byte + paeth(left, up, upLeft)) & 255;
    }
    prev = row;
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      pixels.push({
        r: row[i]!,
        g: row[i + 1]!,
        b: row[i + 2]!,
        a: channels === 4 ? row[i + 3]! : 255,
      });
    }
  }
  return { width, height, pixels };
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Composite RGBA pixels onto an opaque board-950 base and return a PNG.
 * Used only by the S4_PIXELS dump so a later diff can compare against r4.
 */
/** Encode RGBA pixels (row-major) as an 8-bit PNG. */
function encodeRgbaPng(width: number, height: number, pixels: PngPixel[]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const pixel = pixels[y * width + x]!;
      const i = rowStart + 1 + x * 4;
      raw[i] = pixel.r;
      raw[i + 1] = pixel.g;
      raw[i + 2] = pixel.b;
      raw[i + 3] = pixel.a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Per-channel delta. A pixel fails when any channel differs by more than
 * CHANNEL_TOLERANCE. A block is a run of failing pixels that share a row
 * and are at least BLOCK_EDGE long on both axes of the failing set.
 */
const CHANNEL_TOLERANCE = 4;
const BLOCK_EDGE = 8;

function pixelDelta(a: PngPixel, b: PngPixel): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(a.a - b.a),
  );
}

/**
 * Crop pixels that overlap a `.monaco-editor` box. Capture blanks that
 * subtree in place (visibility:hidden), so those pixels are an opaque board
 * fill and must not be 99%-compared to live code. The current 1280 viz drag
 * and 390 subtitle drag do not hit monaco; this records the overlap so a
 * later code crop can split the assert. Returns CSS-pixel rects in the
 * pre-encode image (origin = crop origin).
 */
async function monacoOverlapInCrop(
  page: Page,
  crop: CropBox,
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return page.evaluate((box) => {
    const editors = document.querySelectorAll(".monaco-editor");
    const hits: { x: number; y: number; width: number; height: number }[] = [];
    const cropRight = box.x + box.width;
    const cropBottom = box.y + box.height;
    for (const editor of editors) {
      const rect = editor.getBoundingClientRect();
      const left = Math.max(box.x, rect.left);
      const top = Math.max(box.y, rect.top);
      const right = Math.min(cropRight, rect.right);
      const bottom = Math.min(cropBottom, rect.bottom);
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) continue;
      hits.push({
        x: left - box.x,
        y: top - box.y,
        width,
        height,
      });
    }
    return hits;
  }, crop);
}

/**
 * Code pixels the product blanks: opaque fill, transparency ≤1%, no half
 * glyphs (no channel spread that would be a leftover stroke or mask edge).
 * Callers pass only the pixels inside the monaco overlap. A flat gold frame
 * is not a pass: the non-code 99% assert still covers the rest of the crop.
 */
function assertBlankedCodePixels(pixels: PngPixel[]): void {
  expect(pixels.length, "code-region sample").toBeGreaterThan(0);
  let transparent = 0;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (const pixel of pixels) {
    if (pixel.a < 255) transparent += 1;
    if (pixel.r < minR) minR = pixel.r;
    if (pixel.r > maxR) maxR = pixel.r;
    if (pixel.g < minG) minG = pixel.g;
    if (pixel.g > maxG) maxG = pixel.g;
    if (pixel.b < minB) minB = pixel.b;
    if (pixel.b > maxB) maxB = pixel.b;
  }
  expect(transparent / pixels.length, "code region transparency").toBeLessThanOrEqual(0.01);
  // A glyph or a gold stroke spreads a channel by well more than a flat fill.
  const spread = Math.max(maxR - minR, maxG - minG, maxB - minB);
  expect(spread, "code region is a flat opaque fill, no half glyphs").toBeLessThanOrEqual(8);
}

function comparePixels(
  baseline: PngPixel[],
  candidate: PngPixel[],
  width: number,
  height: number,
  skip?: Uint8Array,
): { matchRatio: number; largestBlock: number; diff: PngPixel[] } {
  const total = width * height;
  let compared = 0;
  let matched = 0;
  const fail = new Uint8Array(total);
  const diff: PngPixel[] = new Array(total);
  for (let i = 0; i < total; i++) {
    if (skip?.[i]) {
      diff[i] = { r: 0, g: 40, b: 0, a: 255 };
      continue;
    }
    compared += 1;
    const delta = pixelDelta(baseline[i]!, candidate[i]!);
    if (delta <= CHANNEL_TOLERANCE) {
      matched += 1;
      diff[i] = { r: 0, g: 0, b: 0, a: 255 };
    } else {
      fail[i] = 1;
      const mag = Math.min(255, delta);
      diff[i] = { r: mag, g: 0, b: 0, a: 255 };
    }
  }
  // Largest axis-aligned run of failing pixels. A block is large when both
  // its width and its height reach BLOCK_EDGE.
  let largestBlock = 0;
  const seen = new Uint8Array(total);
  for (let start = 0; start < total; start++) {
    if (!fail[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let count = 0;
    while (queue.length > 0) {
      const at = queue.pop()!;
      count += 1;
      const x = at % width;
      const y = Math.floor(at / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [at - 1, at + 1, at - width, at + width];
      for (const next of neighbors) {
        if (next < 0 || next >= total || seen[next] || !fail[next]) continue;
        const nx = next % width;
        const ny = Math.floor(next / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    const blockW = maxX - minX + 1;
    const blockH = maxY - minY + 1;
    if (blockW >= BLOCK_EDGE && blockH >= BLOCK_EDGE) {
      largestBlock = Math.max(largestBlock, count);
    }
  }
  return { matchRatio: compared === 0 ? 1 : matched / compared, largestBlock, diff };
}

function flattenOntoBoard950(png: Buffer): Buffer {
  const { width, height, pixels } = decodePngPixels(png);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const pixel = pixels[y * width + x]!;
      const alpha = pixel.a / 255;
      const i = rowStart + 1 + x * 3;
      raw[i] = Math.round(pixel.r * alpha + BOARD_950.r * (1 - alpha));
      raw[i + 1] = Math.round(pixel.g * alpha + BOARD_950.g * (1 - alpha));
      raw[i + 2] = Math.round(pixel.b * alpha + BOARD_950.b * (1 - alpha));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode the ask image payload to PNG bytes. WebP and JPEG both go through a canvas. */
async function payloadToPng(page: Page, image: AskImage): Promise<Buffer> {
  const dataUrl = `data:${image.mime};base64,${image.dataBase64}`;
  const base64 = await page.evaluate(async (url) => {
    const decoded = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(decoded, 0, 0);
    decoded.close();
    const png = canvas.toDataURL("image/png");
    const comma = png.indexOf(",");
    return png.slice(comma + 1);
  }, dataUrl);
  return Buffer.from(base64, "base64");
}

/**
 * Submit one ask and return the image the request body actually sent.
 * Same scene as the dump: pause, enter selection, drag, fill, submit.
 */
async function submitAskImage(page: Page, width: number): Promise<AskImage> {
  test.setTimeout(120_000);
  let image: AskImage | null = null;
  let received: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    received = resolve;
  });

  await page.route("**/api/lecture/ask", async (route) => {
    const body = route.request().postDataJSON() as { image?: AskImage | null };
    if (body.image && typeof body.image.dataBase64 === "string") image = body.image;
    received();
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });

  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  if (width === 390) await dragOnSubtitle(page);
  else await dragOnStage(page);

  const panel = page.locator("[data-ask-panel]");
  await panel.locator("[data-ask-question]").fill(QUESTION);
  await panel.locator("[data-ask-submit]").click();
  await asked;

  expect(image, "ask request attached an image").not.toBeNull();
  return image as unknown as AskImage;
}

type CaptureProbe = {
  captureCanvas?: HTMLCanvasElement;
  captureCloneMs?: number;
  captureEmbedMs?: number;
  captureSvgMs?: number;
  captureRasterMs?: number;
  captureSourceNodes?: number;
  captureClonedNodes?: number;
};

/**
 * Submit one ask and keep the pre-encode canvas on the timing probe.
 * The panel is closed and the selection overlay removed before the caller
 * screenshots the same CSS rect the crop used.
 */
async function submitAndReadCrop(page: Page, width: number): Promise<{ image: AskImage; crop: CropBox; dpr: number }> {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as unknown as { __ASK_TIMING__?: object }).__ASK_TIMING__ = {};
  });
  let image: AskImage | null = null;
  let received: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    received = resolve;
  });

  await page.route("**/api/lecture/ask", async (route) => {
    const body = route.request().postDataJSON() as { image?: AskImage | null };
    if (body.image && typeof body.image.dataBase64 === "string") image = body.image;
    received();
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream("s1"),
    });
  });

  await startGenerated(page);
  await pauseLecture(page);
  await enterSelection(page);
  if (width === 390) await dragOnSubtitle(page);
  else await dragOnStage(page);

  const panel = page.locator("[data-ask-panel]");
  await panel.locator("[data-ask-question]").fill(QUESTION);
  const crop = await page.evaluate(() => {
    const box = document.querySelector("[data-ask-selection]")?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  expect(crop, "selection box has a CSS rect").not.toBeNull();
  await panel.locator("[data-ask-submit]").click();
  await asked;
  expect(image, "ask request attached an image").not.toBeNull();

  await expect(page.locator("[data-ask-panel]")).toHaveCount(0);
  await page.evaluate(() => {
    document.querySelector("[data-ask-layer]")?.remove();
  });
  await expect(page.locator("[data-ask-layer]")).toHaveCount(0);
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  return { image: image as unknown as AskImage, crop: crop as CropBox, dpr };
}

/** Pre-encode canvas (HEAD) as PNG bytes. Null when the probe never stored one. */
async function readPreEncodePng(page: Page): Promise<Buffer | null> {
  const base64 = await page.evaluate(() => {
    const probe = (window as unknown as { __ASK_TIMING__?: CaptureProbe }).__ASK_TIMING__;
    const canvas = probe?.captureCanvas;
    if (!canvas || typeof canvas.toDataURL !== "function") return null;
    const png = canvas.toDataURL("image/png");
    const comma = png.indexOf(",");
    return comma < 0 ? null : png.slice(comma + 1);
  });
  if (!base64) return null;
  return Buffer.from(base64, "base64");
}

/**
 * Screenshot the selection's CSS rect at scale "css", sized to the pre-encode
 * canvas. Capture rasters at scale:1, so the baseline is already CSS pixels.
 * A full-page device-pixel shot scaled down to that size anti-aliases glyphs
 * a second time and misses the 0.99 gate on edges the product painted once.
 *
 * The selection bbox is fractional. Playwright's clip rounds each edge to a
 * device pixel and then divides by DPR, so a half-pixel origin (390, y=430.5,
 * DPR 3) comes back one CSS pixel taller than canvas drawImage's floor/ceil
 * crop. The clip is snapped to outWidth×outHeight, which is that canvas size.
 */
async function baselinePng(page: Page, crop: CropBox, outWidth: number, outHeight: number): Promise<Buffer> {
  return page.screenshot({
    type: "png",
    scale: "css",
    clip: {
      x: Math.floor(crop.x),
      y: Math.floor(crop.y),
      width: outWidth,
      height: outHeight,
    },
  });
}

async function assertPreEncodePixels(page: Page, width: number) {
  const { image, crop, dpr } = await submitAndReadCrop(page, width);
  const candidatePng = await readPreEncodePng(page);
  expect(candidatePng, "pre-encode canvas on __ASK_TIMING__").not.toBeNull();
  const candidate = decodePngPixels(candidatePng as Buffer);
  console.log(
    JSON.stringify({
      width,
      dpr,
      cropCss: crop,
      preEncode: { w: candidate.width, h: candidate.height },
      encodedMime: image.mime,
      encodedBytes: Math.floor((image.dataBase64.length * 3) / 4),
    }),
  );
  if (width === 390) {
    // The 390 subtitle drag crops about 258×73 CSS px. Log the actual size
    // and keep the assertion on that order, not on a single frozen pair.
    expect(candidate.width).toBeGreaterThan(180);
    expect(candidate.width).toBeLessThan(340);
    expect(candidate.height).toBeGreaterThan(40);
    expect(candidate.height).toBeLessThan(140);
  }
  const baselineBuf = await baselinePng(page, crop, candidate.width, candidate.height);
  const baseline = decodePngPixels(baselineBuf);
  expect(baseline.width).toBe(candidate.width);
  expect(baseline.height).toBe(candidate.height);

  // Monaco overlap is in CSS px relative to the crop. The current drags
  // (1280 viz, 390 subtitle) miss `.monaco-editor`. When a crop does overlap,
  // those pixels are asserted as a blank opaque fill and left out of the 99%
  // compare. Every other pixel still has to match the closed-panel crop.
  const monacoBoxes = await monacoOverlapInCrop(page, crop);
  const scaleX = candidate.width / crop.width;
  const scaleY = candidate.height / crop.height;
  const skip = new Uint8Array(candidate.width * candidate.height);
  const codePixels: PngPixel[] = [];
  for (const box of monacoBoxes) {
    const x0 = Math.max(0, Math.floor(box.x * scaleX));
    const y0 = Math.max(0, Math.floor(box.y * scaleY));
    const x1 = Math.min(candidate.width, Math.ceil((box.x + box.width) * scaleX));
    const y1 = Math.min(candidate.height, Math.ceil((box.y + box.height) * scaleY));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * candidate.width + x;
        if (skip[index]) continue;
        skip[index] = 1;
        codePixels.push(candidate.pixels[index]!);
      }
    }
  }
  if (codePixels.length > 0) {
    assertBlankedCodePixels(codePixels);
  }

  const { matchRatio, largestBlock, diff } = comparePixels(
    baseline.pixels,
    candidate.pixels,
    candidate.width,
    candidate.height,
    skip,
  );
  mkdirSync(OUT_DIR, { recursive: true });
  const baselineFile = path.join(OUT_DIR, `${LABEL}-${width}-baseline.png`);
  const candidateFile = path.join(OUT_DIR, `${LABEL}-${width}-preencode.png`);
  const diffFile = path.join(OUT_DIR, `${LABEL}-${width}-diff.png`);
  writeFileSync(baselineFile, baselineBuf);
  writeFileSync(candidateFile, candidatePng as Buffer);
  writeFileSync(diffFile, encodeRgbaPng(candidate.width, candidate.height, diff));
  console.log(
    JSON.stringify({
      width,
      matchRatio,
      largestBlock,
      monacoOverlapPx: codePixels.length,
      baselineFile,
      candidateFile,
      diffFile,
    }),
  );
  expect(matchRatio, `pre-encode pixels within ${CHANNEL_TOLERANCE} per channel`).toBeGreaterThanOrEqual(0.99);
  expect(largestBlock, "no large block of differing pixels").toBe(0);
}

async function capturePixels(page: Page, width: number) {
  const payload = await submitAskImage(page, width);
  expect(payload.mime === "image/webp" || payload.mime === "image/jpeg").toBe(true);
  const png = await payloadToPng(page, payload);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${LABEL}-${width}.png`);
  writeFileSync(file, png);
  const flatFile = path.join(OUT_DIR, `${LABEL}-${width}-board950.png`);
  writeFileSync(flatFile, flattenOntoBoard950(png));
  console.log(JSON.stringify({ label: LABEL, width, file, flatFile, mime: payload.mime, bytes: png.length }));
}

test.describe("S4 capture pixels", () => {
  test.describe("1280x800", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("saves the captured image at 1280", async ({ page }) => {
      test.skip(process.env.S4_PIXELS !== "1", "set S4_PIXELS=1 to dump the ask capture image");
      await capturePixels(page, 1280);
    });

    test("pre-encode canvas matches the closed-panel screenshot at 1280", async ({ page }) => {
      await assertPreEncodePixels(page, 1280);
    });
  });

  test.describe("390x844", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
      viewport: { width: 390, height: 844 },
    });

    test("saves the captured image at 390", async ({ page }) => {
      test.skip(process.env.S4_PIXELS !== "1", "set S4_PIXELS=1 to dump the ask capture image");
      await capturePixels(page, 390);
    });

    test("pre-encode canvas matches the closed-panel screenshot at 390", async ({ page }) => {
      await assertPreEncodePixels(page, 390);
    });

    test("the 390 ask image is at most 1% transparent", async ({ page }) => {
      const payload = await submitAskImage(page, 390);
      expect(payload.mime === "image/webp" || payload.mime === "image/jpeg" || payload.mime === "image/png").toBe(true);
      if (payload.mime === "image/jpeg") {
        test.info().annotations.push({
          type: "note",
          description: "image/jpeg has no alpha channel; opacity is trivially opaque",
        });
        return;
      }
      const png = await payloadToPng(page, payload);
      const { pixels } = decodePngPixels(png);
      expect(pixels.length).toBeGreaterThan(0);
      let transparent = 0;
      for (const pixel of pixels) {
        if (pixel.a < 255) transparent += 1;
      }
      expect(transparent / pixels.length).toBeLessThanOrEqual(0.01);
    });
  });
});

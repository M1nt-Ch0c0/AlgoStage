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
  });

  test.describe("390x844", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test("saves the captured image at 390", async ({ page }) => {
      test.skip(process.env.S4_PIXELS !== "1", "set S4_PIXELS=1 to dump the ask capture image");
      await capturePixels(page, 390);
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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * S4 pixel dump of the image attached to the ask request.
 * The whole file is skipped unless S4_PIXELS=1. It is not part of daily e2e.
 * Scene helpers are copied from e2e/s4-capture-perf.spec.ts and are not imported.
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

type AskImage = {
  mime: string;
  dataBase64: string;
  width?: number;
  height?: number;
  rect?: unknown;
  scale?: number;
  dpr?: number;
  [key: string]: unknown;
};

const OUT_DIR = process.env.S4_OUT_DIR ?? "/workspace/logs/gavin-s4-capture";
const LABEL = process.env.S4_LABEL ?? "pixels";

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

async function capturePixels(page: Page, width: number) {
  test.setTimeout(120_000);
  let image: AskImage | null = null;
  let received: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    received = resolve;
  });

  await page.route("**/api/lecture/ask", async (route) => {
    const body = route.request().postDataJSON() as { image?: AskImage | null };
    if (body.image && typeof body.image.dataBase64 === "string") {
      image = body.image;
      // Extra dump, before the response. The asserts below are unchanged.
      // captureStage passes the [data-ask-stage] element to domToCanvas, and
      // that attribute is on the same element at 22a4807.
      mkdirSync(OUT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(OUT_DIR, `${LABEL}-${width}-viewport.png`),
        fullPage: false,
      });
      const { dataBase64, ...imageMeta } = body.image;
      const rawExt = body.image.mime === "image/webp" ? "webp" : "jpg";
      writeFileSync(
        path.join(OUT_DIR, `${LABEL}-${width}-raw.${rawExt}`),
        Buffer.from(dataBase64, "base64"),
      );
      const stageBox = await page.evaluate(() => {
        const stage = document.querySelector("[data-ask-stage]");
        const box = stage?.getBoundingClientRect();
        return {
          selector: "[data-ask-stage]",
          devicePixelRatio: window.devicePixelRatio,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          rect: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        };
      });
      writeFileSync(
        path.join(OUT_DIR, `${LABEL}-${width}-meta.json`),
        JSON.stringify({ image: imageMeta, ...stageBox }, null, 2),
      );
    }
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
  const payload = image as unknown as AskImage;
  expect(payload.mime === "image/webp" || payload.mime === "image/jpeg").toBe(true);
  const png = await payloadToPng(page, payload);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${LABEL}-${width}.png`);
  writeFileSync(file, png);
  console.log(JSON.stringify({ label: LABEL, width, file, mime: payload.mime, bytes: png.length }));
}

test.describe("S4 capture pixels", () => {
  test.skip(process.env.S4_PIXELS !== "1", "set S4_PIXELS=1 to dump the ask capture image");

  test.describe("1280x800", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("saves the captured image at 1280", async ({ page }) => {
      await capturePixels(page, 1280);
    });
  });

  test.describe("390x844", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

    test("saves the captured image at 390", async ({ page }) => {
      await capturePixels(page, 390);
    });
  });
});

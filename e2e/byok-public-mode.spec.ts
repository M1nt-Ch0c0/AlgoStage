import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Public instance (serverKeyDisabled) must attach the local BYOK key to
 * lecture, hint, and ask bodies. Responses are mocked so no upstream is contacted.
 */

const FAKE_KEY = "sk-fake-e2e-0000";
const CACHE_KEY = "c".repeat(40);
const SCRIPT_VERSION = "d".repeat(40);
const QUESTION = "这一步在做什么？";
const ANSWER_NARRATION = "把相同字母的词放进同一组。";

function step(id = "s1", narration = "开局把词按字母分组") {
  return {
    id,
    narration,
    targets: [{ kind: "code-line", start: 1, end: 2 }],
    effects: [],
    dwellMs: 60_000,
    viz: { type: "array", state: { values: [1, 2, 3], highlight: [0] } },
  };
}

function lectureNdjson() {
  const steps = [step(), step("s2", "再写回结果"), step("s3", "返回分组")];
  const lines = [
    ...steps.map((item) => JSON.stringify({ type: "step", step: item })),
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
      askDisabledStepIds: [],
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function askStream() {
  const segment = { id: "seg1", narration: ANSWER_NARRATION };
  const answer = {
    v: 1,
    id: "ans-e2e-byok",
    stepId: "s1",
    question: QUESTION,
    selection: {
      mode: "single",
      bbox: { x: 0, y: 0, width: 40, height: 40 },
      targets: [{ kind: "step", id: "step:s1", stepId: "s1", text: "开局把词按字母分组" }],
    },
    segments: [segment],
    createdAt: "2026-10-14T00:00:00.000Z",
  };
  return [
    JSON.stringify({ type: "start", answerId: answer.id, stepId: "s1", imageUsed: false }),
    JSON.stringify({ type: "segment", segment }),
    JSON.stringify({ type: "result", answer }),
  ].join("\n") + "\n";
}

type ByokBody = { byok?: { apiKey?: string } };

function readByokKey(route: Route): string | undefined {
  const body = route.request().postDataJSON() as ByokBody;
  return body.byok?.apiKey;
}

async function mockPublicSettings(page: Page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {},
        keySource: "none",
        envConfigured: false,
        serverKeyDisabled: true,
      }),
    });
  });
}

test("public mode attaches the local key to lecture, hint, and ask", async ({ page }) => {
  const seen: { lecture?: string; hint?: string; ask?: string } = {};

  await mockPublicSettings(page);

  await page.route("**/api/lecture/ask", async (route) => {
    seen.ask = readByokKey(route);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: askStream(),
    });
  });

  await page.route("**/api/lecture", async (route) => {
    if (route.request().url().includes("/api/lecture/ask")) {
      await route.fallback();
      return;
    }
    seen.lecture = readByokKey(route);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: lectureNdjson(),
    });
  });

  await page.route("**/api/hint", async (route) => {
    seen.hint = readByokKey(route);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ level: 1, hint: "先看输入里有没有重复的字母。" }),
    });
  });

  await page.addInitScript((key) => {
    window.localStorage.setItem("algostage.byok", JSON.stringify({ apiKey: key }));
  }, FAKE_KEY);
  await page.goto("/problem/group-anagrams");

  await page.locator("header").getByRole("button", { name: "开始讲课", exact: true }).click();
  await expect(page.getByText("第 1 / 3 步")).toBeVisible();
  expect(seen.lecture).toBe(FAKE_KEY);

  const pause = page.locator("header").getByRole("button", { name: "暂停", exact: true });
  const resume = page.locator("header").getByRole("button", { name: "继续", exact: true });
  await expect(pause.or(resume)).toBeVisible();
  if (await pause.isVisible()) await pause.click();

  await page.getByRole("button", { name: /L1\s*观察/ }).click();
  await expect(page.getByText("先看输入里有没有重复的字母。")).toBeVisible();
  expect(seen.hint).toBe(FAKE_KEY);

  const entry = page.locator("[data-ask-entry]");
  await expect(entry).toBeEnabled();
  await entry.click();
  await expect(page.locator("[data-ask-layer]")).toBeVisible();
  await page.locator('[data-ask-shortcut="step"]').click();
  const panel = page.locator("[data-ask-panel]");
  await expect(panel).toBeVisible();
  await panel.locator("[data-ask-question]").fill(QUESTION);
  await panel.locator("[data-ask-submit]").click();
  await expect(page.getByText(ANSWER_NARRATION)).toBeVisible();
  expect(seen.ask).toBe(FAKE_KEY);
});

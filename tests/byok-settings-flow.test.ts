// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AiSetupPrompt from "../components/settings/ai-setup-prompt";
import { resetServerKeyDisabledCache } from "../lib/byok/client";
import { BYOK_STORAGE_KEY, maskKey, readLocalByok } from "../lib/byok/storage";
import { localSeedSource } from "../lib/content/local-source";
import { usePlayerStore } from "../lib/player/store";

const params = vi.hoisted(() => ({ slug: "3sum" }));
vi.mock("next/navigation", () => ({ useParams: () => params }));
vi.mock("motion/react", () => ({
  motion: {
    svg: "svg",
    path: () => null,
    span: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("span", { className }, children),
  },
}));
vi.mock("../components/board/code-editor", () => ({
  default: ({ value }: { value: string }) =>
    createElement("pre", { "data-editor": true }, value),
}));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));

import ProblemPage from "../app/problem/[slug]/page";
import SettingsPage from "../app/settings/page";

const PROBLEM_HINT = "这道题的 AI 讲解需要你自己的 API Key。";
const LOCAL_ONLY_COPY = "Key 只保存在你这台浏览器里，不会存到服务器";
const FORBIDDEN_COPY = "保存到服务器";

const step = {
  id: "s1",
  narration: "哈希归组",
  targets: [{ kind: "code-line" as const, start: 2 }],
  effects: [],
  dwellMs: 5000,
};

const lectureNdjson = (problemSlug: string) =>
  JSON.stringify({ type: "step", step }) +
  "\n" +
  JSON.stringify({
    type: "result",
    script: {
      problemSlug,
      mode: "lecture",
      solutionLanguage: "typescript",
      language: "zh",
      steps: [step],
    },
  }) +
  "\n";

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("BYOK local-only settings & prompt end-to-end flow", () => {
  let settingsContainer: HTMLDivElement;
  let settingsRoot: Root;
  let problemContainer: HTMLDivElement;
  let problemRoot: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    resetServerKeyDisabledCache();
    usePlayerStore.getState().reset();
    params.slug = "3sum";

    settingsContainer = document.createElement("div");
    problemContainer = document.createElement("div");
    document.body.append(settingsContainer, problemContainer);
    settingsRoot = createRoot(settingsContainer);
    problemRoot = createRoot(problemContainer);
  });

  afterEach(async () => {
    await act(async () => {
      settingsRoot.unmount();
      problemRoot.unmount();
    });
    settingsContainer.remove();
    problemContainer.remove();
    window.localStorage.clear();
    resetServerKeyDisabledCache();
    usePlayerStore.getState().reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  test("serverKeyDisabled=true full flow: prompt visible -> save local key (no PUT) -> prompt hides -> reload masked -> switch slug & lecture POST has byok -> clear key restores prompt", async () => {
    const rawKey = "sk-local-only-secret-key-99887766";
    const masked = maskKey(rawKey);
    const fetchedUrls: string[] = [];
    const putCalls: unknown[] = [];
    const lectureBodies: Record<string, unknown>[] = [];
    const hintBodies: Record<string, unknown>[] = [];

    const assertNoRawKeyLeak = () => {
      expect(document.body.innerHTML).not.toContain(rawKey);
      for (const url of fetchedUrls) {
        expect(url).not.toContain(rawKey);
      }
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (init?.method === "PUT") {
        putCalls.push(init.body);
        return Response.json({ error: "SETTINGS_LOCKED" }, { status: 403 });
      }
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "none",
          serverKeyDisabled: true,
        });
      }
      const slugMatch = url.match(/\/api\/problems\/([^/]+)$/);
      if (slugMatch) {
        return Response.json({
          problem: await localSeedSource.detail(slugMatch[1]),
        });
      }
      if (url.endsWith("/api/lecture")) {
        const body = JSON.parse(String(init?.body));
        lectureBodies.push(body);
        return new Response(lectureNdjson(String(body.slug ?? "3sum")), {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }
      if (url.endsWith("/api/hint")) {
        const body = JSON.parse(String(init?.body));
        hintBodies.push(body);
        return Response.json({ level: 1, hint: "连接正常" });
      }
      return Response.json({ ok: true });
    });

    // 1. No key -> prompt visible on problem page, local-only copy on settings page
    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
      problemRoot.render(createElement(ProblemPage));
    });

    expect(problemContainer.textContent).toContain(PROBLEM_HINT);
    expect(settingsContainer.textContent).toContain(LOCAL_ONLY_COPY);
    expect(settingsContainer.textContent).not.toContain(FORBIDDEN_COPY);
    expect(document.body.textContent).not.toContain(FORBIDDEN_COPY);
    assertNoRawKeyLeak();

    // 2. Enter key, baseURL, model and save on settings page -> NO PUT, localStorage set, input cleared, masked key shown, prompt hides immediately
    await act(async () => {
      const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
      const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
      const modelInput = settingsContainer.querySelector<HTMLInputElement>("#model")!;
      setInputValue(keyInput, `  ${rawKey}  `);
      setInputValue(baseInput, "  https://api.deepseek.com/v1  ");
      setInputValue(modelInput, "  deepseek-chat  ");
    });

    const saveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(putCalls).toHaveLength(0);
    expect(window.localStorage.getItem(BYOK_STORAGE_KEY)).not.toBeNull();
    expect(readLocalByok()).toEqual({
      apiKey: rawKey,
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });

    const keyInputAfterSave =
      settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    expect(keyInputAfterSave.value).toBe("");
    expect(settingsContainer.textContent).toContain(masked);
    expect(problemContainer.textContent).not.toContain(PROBLEM_HINT);
    assertNoRawKeyLeak();

    // Test connection on settings page uses local byok in POST body (never in URL)
    const testBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });
    expect(hintBodies).toHaveLength(1);
    expect(hintBodies[0]).toEqual({
      slug: "two-sum",
      level: 1,
      byok: {
        apiKey: rawKey,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      },
    });
    assertNoRawKeyLeak();

    // 3. Unmount/remount (reload) -> still saved, masked, prompt still hidden
    await act(async () => {
      settingsRoot.unmount();
      problemRoot.unmount();
    });
    settingsRoot = createRoot(settingsContainer);
    problemRoot = createRoot(problemContainer);

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
      problemRoot.render(createElement(ProblemPage));
    });

    expect(readLocalByok()).toEqual({
      apiKey: rawKey,
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
    expect(settingsContainer.textContent).toContain(masked);
    expect(settingsContainer.textContent).toContain(LOCAL_ONLY_COPY);
    expect(settingsContainer.textContent).not.toContain(FORBIDDEN_COPY);
    expect(
      settingsContainer.querySelector<HTMLInputElement>("#apiKey")!.value,
    ).toBe("");
    expect(
      settingsContainer.querySelector<HTMLInputElement>("#baseURL")!.value,
    ).toBe("https://api.deepseek.com/v1");
    expect(
      settingsContainer.querySelector<HTMLInputElement>("#model")!.value,
    ).toBe("deepseek-chat");
    expect(problemContainer.textContent).not.toContain(PROBLEM_HINT);
    assertNoRawKeyLeak();

    // 4. Switch problem slug -> prompt still hidden and lecture POST body has byok
    params.slug = "group-anagrams";
    await act(async () => {
      problemRoot.unmount();
    });
    problemRoot = createRoot(problemContainer);
    await act(async () => {
      problemRoot.render(createElement(ProblemPage));
    });

    expect(problemContainer.textContent).not.toContain(PROBLEM_HINT);

    const startLectureBtn = Array.from(
      problemContainer.querySelectorAll<HTMLButtonElement>("header button"),
    ).find((b) => b.textContent === "开始讲课")!;
    await act(async () => {
      startLectureBtn.click();
    });

    expect(lectureBodies).toHaveLength(1);
    expect(lectureBodies[0]).toMatchObject({
      slug: "group-anagrams",
      solutionLanguage: "typescript",
      byok: {
        apiKey: rawKey,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      },
    });
    assertNoRawKeyLeak();

    // 5. Click '清除本机 Key' -> storage cleared, masked key gone, prompt shows again
    const clearBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent === "清除本机 Key",
    )!;
    expect(clearBtn).toBeDefined();
    await act(async () => {
      clearBtn.click();
    });

    expect(window.localStorage.getItem(BYOK_STORAGE_KEY)).toBeNull();
    expect(readLocalByok()).toBeNull();
    expect(settingsContainer.textContent).not.toContain(masked);
    expect(problemContainer.textContent).toContain(PROBLEM_HINT);
    expect(putCalls).toHaveLength(0);
    assertNoRawKeyLeak();
  });

  test("settings page testConnection maps BYOK error codes via mapByokErrorMessage in serverKeyDisabled mode", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "none",
          serverKeyDisabled: true,
        });
      }
      if (url.endsWith("/api/hint")) {
        return Response.json(
          { code: "SETTINGS_LOCKED", error: "SETTINGS_LOCKED" },
          { status: 403 },
        );
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const testBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });

    expect(settingsContainer.textContent).toContain("公共实例不支持修改服务器设置");
    expect(settingsContainer.textContent).not.toContain("SETTINGS_LOCKED");
  });

  test("settings page testConnection NO_BYOK in serverKeyDisabled mode renders NO_BYOK copy and 去设置 outline link", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "none",
          serverKeyDisabled: true,
        });
      }
      if (url.endsWith("/api/hint")) {
        return Response.json(
          { code: "NO_BYOK", error: "NO_BYOK" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const testBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });

    expect(settingsContainer.textContent).toContain(
      "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
    );
    expect(settingsContainer.textContent).not.toContain("NO_BYOK");
    const link = settingsContainer.querySelector('a[href="/settings"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("去设置");
    expect(link!.classList.contains("border")).toBe(true);
    expect(link!.classList.contains("border-beam-gold/60")).toBe(true);
    expect(link!.classList.contains("text-beam-gold")).toBe(true);
    expect(link!.classList.contains("bg-transparent")).toBe(true);
  });

  test("~200-char base URL saved locally renders fully without truncate or font-mono", async () => {
    const longBaseUrl =
      "https://gateway.enterprise-ai-proxy.example.com/v1/organizations/org-1234567890abcdef/projects/proj-0987654321fedcba/deployments/custom-openai-compatible-endpoint-with-very-long-path-segment-for-testing/v1";
    expect(longBaseUrl.length).toBeGreaterThanOrEqual(190);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "none",
          serverKeyDisabled: true,
        });
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    await act(async () => {
      const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
      const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
      setInputValue(keyInput, "sk-long-url-test-key-123456");
      setInputValue(baseInput, longBaseUrl);
    });

    const saveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    expect(baseInput.value).toBe(longBaseUrl);
    expect(baseInput.classList.contains("w-full")).toBe(true);
    expect(baseInput.classList.contains("min-w-0")).toBe(true);
    expect(baseInput.classList.contains("font-mono")).toBe(false);
    expect(baseInput.classList.contains("truncate")).toBe(false);
    expect(baseInput.classList.contains("text-ellipsis")).toBe(false);
    expect(baseInput.classList.contains("whitespace-nowrap")).toBe(false);

    expect(settingsContainer.textContent).toContain(longBaseUrl);
    const savedUrlEl = Array.from(settingsContainer.querySelectorAll("p")).find(
      (p) => p.textContent?.includes(longBaseUrl),
    );
    expect(savedUrlEl).toBeDefined();
    expect(savedUrlEl!.classList.contains("break-all")).toBe(true);
    expect(savedUrlEl!.classList.contains("font-mono")).toBe(false);
    expect(savedUrlEl!.classList.contains("truncate")).toBe(false);
    expect(savedUrlEl!.classList.contains("text-ellipsis")).toBe(false);
    expect(savedUrlEl!.classList.contains("whitespace-nowrap")).toBe(false);
  });

  test("AiSetupPrompt reacts to slug switch while keeping local key state when serverKeyDisabled is true", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ settings: {}, keySource: "none", serverKeyDisabled: true }),
    );

    await act(async () => {
      problemRoot.render(createElement(AiSetupPrompt, { problemSlug: "3sum" }));
    });
    expect(problemContainer.textContent).toContain(PROBLEM_HINT);

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });
    await act(async () => {
      const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
      setInputValue(keyInput, "sk-switch-slug-test-key-1234");
    });
    await act(async () => {
      Array.from(settingsContainer.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("保存设置"))!
        .click();
    });

    expect(problemContainer.textContent).toBe("");

    await act(async () => {
      problemRoot.render(
        createElement(AiSetupPrompt, { problemSlug: "group-anagrams" }),
      );
    });
    expect(problemContainer.textContent).toBe("");
    expect(document.body.innerHTML).not.toContain("sk-switch-slug-test-key-1234");
  });
});

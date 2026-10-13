// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AiSetupPrompt from "../components/settings/ai-setup-prompt";
import {
  BASE_URL_INVALID_MESSAGE,
  BASE_URL_NOT_ALLOWED_SETTINGS_MESSAGE,
  ENDPOINT_SAVED_NEED_KEY_MESSAGE,
  isBaseUrlInvalid,
  isBaseUrlNotAllowed,
  isValidHttpBaseUrl,
  NO_BYOK_SETTINGS_MESSAGE,
  parseFocusParam,
  readLocalBaseUrl,
  resetServerKeyDisabledCache,
} from "../lib/byok/client";
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
      if (url.endsWith("/api/hint") || url.endsWith("/api/settings/test-connection")) {
        const body = JSON.parse(String(init?.body));
        hintBodies.push(body);
        return Response.json({ ok: true, level: 1, hint: "连接正常" });
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
    expect(hintBodies[0]).toMatchObject({
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
      if (url.endsWith("/api/settings/test-connection")) {
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

  test("settings page testConnection NO_BYOK renders NO_BYOK_SETTINGS_MESSAGE, no 去设置 link, and focuses + highlights API Key input", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "none",
          serverKeyDisabled: true,
        });
      }
      if (url.endsWith("/api/settings/test-connection")) {
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

    const apiKeyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    const scrollSpy = vi.fn();
    apiKeyInput.scrollIntoView = scrollSpy;

    const testBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });

    expect(settingsContainer.textContent).toContain(NO_BYOK_SETTINGS_MESSAGE);
    expect(settingsContainer.textContent).not.toContain("先去设置页");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.textContent).not.toContain("NO_BYOK");
    expect(settingsContainer.querySelector('a[href="/settings"]')).toBeNull();

    expect(document.activeElement).toBe(apiKeyInput);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(apiKeyInput.getAttribute("data-highlight")).toBe("true");
    expect(apiKeyInput.classList.contains("ring-2")).toBe(true);
    expect(apiKeyInput.classList.contains("ring-beam-gold")).toBe(true);

    // Highlight clears when editing API key
    await act(async () => {
      setInputValue(apiKeyInput, "sk-editing");
    });
    expect(apiKeyInput.getAttribute("data-highlight")).toBeNull();
    expect(apiKeyInput.classList.contains("ring-beam-gold")).toBe(false);
  });

  test("BASE_URL_NOT_ALLOWED and BASE_URL_INVALID on save and testConnection show respective inline copy, focus Base URL, render no 去设置 link/button, no toast or testState fail, and clear on edit", async () => {
    let serverKeyDisabledMode = false;
    let errorCodeToReturn: "BASE_URL_NOT_ALLOWED" | "BASE_URL_INVALID" = "BASE_URL_NOT_ALLOWED";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        return Response.json(
          { error: errorCodeToReturn, message: "Custom server message should be ignored" },
          { status: 400 },
        );
      }
      if (url.endsWith("/api/settings/test-connection")) {
        return Response.json(
          { code: errorCodeToReturn, message: "Custom server message" },
          { status: 400 },
        );
      }
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "settings",
          serverKeyDisabled: serverKeyDisabledMode,
        });
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    await act(async () => {
      setInputValue(baseInput, "http://127.0.0.1:8080/v1");
    });

    const saveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    const errEl = settingsContainer.querySelector("#baseURL-error");
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent).toBe(BASE_URL_NOT_ALLOWED_SETTINGS_MESSAGE);
    expect(document.activeElement).toBe(baseInput);
    expect(settingsContainer.textContent).not.toContain("Custom server message");
    expect(settingsContainer.textContent).not.toContain("设置保存失败");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.querySelector('[data-testid="goto-settings"]')).toBeNull();
    expect(settingsContainer.querySelector('a[href*="/settings"]')).toBeNull();
    expect(settingsContainer.querySelectorAll('[role="alert"]')).toHaveLength(1);

    // Clear when edited
    await act(async () => {
      setInputValue(baseInput, "http://10.0.0.1/v1");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    // Test connection with BASE_URL_NOT_ALLOWED
    const testBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("测试连接"),
    )!;
    await act(async () => {
      testBtn.click();
    });

    const errElAfterTest = settingsContainer.querySelector("#baseURL-error");
    expect(errElAfterTest).not.toBeNull();
    expect(errElAfterTest!.textContent).toBe(BASE_URL_NOT_ALLOWED_SETTINGS_MESSAGE);
    expect(document.activeElement).toBe(baseInput);
    expect(settingsContainer.textContent).not.toContain("✗");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.querySelector('[data-testid="goto-settings"]')).toBeNull();
    expect(settingsContainer.querySelector('a[href*="/settings"]')).toBeNull();

    // Now test server BASE_URL_INVALID on save and testConnection
    errorCodeToReturn = "BASE_URL_INVALID";
    await act(async () => {
      setInputValue(baseInput, "https://valid-looking-but-server-rejected.example.com");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    await act(async () => {
      saveBtn.click();
    });

    const errElInvalidSave = settingsContainer.querySelector("#baseURL-error");
    expect(errElInvalidSave).not.toBeNull();
    expect(errElInvalidSave!.textContent).toBe(BASE_URL_INVALID_MESSAGE);
    expect(document.activeElement).toBe(baseInput);
    expect(settingsContainer.textContent).not.toContain("Custom server message");
    expect(settingsContainer.textContent).not.toContain("设置保存失败");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.querySelector('[data-testid="goto-settings"]')).toBeNull();
    expect(settingsContainer.querySelector('a[href*="/settings"]')).toBeNull();
    expect(settingsContainer.querySelectorAll('[role="alert"]')).toHaveLength(1);

    // Clear on edit and test connection with BASE_URL_INVALID
    await act(async () => {
      setInputValue(baseInput, "https://another-rejected.example.com");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    await act(async () => {
      testBtn.click();
    });

    const errElInvalidTest = settingsContainer.querySelector("#baseURL-error");
    expect(errElInvalidTest).not.toBeNull();
    expect(errElInvalidTest!.textContent).toBe(BASE_URL_INVALID_MESSAGE);
    expect(document.activeElement).toBe(baseInput);
    expect(settingsContainer.textContent).not.toContain("✗");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.querySelector('[data-testid="goto-settings"]')).toBeNull();
    expect(settingsContainer.querySelector('a[href*="/settings"]')).toBeNull();

    // Local validation in serverKeyDisabled mode
    serverKeyDisabledMode = true;
    await act(async () => {
      settingsRoot.unmount();
    });
    settingsRoot = createRoot(settingsContainer);
    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const localBaseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    const localKeyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    await act(async () => {
      setInputValue(localKeyInput, "sk-local-key-12345");
      setInputValue(localBaseInput, "not-a-valid-url");
    });

    const localSaveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;
    await act(async () => {
      localSaveBtn.click();
    });

    expect(settingsContainer.querySelector("#baseURL-error")?.textContent).toBe(
      BASE_URL_INVALID_MESSAGE,
    );
    expect(document.activeElement).toBe(localBaseInput);
    expect(readLocalByok()).toBeNull();
    expect(settingsContainer.textContent).not.toContain("已保存");
    expect(settingsContainer.textContent).not.toContain("去设置");
    expect(settingsContainer.querySelector('[data-testid="goto-settings"]')).toBeNull();
  });

  test("baseURL frontend validation: typing invalid shows no error; blur invalid shows error; editing clears; empty ok on blur and save; save invalid blocked; http://192.168.1.2 passes and saves", async () => {
    let serverKeyDisabledMode = false;
    const putCalls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        putCalls.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/settings")) {
        return Response.json({
          settings: {},
          keySource: "settings",
          serverKeyDisabled: serverKeyDisabledMode,
        });
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    const saveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;

    // 1. Typing invalid shows no error
    await act(async () => {
      setInputValue(baseInput, "ftp://invalid.example.com");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    // 2. Blur invalid shows error and focuses input
    await act(async () => {
      baseInput.focus();
      baseInput.blur();
    });
    expect(settingsContainer.querySelector("#baseURL-error")?.textContent).toBe(
      BASE_URL_INVALID_MESSAGE,
    );
    expect(document.activeElement).toBe(baseInput);
    expect(settingsContainer.textContent).not.toContain("去设置");

    // 3. Editing after shows clears error immediately
    await act(async () => {
      setInputValue(baseInput, "not-a-url");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    // 4. Save with invalid blocked (no fetch PUT) with focus on input
    await act(async () => {
      saveBtn.click();
    });
    expect(settingsContainer.querySelector("#baseURL-error")?.textContent).toBe(
      BASE_URL_INVALID_MESSAGE,
    );
    expect(document.activeElement).toBe(baseInput);
    expect(putCalls).toHaveLength(0);

    // 5. Empty ok on blur and save
    await act(async () => {
      setInputValue(baseInput, "   ");
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    await act(async () => {
      baseInput.focus();
      baseInput.blur();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    await act(async () => {
      saveBtn.click();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    expect(putCalls).toHaveLength(1);

    // 6. http://192.168.1.2 passes frontend validation and save proceeds (normal mode)
    await act(async () => {
      setInputValue(baseInput, "http://192.168.1.2");
    });
    await act(async () => {
      baseInput.focus();
      baseInput.blur();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    await act(async () => {
      saveBtn.click();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    expect(putCalls).toHaveLength(2);
    expect(putCalls[1]).toEqual({
      settings: { baseURL: "http://192.168.1.2" },
    });

    // 7. http://192.168.1.2 passes frontend validation and save proceeds (serverKeyDisabled mode)
    serverKeyDisabledMode = true;
    await act(async () => {
      settingsRoot.unmount();
    });
    settingsRoot = createRoot(settingsContainer);
    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const localBaseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    const localKeyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    const localSaveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;

    await act(async () => {
      setInputValue(localKeyInput, "sk-local-lan-key-123");
      setInputValue(localBaseInput, "http://192.168.1.2");
    });
    await act(async () => {
      localBaseInput.focus();
      localBaseInput.blur();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();

    await act(async () => {
      localSaveBtn.click();
    });
    expect(settingsContainer.querySelector("#baseURL-error")).toBeNull();
    expect(putCalls).toHaveLength(2);
    expect(readLocalByok()).toMatchObject({
      apiKey: "sk-local-lan-key-123",
      baseURL: "http://192.168.1.2",
    });
  });

  test("focus=baseUrl and focus=apiKey query params focus, scrollIntoView, and highlight target input after settings load", async () => {
    const origLocation = window.location.href;
    window.history.replaceState({}, "", "/settings?focus=baseUrl");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ settings: {}, keySource: "none", serverKeyDisabled: true }),
    );

    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;

    try {
      await act(async () => {
        settingsRoot.render(createElement(SettingsPage));
      });

      const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
      expect(document.activeElement).toBe(baseInput);
      expect(scrollSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(baseInput.getAttribute("data-highlight")).toBe("true");
      expect(baseInput.classList.contains("ring-beam-gold")).toBe(true);
      expect(baseInput.classList.contains("font-sans")).toBe(false);

      // Edit clears highlight
      await act(async () => {
        setInputValue(baseInput, "https://api.openai.com/v1");
      });
      expect(baseInput.getAttribute("data-highlight")).toBeNull();

      // Now test focus=apiKey
      await act(async () => {
        settingsRoot.unmount();
      });
      window.history.replaceState({}, "", "/settings?focus=apiKey");
      settingsRoot = createRoot(settingsContainer);
      await act(async () => {
        settingsRoot.render(createElement(SettingsPage));
      });

      const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
      expect(document.activeElement).toBe(keyInput);
      expect(keyInput.getAttribute("data-highlight")).toBe("true");
      expect(keyInput.classList.contains("ring-beam-gold")).toBe(true);
    } finally {
      window.history.replaceState({}, "", origLocation);
    }
  });

  test("save success shows only 已保存 and never 验证通过, and pure helpers work as expected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ settings: {}, keySource: "none", serverKeyDisabled: true }),
    );

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    await act(async () => {
      setInputValue(keyInput, "sk-save-copy-test-12345");
    });

    const saveBtn = Array.from(settingsContainer.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存设置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(saveBtn.textContent).toBe("已保存");
    expect(settingsContainer.textContent).toContain("已保存");
    expect(settingsContainer.textContent).not.toContain("验证通过");

    // Pure helpers unit assertions
    expect(parseFocusParam("?focus=baseUrl")).toBe("baseURL");
    expect(parseFocusParam("?focus=baseURL")).toBe("baseURL");
    expect(parseFocusParam("?focus=apiKey")).toBe("apiKey");
    expect(parseFocusParam("?focus=other")).toBeNull();
    expect(parseFocusParam("")).toBeNull();

    expect(isBaseUrlNotAllowed({ error: "BASE_URL_NOT_ALLOWED" })).toBe(true);
    expect(isBaseUrlNotAllowed({ code: "BASE_URL_NOT_ALLOWED" })).toBe(true);
    expect(isBaseUrlNotAllowed({ error: "OTHER" })).toBe(false);

    expect(isBaseUrlInvalid({ error: "BASE_URL_INVALID" })).toBe(true);
    expect(isBaseUrlInvalid({ code: "BASE_URL_INVALID" })).toBe(true);
    expect(isBaseUrlInvalid({ error: "OTHER" })).toBe(false);

    expect(isValidHttpBaseUrl("")).toBe(true);
    expect(isValidHttpBaseUrl("   ")).toBe(true);
    expect(isValidHttpBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isValidHttpBaseUrl("http://example.com/v1")).toBe(true);
    expect(isValidHttpBaseUrl("http://192.168.1.2")).toBe(true);
    expect(isValidHttpBaseUrl("http://localhost:8000")).toBe(true);
    expect(isValidHttpBaseUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isValidHttpBaseUrl("http://10.0.0.1/v1")).toBe(true);
    expect(isValidHttpBaseUrl("http://[::1]:8000/v1")).toBe(true);
    expect(isValidHttpBaseUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpBaseUrl("not-a-url")).toBe(false);
    expect(isValidHttpBaseUrl("http://")).toBe(false);
    expect(isValidHttpBaseUrl("https://")).toBe(false);
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

  test("serverKeyDisabled mode: (a) saving valid baseURL without API key shows ENDPOINT_SAVED_NEED_KEY_MESSAGE, saves baseURL locally, and focuses #apiKey; (b) with both filled shows only 已保存; (c) with saved key and only baseURL changed shows 已保存", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ settings: {}, keySource: "none", serverKeyDisabled: true }),
    );

    await act(async () => {
      settingsRoot.render(createElement(SettingsPage));
    });

    const baseInput = settingsContainer.querySelector<HTMLInputElement>("#baseURL")!;
    const keyInput = settingsContainer.querySelector<HTMLInputElement>("#apiKey")!;
    const getSaveBtn = () =>
      Array.from(settingsContainer.querySelectorAll("button")).find(
        (b) =>
          b.textContent?.includes("保存设置") ||
          b.textContent?.includes("已保存") ||
          b.textContent?.includes(ENDPOINT_SAVED_NEED_KEY_MESSAGE),
      )!;

    // (a) Valid baseURL, no API key typed and none saved
    await act(async () => {
      setInputValue(baseInput, "https://api.deepseek.com/v1");
    });
    await act(async () => {
      getSaveBtn().click();
    });

    expect(getSaveBtn().textContent).toBe(ENDPOINT_SAVED_NEED_KEY_MESSAGE);
    expect(settingsContainer.textContent).toContain(ENDPOINT_SAVED_NEED_KEY_MESSAGE);
    expect(readLocalBaseUrl()).toBe("https://api.deepseek.com/v1");
    expect(readLocalByok()).toBeNull();
    expect(settingsContainer.textContent).toContain(
      "已保存接口地址：https://api.deepseek.com/v1",
    );
    expect(document.activeElement).toBe(keyInput);
    expect(keyInput.getAttribute("data-highlight")).toBe("true");

    // (b) Both baseURL and API key filled -> shows only 已保存 and not the need-key message
    await act(async () => {
      setInputValue(baseInput, "https://api.openai.com/v1");
      setInputValue(keyInput, "sk-both-filled-test-key-12345");
    });
    await act(async () => {
      getSaveBtn().click();
    });

    expect(getSaveBtn().textContent).toBe("已保存");
    expect(settingsContainer.textContent).toContain("已保存");
    expect(settingsContainer.textContent).not.toContain(
      ENDPOINT_SAVED_NEED_KEY_MESSAGE,
    );
    expect(readLocalByok()).toMatchObject({
      apiKey: "sk-both-filled-test-key-12345",
      baseURL: "https://api.openai.com/v1",
    });
    expect(readLocalBaseUrl()).toBe("https://api.openai.com/v1");
    expect(keyInput.value).toBe("");

    // (c) Key already saved locally and only baseURL changed -> shows 已保存
    await act(async () => {
      setInputValue(baseInput, "https://proxy.example.com/v1");
    });
    await act(async () => {
      getSaveBtn().click();
    });

    expect(getSaveBtn().textContent).toBe("已保存");
    expect(settingsContainer.textContent).toContain("已保存");
    expect(settingsContainer.textContent).not.toContain(
      ENDPOINT_SAVED_NEED_KEY_MESSAGE,
    );
    expect(readLocalByok()).toMatchObject({
      apiKey: "sk-both-filled-test-key-12345",
      baseURL: "https://proxy.example.com/v1",
    });
    expect(readLocalBaseUrl()).toBe("https://proxy.example.com/v1");
  });
});

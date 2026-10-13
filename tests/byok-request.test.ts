// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import HintLadder from "../components/hint/hint-ladder";
import {
  fetchServerKeyDisabled,
  mapByokErrorMessage,
  resetServerKeyDisabledCache,
  withByok,
} from "../lib/byok/client";
import { writeLocalByok } from "../lib/byok/storage";
import { localSeedSource } from "../lib/content/local-source";
import { usePlayerStore } from "../lib/player/store";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
vi.mock("../components/board/code-editor", () => ({
  default: ({ value }: { value: string }) =>
    createElement("pre", { "data-editor": true }, value),
}));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));
import ProblemPage from "../app/problem/[slug]/page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  resetServerKeyDisabledCache();
  usePlayerStore.getState().reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  resetServerKeyDisabledCache();
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const step = {
  id: "s1",
  narration: "先排序",
  targets: [{ kind: "code-line" as const, start: 2 }],
  effects: [],
  dwellMs: 5000,
};

const lectureNdjson = () =>
  JSON.stringify({ type: "step", step }) +
  "\n" +
  JSON.stringify({
    type: "result",
    script: {
      problemSlug: "3sum",
      mode: "lecture",
      solutionLanguage: "typescript",
      language: "zh",
      steps: [step],
    },
  }) +
  "\n";

describe("lib/byok/client pure helpers & fetchServerKeyDisabled", () => {
  test("withByok adds byok only when serverKeyDisabled is true and byok has apiKey", () => {
    const base = { slug: "3sum", level: 1 };
    const key = {
      apiKey: "sk-test-secret-123",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o",
    };

    expect(withByok(base, true, key)).toEqual({
      slug: "3sum",
      level: 1,
      byok: key,
    });
    expect(withByok(base, false, key)).toEqual(base);
    expect(withByok(base, undefined, key)).toEqual(base);
    expect(withByok(base, true, null)).toEqual(base);
  });

  test("fetchServerKeyDisabled caches result and supports abort signal", async () => {
    let settingsCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/settings")) {
        settingsCalls++;
        expect(init?.cache).toBe("no-store");
        return Response.json({ serverKeyDisabled: true });
      }
      return Response.json({});
    });

    expect(await fetchServerKeyDisabled()).toBe(true);
    expect(await fetchServerKeyDisabled()).toBe(true);
    expect(settingsCalls).toBe(1);

    resetServerKeyDisabledCache();
    const ac = new AbortController();
    ac.abort();
    await expect(fetchServerKeyDisabled(ac.signal)).rejects.toThrow();
  });

  test("mapByokErrorMessage maps error codes to Chinese copy and never returns raw error codes", () => {
    expect(mapByokErrorMessage({ code: "BYOK_KEY_REQUIRED" })).toBe(
      "用自定义地址时需要同时填你自己的 Key",
    );
    expect(mapByokErrorMessage({ code: "BASE_URL_NOT_ALLOWED" })).toBe(
      "只支持公网 http(s) 地址",
    );
    expect(mapByokErrorMessage({ code: "SETTINGS_LOCKED" })).toBe(
      "公共实例不支持修改服务器设置",
    );
    expect(mapByokErrorMessage({ code: "NO_BYOK" })).toBe(
      "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
    );
  });
});

describe("Lecture & Hint BYOK request attachment", () => {
  test("when serverKeyDisabled is true and key is stored, POST body includes byok and NO fetched URL contains the key", async () => {
    const secretKey = "sk-super-secret-byok-key-98765";
    writeLocalByok({
      apiKey: secretKey,
      baseURL: "https://proxy.example.com/v1",
      model: "deepseek-chat",
    });

    const detail = await localSeedSource.detail("3sum");
    const fetchedUrls: string[] = [];
    const lectureBodies: Record<string, unknown>[] = [];
    const hintBodies: Record<string, unknown>[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith("/api/settings")) {
        return Response.json({ keySource: "none", serverKeyDisabled: true });
      }
      if (url.endsWith("/api/problems/3sum")) {
        return Response.json({ problem: detail });
      }
      if (url.endsWith("/api/lecture")) {
        lectureBodies.push(JSON.parse(String(init?.body)));
        return new Response(lectureNdjson(), {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }
      if (url.endsWith("/api/hint")) {
        hintBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ level: 1, hint: "先排序再双指针" });
      }
      return Response.json({ ok: true });
    });

    await act(async () => {
      root.render(createElement(ProblemPage));
    });

    const startBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("header button"),
    ).find((b) => b.textContent === "开始讲课")!;
    await act(async () => {
      startBtn.click();
    });

    expect(lectureBodies).toHaveLength(1);
    expect(lectureBodies[0]).toMatchObject({
      slug: "3sum",
      solutionLanguage: "typescript",
      byok: {
        apiKey: secretKey,
        baseURL: "https://proxy.example.com/v1",
        model: "deepseek-chat",
      },
    });

    // Newly saved key in localStorage is used immediately at request time
    const updatedKey = "sk-newly-saved-key-55555";
    writeLocalByok({
      apiKey: updatedKey,
      model: "gpt-4.1",
    });

    const hintBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("观察") ||
        b.getAttribute("title")?.includes("观察"),
    )!;
    await act(async () => {
      hintBtn.click();
    });

    expect(hintBodies).toHaveLength(1);
    expect(hintBodies[0]).toEqual({
      slug: "3sum",
      level: 1,
      byok: {
        apiKey: updatedKey,
        model: "gpt-4.1",
      },
    });

    expect(fetchedUrls.length).toBeGreaterThan(0);
    for (const url of fetchedUrls) {
      expect(url).not.toContain(secretKey);
      expect(url).not.toContain(updatedKey);
      expect(url).not.toContain("apiKey");
    }
  });

  test.each([
    { label: "false", settingsPayload: { keySource: "env", serverKeyDisabled: false } },
    { label: "absent", settingsPayload: { keySource: "env" } },
  ])(
    "when serverKeyDisabled is $label, POST body does NOT include byok even when localStorage has a key",
    async ({ settingsPayload }) => {
      const secretKey = "sk-unused-local-key-11111";
      writeLocalByok({
        apiKey: secretKey,
        baseURL: "https://proxy.example.com/v1",
        model: "deepseek-chat",
      });

      const detail = await localSeedSource.detail("3sum");
      const fetchedUrls: string[] = [];
      const lectureBodies: Record<string, unknown>[] = [];
      const hintBodies: Record<string, unknown>[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.endsWith("/api/settings")) {
          return Response.json(settingsPayload);
        }
        if (url.endsWith("/api/problems/3sum")) {
          return Response.json({ problem: detail });
        }
        if (url.endsWith("/api/lecture")) {
          lectureBodies.push(JSON.parse(String(init?.body)));
          return new Response(lectureNdjson(), {
            headers: { "Content-Type": "application/x-ndjson" },
          });
        }
        if (url.endsWith("/api/hint")) {
          hintBodies.push(JSON.parse(String(init?.body)));
          return Response.json({ level: 1, hint: "提示内容" });
        }
        return Response.json({ ok: true });
      });

      await act(async () => {
        root.render(createElement(ProblemPage));
      });

      const startBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("header button"),
      ).find((b) => b.textContent === "开始讲课")!;
      await act(async () => {
        startBtn.click();
      });

      expect(lectureBodies).toHaveLength(1);
      expect(lectureBodies[0]).not.toHaveProperty("byok");
      expect(JSON.stringify(lectureBodies[0])).not.toContain(secretKey);

      const hintBtn = Array.from(container.querySelectorAll("button")).find(
        (b) =>
          b.textContent?.includes("观察") ||
          b.getAttribute("title")?.includes("观察"),
      )!;
      await act(async () => {
        hintBtn.click();
      });

      expect(hintBodies).toHaveLength(1);
      expect(hintBodies[0]).not.toHaveProperty("byok");
      expect(JSON.stringify(hintBodies[0])).not.toContain(secretKey);

      for (const url of fetchedUrls) {
        expect(url).not.toContain(secretKey);
      }
    },
  );
});

describe("Error code mapping in HintLadder and ProblemPage", () => {
  test.each([
    {
      code: "BYOK_KEY_REQUIRED",
      expected: "用自定义地址时需要同时填你自己的 Key",
    },
    {
      code: "BASE_URL_NOT_ALLOWED",
      expected: "只支持公网 http(s) 地址",
    },
    {
      code: "NO_BYOK",
      expected: "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
    },
  ])(
    "HintLadder maps error code $code to Chinese copy and never shows raw code",
    async ({ code, expected }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({ serverKeyDisabled: true });
        }
        if (url.endsWith("/api/hint")) {
          return Response.json({ error: code, message: code }, { status: 400 });
        }
        return Response.json({ ok: true });
      });

      await act(async () => {
        root.render(createElement(HintLadder, { slug: "3sum" }));
      });

      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) =>
          b.textContent?.includes("观察") ||
          b.getAttribute("title")?.includes("观察"),
      )!;
      await act(async () => {
        btn.click();
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(expected);
      expect(alert!.textContent).not.toContain(code);
      if (code === "NO_BYOK") {
        const link = alert!.querySelector('a[href="/settings"]');
        expect(link).not.toBeNull();
        expect(link!.textContent).toBe("去设置");
        expect(link!.classList.contains("border")).toBe(true);
        expect(link!.classList.contains("border-beam-gold/60")).toBe(true);
        expect(link!.classList.contains("text-beam-gold")).toBe(true);
        expect(link!.classList.contains("bg-transparent")).toBe(true);
      }
    },
  );

  test.each([
    {
      code: "BYOK_KEY_REQUIRED",
      expected: "用自定义地址时需要同时填你自己的 Key",
    },
    {
      code: "BASE_URL_NOT_ALLOWED",
      expected: "只支持公网 http(s) 地址",
    },
    {
      code: "NO_BYOK",
      expected: "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
    },
  ])(
    "ProblemPage lecture maps HTTP error code $code to Chinese copy and never shows raw code",
    async ({ code, expected }) => {
      const detail = await localSeedSource.detail("3sum");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({ serverKeyDisabled: true });
        }
        if (url.endsWith("/api/problems/3sum")) {
          return Response.json({ problem: detail });
        }
        if (url.endsWith("/api/lecture")) {
          return Response.json({ error: code, message: code }, { status: 400 });
        }
        return Response.json({ ok: true });
      });

      await act(async () => {
        root.render(createElement(ProblemPage));
      });

      const startBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("header button"),
      ).find((b) => b.textContent === "开始讲课")!;
      await act(async () => {
        startBtn.click();
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(expected);
      expect(alert!.textContent).not.toContain(code);
      if (code === "NO_BYOK") {
        const link = alert!.querySelector('a[href="/settings"]');
        expect(link).not.toBeNull();
        expect(link!.textContent).toBe("去设置");
        expect(link!.classList.contains("border")).toBe(true);
        expect(link!.classList.contains("border-beam-gold/60")).toBe(true);
        expect(link!.classList.contains("text-beam-gold")).toBe(true);
        expect(link!.classList.contains("bg-transparent")).toBe(true);
      }
    },
  );
});

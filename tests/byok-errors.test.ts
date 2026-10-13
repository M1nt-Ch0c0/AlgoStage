// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SettingsPage from "../app/settings/page";
import HintLadder from "../components/hint/hint-ladder";
import {
  BASE_URL_INVALID_LECTURE_MESSAGE,
  BASE_URL_INVALID_MESSAGE,
  BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
  BASE_URL_NOT_ALLOWED_MESSAGE,
  ByokError,
  isBaseUrlInvalid,
  mapByokErrorMessage,
  resetServerKeyDisabledCache,
  toByokError,
  UPSTREAM_ERROR_MESSAGE,
} from "../lib/byok/client";
import { localSeedSource } from "../lib/content/local-source";
import { readLectureResponse } from "../lib/player/lecture-response";
import { usePlayerStore } from "../lib/player/store";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
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

const EXPECTED_MAPPINGS = [
  {
    code: "BYOK_KEY_REQUIRED",
    expected: "用自定义地址时需要同时填你自己的 Key",
  },
  {
    code: "BASE_URL_INVALID",
    expected: BASE_URL_INVALID_MESSAGE,
  },
  {
    code: "BASE_URL_NOT_ALLOWED",
    expected: "接口地址只支持公网 http(s) 地址",
  },
  {
    code: "SETTINGS_LOCKED",
    expected: "公共实例不支持修改服务器设置",
  },
  {
    code: "NO_BYOK",
    expected: "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
  },
  {
    code: "UPSTREAM_ERROR",
    expected: UPSTREAM_ERROR_MESSAGE,
  },
] as const;

describe("mapByokErrorMessage pure unit tests", () => {
  test.each(EXPECTED_MAPPINGS)(
    "maps $code from { code } and { error } shapes",
    ({ code, expected }) => {
      expect(mapByokErrorMessage({ code })).toBe(expected);
      expect(mapByokErrorMessage({ error: code })).toBe(expected);
      expect(mapByokErrorMessage({ code, message: code })).toBe(expected);
      expect(mapByokErrorMessage({ error: code, message: code })).toBe(
        expected,
      );
      expect(
        mapByokErrorMessage({
          code,
          error: "OTHER_CODE",
          message: "server raw message",
        }),
      ).toBe(expected);
      expect(mapByokErrorMessage(code)).toBe(expected);
    },
  );

  test("unknown code returns undefined (or non-raw message) and never returns raw code", () => {
    expect(mapByokErrorMessage({ code: "UNKNOWN_SERVER_CODE" })).toBeUndefined();
    expect(
      mapByokErrorMessage({ error: "UNKNOWN_SERVER_CODE" }),
    ).toBeUndefined();
    expect(
      mapByokErrorMessage({
        code: "UNKNOWN_SERVER_CODE",
        message: "UNKNOWN_SERVER_CODE",
      }),
    ).toBeUndefined();
    expect(
      mapByokErrorMessage({
        error: "UNKNOWN_SERVER_CODE",
        message: "UNKNOWN_SERVER_CODE",
      }),
    ).toBeUndefined();
    expect(
      mapByokErrorMessage({
        code: "some-custom-code",
        message: "some-custom-code",
      }),
    ).toBeUndefined();
    expect(mapByokErrorMessage(null)).toBeUndefined();
    expect(mapByokErrorMessage(undefined)).toBeUndefined();
    expect(mapByokErrorMessage({})).toBeUndefined();

    // Non-raw human-readable message is preserved when code is unknown
    expect(
      mapByokErrorMessage({
        code: "SOME_OTHER_ERROR",
        message: "Key 无效或没有权限，请检查设置。",
      }),
    ).toBe("Key 无效或没有权限，请检查设置。");

    expect(UPSTREAM_ERROR_MESSAGE).toBe("AI 服务暂时连不上，请稍后再试。");
    expect(isBaseUrlInvalid({ error: "BASE_URL_INVALID" })).toBe(true);
    expect(isBaseUrlInvalid({ code: "BASE_URL_INVALID" })).toBe(true);
    expect(isBaseUrlInvalid({ error: "BASE_URL_NOT_ALLOWED" })).toBe(false);
    expect(isBaseUrlInvalid(null)).toBe(false);
    expect(BASE_URL_INVALID_MESSAGE).toBe(
      "接口地址格式不对，要以 http:// 或 https:// 开头",
    );
    expect(BASE_URL_INVALID_LECTURE_MESSAGE).toBe(
      "接口地址格式不对，要以 http:// 或 https:// 开头，去设置页改一下就能开讲。",
    );
    expect(BASE_URL_NOT_ALLOWED_MESSAGE).toBe(
      "接口地址只支持公网 http(s) 地址",
    );
  });

  test("Object.hasOwn safety: prototype keys like constructor and toString do not map to a function", () => {
    for (const protoKey of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(mapByokErrorMessage(protoKey)).toBeUndefined();
      expect(mapByokErrorMessage({ code: protoKey })).toBeUndefined();
      expect(mapByokErrorMessage({ error: protoKey })).toBeUndefined();
      expect(mapByokErrorMessage({ message: protoKey })).toBe(protoKey);
      expect(typeof mapByokErrorMessage({ code: protoKey })).not.toBe("function");
      const err = toByokError({ code: protoKey }, "fallback");
      expect(err).toBeInstanceOf(ByokError);
      expect(err.code).toBe("UNKNOWN");
      expect(err.message).toBe("fallback");
    }
  });
});

describe("readLectureResponse BYOK error mapping", () => {
  test.each(EXPECTED_MAPPINGS)(
    "maps HTTP and NDJSON error for $code in both { code } and { error } shapes",
    async ({ code, expected }) => {
      const resCode = Response.json({ code }, { status: 400 });
      await expect(readLectureResponse(resCode, () => {})).rejects.toThrow(
        expected,
      );

      const resError = Response.json(
        { error: code, message: code },
        { status: 400 },
      );
      await expect(readLectureResponse(resError, () => {})).rejects.toThrow(
        expected,
      );

      const ndjsonCode = new Response(
        JSON.stringify({ type: "error", code }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
      await expect(readLectureResponse(ndjsonCode, () => {})).rejects.toThrow(
        expected,
      );

      const ndjsonError = new Response(
        JSON.stringify({ type: "error", error: code, message: code }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
      await expect(readLectureResponse(ndjsonError, () => {})).rejects.toThrow(
        expected,
      );
    },
  );

  test("unknown code falls back to default message and never contains raw code", async () => {
    const rawCode = "SOME_UNKNOWN_RAW_CODE";
    const res = Response.json(
      { code: rawCode, message: rawCode },
      { status: 500 },
    );
    let caughtError: Error | null = null;
    try {
      await readLectureResponse(res, () => {});
    } catch (e) {
      caughtError = e as Error;
    }
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe(
      "这次备课未能完成，请重试或换用 gpt-6.1-sol。",
    );
    expect(caughtError!.message).not.toContain(rawCode);
    expect((caughtError as ByokError).code).toBe("UNKNOWN");
  });
});

describe("Rendered UI error messages in HintLadder and ProblemPage", () => {
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

  test.each(
    EXPECTED_MAPPINGS.flatMap(({ code, expected }) => {
      const uiExpected =
        code === "BASE_URL_NOT_ALLOWED"
          ? BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE
          : code === "BASE_URL_INVALID"
            ? BASE_URL_INVALID_LECTURE_MESSAGE
            : expected;
      return [
        { shape: "code", payload: { code }, code, expected: uiExpected },
        {
          shape: "error+message",
          payload: { error: code, message: code },
          code,
          expected: uiExpected,
        },
      ];
    }),
  )(
    "HintLadder renders mapped message for $code ($shape) and never contains raw code",
    async ({ payload, code, expected }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({ serverKeyDisabled: true });
        }
        if (url.endsWith("/api/hint")) {
          return Response.json(payload, {
            status: code === "UPSTREAM_ERROR" ? 502 : 400,
          });
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

      const settingsLink = Array.from(alert!.querySelectorAll("a")).find(
        (a) => a.textContent === "去设置",
      );
      if (
        code === "NO_BYOK" ||
        code === "BASE_URL_NOT_ALLOWED" ||
        code === "BASE_URL_INVALID"
      ) {
        expect(settingsLink).toBeDefined();
        expect(settingsLink!.getAttribute("data-testid")).toBe("goto-settings");
        expect(settingsLink!.getAttribute("href")).toBe(
          code === "NO_BYOK"
            ? "/settings?focus=apiKey"
            : "/settings?focus=baseUrl",
        );
        expect(settingsLink!.classList.contains("border")).toBe(true);
        expect(settingsLink!.classList.contains("border-beam-gold/60")).toBe(true);
        expect(settingsLink!.classList.contains("text-beam-gold")).toBe(true);
        expect(settingsLink!.classList.contains("bg-transparent")).toBe(true);
      } else {
        expect(settingsLink).toBeUndefined();
      }
    },
  );

  test("HintLadder falls back on unknown code and rendered text never contains raw code", async () => {
    const rawCode = "UNKNOWN_HINT_ERROR_CODE";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({ serverKeyDisabled: true });
      }
      if (url.endsWith("/api/hint")) {
        return Response.json(
          { code: rawCode, error: rawCode, message: rawCode },
          { status: 400 },
        );
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
    expect(alert!.textContent).toContain("老师这会儿有点慢，请再试一次。");
    expect(alert!.textContent).not.toContain(rawCode);
  });

  test.each(
    EXPECTED_MAPPINGS.flatMap(({ code, expected }) => {
      const uiExpected =
        code === "BASE_URL_NOT_ALLOWED"
          ? BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE
          : code === "BASE_URL_INVALID"
            ? BASE_URL_INVALID_LECTURE_MESSAGE
            : expected;
      return [
        { shape: "code", payload: { code }, code, expected: uiExpected },
        {
          shape: "error+message",
          payload: { error: code, message: code },
          code,
          expected: uiExpected,
        },
      ];
    }),
  )(
    "ProblemPage lecture renders mapped message for $code ($shape) and never contains raw code",
    async ({ payload, code, expected }) => {
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
          return Response.json(payload, {
            status: code === "UPSTREAM_ERROR" ? 502 : 400,
          });
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

      const settingsLink = Array.from(alert!.querySelectorAll("a")).find(
        (a) => a.textContent === "去设置",
      );
      if (code === "UPSTREAM_ERROR") {
        expect(settingsLink).toBeUndefined();
        expect(alert!.querySelector('[data-testid="goto-settings"]')).toBeNull();
        expect(alert!.querySelectorAll("a")).toHaveLength(0);
        const buttons = Array.from(alert!.querySelectorAll("button"));
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe("重试");
      } else {
        expect(settingsLink).toBeDefined();
        if (
          code === "NO_BYOK" ||
          code === "BASE_URL_NOT_ALLOWED" ||
          code === "BASE_URL_INVALID"
        ) {
          expect(settingsLink!.getAttribute("data-testid")).toBe("goto-settings");
          expect(settingsLink!.getAttribute("href")).toBe(
            code === "NO_BYOK"
              ? "/settings?focus=apiKey"
              : "/settings?focus=baseUrl",
          );
          expect(settingsLink!.classList.contains("border")).toBe(true);
          expect(settingsLink!.classList.contains("border-beam-gold/60")).toBe(true);
          expect(settingsLink!.classList.contains("text-beam-gold")).toBe(true);
          expect(settingsLink!.classList.contains("bg-transparent")).toBe(true);
        } else {
          expect(settingsLink!.getAttribute("href")).toBe("/settings");
          expect(settingsLink!.classList.contains("border-beam-gold/60")).toBe(false);
        }
      }
    },
  );

  test.each([
    { label: "502 + error: UPSTREAM_ERROR", status: 502, payload: { error: "UPSTREAM_ERROR", message: "无法连接到 AI 服务，请检查接口地址。" } },
    { label: "502 + code: UPSTREAM_ERROR", status: 502, payload: { code: "UPSTREAM_ERROR", message: "Key 无效或没有权限，请检查设置。" } },
    { label: "502 status only", status: 502, payload: {} },
  ])(
    "HintLadder UPSTREAM_ERROR ($label): shows UPSTREAM_ERROR_MESSAGE, ONLY 重试 button (no 去设置), and clicking 重试 re-runs the same request",
    async ({ status, payload }) => {
      const hintCalls: Record<string, unknown>[] = [];
      let callCount = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({ serverKeyDisabled: true });
        }
        if (url.endsWith("/api/hint")) {
          hintCalls.push(JSON.parse(String(init?.body)));
          callCount++;
          if (callCount === 1) {
            return Response.json(payload, { status });
          }
          return Response.json({ level: 2, hint: "双指针思路" });
        }
        return Response.json({ ok: true });
      });

      await act(async () => {
        root.render(createElement(HintLadder, { slug: "3sum", userCode: "const x = 1;" }));
      });

      const l2Btn = Array.from(container.querySelectorAll("button")).find(
        (b) =>
          b.textContent?.includes("模式") ||
          b.getAttribute("title")?.includes("模式"),
      )!;
      await act(async () => {
        l2Btn.click();
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(UPSTREAM_ERROR_MESSAGE);
      expect(alert!.textContent).not.toContain("UPSTREAM_ERROR");
      expect(alert!.textContent).not.toContain("去设置");
      expect(alert!.querySelectorAll("a")).toHaveLength(0);
      expect(alert!.querySelector('[data-testid="goto-settings"]')).toBeNull();

      const buttons = Array.from(alert!.querySelectorAll("button"));
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe("重试");

      await act(async () => {
        buttons[0].click();
      });

      expect(hintCalls).toHaveLength(2);
      expect(hintCalls[0]).toEqual({ slug: "3sum", level: 2, userCode: "const x = 1;" });
      expect(hintCalls[1]).toEqual(hintCalls[0]);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("双指针思路");
    },
  );

  test("HintLadder 502 with BASE_URL_INVALID body shows BASE_URL_INVALID copy and 去设置 link", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/settings")) {
        return Response.json({ serverKeyDisabled: true });
      }
      if (url.endsWith("/api/hint")) {
        return Response.json(
          { code: "BASE_URL_INVALID", error: "BASE_URL_INVALID", message: "bad url" },
          { status: 502 },
        );
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
    expect(alert!.textContent).toContain(BASE_URL_INVALID_LECTURE_MESSAGE);
    expect(alert!.textContent).not.toContain(UPSTREAM_ERROR_MESSAGE);
    const settingsLink = alert!.querySelector('[data-testid="goto-settings"]');
    expect(settingsLink).not.toBeNull();
    expect(settingsLink!.getAttribute("href")).toBe("/settings?focus=baseUrl");
  });

  test("ProblemPage streamed UPSTREAM_ERROR shows fixed copy + only 重试, raw server message not in DOM, console.warn called with it", async () => {
    const rawServerMsg = "raw upstream gateway error detail 502 bad gateway";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        const ndjson =
          JSON.stringify({
            type: "error",
            error: "UPSTREAM_ERROR",
            message: rawServerMsg,
          }) + "\n";
        return new Response(ndjson, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
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
    expect(alert!.textContent).toContain(UPSTREAM_ERROR_MESSAGE);
    expect(container.textContent).not.toContain(rawServerMsg);
    expect(warnSpy).toHaveBeenCalledWith(rawServerMsg);

    const buttons = Array.from(alert!.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("重试");
    expect(alert!.querySelectorAll("a")).toHaveLength(0);
    expect(alert!.textContent).not.toContain("去设置");
  });

  test.each([
    { label: "502 + error: UPSTREAM_ERROR", status: 502, payload: { error: "UPSTREAM_ERROR", message: "无法连接到 AI 服务，请检查接口地址。" } },
    { label: "502 + code: UPSTREAM_ERROR", status: 502, payload: { code: "UPSTREAM_ERROR", message: "Key 无效或没有权限，请检查设置。" } },
    { label: "502 status only", status: 502, payload: {} },
  ])(
    "ProblemPage lecture UPSTREAM_ERROR ($label): shows UPSTREAM_ERROR_MESSAGE, ONLY 重试 button (no 去设置), and clicking 重试 re-runs the same request",
    async ({ status, payload }) => {
      const detail = await localSeedSource.detail("3sum");
      const step = {
        id: "s1",
        narration: "先排序",
        targets: [{ kind: "code-line" as const, start: 2 }],
        effects: [],
        dwellMs: 5000,
      };
      const lectureCalls: Record<string, unknown>[] = [];
      let callCount = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({ serverKeyDisabled: true });
        }
        if (url.endsWith("/api/problems/3sum")) {
          return Response.json({ problem: detail });
        }
        if (url.endsWith("/api/lecture")) {
          lectureCalls.push(JSON.parse(String(init?.body)));
          callCount++;
          if (callCount === 1) {
            return Response.json(payload, { status });
          }
          const ndjson =
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
          return new Response(ndjson, {
            headers: { "Content-Type": "application/x-ndjson" },
          });
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
      expect(alert!.textContent).toContain(UPSTREAM_ERROR_MESSAGE);
      expect(alert!.textContent).not.toContain("UPSTREAM_ERROR");
      expect(alert!.textContent).not.toContain("去设置");
      expect(alert!.querySelectorAll("a")).toHaveLength(0);
      expect(alert!.querySelector('[data-testid="goto-settings"]')).toBeNull();

      const buttons = Array.from(alert!.querySelectorAll("button"));
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe("重试");

      await act(async () => {
        buttons[0].click();
      });

      expect(lectureCalls).toHaveLength(2);
      expect(lectureCalls[0]).toEqual({ slug: "3sum", solutionLanguage: "typescript" });
      expect(lectureCalls[1]).toEqual(lectureCalls[0]);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("教案已生成完成");
    },
  );

  test.each([
    { shape: "error", payload: { error: "UPSTREAM_ERROR", message: "无法连接到 AI 服务，请检查接口地址。" } },
    { shape: "code", payload: { code: "UPSTREAM_ERROR", message: "Key 无效或没有权限，请检查设置。" } },
    { shape: "502-only", payload: {} },
  ])(
    "SettingsPage testConnection 502 UPSTREAM_ERROR ($shape) shows UPSTREAM_ERROR_MESSAGE with no 去设置",
    async ({ payload }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/settings")) {
          return Response.json({
            settings: {},
            keySource: "settings",
            serverKeyDisabled: false,
          });
        }
        if (url.endsWith("/api/settings/test-connection")) {
          return Response.json(payload, { status: 502 });
        }
        return Response.json({ ok: true });
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const testBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("测试连接"),
      )!;
      await act(async () => {
        testBtn.click();
      });

      expect(container.textContent).toContain(UPSTREAM_ERROR_MESSAGE);
      expect(container.textContent).not.toContain("UPSTREAM_ERROR");
      expect(container.textContent).not.toContain("去设置");
      expect(container.querySelector('[data-testid="goto-settings"]')).toBeNull();
      expect(container.querySelector('a[href*="/settings"]')).toBeNull();
    },
  );
});


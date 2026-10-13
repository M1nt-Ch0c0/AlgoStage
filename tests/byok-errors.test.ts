// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import HintLadder from "../components/hint/hint-ladder";
import {
  BASE_URL_NOT_ALLOWED_LECTURE_MESSAGE,
  mapByokErrorMessage,
  resetServerKeyDisabledCache,
} from "../lib/byok/client";
import { localSeedSource } from "../lib/content/local-source";
import { readLectureResponse } from "../lib/player/lecture-response";
import { usePlayerStore } from "../lib/player/store";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
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
    code: "BASE_URL_NOT_ALLOWED",
    expected: "只支持公网 http(s) 地址",
  },
  {
    code: "SETTINGS_LOCKED",
    expected: "公共实例不支持修改服务器设置",
  },
  {
    code: "NO_BYOK",
    expected: "还没填 API Key。先去设置页填入你自己的 API Key 就能开讲。",
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
        code: "UPSTREAM_ERROR",
        message: "Key 无效或没有权限，请检查设置。",
      }),
    ).toBe("Key 无效或没有权限，请检查设置。");
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
          return Response.json(payload, { status: 400 });
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
      if (code === "NO_BYOK" || code === "BASE_URL_NOT_ALLOWED") {
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
          return Response.json(payload, { status: 400 });
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
      expect(settingsLink).toBeDefined();
      if (code === "NO_BYOK" || code === "BASE_URL_NOT_ALLOWED") {
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
    },
  );
});

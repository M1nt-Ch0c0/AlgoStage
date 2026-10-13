// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import HintLadder from "../components/hint/hint-ladder";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("副标题固定为本地文案，不含体验版", async () => {
  await act(async () => {
    root.render(createElement(HintLadder, { slug: "two-sum" }));
  });
  expect(container.textContent).toContain("用了几级会记在看板上");
  expect(container.textContent).not.toContain("体验版");
  expect(container.textContent).not.toContain("在线体验");

  const source = readFileSync(
    path.join(__dirname, "../components/hint/hint-ladder.tsx"),
    "utf8",
  );
  expect(source).not.toContain("IS_DEMO");
  expect(source).not.toContain('error === "DEMO"');
  expect(source).not.toContain("体验版");
});

function levelButton(label = "观察") {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label) || b.getAttribute("title")?.includes(label),
  )!;
}

test("请求中显示已用时与取消，取消会 abort", async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (v: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal as AbortSignal | undefined;
    return pending;
  });
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => {
    root.render(createElement(HintLadder, { slug: "two-sum" }));
  });
  await act(async () => {
    levelButton("观察").click();
  });
  expect(fetchMock).toHaveBeenCalled();
  expect(container.textContent).toMatch(/已用\s*0s/);
  expect(
    Array.from(container.querySelectorAll("button")).some(
      (b) => b.textContent === "取消",
    ),
  ).toBe(true);

  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "取消")!
      .click();
  });
  expect(signal?.aborted).toBe(true);
  expect(container.textContent).not.toMatch(/已用/);
  // settle dangling promise so no unhandled rejection
  resolve(Response.json({ level: 1, hint: "x" }));
  await act(async () => {});
});

test("超时失败显示慢提示与重试，重试再次请求", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: "TIMEOUT", message: "提示请求超时，请重试。" },
        { status: 504 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ level: 1, hint: "看一下目标值" }));
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => {
    root.render(createElement(HintLadder, { slug: "two-sum" }));
  });
  await act(async () => {
    levelButton("观察").click();
  });
  await act(async () => {});
  expect(container.textContent).toContain("老师这会儿有点慢");
  const retry = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "重试",
  )!;
  await act(async () => {
    retry.click();
  });
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3); // hint fail + hint retry + progress
  expect(container.textContent).toContain("看一下目标值");
});

test("卸载时中止进行中的请求", async () => {
  let signal: AbortSignal | undefined;
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return pending;
    }),
  );

  await act(async () => {
    root.render(createElement(HintLadder, { slug: "two-sum" }));
  });
  await act(async () => {
    levelButton("观察").click();
  });
  expect(signal?.aborted).toBe(false);
  await act(async () => {
    root.unmount();
  });
  expect(signal?.aborted).toBe(true);
  // remount fresh root for afterEach
  root = createRoot(container);
});

test("同一 tick 连续三次点击提示重试仅发起一次 /api/hint 请求，完成后再次点击可发起新请求", async () => {
  let hintCalls = 0;
  let phase = 0;
  let resolvePending!: (v: Response) => void;
  const fetchMock = vi.fn((url: unknown) => {
    const path = String(url);
    if (path.endsWith("/api/hint")) {
      hintCalls++;
      phase++;
      if (phase === 1) {
        return Promise.resolve(
          Response.json(
            { error: "TIMEOUT", message: "提示请求超时，请重试。" },
            { status: 504 },
          ),
        );
      }
      if (phase === 2) {
        return new Promise<Response>((r) => {
          resolvePending = r;
        });
      }
      return Promise.resolve(Response.json({ level: 1, hint: "新提示" }));
    }
    return Promise.resolve(Response.json({ ok: true }));
  });
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => {
    root.render(createElement(HintLadder, { slug: "two-sum" }));
  });
  await act(async () => {
    levelButton("观察").click();
  });
  await act(async () => {});
  expect(hintCalls).toBe(1);

  const retryBtn = () =>
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "重试",
    )!;
  expect(retryBtn()).toBeDefined();

  hintCalls = 0;
  await act(async () => {
    const btn = retryBtn();
    btn.click();
    btn.click();
    btn.click();
  });
  expect(hintCalls).toBe(1);

  await act(async () => {
    resolvePending(
      Response.json(
        { error: "TIMEOUT", message: "提示请求超时，请重试。" },
        { status: 504 },
      ),
    );
  });
  await act(async () => {});

  await act(async () => {
    retryBtn().click();
  });
  await act(async () => {});
  expect(hintCalls).toBe(2);
  expect(container.textContent).toContain("新提示");
});


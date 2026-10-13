// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  LECTURE_TIMEOUT_MESSAGE,
  UPSTREAM_AUTH_LECTURE_MESSAGE,
  UPSTREAM_ERROR_MESSAGE,
} from "../lib/byok/client";
import { usePlayerStore } from "../lib/player/store";
import { localSeedSource } from "../lib/content/local-source";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
vi.mock("../components/board/code-editor", () => ({ default: ({ value }: { value: string }) => createElement("pre", { "data-editor": true }, value) }));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));
import ProblemPage from "../app/problem/[slug]/page";

afterEach(() => { usePlayerStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

test.each([
  { error: "UPSTREAM_AUTH", message: UPSTREAM_AUTH_LECTURE_MESSAGE },
  { error: "AUTH_ERROR", message: UPSTREAM_AUTH_LECTURE_MESSAGE },
  { error: "TIMEOUT", message: LECTURE_TIMEOUT_MESSAGE },
  { error: "INVALID_SCRIPT", message: "教案不合法，请换用 gpt-6.1-sol。" },
])("流式备课失败清空半份教案，保留对应错误和操作入口：%j", async ({ error, message }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(c) { stream = c; } }), { headers: { "Content-Type": "application/x-ndjson" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) return response;
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "开始讲课")!.click());
    await act(async () => send({ type: "step", step: { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 } }));
    expect(usePlayerStore.getState().steps).toHaveLength(1);
    expect(usePlayerStore.getState().status).toBe("playing");
    await act(async () => { send({ type: "error", code: error, error, retryable: error === "TIMEOUT" }); stream.close(); });
    expect(usePlayerStore.getState()).toMatchObject({ steps: [], status: "idle", script: null, receiving: false });
    expect(container.querySelector("[data-editor]")?.textContent).toBe(detail.referenceSolutions!.find(s => s.language === "typescript")!.code);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(message);
    if (error === "UPSTREAM_AUTH" || error === "AUTH_ERROR") {
      expect(alert.querySelectorAll("button")).toHaveLength(0);
      expect(alert.textContent).not.toContain("重试");
      const link = alert.querySelector('[data-testid="goto-settings"]') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute("href")).toBe("/settings?focus=apiKey");
      expect(link.textContent).toBe("去设置");
    } else if (error === "TIMEOUT") {
      const buttons = Array.from(alert.querySelectorAll("button"));
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe("重试");
      expect(alert.querySelectorAll("a")).toHaveLength(0);
      expect(alert.textContent).not.toContain("去设置");
    } else {
      expect(alert.textContent).toContain("重试讲课");
      expect(alert.querySelector('a[href="/settings"]')?.textContent).toBe("去设置");
    }
    expect(container.textContent).not.toContain("这道题的 AI 讲解需要你自己的 API Key。");
  } finally { await act(async () => root.unmount()); }
});

test.each([
  { shape: "error", payload: { type: "error", error: "UPSTREAM_ERROR", message: "无法连接到 AI 服务，请检查接口地址。" } },
  { shape: "code", payload: { type: "error", code: "UPSTREAM_ERROR", message: "upstream raw gateway failure 502" } },
])("流式 UPSTREAM_ERROR ($shape) 展示固定文案且仅保留「重试」，原始消息只记 console.warn 不入 DOM", async ({ payload }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const detail = await localSeedSource.detail("3sum");
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(c) { stream = c; } }), { headers: { "Content-Type": "application/x-ndjson" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) return response;
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "开始讲课")!.click());
    await act(async () => send({ type: "step", step: { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 } }));
    await act(async () => { send(payload); stream.close(); });
    expect(usePlayerStore.getState()).toMatchObject({ steps: [], status: "idle", script: null, receiving: false });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(UPSTREAM_ERROR_MESSAGE);
    expect(container.textContent).not.toContain(payload.message);
    expect(warnSpy).toHaveBeenCalledWith(payload.message);
    const buttons = Array.from(alert.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("重试");
    expect(alert.querySelectorAll("a")).toHaveLength(0);
    expect(alert.textContent).not.toContain("去设置");
  } finally { await act(async () => root.unmount()); }
});

test("生成期间主按钮可暂停并补全字幕，完成提示独立于播放状态", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(c) { stream = c; } }), { headers: { "Content-Type": "application/x-ndjson" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) return response;
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  const primary = (label: string) => Array.from(container.querySelectorAll("header button")).find(button => button.textContent === label) as HTMLButtonElement;
  const step = { id: "s1", narration: "先排序，让左右指针可以根据和的大小决定移动方向。", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 };
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => primary("开始讲课").click());
    await act(async () => send({ type: "step", step }));
    expect(primary("暂停").disabled).toBe(false);
    await act(async () => primary("暂停").click());
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(Array.from(container.querySelectorAll("p")).some(p => p.textContent === step.narration)).toBe(true);
    expect(container.textContent).not.toContain("教案已生成完成");
    await act(async () => {
      send({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps: [step] } });
      stream.close();
    });
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("教案已生成完成，共 1 步");
    await act(async () => primary("继续").click());
    expect(usePlayerStore.getState().status).toBe("playing");
    expect(primary("暂停")).toBeDefined();
    expect(container.textContent).toContain("教案已生成完成");
  } finally { await act(async () => root.unmount()); }
});

test.each([
  { error: "UPSTREAM_ERROR", label: "重试" },
  { error: "TIMEOUT", label: "重试" },
  { error: "INVALID_SCRIPT", label: "重试讲课" },
])("同一 tick 连续三次点击 $label 仅发起一次 /api/lecture 请求，完成后再次点击可发起新请求", async ({ error, label }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const detail = await localSeedSource.detail("3sum");
  let lectureCalls = 0;
  let phase = 0;
  let resolvePending!: (res: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) {
      lectureCalls++;
      phase++;
      if (phase === 1) {
        return new Response(
          JSON.stringify({ type: "error", error, message: "失败" }) + "\n",
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      if (phase === 2) {
        return new Promise<Response>(r => { resolvePending = r; });
      }
      return new Response(
        JSON.stringify({ type: "error", error, message: "再次失败" }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "开始讲课")!.click());
    expect(lectureCalls).toBe(1);
    const retryBtn = () => Array.from(container.querySelectorAll('[role="alert"] button')).find(b => b.textContent === label) as HTMLButtonElement;
    expect(retryBtn()).toBeDefined();

    lectureCalls = 0;
    await act(async () => {
      const btn = retryBtn();
      btn.click();
      btn.click();
      btn.click();
    });
    expect(lectureCalls).toBe(1);

    await act(async () => {
      resolvePending(
        new Response(
          JSON.stringify({ type: "error", error, message: "重试又失败" }) + "\n",
          { headers: { "Content-Type": "application/x-ndjson" } },
        ),
      );
    });

    await act(async () => {
      retryBtn().click();
    });
    expect(lectureCalls).toBe(2);
  } finally { await act(async () => root.unmount()); }
});


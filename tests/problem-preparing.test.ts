// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";
import { localSeedSource } from "../lib/content/local-source";
import type { TeachingStep } from "../lib/teaching/types";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
vi.mock("../components/board/code-editor", () => ({ default: () => null }));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));
import ProblemPage from "../app/problem/[slug]/page";

afterEach(() => {
  usePlayerStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test.each([false, true])("首个真实步骤到达前显示备课中，不显示步骤或满进度（重新生成：%s）", async regenerate => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const step: TeachingStep = { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [] };
  const script = { problemSlug: "3sum", mode: "lecture" as const, language: "zh" as const, solutionLanguage: "typescript" as const, steps: [step] };
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input).endsWith("/api/lecture")) return response;
    if (String(input).endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (String(input).endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    const controls = container.querySelector('[aria-label="语速"]')!.parentElement!;
    expect(controls.textContent).toContain("还没开始上课");
    if (regenerate) {
      await act(async () => usePlayerStore.getState().loadScript(script));
      expect(controls.textContent).toContain("第 1 / 1 步");
    }
    if (regenerate) {
      await act(async () => container.querySelector<HTMLButtonElement>('header button[aria-label="更多"]')!.click());
      const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
      await act(async () => item.click());
      const confirm = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "确定重新生成") as HTMLButtonElement;
      await act(async () => confirm.click());
    } else {
      await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("header button"))
        .find(button => button.textContent === "开始讲课")!.click());
    }
    await act(async () => send({ type: "progress", attempt: 1, message: "正在生成首个讲解步骤…" }));
    expect(controls.querySelector('[role="status"]')?.textContent).toBe("备课中…");
    expect(controls.textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*步/);
    expect(controls.querySelector('[aria-label^="跳到第"]')).toBeNull();
    for (const label of ["上一步", "播放", "下一步"]) {
      expect(controls.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(true);
    }
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    // 重新生成会先 reset，步骤清空后状态是 idle，与首次开讲相同；空格在备课中不推进。
    expect(usePlayerStore.getState().status).toBe("idle");

    await act(async () => send({ type: "step", step }));
    // 首步到达、教案未完成：可播放，但不能显示「第 1 / 1 步」满格，总步数未知。
    expect(controls.querySelector('[role="status"]')?.textContent).toBe("已收到 1 步，仍在备课…");
    expect(controls.textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*步/);
    expect(controls.querySelector('[data-pending-step="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain("共 1 步");
    expect(controls.querySelector('[aria-label="跳到第 1 步"]')).not.toBeNull();
    expect(controls.querySelector<HTMLButtonElement>('[aria-label="暂停"]')?.disabled).toBe(false);
    // 首步和后续步骤之间停顿：仍然不满格。
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(controls.textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*步/);
    expect(controls.querySelector('[data-pending-step="true"]')).not.toBeNull();
    await act(async () => { send({ type: "result", script }); stream.close(); });
    expect(controls.textContent).toContain("第 1 / 1 步");
    expect(controls.querySelector('[data-pending-step="true"]')).toBeNull();
    expect(controls.querySelector('[role="status"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

test.each(["timeout", "disconnect", "upstream"] as const)("已收到步骤后备课%s：显示「已收到 N 步，备课中断」，不满格，步骤可播放，有重试", async kind => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const mk = (id: string): TeachingStep => ({ id, narration: id, targets: [{ kind: "code-line", start: 2 }], effects: [] });
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input).endsWith("/api/lecture")) return response;
    if (String(input).endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (String(input).endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    const controls = container.querySelector('[aria-label="语速"]')!.parentElement!;
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("header button"))
      .find(button => button.textContent === "开始讲课")!.click());
    await act(async () => { send({ type: "step", step: mk("s1") }); send({ type: "step", step: mk("s2") }); });
    await act(async () => {
      if (kind === "timeout") send({ type: "error", code: "TIMEOUT", retryable: true });
      // 上游 EOF/RST/500，服务端重试后放弃
      if (kind === "upstream") send({ type: "error", code: "UPSTREAM_ERROR", retryable: true });
      stream.close();
    });
    expect(controls.querySelector('[role="status"]')?.textContent).toBe("已收到 2 步，备课中断");
    expect(controls.textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*步/);
    const pending = controls.querySelector<HTMLElement>('[data-pending-step]');
    expect(pending?.dataset.pendingStep).toBe("broken");
    expect(pending?.innerHTML).not.toContain("animate-pulse");
    expect(container.textContent).toContain("已收到 2 步");
    expect(container.textContent).not.toContain("共 2 步");
    expect(container.textContent).toContain("重试");
    // 已收到的步骤仍可点、可播放
    const dot = controls.querySelector<HTMLButtonElement>('[aria-label="跳到第 1 步"]')!;
    await act(async () => dot.click());
    expect(usePlayerStore.getState().currentIndex).toBe(0);
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    const playBtn = controls.querySelector<HTMLButtonElement>('[aria-label="播放"],[aria-label="暂停"]')!;
    expect(playBtn.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

test("占位段的脉冲只在 motion-safe 下生效，prefers-reduced-motion 时不动画", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { default: PlayerControls } = await import("../components/board/player-controls");
  const step: TeachingStep = { id: "s1", narration: "x", targets: [], effects: [] };
  usePlayerStore.getState().loadScript({ problemSlug: "3sum", mode: "lecture", language: "zh", solutionLanguage: "typescript", steps: [step] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PlayerControls, { generating: true })));
    const bar = container.querySelector('[data-pending-step="true"] > span')!;
    const classes = bar.className.split(/\s+/);
    expect(classes).toContain("motion-safe:animate-pulse");
    expect(classes).toContain("motion-reduce:animate-none");
    expect(classes).not.toContain("animate-pulse");
    expect(bar.className).not.toMatch(/(^|\s)(transition|animate-(?!none))/);
  } finally { await act(async () => root.unmount()); }
});

test.each([
  ["UPSTREAM_ERROR", 0],
  ["UPSTREAM_AUTH", 1],
  ["INVALID_SCRIPT", 1],
] as const)("%s（已收到 %d 步）仍清空，不算中断", async (code, n) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  let stream!: ReadableStreamDefaultController;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input).endsWith("/api/lecture")) return response;
    if (String(input).endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (String(input).endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = (event: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("header button"))
      .find(button => button.textContent === "开始讲课")!.click());
    for (let i = 0; i < n; i++) await act(async () => send({ type: "step", step: { id: `s${i}`, narration: "x", targets: [{ kind: "code-line", start: 2 }], effects: [] } }));
    await act(async () => { send({ type: "error", code, retryable: code === "UPSTREAM_ERROR" }); stream.close(); });
    expect(usePlayerStore.getState()).toMatchObject({ steps: [], status: "idle" });
    expect(container.textContent).not.toContain("备课中断");
    expect(container.querySelector('[data-pending-step]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

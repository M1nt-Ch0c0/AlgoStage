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
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("header button"))
      .find(button => button.textContent === (regenerate ? "重新生成" : "开始讲课"))!.click());
    await act(async () => send({ type: "progress", attempt: 1, message: "正在生成首个讲解步骤…" }));
    expect(controls.querySelector('[role="status"]')?.textContent).toBe("备课中…");
    expect(controls.textContent).not.toMatch(/第\s*\d+\s*\/\s*\d+\s*步/);
    expect(controls.querySelector('[aria-label^="跳到第"]')).toBeNull();
    for (const label of ["上一步", "播放", "下一步"]) {
      expect(controls.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(true);
    }
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(usePlayerStore.getState().status).toBe(regenerate ? "paused" : "idle");

    await act(async () => send({ type: "step", step }));
    expect(controls.querySelector('[role="status"]')).toBeNull();
    expect(controls.textContent).toContain("第 1 / 1 步");
    expect(controls.querySelector('[aria-label="跳到第 1 步"]')).not.toBeNull();
    expect(controls.querySelector<HTMLButtonElement>('[aria-label="暂停"]')?.disabled).toBe(false);
    await act(async () => { send({ type: "result", script }); stream.close(); });
    expect(controls.textContent).toContain("第 1 / 1 步");
  } finally { await act(async () => root.unmount()); }
});

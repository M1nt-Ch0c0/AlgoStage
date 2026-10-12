// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { usePlayerStore } from "../lib/player/store";
import { localSeedSource } from "../lib/content/local-source";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "3sum" }) }));
vi.mock("../components/board/code-editor", () => ({ default: ({ value }: { value: string }) => createElement("pre", { "data-editor": true }, value) }));
vi.mock("../components/effects/effect-stage", () => ({ default: () => null }));
vi.mock("../components/judge/judge-controls", () => ({ default: () => null }));
import ProblemPage from "../app/problem/[slug]/page";

afterEach(() => { usePlayerStore.getState().reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

test.each(["Key 无效或没有权限，请检查设置。", "备课超时，请重试。", "教案不合法，请换用 gpt-6.1-sol。"])("流式备课失败清空半份教案，保留错误、重试和设置入口：%s", async message => {
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
    await act(async () => { send({ type: "error", error: "UPSTREAM_ERROR", message }); stream.close(); });
    expect(usePlayerStore.getState()).toMatchObject({ steps: [], status: "idle", script: null, receiving: false });
    expect(container.querySelector("[data-editor]")?.textContent).toBe(detail.referenceSolutions!.find(s => s.language === "typescript")!.code);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("重试讲课");
    expect(alert.querySelector('a[href="/settings"]')?.textContent).toBe("去设置");
    expect(container.textContent).not.toContain("还没接上 AI？去设置");
  } finally { await act(async () => root.unmount()); }
});

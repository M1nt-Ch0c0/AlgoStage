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

test("完成态「从头再讲」本地重播不发请求，「重新生成」重新请求讲解", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  let lectureCalls = 0;
  const lectureBodies: Array<{ regenerate?: boolean }> = [];
  const progressBodies: Array<{ type?: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith("/api/lecture")) {
      lectureCalls++;
      lectureBodies.push(body);
      return new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (path.endsWith("/api/progress")) progressBodies.push(body);
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    expect(button("重新生成")).toBeUndefined();
    await act(async () => button("开始讲课")!.click());
    expect(lectureCalls).toBe(1);
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    await act(async () => { usePlayerStore.setState({ currentIndex: 1, status: "playing" }); usePlayerStore.getState().next(); });
    expect(usePlayerStore.getState().status).toBe("finished");

    const lectureSteps = () => progressBodies.filter(body => body.type === "lecture-step");
    const reportedBeforeReplay = lectureSteps().length;
    await act(async () => button("从头再讲")!.click());
    expect(lectureCalls).toBe(1);
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });
    expect(usePlayerStore.getState().steps.map(s => s.id)).toEqual(["s1", "s2"]);
    expect(button("重新生成")).toBeUndefined();
    await act(async () => button("暂停")!.click());
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(button("重新生成")).toBeDefined();
    await act(async () => button("继续讲课")!.click());
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });
    expect(button("重新生成")).toBeUndefined();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!.click());
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 1 });
    expect(lectureSteps()).toHaveLength(reportedBeforeReplay);

    await act(async () => button("暂停")!.click());
    expect(button("重新生成")).toBeDefined();
    await act(async () => button("重新生成")!.click());
    expect(lectureCalls).toBe(2);
    expect(lectureBodies[0].regenerate).not.toBe(true);
    expect(lectureBodies[1].regenerate).toBe(true);
    expect(usePlayerStore.getState().steps.map(s => s.id)).toEqual(["s1", "s2"]);
  } finally { await act(async () => root.unmount()); }
});

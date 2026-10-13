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

function moreButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('header button[aria-label="更多"]');
}

function replayButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "重播");
}

/** 「更多」→「重新生成」→「确定重新生成」 */
async function confirmRegenerate(container: HTMLElement) {
  await act(async () => moreButton(container)!.click());
  const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(item.textContent).toContain("重新生成");
  await act(async () => item.click());
  const confirm = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "确定重新生成") as HTMLButtonElement;
  await act(async () => confirm.click());
}

test("结束面板显示时全页只有面板上的一个「重播」，顶栏主按钮不渲染", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) return new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } });
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const headerButton = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    expect(headerButton("开始讲课")?.textContent).toBe("开始讲课");
    expect(replayButtons(container)).toHaveLength(0);
    await act(async () => headerButton("开始讲课")!.click());
    expect(headerButton("暂停")?.textContent).toBe("暂停");
    expect(replayButtons(container)).toHaveLength(0);
    await act(async () => { usePlayerStore.setState({ currentIndex: 1, status: "playing" }); usePlayerStore.getState().next(); });
    expect(usePlayerStore.getState().status).toBe("finished");
    expect(container.textContent).toContain("讲完了");
    const replays = replayButtons(container);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.closest("header")).toBeNull();
    expect(headerButton("重播")).toBeUndefined();
    expect(headerButton("开始讲课")).toBeUndefined();
    expect(headerButton("暂停")).toBeUndefined();
  } finally { await act(async () => root.unmount()); }
});

test("完成态「重播」本地重播不发请求，「重新生成」重新请求讲解", async () => {
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
    expect(moreButton(container)).toBeNull();
    expect(button("重新生成")).toBeUndefined();
    await act(async () => button("开始讲课")!.click());
    expect(lectureCalls).toBe(1);
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    await act(async () => { usePlayerStore.setState({ currentIndex: 1, status: "playing" }); usePlayerStore.getState().next(); });
    expect(usePlayerStore.getState().status).toBe("finished");
    const replays = replayButtons(container);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.closest("header")).toBeNull();
    expect(container.textContent).toContain("讲完了");

    const lectureSteps = () => progressBodies.filter(body => body.type === "lecture-step");
    const reportedBeforeReplay = lectureSteps().length;
    await act(async () => replays[0]!.click());
    expect(lectureCalls).toBe(1);
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });
    expect(usePlayerStore.getState().steps.map(s => s.id)).toEqual(["s1", "s2"]);
    expect(moreButton(container)).toBeNull();
    await act(async () => button("暂停")!.click());
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(moreButton(container)).toBeDefined();
    await act(async () => button("继续")!.click());
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 0 });
    expect(moreButton(container)).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!.click());
    expect(usePlayerStore.getState()).toMatchObject({ status: "playing", currentIndex: 1 });
    expect(lectureSteps()).toHaveLength(reportedBeforeReplay);

    await act(async () => button("暂停")!.click());
    expect(moreButton(container)).toBeDefined();
    await confirmRegenerate(container);
    expect(lectureCalls).toBe(2);
    expect(lectureBodies[0].regenerate).not.toBe(true);
    expect(lectureBodies[1].regenerate).toBe(true);
    expect(usePlayerStore.getState().steps.map(s => s.id)).toEqual(["s1", "s2"]);
  } finally { await act(async () => root.unmount()); }
});

test("播放中不显示「重新生成」", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) return new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } });
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => button("开始讲课")!.click());
    if (usePlayerStore.getState().status !== "playing") {
      await act(async () => usePlayerStore.setState({ status: "playing" }));
    }
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    expect(usePlayerStore.getState().status).toBe("playing");
    expect(moreButton(container)).toBeNull();
    expect(button("重新生成")).toBeUndefined();
    await act(async () => button("暂停")!.click());
    expect(moreButton(container)).toBeDefined();
  } finally { await act(async () => root.unmount()); }
});

test("重新生成后恢复 lecture-step 进度上报", async () => {
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
    await act(async () => button("开始讲课")!.click());
    await act(async () => { usePlayerStore.setState({ currentIndex: 1, status: "playing" }); usePlayerStore.getState().next(); });
    expect(usePlayerStore.getState().status).toBe("finished");
    const replays = replayButtons(container);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.closest("header")).toBeNull();

    const lectureSteps = () => progressBodies.filter(body => body.type === "lecture-step");
    const beforeReplay = lectureSteps().length;
    await act(async () => replays[0]!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!.click());
    expect(lectureSteps()).toHaveLength(beforeReplay);

    await act(async () => button("暂停")!.click());
    await confirmRegenerate(container);
    expect(lectureCalls).toBe(2);
    expect(lectureBodies[1].regenerate).toBe(true);
    expect(usePlayerStore.getState().replaying).toBe(false);

    const afterRegen = lectureSteps().length;
    if (usePlayerStore.getState().currentIndex === 0 && (usePlayerStore.getState().status === "playing" || usePlayerStore.getState().status === "paused")) {
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一步"]')!.click());
    }
    expect(lectureSteps().length).toBeGreaterThan(afterRegen);
    expect(lectureSteps().length).toBeGreaterThan(beforeReplay);
  } finally { await act(async () => root.unmount()); }
});

test("重新生成请求未返回时主按钮为备课中且旧步骤不再恢复", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  let lectureCalls = 0;
  let releaseHung: ((value: Response) => void) | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) {
      lectureCalls++;
      if (lectureCalls === 1) return Promise.resolve(new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } }));
      return new Promise<Response>((resolve, reject) => {
        releaseHung = resolve;
        const signal = init?.signal;
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (path.endsWith("/api/settings")) return Promise.resolve(Response.json({ keySource: "env" }));
    if (path.endsWith("/api/problems/3sum")) return Promise.resolve(Response.json({ problem: detail }));
    return Promise.resolve(Response.json({ ok: true }));
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => button("开始讲课")!.click());
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    await act(async () => button("暂停")!.click());
    expect(usePlayerStore.getState().status).toBe("paused");
    await confirmRegenerate(container);
    const preparing = button("备课中…");
    expect(preparing?.textContent).toBe("备课中…");
    expect(preparing?.disabled).toBe(true);
    expect(usePlayerStore.getState().steps).toHaveLength(0);
    expect(usePlayerStore.getState().status).not.toBe("playing");
    expect(usePlayerStore.getState().status).not.toBe("paused");
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(b => b.textContent === "取消备课")!.click();
    });
    await act(async () => { releaseHung?.(new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } })); });
    expect(usePlayerStore.getState().steps).toHaveLength(0);
    expect(usePlayerStore.getState().steps.map(step => step.id)).not.toEqual(["s1", "s2"]);
    expect(usePlayerStore.getState().status).not.toBe("playing");
    expect(usePlayerStore.getState().status).not.toBe("paused");
  } finally { await act(async () => root.unmount()); }
});

test("重新生成请求失败后步骤清空，主按钮回到开始讲课", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  let lectureCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) {
      lectureCalls++;
      if (lectureCalls > 1) throw new Error("老师这次没备好课，请重试。");
      return new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => button("开始讲课")!.click());
    expect(usePlayerStore.getState().steps).toHaveLength(2);
    await act(async () => button("暂停")!.click());
    await confirmRegenerate(container);
    expect(usePlayerStore.getState().steps).toHaveLength(0);
    expect(usePlayerStore.getState().status).toBe("idle");
    expect(button("开始讲课")?.textContent).toBe("开始讲课");
    expect(button("开始讲课")?.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});

test("点击「重新生成」菜单项本身不请求新讲解，「取消」关闭确认框", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("3sum");
  const steps = [
    { id: "s1", narration: "先排序", targets: [{ kind: "code-line", start: 2 }], effects: [], dwellMs: 5000 },
    { id: "s2", narration: "再双指针", targets: [{ kind: "code-line", start: 4 }], effects: [], dwellMs: 5000 },
  ];
  const lectureBody = () => steps.map(step => JSON.stringify({ type: "step", step })).join("\n") + "\n" +
    JSON.stringify({ type: "result", script: { problemSlug: "3sum", mode: "lecture", solutionLanguage: "typescript", language: "zh", steps } }) + "\n";
  let lectureCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/api/lecture")) {
      lectureCalls++;
      return new Response(lectureBody(), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (path.endsWith("/api/settings")) return Response.json({ keySource: "env" });
    if (path.endsWith("/api/problems/3sum")) return Response.json({ problem: detail });
    return Response.json({ ok: true });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => Array.from(container.querySelectorAll("header button")).find(b => b.textContent === label) as HTMLButtonElement | undefined;
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    await act(async () => button("开始讲课")!.click());
    await act(async () => { usePlayerStore.setState({ currentIndex: 1, status: "playing" }); usePlayerStore.getState().next(); });
    expect(usePlayerStore.getState().status).toBe("finished");
    expect(lectureCalls).toBe(1);

    await act(async () => moreButton(container)!.click());
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent).toContain("重新生成");
    await act(async () => item.click());
    expect(lectureCalls).toBe(1);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("重新生成会清掉当前教案，确定吗？");
    const cancel = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "取消") as HTMLButtonElement;
    await act(async () => cancel.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(lectureCalls).toBe(1);
  } finally { await act(async () => root.unmount()); }
});

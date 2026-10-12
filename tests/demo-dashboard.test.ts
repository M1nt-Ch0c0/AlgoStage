// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import DashboardPage from "../app/dashboard/page";
import { SiteNav } from "../components/site-nav";

const runtime = vi.hoisted(() => ({ isDemo: false }));
vi.mock("../lib/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/runtime")>(),
  get IS_DEMO() { return runtime.isDemo; },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
// 检查页面数据和导航，不启动动画计时器。
vi.mock("motion/react", () => ({
  animate: (_from: number, to: number, options: { onUpdate: (value: number) => void }) => {
    options.onUpdate(to);
    return { stop: () => {} };
  },
  motion: {
    div: ({ children, className }: { children?: ReactNode; className?: string }) => createElement("div", { className }, children),
    span: ({ children, className }: { children?: ReactNode; className?: string }) => createElement("span", { className }, children),
  },
}));

beforeEach(() => {
  runtime.isDemo = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

const dashboard = {
  heatmap: {}, mastery: { "hash-map": 0.75 }, streak: 2, acCount: 1,
  totalSubmissions: 3, independence: 1, reviewDue: 0,
};

async function render(Component: typeof DashboardPage | typeof SiteNav) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component)));
  return { container, root };
}

function expectUnavailable(container: HTMLElement) {
  expect(container.textContent).toContain("体验版没有学习看板");
  expect(container.textContent).not.toContain("知识点掌握度");
  expect(container.querySelector('[aria-label="近一年每天的学习次数"]')).toBeNull();
  expect(container.querySelector(".animate-pulse")).toBeNull();
}

test.each([true, false])("导航仅在非 Demo 时显示看板入口：IS_DEMO=%s", async isDemo => {
  runtime.isDemo = isDemo;
  const { container, root } = await render(SiteNav);
  try {
    expect(container.querySelector('a[href="/dashboard"]') !== null).toBe(!isDemo);
    if (!isDemo) expect(container.querySelector('a[href="/dashboard"]')?.getAttribute("aria-current")).toBe("page");
    for (const href of ["/roadmap", "/review", "/settings"]) {
      expect(container.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
  } finally { await act(async () => root.unmount()); }
});

test("Demo 直接访问看板只显示静态提示，不请求 API", async () => {
  runtime.isDemo = true;
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Demo 不应加载看板"));
  const { container, root } = await render(DashboardPage);
  try {
    expectUnavailable(container);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

test.each([
  ["/api/dashboard", 403], ["/api/dashboard", 500],
  ["/api/problems", 403], ["/api/problems", 500],
] as const)("看板接口 %s 返回 %s 时不解析错误响应，显示静态提示", async (failedPath, status) => {
  const response = Response.json({ error: "DEMO" }, { status });
  const json = vi.spyOn(response, "json");
  vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input) === failedPath ? response : Response.json(String(input) === "/api/dashboard" ? dashboard : { problems: [] }),
  );
  const { container, root } = await render(DashboardPage);
  try {
    expectUnavailable(container);
    expect(json).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

test("看板数据为 undefined 时显示提示，不访问 mastery", async () => {
  const response = Response.json(null);
  vi.spyOn(response, "json").mockResolvedValue(undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input) === "/api/dashboard" ? response : Response.json({ problems: [] }),
  );
  const { container, root } = await render(DashboardPage);
  try { expectUnavailable(container); } finally { await act(async () => root.unmount()); }
});

test("非 Demo 看板加载期间和成功响应后正常渲染", async () => {
  let resolveDashboard!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveDashboard = resolve; });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
    String(input) === "/api/dashboard" ? pending : Response.json({ problems: [] }),
  );
  const { container, root } = await render(DashboardPage);
  try {
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    await act(async () => resolveDashboard(Response.json(dashboard)));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["/api/dashboard", "/api/problems"]);
    expect(container.textContent).not.toContain("体验版没有学习看板");
    expect(container.textContent).toContain("共提交 3 次");
    expect(container.textContent).toContain("75 分");
    expect(container.querySelector('[aria-label="近一年每天的学习次数"]')).not.toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

test("看板网络请求失败仍显示加载错误提示", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const { container, root } = await render(DashboardPage);
  try {
    expect(container.textContent).toContain("学习记录没加载出来");
    expect(container.querySelector(".animate-pulse")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

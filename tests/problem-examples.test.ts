// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { localSeedSource } from "../lib/content/local-source";
import { usePlayerStore } from "../lib/player/store";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "group-anagrams" }) }));
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

test("示例表格限制列宽并允许输入、输出换行，完整保留第 49 题及长字符串示例", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const detail = await localSeedSource.detail("group-anagrams");
  const testCases = [...detail.testCases!, { input: "x".repeat(200), expected: "y".repeat(200) }];
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).endsWith("/api/settings")
    ? Response.json({ keySource: "none" })
    : Response.json({ problem: { ...detail, testCases } }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ProblemPage)));
    const table = container.querySelector("table")!;
    expect(table.classList.contains("w-full")).toBe(true);
    expect(table.classList.contains("table-fixed")).toBe(true);
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(testCases.length);
    rows.forEach((row, i) => {
      const cells = Array.from(row.querySelectorAll("td"));
      expect(cells.map(cell => cell.textContent)).toEqual([testCases[i].input, `→ ${testCases[i].expected}`]);
      for (const cell of cells) {
        expect(cell.classList.contains("whitespace-normal")).toBe(true);
        expect(cell.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
        expect(cell.classList.contains("whitespace-nowrap")).toBe(false);
        expect(cell.classList.contains("truncate")).toBe(false);
      }
    });
  } finally { await act(async () => root.unmount()); }
});

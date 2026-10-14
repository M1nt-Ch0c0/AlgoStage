// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskSelectionSummary, AskTarget } from "@/lib/ask/types";
import { collectAskCandidates, collectAskCandidatesInBox, summarizeSelection } from "@/lib/ask/collect-candidates";
import { type CodeEditorHandle, registerCodeEditor, resetCodeEditorRegistry } from "@/lib/ask/code-editor-registry";

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function mockRect(el: Element, box: DOMRect): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(box);
}

function summary(targets: AskTarget[], mode: AskSelectionSummary["mode"] = "single"): AskSelectionSummary {
  return { mode, bbox: { x: 0, y: 0, width: 10, height: 10 }, targets };
}

describe("collectAskCandidates", () => {
  afterEach(() => {
    resetCodeEditorRegistry();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("1. only collects data-ask-target inside the stage and skips exclude subtrees", () => {
    document.body.innerHTML = `
      <div id="outside" data-ask-target="step" data-ask-id="step:out" data-ask-step-id="s-out">外面</div>
      <section id="problem"><div data-ask-target="step" data-ask-id="step:problem">题目栏</div></section>
      <div id="stage" data-ask-stage>
        <p data-ask-target="subtitle" data-ask-id="subtitle:s1" data-ask-step-id="s1">字幕</p>
        <div data-ask-target="step" data-ask-id="step:s1" data-ask-step-id="s1">步骤</div>
        <div data-ask-exclude>
          <span data-ask-target="step" data-ask-id="step:excluded" data-ask-step-id="s1">回答区</span>
          <span data-ask-target="viz" data-ask-viz-index="0" data-ask-step-id="s1">格子</span>
        </div>
        <pre>代码编辑器没有 target</pre>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    mockRect(stage, rect(100, 50, 400, 300));
    for (const el of document.querySelectorAll("[data-ask-target]")) {
      mockRect(el, rect(110, 60, 40, 20));
    }

    const candidates = collectAskCandidates(stage);
    expect(candidates.map((c) => c.target.id)).toEqual(["subtitle:s1", "step:s1"]);
    expect(candidates.every((c) => c.target.text !== "回答区" && c.target.text !== "外面")).toBe(true);
  });

  it("30. elements under data-ask-exclude never appear even with data-ask-target", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div data-ask-exclude data-ask-target="step" data-ask-id="step:self" data-ask-step-id="s1">排除根自己</div>
        <article data-ask-exclude>
          <div>
            <span data-ask-target="subtitle" data-ask-id="subtitle:nested" data-ask-step-id="s1">嵌套</span>
          </div>
        </article>
        <div data-ask-target="viz" data-ask-id="viz:s1" data-ask-step-id="s1">保留</div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    mockRect(stage, rect(0, 0, 200, 200));
    for (const el of document.querySelectorAll("[data-ask-target]")) {
      mockRect(el, rect(10, 10, 20, 20));
    }
    const candidates = collectAskCandidates(stage);
    expect(candidates.map((c) => c.target.id)).toEqual(["viz:s1"]);
  });

  it("2. rect is relative to the stage and follows scrollLeft/scrollTop", () => {
    document.body.innerHTML = `<div id="stage"><div id="cell" data-ask-target="step" data-ask-step-id="s1">步</div></div>`;
    const stage = document.getElementById("stage") as HTMLElement;
    const cell = document.getElementById("cell") as HTMLElement;
    mockRect(stage, rect(100, 40, 500, 400));
    mockRect(cell, rect(130, 90, 80, 24));
    Object.defineProperty(stage, "scrollLeft", { value: 0, configurable: true });
    Object.defineProperty(stage, "scrollTop", { value: 0, configurable: true });

    expect(collectAskCandidates(stage)[0]?.rect).toEqual({ x: 30, y: 50, width: 80, height: 24 });

    Object.defineProperty(stage, "scrollLeft", { value: 15, configurable: true });
    Object.defineProperty(stage, "scrollTop", { value: 40, configurable: true });
    expect(collectAskCandidates(stage)[0]?.rect).toEqual({ x: 45, y: 90, width: 80, height: 24 });
  });

  it("3. collapses whitespace, truncates text to 200, builds vizHit and ids", () => {
    const long = `${"字".repeat(180)} ${"字".repeat(40)} 尾`;
    document.body.innerHTML = `
      <div id="stage">
        <p id="sub" data-ask-target="subtitle" data-ask-step-id="step-9">  多   空格\n字幕  </p>
        <div id="step" data-ask-target="step" data-ask-step-id="step-9"></div>
        <div id="block" data-ask-target="viz" data-ask-step-id="step-9">整块</div>
        <div id="cell" data-ask-target="viz" data-ask-step-id="step-9" data-ask-viz-index="2">格</div>
        <div id="bad" data-ask-target="viz" data-ask-step-id="step-9" data-ask-viz-index="-1">负</div>
        <div id="frac" data-ask-target="viz" data-ask-step-id="step-9" data-ask-viz-index="1.5">小数</div>
        <div id="long" data-ask-target="step" data-ask-id="step:custom" data-ask-step-id="step-9"></div>
        <div id="unknown" data-ask-target="widget" data-ask-step-id="step-9">未知</div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    mockRect(stage, rect(0, 0, 100, 100));
    for (const el of stage.querySelectorAll("[data-ask-target]")) {
      mockRect(el, rect(0, 0, 10, 10));
    }
    const longEl = document.getElementById("long") as HTMLElement;
    longEl.textContent = long;

    const candidates = collectAskCandidates(stage);
    const byId = Object.fromEntries(candidates.map((c) => [c.target.id, c.target]));

    expect(byId["subtitle:step-9"]).toMatchObject({
      kind: "subtitle",
      id: "subtitle:step-9",
      stepId: "step-9",
      text: "多 空格 字幕",
    });
    expect(byId["subtitle:step-9"]?.vizHit).toBeUndefined();

    expect(byId["step:step-9"]).toMatchObject({ kind: "step", id: "step:step-9", stepId: "step-9" });
    const block = candidates.find((c) => c.target.text === "整块");
    expect(block?.target).toMatchObject({ kind: "viz", id: "viz:step-9", stepId: "step-9", text: "整块" });
    expect(block?.target.vizHit).toBeUndefined();

    expect(byId["viz:step-9:2"]).toMatchObject({
      kind: "viz",
      id: "viz:step-9:2",
      stepId: "step-9",
      vizHit: { structure: "array", indices: [2] },
    });
    expect(candidates.some((c) => c.target.text === "负")).toBe(true);
    const negative = candidates.find((c) => c.target.text === "负");
    expect(negative?.target.id).toBe("viz:step-9");
    expect(negative?.target.vizHit).toBeUndefined();
    expect(negative).not.toBe(block);
    const fraction = candidates.find((c) => c.target.text === "小数");
    expect(fraction?.target.vizHit).toBeUndefined();

    const customText = byId["step:custom"]?.text ?? "";
    expect(customText.length).toBe(ASK_LIMITS.targetTextMax);
    expect(customText.length).toBe(200);
    expect(customText.startsWith("字")).toBe(true);
    expect(customText.includes("  ")).toBe(false);
    expect(customText.endsWith(" ")).toBe(false);

    expect(candidates.some((c) => c.target.text === "未知")).toBe(false);
    expect(candidates.some((c) => c.target.kind === "code")).toBe(false);
  });

  it("keeps a zero-size rect and drops a non-finite rect", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div id="zero" data-ask-target="step" data-ask-id="step:z" data-ask-step-id="s">零</div>
        <div id="nan" data-ask-target="step" data-ask-id="step:n" data-ask-step-id="s">坏</div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    mockRect(stage, rect(0, 0, 10, 10));
    mockRect(document.getElementById("zero") as Element, rect(1, 2, 0, 0));
    mockRect(document.getElementById("nan") as Element, rect(Number.NaN, 0, 10, 10));
    const candidates = collectAskCandidates(stage);
    expect(candidates.map((c) => c.target.id)).toEqual(["step:z"]);
    expect(candidates[0]?.rect).toEqual({ x: 1, y: 2, width: 0, height: 0 });
  });

  it("mock-editor handle returns {3,7} -> codeRange {startLine:3,endLine:7}, text = lines 3..7 truncated to 200", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div id="code" data-ask-target="code" data-ask-id="code:main" data-ask-step-id="s1"></div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    const codeEl = document.getElementById("code") as HTMLElement;
    mockRect(stage, rect(0, 0, 500, 500));
    mockRect(codeEl, rect(50, 50, 400, 300));

    const longCodeLines = "const x = 1;\n".repeat(25); // > 200 chars
    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn((_top, _bottom) => ({ startLine: 3, endLine: 7 })),
      getLinesText: vi.fn((_start, _end) => longCodeLines),
      getFullText: vi.fn(() => "full code"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const box = { x: 60, y: 60, width: 200, height: 100 };
    const candidates = collectAskCandidatesInBox(stage, box);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate.target.kind).toBe("code");
    expect(candidate.target.id).toBe("code:main");
    expect(candidate.target.codeRange).toEqual({ startLine: 3, endLine: 7 });
    expect(candidate.target.text).toBe(longCodeLines.slice(0, 200));
    expect(candidate.target.text?.length).toBe(200);
    expect(candidate.target.text?.includes("\n")).toBe(true);
    expect(mockHandle.getLineRangeForClientBox).toHaveBeenCalledWith(60, 160);
  });

  it("fallback (handle returns null or no handle) -> no codeRange, summary 「已选：当前代码」, counts as a code unit", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div id="code-null-range" data-ask-target="code" data-ask-id="code:c1" data-ask-step-id="s1"></div>
        <div id="code-no-handle" data-ask-target="code" data-ask-id="code:c2" data-ask-step-id="s1">fallback text</div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    const code1 = document.getElementById("code-null-range") as HTMLElement;
    const code2 = document.getElementById("code-no-handle") as HTMLElement;
    mockRect(stage, rect(0, 0, 500, 500));
    mockRect(code1, rect(10, 10, 100, 100));
    mockRect(code2, rect(10, 150, 100, 100));

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => null),
      getLinesText: vi.fn(() => ""),
      getFullText: vi.fn(() => "handle full text"),
    };
    registerCodeEditor(code1, mockHandle);

    const box = { x: 5, y: 5, width: 200, height: 300 };
    const candidates = collectAskCandidates(stage, box);
    expect(candidates).toHaveLength(2);

    // code1: handle returns null range -> fallback whole block
    expect(candidates[0].target.codeRange).toBeUndefined();
    expect(candidates[0].target.text).toBe("handle full text");
    expect(summarizeSelection(summary([candidates[0].target]))).toBe("已选：当前代码");

    // code2: no handle -> fallback textContent
    expect(candidates[1].target.codeRange).toBeUndefined();
    expect(candidates[1].target.text).toBe("fallback text");
    expect(summarizeSelection(summary([candidates[1].target]))).toBe("已选：当前代码");
  });

  it("mixed code+viz collects both", () => {
    document.body.innerHTML = `
      <div id="stage">
        <div id="code" data-ask-target="code" data-ask-id="code:main" data-ask-step-id="s1"></div>
        <div id="viz" data-ask-target="viz" data-ask-id="viz:s1" data-ask-step-id="s1">整块</div>
      </div>
    `;
    const stage = document.getElementById("stage") as HTMLElement;
    const codeEl = document.getElementById("code") as HTMLElement;
    const vizEl = document.getElementById("viz") as HTMLElement;
    mockRect(stage, rect(0, 0, 500, 500));
    mockRect(codeEl, rect(10, 10, 100, 50));
    mockRect(vizEl, rect(10, 80, 100, 50));

    const mockHandle: CodeEditorHandle = {
      getLineRangeForClientBox: vi.fn(() => ({ startLine: 3, endLine: 7 })),
      getLinesText: vi.fn(() => "line 3 to 7"),
      getFullText: vi.fn(() => "full code"),
    };
    registerCodeEditor(codeEl, mockHandle);

    const box = { x: 0, y: 0, width: 200, height: 200 };
    const candidates = collectAskCandidatesInBox(stage, box);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.target.kind)).toEqual(["code", "viz"]);
    expect(candidates[0].target.codeRange).toEqual({ startLine: 3, endLine: 7 });

    const mixedSummary = summarizeSelection(summary(candidates.map((c) => c.target), "region"));
    expect(mixedSummary).toBe("已选：代码第 3–7 行 · 可视化 1 处");
  });
});

describe("summarizeSelection", () => {
  it("summary verbatim 已选：代码第 3–7 行 with U+2013 (assert charCode 0x2013)", () => {
    const targetWithRange: AskTarget = {
      kind: "code",
      id: "code:main",
      codeRange: { startLine: 3, endLine: 7 },
      text: "line 3..7",
    };
    const singleSummary = summarizeSelection(summary([targetWithRange]));
    expect(singleSummary).toBe("已选：代码第 3–7 行");

    // Assert EN DASH U+2013 verbatim between 3 and 7
    const dash = singleSummary.slice(singleSummary.indexOf("3") + 1, singleSummary.indexOf("7"));
    expect(dash).toBe("–");
    expect(dash.charCodeAt(0)).toBe(0x2013);
  });
  it("4. stays within 24 code points for single subtitle, single step, and viz N", () => {
    expect(summarizeSelection(summary([{ kind: "subtitle", id: "subtitle:s3", stepId: "s3" }]))).toBe("已选：当前字幕");
    expect(summarizeSelection(summary([{ kind: "step", id: "step:s3", stepId: "s3" }]))).toBe("已选：当前步骤");
    const viz = (n: number): AskTarget[] =>
      Array.from({ length: n }, (_, i) => ({
        kind: "viz" as const,
        id: `viz:s3:${i}`,
        stepId: "s3",
        vizHit: { structure: "array", indices: [i] },
      }));
    expect(summarizeSelection(summary(viz(3), "region"))).toBe("已选：可视化 3 处");
    expect(summarizeSelection(summary(viz(1)))).toBe("已选：可视化 1 处");
    expect(summarizeSelection(summary([]))).toBe("已选：无");

    const mixed = summarizeSelection(
      summary(
        [
          { kind: "subtitle", id: "subtitle:s3" },
          { kind: "step", id: "step:s3" },
          ...viz(3),
        ],
        "region",
      ),
    );
    expect(Array.from(mixed).length).toBeLessThanOrEqual(24);
    expect(mixed.startsWith("已选：")).toBe(true);

    const huge = summarizeSelection(summary(viz(10_000), "region"));
    expect(Array.from(huge).length).toBeLessThanOrEqual(24);
  });
});

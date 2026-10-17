import { describe, expect, it } from "vitest";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskCandidate, AskTarget } from "@/lib/ask/types";
import { hitTest } from "@/lib/ask/hit-test";
import {
  classifyOrigin,
  codeCaptureBox,
  filterHitByOrigin,
  resolveCaptureSelection,
} from "@/lib/ask/origin-kind";

function target(id: string, kind: AskTarget["kind"]): AskTarget {
  return { kind, id };
}

function candidate(id: string, rect: AskBBox, kind: AskTarget["kind"]): AskCandidate {
  return { target: target(id, kind), rect };
}

const codeRect: AskBBox = { x: 0, y: 0, width: 100, height: 80 };
const vizRect: AskBBox = { x: 120, y: 0, width: 80, height: 60 };

describe("classifyOrigin", () => {
  it("U1 inside code → code; inside viz → viz; overlap → code; neither → other; edge counts as inside; non-finite rect skipped", () => {
    expect(classifyOrigin({ x: 10, y: 10 }, [codeRect], [vizRect])).toBe("code");
    expect(classifyOrigin({ x: 150, y: 20 }, [codeRect], [vizRect])).toBe("viz");

    // Viz wins an overlap: the code container's padding can cover the viz block.
    const overlappingViz: AskBBox = { x: 80, y: 0, width: 40, height: 40 };
    expect(classifyOrigin({ x: 90, y: 10 }, [codeRect], [overlappingViz])).toBe("viz");

    expect(classifyOrigin({ x: 110, y: 10 }, [codeRect], [vizRect])).toBe("other");
    expect(classifyOrigin({ x: 200, y: 200 }, [codeRect], [vizRect])).toBe("other");

    // Inclusive edges, including a negative rect that normalizes onto the same box.
    expect(classifyOrigin({ x: 0, y: 0 }, [codeRect], [vizRect])).toBe("code");
    expect(classifyOrigin({ x: 100, y: 80 }, [codeRect], [vizRect])).toBe("code");
    expect(classifyOrigin({ x: 120, y: 0 }, [codeRect], [vizRect])).toBe("viz");
    expect(classifyOrigin({ x: 200, y: 60 }, [codeRect], [vizRect])).toBe("viz");
    expect(classifyOrigin({ x: 0, y: 0 }, [{ x: 100, y: 80, width: -100, height: -80 }], [])).toBe("code");

    expect(
      classifyOrigin(
        { x: 10, y: 10 },
        [{ x: Number.NaN, y: 0, width: 100, height: 80 }],
        [vizRect],
      ),
    ).toBe("other");
    expect(
      classifyOrigin(
        { x: 10, y: 10 },
        [{ x: Number.POSITIVE_INFINITY, y: 0, width: 50, height: 50 }, codeRect],
        [],
      ),
    ).toBe("code");
  });
});

describe("filterHitByOrigin", () => {
  it("U2 code keeps only code targets and recomputes mode; all non-code → empty single", () => {
    const mixed = {
      mode: "region" as const,
      targets: [
        target("sub", "subtitle"),
        target("code-a", "code"),
        target("viz", "viz"),
        target("step", "step"),
        target("code-b", "code"),
        target("handout", "handout"),
      ],
    };
    expect(filterHitByOrigin(mixed, "code")).toEqual({
      mode: "region",
      targets: [target("code-a", "code"), target("code-b", "code")],
    });

    const oneCode = {
      mode: "region" as const,
      targets: [target("viz", "viz"), target("code-a", "code")],
    };
    expect(filterHitByOrigin(oneCode, "code")).toEqual({
      mode: "single",
      targets: [target("code-a", "code")],
    });

    const noCode = {
      mode: "region" as const,
      targets: [target("viz", "viz"), target("step", "step")],
    };
    expect(filterHitByOrigin(noCode, "code")).toEqual({ mode: "single", targets: [] });
  });

  it("U3 viz and other return the same hit", () => {
    const hit = {
      mode: "region" as const,
      targets: [target("code-a", "code"), target("viz", "viz")],
    };
    expect(filterHitByOrigin(hit, "viz")).toBe(hit);
    expect(filterHitByOrigin(hit, "other")).toBe(hit);
  });
});

describe("targetsMax prefilter", () => {
  it("U4 viz candidates listed before the only code candidate do not squeeze code out when filtered first", () => {
    const box: AskBBox = { x: 0, y: 0, width: 1000, height: 100 };
    const vizFirst: AskCandidate[] = [];
    for (let i = 0; i < ASK_LIMITS.targetsMax; i += 1) {
      vizFirst.push(candidate(`viz-${i}`, { x: i * 10, y: 0, width: 30, height: 30 }, "viz"));
    }
    vizFirst.push(candidate("code-last", { x: 0, y: 0, width: 40, height: 40 }, "code"));

    const unfiltered = hitTest(box, vizFirst);
    expect(unfiltered.targets.some((item) => item.kind === "code")).toBe(false);
    expect(unfiltered.targets).toHaveLength(ASK_LIMITS.targetsMax);

    const filtered = hitTest(
      box,
      vizFirst.filter((item) => item.target.kind === "code"),
    );
    expect(filtered).toEqual({ mode: "single", targets: [target("code-last", "code")] });
  });
});

describe("codeCaptureBox", () => {
  it("partial overlap, box fully inside code, no overlap → null, two code rects", () => {
    expect(codeCaptureBox({ x: 50, y: 20, width: 100, height: 40 }, [codeRect])).toEqual({
      x: 50,
      y: 20,
      width: 50,
      height: 40,
    });

    expect(codeCaptureBox({ x: 10, y: 10, width: 20, height: 20 }, [codeRect])).toEqual({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    });

    expect(codeCaptureBox({ x: 200, y: 200, width: 30, height: 30 }, [codeRect])).toBeNull();
    expect(codeCaptureBox({ x: 100, y: 0, width: 20, height: 20 }, [codeRect])).toBeNull();

    const left: AskBBox = { x: 0, y: 0, width: 40, height: 40 };
    const right: AskBBox = { x: 80, y: 10, width: 40, height: 30 };
    expect(codeCaptureBox({ x: 20, y: 0, width: 80, height: 50 }, [left, right])).toEqual({
      x: 20,
      y: 0,
      width: 80,
      height: 40,
    });

    // A negative drawn box is normalized before intersecting.
    expect(codeCaptureBox({ x: 150, y: 60, width: -100, height: -40 }, [codeRect])).toEqual({
      x: 50,
      y: 20,
      width: 50,
      height: 40,
    });
    expect(
      codeCaptureBox({ x: 10, y: 10, width: 20, height: 20 }, [{ x: Number.NaN, y: 0, width: 100, height: 80 }]),
    ).toBeNull();
  });
});

describe("resolveCaptureSelection", () => {
  it("replaces bbox with captureBBox when present and returns the same selection otherwise", () => {
    const plain = {
      bbox: { x: 0, y: 0, width: 200, height: 100 },
      targets: [target("code-a", "code")],
    };
    expect(resolveCaptureSelection(plain)).toBe(plain);

    const cropped = {
      ...plain,
      captureBBox: { x: 10, y: 10, width: 40, height: 30 },
    };
    const resolved = resolveCaptureSelection(cropped);
    expect(resolved.bbox).toEqual(cropped.captureBBox);
    expect(resolved.targets).toBe(cropped.targets);
    expect(cropped.bbox).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

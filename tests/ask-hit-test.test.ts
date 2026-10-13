import { describe, it, expect } from "vitest";
import { ASK_LIMITS } from "@/lib/ask/types";
import type { AskBBox, AskCandidate, AskTarget } from "@/lib/ask/types";
import { expandToMinTouch, hitTest, hitTestPoint, intersects, normalizeBBox } from "@/lib/ask/hit-test";

function target(id: string, kind: AskTarget["kind"] = "code"): AskTarget {
  return { kind, id };
}

function candidate(id: string, rect: AskBBox, kind: AskTarget["kind"] = "code"): AskCandidate {
  return { target: target(id, kind), rect };
}

describe("ask hit-test", () => {
  it("1. 负宽高选框与正向等价", () => {
    const forward = { x: 10, y: 20, width: 40, height: 30 };
    const flipped = { x: 50, y: 50, width: -40, height: -30 };
    expect(normalizeBBox(flipped)).toEqual(forward);
    expect(normalizeBBox({ x: 0, y: 5, width: -10, height: 8 })).toEqual({ x: -10, y: 5, width: 10, height: 8 });
    expect(normalizeBBox({ x: 3, y: 9, width: 4, height: -6 })).toEqual({ x: 3, y: 3, width: 4, height: 6 });

    const candidates = [candidate("a", { x: 10, y: 20, width: 40, height: 30 })];
    expect(hitTest(flipped, candidates)).toEqual(hitTest(forward, candidates));
    expect(hitTest({ x: 0, y: 0, width: -4, height: 20 }, candidates).mode).toBe("single");
  });

  it("2. 贴边（overlap=0）不命中；重叠 1px 命中", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const touchingRight = { x: 10, y: 0, width: 10, height: 10 };
    const touchingBottom = { x: 0, y: 10, width: 10, height: 10 };
    const overlap = { x: 9, y: 0, width: 10, height: 10 };
    expect(intersects(box, touchingRight)).toBe(false);
    expect(intersects(box, touchingBottom)).toBe(false);
    expect(intersects(touchingRight, box)).toBe(false);
    expect(intersects(box, overlap)).toBe(true);

    const miss = hitTest(box, [candidate("edge", touchingRight)]);
    expect(miss).toEqual({ mode: "single", targets: [] });
    const hit = hitTest(box, [candidate("overlap", overlap)]);
    expect(hit.mode).toBe("single");
    expect(hit.targets.map((item) => item.id)).toEqual(["overlap"]);
  });

  it("3. 小于 8px 的框按点处理", () => {
    const wide = candidate("wide", { x: 0, y: 0, width: 100, height: 100 }, "step");
    const small = candidate("small", { x: 40, y: 40, width: 20, height: 20 }, "code");
    // Center (50, 50) sits inside `small`. A region drag would also cover `wide`.
    const thin = { x: 48, y: 0, width: 4, height: 100 };
    expect(thin.width).toBeLessThan(ASK_LIMITS.dragThresholdPx);
    const result = hitTest(thin, [wide, small]);
    expect(result).toEqual({ mode: "single", targets: [small.target] });

    const short = { x: 0, y: 48, width: 100, height: 4 };
    expect(short.height).toBeLessThan(ASK_LIMITS.dragThresholdPx);
    expect(hitTest(short, [wide, small]).targets.map((item) => item.id)).toEqual(["small"]);

    // Shorter than the drag threshold, so the gap between two targets is a miss
    // even though the box overlaps both rects.
    const both = [
      candidate("left", { x: 0, y: 0, width: 40, height: 80 }),
      candidate("right", { x: 60, y: 0, width: 40, height: 80 }),
    ];
    expect(hitTest({ x: 0, y: 30, width: 100, height: 4 }, both).targets).toEqual([]);
  });

  it("4. 点在 rect 左/上边命中，右/下边不命中", () => {
    // Both sides are already ≥ minTouchPx, so this checks the half-open edge rule.
    const rect = { x: 10, y: 20, width: 50, height: 60 };
    const candidates = [candidate("box", rect)];
    expect(hitTestPoint(10, 20, candidates).targets.map((item) => item.id)).toEqual(["box"]);
    expect(hitTestPoint(10, 79, candidates).targets.map((item) => item.id)).toEqual(["box"]);
    expect(hitTestPoint(59, 20, candidates).targets.map((item) => item.id)).toEqual(["box"]);
    expect(hitTestPoint(60, 30, candidates).targets).toEqual([]);
    expect(hitTestPoint(20, 80, candidates).targets).toEqual([]);
    expect(hitTestPoint(60, 80, candidates).targets).toEqual([]);
  });

  it("5. 嵌套目标（step 里含 code）点按取面积最小的 code", () => {
    const step = candidate("step", { x: 0, y: 0, width: 200, height: 200 }, "step");
    const code = candidate("code", { x: 40, y: 40, width: 20, height: 20 }, "code");
    const viz = candidate("viz", { x: 30, y: 30, width: 80, height: 80 }, "viz");
    const result = hitTestPoint(50, 50, [step, viz, code]);
    expect(result).toEqual({ mode: "single", targets: [code.target] });

    // Equal area: the first candidate in order wins.
    const first = candidate("first", { x: 0, y: 0, width: 10, height: 10 });
    const second = candidate("second", { x: 0, y: 0, width: 10, height: 10 });
    expect(hitTestPoint(1, 1, [first, second]).targets.map((item) => item.id)).toEqual(["first"]);
  });

  it("6. 20×20 小目标：外 10px 命中，外 13px 不命中", () => {
    // Expanded to 44 → 12px margin on each side. 10px is inside, 13px is outside.
    const small = candidate("chip", { x: 100, y: 100, width: 20, height: 20 });
    expect(expandToMinTouch(small.rect)).toEqual({ x: 88, y: 88, width: 44, height: 44 });

    const inside = hitTestPoint(100 - 10, 110, [small]);
    expect(inside.targets.map((item) => item.id)).toEqual(["chip"]);

    const outside = hitTestPoint(100 - 13, 110, [small]);
    expect(outside).toEqual({ mode: "single", targets: [] });

    // Just inside the expanded right edge (half-open): right = 88 + 44 = 132.
    expect(hitTestPoint(131.9, 110, [small]).targets.map((item) => item.id)).toEqual(["chip"]);
    expect(hitTestPoint(132, 110, [small]).targets).toEqual([]);
  });

  it("7. 多命中 → region，顺序稳定，重复 id 去重，超过 20 截断", () => {
    const box = { x: 0, y: 0, width: 1000, height: 100 };
    const candidates: AskCandidate[] = [];
    for (let i = 0; i < 25; i += 1) {
      candidates.push(candidate(`t${i}`, { x: i * 10, y: 0, width: 30, height: 30 }));
    }
    // A repeat of t0 while the result is still under the cap is dropped.
    candidates.splice(2, 0, candidate("t0", { x: 0, y: 0, width: 30, height: 30 }));
    // Duplicate of t0 after the cap, plus one that only touches an edge.
    candidates.push(candidate("t0", { x: 0, y: 0, width: 30, height: 30 }));
    candidates.push(candidate("edge", { x: 1000, y: 0, width: 30, height: 30 }));
    // Non-finite rect is skipped and does not throw.
    candidates.splice(3, 0, candidate("bad", { x: Number.NaN, y: 0, width: 30, height: 30 }));

    const result = hitTest(box, candidates);
    expect(result.mode).toBe("region");
    expect(result.targets).toHaveLength(ASK_LIMITS.targetsMax);
    expect(result.targets.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${i}`),
    );
    expect(result.targets.filter((item) => item.id === "t0")).toHaveLength(1);

    // Negative candidate rects are normalized before the intersection test.
    // A repeat of an id that was dropped by the cap is still skipped.
    const capped = hitTest(box, [
      ...Array.from({ length: 20 }, (_, i) => candidate(`k${i}`, { x: i * 10, y: 0, width: 20, height: 20 })),
      candidate("k0", { x: 0, y: 0, width: 20, height: 20 }),
      candidate("extra", { x: 0, y: 0, width: 20, height: 20 }),
    ]);
    expect(capped.targets.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `k${i}`),
    );

    const flipped = hitTest(box, [
      candidate("neg", { x: 40, y: 40, width: -20, height: -20 }),
      candidate("pos", { x: 50, y: 0, width: 20, height: 20 }),
    ]);
    expect(flipped.mode).toBe("region");
    expect(flipped.targets.map((item) => item.id)).toEqual(["neg", "pos"]);
  });

  it("8. 空 candidates / 空白区 → single + []", () => {
    const box = { x: 0, y: 0, width: 40, height: 40 };
    expect(hitTest(box, [])).toEqual({ mode: "single", targets: [] });
    expect(hitTestPoint(5, 5, [])).toEqual({ mode: "single", targets: [] });
    const far = [candidate("far", { x: 500, y: 500, width: 10, height: 10 })];
    expect(hitTest(box, far)).toEqual({ mode: "single", targets: [] });
    expect(hitTestPoint(0, 0, far)).toEqual({ mode: "single", targets: [] });
  });

  it("9. NaN/Infinity 坐标不抛异常，返回空", () => {
    const candidates = [candidate("ok", { x: 0, y: 0, width: 50, height: 50 })];
    const bad: AskBBox[] = [
      { x: Number.NaN, y: 0, width: 20, height: 20 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 20, height: 20 },
      { x: 0, y: 0, width: Number.NEGATIVE_INFINITY, height: 20 },
      { x: 0, y: 0, width: 20, height: Number.NaN },
    ];
    for (const bbox of bad) {
      expect(hitTest(bbox, candidates)).toEqual({ mode: "single", targets: [] });
    }
    expect(hitTestPoint(Number.NaN, 10, candidates)).toEqual({ mode: "single", targets: [] });
    expect(hitTestPoint(10, Number.POSITIVE_INFINITY, candidates)).toEqual({ mode: "single", targets: [] });
    expect(hitTestPoint(Number.NEGATIVE_INFINITY, Number.NaN, candidates)).toEqual({ mode: "single", targets: [] });

    const poisoned = [
      candidate("nan", { x: Number.NaN, y: 0, width: 10, height: 10 }),
      candidate("inf", { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 }),
    ];
    expect(hitTestPoint(1, 1, poisoned)).toEqual({ mode: "single", targets: [] });
    expect(hitTest({ x: 0, y: 0, width: 100, height: 100 }, poisoned)).toEqual({ mode: "single", targets: [] });
  });

  it("normalizeBBox / expandToMinTouch / intersects 边界", () => {
    expect(normalizeBBox({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(normalizeBBox({ x: 8, y: 8, width: 0, height: 0 })).toEqual({ x: 8, y: 8, width: 0, height: 0 });

    const already = { x: 0, y: 0, width: 50, height: 60 };
    expect(expandToMinTouch(already)).toEqual(already);
    expect(expandToMinTouch(already, 80)).toEqual({ x: -15, y: -10, width: 80, height: 80 });
    // Only the short side grows, around its own center.
    expect(expandToMinTouch({ x: 10, y: 10, width: 10, height: 50 }, 20)).toEqual({
      x: 5, y: 10, width: 20, height: 50,
    });
    // Negative input is normalized before expansion.
    expect(expandToMinTouch({ x: 30, y: 40, width: -10, height: -8 }, 20)).toEqual({
      x: 15, y: 26, width: 20, height: 20,
    });

    expect(intersects(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 10, width: 5, height: 5 },
    )).toBe(false);
    expect(intersects(
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 10 },
    )).toBe(false);

    // Expanded-hit tie: equal center distance keeps the first candidate.
    const left = candidate("left", { x: 0, y: 10, width: 2, height: 2 });
    const right = candidate("right", { x: 20, y: 10, width: 2, height: 2 });
    expect(hitTestPoint(11, 11, [left, right]).targets.map((item) => item.id)).toEqual(["left"]);
    expect(hitTestPoint(11, 11, [right, left]).targets.map((item) => item.id)).toEqual(["right"]);
  });
});

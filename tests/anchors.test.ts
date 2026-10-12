import { afterEach, expect, test, vi } from "vitest";
import { registerCodeLineResolver, resolveAnchor } from "../lib/anchors";

afterEach(() => {
  registerCodeLineResolver(null);
  vi.unstubAllGlobals();
});

test("code anchors resolve line ranges and fall back safely without an editor or DOM", () => {
  const rect = { x: 10, y: 20, width: 300, height: 40 } as DOMRect;
  const resolver = vi.fn(() => rect);
  registerCodeLineResolver(resolver);
  expect(resolveAnchor({ kind: "code-line", start: 2, end: 4 })).toBe(rect);
  expect(resolver).toHaveBeenLastCalledWith(2, 4);
  resolveAnchor({ kind: "code-line", start: 3 });
  expect(resolver).toHaveBeenLastCalledWith(3, 3);
  expect(resolveAnchor({ kind: "code-token", line: 5, match: "seen" })).toBe(rect);
  expect(resolver).toHaveBeenLastCalledWith(5, 5);
  registerCodeLineResolver(() => null);
  expect(resolveAnchor({ kind: "code-line", start: 99 })).toMatchObject({ width: 0, height: 0 });
  registerCodeLineResolver(null);
  expect(resolveAnchor({ kind: "code-token", line: 1, match: "missing" })).toMatchObject({ x: 0, y: 0 });
});

test("statement, visualization and DOM anchors use viewport rectangles and tolerate missing elements", () => {
  class Rect { constructor(public x: number, public y: number, public width: number, public height: number) {} }
  vi.stubGlobal("DOMRect", Rect);
  const rect = new Rect(40, 80, 120, 24);
  const querySelector = vi.fn((selector: string) => selector === "#missing" ? null : { getBoundingClientRect: () => rect });
  vi.stubGlobal("document", { querySelector });
  expect(resolveAnchor({ kind: "statement", blockId: "intro" })).toBe(rect);
  expect(querySelector).toHaveBeenLastCalledWith('[data-statement="intro"]');
  expect(resolveAnchor({ kind: "viz-node", nodeId: "a0" })).toBe(rect);
  expect(querySelector).toHaveBeenLastCalledWith('[data-viz-node="a0"]');
  expect(resolveAnchor({ kind: "dom", selector: "#board" })).toBe(rect);
  expect(querySelector).toHaveBeenLastCalledWith("#board");
  expect(resolveAnchor({ kind: "dom", selector: "#missing" })).toEqual(new Rect(0, 0, 0, 0));
  querySelector.mockReturnValue(null);
  expect(resolveAnchor({ kind: "statement", blockId: "missing" })).toEqual(new Rect(0, 0, 0, 0));
  expect(resolveAnchor({ kind: "viz-node", nodeId: "missing" })).toEqual(new Rect(0, 0, 0, 0));
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AskStatusRow } from "../components/board/ask-status-row";
import { ASK_CAPTURE_PREPARING, ASK_WAITING_STATUS } from "../lib/ask/ask-ui-text";

const HEIGHT_CLASS = "min-h-12 text-xs leading-6 text-chalk-300 md:min-h-6";
const TRUNCATION = [
  "truncate",
  "overflow-hidden",
  "whitespace-nowrap",
  "text-ellipsis",
  "overflow-y-hidden",
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(state: "idle" | "preparing" | "waiting", seconds = 0) {
  await act(async () => {
    root.render(createElement(AskStatusRow, { state, seconds }));
  });
}

function row(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-ask-status-row]");
  if (!el) throw new Error("status row missing");
  return el;
}

function expectMinHeight(el: HTMLElement) {
  expect(el.className).toContain("min-h-12");
  expect(el.className).toContain("md:min-h-6");
  expect(el.className).toContain("leading-6");
  expect(el.classList.contains("h-12")).toBe(false);
  expect(el.classList.contains("md:h-6")).toBe(false);
  expect(el.className).not.toMatch(/\bline-clamp-/);
  for (const name of TRUNCATION) {
    expect(el.classList.contains(name)).toBe(false);
  }
}

describe("AskStatusRow", () => {
  test("idle, preparing, and waiting share one element and the same minimum-height classes", async () => {
    await render("idle");
    const idle = row();
    expect(container.querySelectorAll("[data-ask-status-row]")).toHaveLength(1);
    expect(idle.tagName).toBe("P");
    expect(idle.className).toBe(`${HEIGHT_CLASS} invisible`);
    expectMinHeight(idle);
    expect(idle.getAttribute("aria-hidden")).toBe("true");
    expect(idle.hasAttribute("data-ask-capture-preparing")).toBe(false);
    expect(idle.hasAttribute("data-ask-waiting")).toBe(false);
    expect(idle.hasAttribute("data-ask-capture-exclude")).toBe(false);
    expect(idle.textContent).toBe("\u00a0");

    await render("preparing");
    const preparing = row();
    expect(container.querySelectorAll("[data-ask-status-row]")).toHaveLength(1);
    expect(preparing.tagName).toBe(idle.tagName);
    expect(preparing.className).toBe(HEIGHT_CLASS);
    expectMinHeight(preparing);
    expect(preparing.hasAttribute("aria-hidden")).toBe(false);
    expect(preparing.hasAttribute("data-ask-capture-preparing")).toBe(true);
    expect(preparing.hasAttribute("data-ask-capture-exclude")).toBe(true);
    expect(preparing.hasAttribute("data-ask-waiting")).toBe(false);
    expect(preparing.textContent).toBe(ASK_CAPTURE_PREPARING);

    await render("waiting", 7);
    const waiting = row();
    expect(container.querySelectorAll("[data-ask-status-row]")).toHaveLength(1);
    expect(waiting.tagName).toBe(idle.tagName);
    expect(waiting.className).toBe(HEIGHT_CLASS);
    expectMinHeight(waiting);
    expect(waiting.hasAttribute("aria-hidden")).toBe(false);
    expect(waiting.hasAttribute("data-ask-waiting")).toBe(true);
    expect(waiting.hasAttribute("data-ask-capture-exclude")).toBe(true);
    expect(waiting.hasAttribute("data-ask-capture-preparing")).toBe(false);
    expect(waiting.textContent).toBe(ASK_WAITING_STATUS(7));
  });
});

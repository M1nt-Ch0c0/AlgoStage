// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { isTypingTarget } from "../lib/player/keyboard";

test("isTypingTarget regression", () => {
  // null
  expect(isTypingTarget(null)).toBe(false);

  // non-Element
  expect(isTypingTarget(window)).toBe(false);
  expect(isTypingTarget(document)).toBe(false);
  const textNode = document.createTextNode("text");
  expect(isTypingTarget(textNode)).toBe(false);

  // INPUT, TEXTAREA, SELECT
  expect(isTypingTarget(document.createElement("input"))).toBe(true);
  expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
  expect(isTypingTarget(document.createElement("select"))).toBe(true);

  // contenteditable=true and empty-string attr ancestor
  const ceTrueParent = document.createElement("div");
  ceTrueParent.setAttribute("contenteditable", "true");
  const ceTrueChild = document.createElement("span");
  ceTrueParent.appendChild(ceTrueChild);
  document.body.appendChild(ceTrueParent);

  expect(isTypingTarget(ceTrueParent)).toBe(true);
  expect(isTypingTarget(ceTrueChild)).toBe(true);

  const ceEmptyParent = document.createElement("div");
  ceEmptyParent.setAttribute("contenteditable", "");
  const ceEmptyChild = document.createElement("p");
  ceEmptyParent.appendChild(ceEmptyChild);
  document.body.appendChild(ceEmptyParent);

  expect(isTypingTarget(ceEmptyParent)).toBe(true);
  expect(isTypingTarget(ceEmptyChild)).toBe(true);

  // .monaco-editor descendant
  const monaco = document.createElement("div");
  monaco.className = "monaco-editor";
  const monacoChild = document.createElement("span");
  monaco.appendChild(monacoChild);
  document.body.appendChild(monaco);

  expect(isTypingTarget(monacoChild)).toBe(true);

  // plain div false
  expect(isTypingTarget(document.createElement("div"))).toBe(false);

  // button false
  expect(isTypingTarget(document.createElement("button"))).toBe(false);

  ceTrueParent.remove();
  ceEmptyParent.remove();
  monaco.remove();
});

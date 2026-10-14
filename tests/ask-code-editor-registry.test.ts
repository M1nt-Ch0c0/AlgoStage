// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodeEditorHandle,
  getAskCodeMissNotice,
  getCodeEditorHandle,
  registerCodeEditor,
  resetCodeEditorRegistry,
  setAskCodeMissNotice,
  subscribeAskCodeMissNotice,
} from "@/lib/ask/code-editor-registry";

function createMockHandle(): CodeEditorHandle {
  return {
    getLineRangeForClientBox: vi.fn(() => ({ startLine: 1, endLine: 5 })),
    getLinesText: vi.fn(() => "line 1\nline 2"),
    getFullText: vi.fn(() => "full code"),
  };
}

describe("code-editor-registry", () => {
  afterEach(() => {
    resetCodeEditorRegistry();
    document.body.innerHTML = "";
  });

  describe("editor registration and lookup", () => {
    it("registers and retrieves handle by element and its descendants", () => {
      const container = document.createElement("div");
      const child = document.createElement("span");
      container.appendChild(child);
      document.body.appendChild(container);

      const handle = createMockHandle();
      const unregister = registerCodeEditor(container, handle);

      expect(getCodeEditorHandle(container)).toBe(handle);
      expect(getCodeEditorHandle(child)).toBe(handle);

      const outside = document.createElement("div");
      expect(getCodeEditorHandle(outside)).toBeUndefined();

      unregister();
      expect(getCodeEditorHandle(container)).toBeUndefined();
      expect(getCodeEditorHandle(child)).toBeUndefined();
    });

    it("clears all handles on resetCodeEditorRegistry", () => {
      const el1 = document.createElement("div");
      const el2 = document.createElement("div");
      const handle1 = createMockHandle();
      const handle2 = createMockHandle();

      registerCodeEditor(el1, handle1);
      registerCodeEditor(el2, handle2);
      expect(getCodeEditorHandle(el1)).toBe(handle1);
      expect(getCodeEditorHandle(el2)).toBe(handle2);

      resetCodeEditorRegistry();
      expect(getCodeEditorHandle(el1)).toBeUndefined();
      expect(getCodeEditorHandle(el2)).toBeUndefined();
    });
  });

  describe("notice store", () => {
    it("initial notice is null", () => {
      expect(getAskCodeMissNotice()).toBeNull();
    });

    it("notifies subscribers when notice changes", () => {
      const listener = vi.fn();
      const unsub = subscribeAskCodeMissNotice(listener);

      setAskCodeMissNotice("code miss hint");
      expect(getAskCodeMissNotice()).toBe("code miss hint");
      expect(listener).toHaveBeenCalledTimes(1);

      // Same value should not re-trigger
      setAskCodeMissNotice("code miss hint");
      expect(listener).toHaveBeenCalledTimes(1);

      // Change value
      setAskCodeMissNotice("another hint");
      expect(getAskCodeMissNotice()).toBe("another hint");
      expect(listener).toHaveBeenCalledTimes(2);

      // Unsubscribe
      unsub();
      setAskCodeMissNotice(null);
      expect(getAskCodeMissNotice()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("resets notice on resetCodeEditorRegistry", () => {
      const listener = vi.fn();
      subscribeAskCodeMissNotice(listener);

      setAskCodeMissNotice("hint");
      expect(getAskCodeMissNotice()).toBe("hint");

      resetCodeEditorRegistry();
      expect(getAskCodeMissNotice()).toBeNull();

      // Old listeners should be cleared
      setAskCodeMissNotice("new hint");
      expect(listener).toHaveBeenCalledTimes(1); // Only the first call before reset
    });
  });
});

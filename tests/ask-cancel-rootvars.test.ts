// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AskPlayerBarVar, { syncAskPlayerBarHeight } from "../components/board/ask-player-bar-var";
import AskSelectionLayer, { computeBottomOcclusion } from "../components/board/ask-selection-layer";
import { finishAskCancelSync } from "../lib/ask/ask-cancel";
import { invalidateAskMeasureCache, sharedAskMeasureCache } from "../lib/ask/ask-occlusion";
import { setAskOpenSource } from "../lib/ask/ask-open-source";
import { usePlayerStore } from "../lib/player/store";
import type { TeachingScript } from "../lib/teaching/types";

const script: TeachingScript = {
  problemSlug: "3sum",
  mode: "lecture",
  language: "zh",
  solutionLanguage: "typescript",
  steps: [{ id: "s1", narration: "第一步讲解。", targets: [], effects: [] }],
};

const ROOT_VARS = ["--ask-player-bar-h", "--ask-bottom-bar-h", "--ask-bottom-occlusion"] as const;

function domRect(x: number, y: number, width: number, height: number): DOMRect {
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

function mobileMatchMedia() {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 639px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/** Hold requestAnimationFrame so a commit can be observed before the frame runs. */
function holdAnimationFrames() {
  const queued: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    queued.push(callback);
    return queued.length;
  });
  return {
    pending: () => queued.length,
    async flush() {
      const batch = queued.splice(0, queued.length);
      await act(async () => {
        for (const callback of batch) callback(performance.now());
      });
    },
    restore() {
      raf.mockRestore();
    },
  };
}

let root: Root;
let container: HTMLDivElement;
let stage: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invalidateAskMeasureCache(sharedAskMeasureCache);
  setAskOpenSource(null);
  usePlayerStore.getState().reset();
  usePlayerStore.getState().loadScript(script);
  document.documentElement.style.removeProperty("--ask-player-bar-h");
  document.documentElement.style.removeProperty("--ask-bottom-bar-h");
  document.documentElement.style.removeProperty("--ask-bottom-occlusion");

  stage = document.createElement("div");
  stage.setAttribute("data-ask-stage", "");
  stage.getBoundingClientRect = () => domRect(0, 0, 390, 300);
  stage.innerHTML = `
    <p data-ask-target="subtitle" data-ask-id="subtitle:s1" data-ask-step-id="s1">字幕内容</p>
  `;
  const subtitle = stage.querySelector<HTMLElement>("[data-ask-target]")!;
  subtitle.getBoundingClientRect = () => domRect(10, 10, 60, 30);
  document.body.append(stage);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  invalidateAskMeasureCache(sharedAskMeasureCache);
  setAskOpenSource(null);
  usePlayerStore.getState().reset();
  container.remove();
  stage.remove();
  document.documentElement.style.removeProperty("--ask-player-bar-h");
  document.documentElement.style.removeProperty("--ask-bottom-bar-h");
  document.documentElement.style.removeProperty("--ask-bottom-occlusion");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AskPlayerBarVar open/closed writes", () => {
  const originalMatchMedia = window.matchMedia;
  let playerEl: HTMLDivElement;
  let frames: ReturnType<typeof holdAnimationFrames>;

  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    window.matchMedia = mobileMatchMedia();
    playerEl = document.createElement("div");
    playerEl.setAttribute("aria-label", "讲解播放区");
    playerEl.getBoundingClientRect = () => domRect(0, 682, 390, 162);
    document.body.appendChild(playerEl);
    frames = holdAnimationFrames();
  });

  afterEach(() => {
    frames.restore();
    playerEl.remove();
    window.matchMedia = originalMatchMedia;
  });

  async function renderBar() {
    usePlayerStore.setState({ askPhase: "idle" });
    await act(async () => {
      root.render(createElement(AskPlayerBarVar));
    });
  }

  function playerVar() {
    return document.documentElement.style.getPropertyValue("--ask-player-bar-h");
  }

  test("idle to selecting writes --ask-player-bar-h synchronously", async () => {
    await renderBar();
    expect(playerVar()).toBe("0px");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });

    expect(playerVar()).toBe("162px");
    expect(frames.pending()).toBe(0);
  });

  test("open phase changes do not write --ask-player-bar-h or rebind listeners", async () => {
    await renderBar();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    expect(playerVar()).toBe("162px");

    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    const addEventListener = vi.spyOn(window, "addEventListener");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "sending" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });

    const playerWrites = setProperty.mock.calls.filter((call) => call[0] === "--ask-player-bar-h");
    expect(playerWrites).toEqual([]);
    expect(addEventListener).not.toHaveBeenCalled();
    expect(playerVar()).toBe("162px");

    setProperty.mockRestore();
    addEventListener.mockRestore();
  });

  test("open to idle writes 0px, and unmount writes 0px", async () => {
    await renderBar();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    expect(playerVar()).toBe("162px");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "idle" });
    });
    expect(playerVar()).toBe("0px");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    expect(playerVar()).toBe("162px");

    await act(async () => {
      root.unmount();
    });
    expect(playerVar()).toBe("0px");
  });

  test("an unchanged height does not call setProperty", async () => {
    await renderBar();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting" });
    });
    expect(playerVar()).toBe("162px");

    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    syncAskPlayerBarHeight();
    const playerWrites = setProperty.mock.calls.filter((call) => call[0] === "--ask-player-bar-h");
    expect(playerWrites).toEqual([]);
    expect(playerVar()).toBe("162px");
    setProperty.mockRestore();
  });
});

describe("cancel root vars", () => {
  const originalMatchMedia = window.matchMedia;
  const originalViewport = window.visualViewport;
  let playerHeight = 164;
  let barHeight = 60;
  let viewportHeight = 844;
  let viewportListeners: Set<() => void>;
  let frames: ReturnType<typeof holdAnimationFrames>;
  const selection = {
    mode: "region" as const,
    bbox: { x: 10, y: 10, width: 60, height: 30 },
    targets: [{ kind: "subtitle" as const, id: "subtitle:s1", stepId: "s1", text: "字幕内容" }],
  };

  function installViewport() {
    viewportListeners = new Set();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        get height() {
          return viewportHeight;
        },
        addEventListener: (_type: string, fn: () => void) => {
          viewportListeners.add(fn);
        },
        removeEventListener: (_type: string, fn: () => void) => {
          viewportListeners.delete(fn);
        },
        dispatchEvent(event: Event) {
          if (event.type !== "resize") return true;
          for (const listener of viewportListeners) listener();
          return true;
        },
      },
    });
  }

  beforeEach(() => {
    playerHeight = 164;
    barHeight = 60;
    viewportHeight = 844;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    window.matchMedia = mobileMatchMedia();
    installViewport();
    frames = holdAnimationFrames();

    const playerEl = document.createElement("div");
    playerEl.setAttribute("aria-label", "讲解播放区");
    playerEl.getBoundingClientRect = () => domRect(0, 844 - playerHeight, 390, playerHeight);
    document.body.appendChild(playerEl);

    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("aria-label") === "讲解播放区") return domRect(0, 844 - playerHeight, 390, playerHeight);
      if (this.hasAttribute("data-ask-bottom-bar")) return domRect(8, 844 - barHeight, 374, barHeight);
      if (this.hasAttribute("data-ask-panel")) return domRect(8, 400, 374, 200);
      if (this.hasAttribute("data-ask-selection")) return domRect(10, 10, 60, 30);
      return originalRect.call(this);
    });
  });

  afterEach(() => {
    frames.restore();
    document.querySelector('[aria-label="讲解播放区"]')?.remove();
    document.querySelector("[data-ask-panel]")?.remove();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: originalViewport });
    window.matchMedia = originalMatchMedia;
  });

  /** A measurement can observe a new node and queue one more frame. Drain those. */
  async function settle() {
    for (let i = 0; i < 6 && frames.pending() > 0; i++) await frames.flush();
    expect(frames.pending()).toBe(0);
  }

  async function renderLayer() {
    usePlayerStore.setState({ askPhase: "selecting", selection, status: "interrupted" });
    await act(async () => {
      root.render(createElement(AskSelectionLayer, { stage }));
    });
  }

  function rootVarWrites(calls: unknown[][]) {
    return calls.filter((call) => ROOT_VARS.includes(call[0] as (typeof ROOT_VARS)[number]));
  }

  test("drafting to selecting writes cached bottom vars before focus, with no layout read in the commit", async () => {
    await renderLayer();
    await settle();

    const expectedOcclusion = `${computeBottomOcclusion({
      playerHeight,
      barHeight,
      panelHeight: 0,
    })}px`;
    expect(expectedOcclusion).toBe("232px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("60px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(expectedOcclusion);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    const panel = document.createElement("div");
    panel.setAttribute("data-ask-panel", "");
    document.body.append(panel);
    await settle();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");

    const order: string[] = [];
    const rawSetProperty = CSSStyleDeclaration.prototype.setProperty;
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      property: string,
      value: string | null,
      priority?: string,
    ) {
      if (ROOT_VARS.includes(property as (typeof ROOT_VARS)[number]) && this === document.documentElement.style) {
        order.push(`write:${property}`);
      }
      return rawSetProperty.call(this, property, value, priority);
    });
    const rawFocus = HTMLElement.prototype.focus;
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      order.push("focus");
      return rawFocus.call(this, options);
    });
    const rect = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    rect.mockClear();
    let innerHeightReads = 0;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      get() {
        innerHeightReads += 1;
        return 844;
      },
    });

    panel.remove();
    await act(async () => {
      finishAskCancelSync(null, () => {
        usePlayerStore.setState({ askPhase: "selecting", selection });
      });
    });

    const chip = document.activeElement as HTMLElement | null;
    expect(chip?.hasAttribute("data-ask-shortcut")).toBe(true);
    expect(chip?.tabIndex).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(expectedOcclusion);
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe(`${barHeight}px`);

    const writeAt = order.findIndex((entry) => entry.startsWith("write:"));
    const focusAt = order.indexOf("focus");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(focusAt).toBeGreaterThan(writeAt);
    expect(order.filter((entry) => entry.startsWith("write:"))).toEqual([
      "write:--ask-bottom-bar-h",
      "write:--ask-bottom-occlusion",
    ]);
    expect(rect).not.toHaveBeenCalled();
    expect(innerHeightReads).toBe(0);
    expect(frames.pending()).toBeGreaterThan(0);

    setProperty.mockRestore();
    focus.mockRestore();
    panel.remove();
  });

  test("a second identical cancel writes none of the three root vars", async () => {
    await renderLayer();
    await settle();

    async function cancelOnce() {
      await act(async () => {
        usePlayerStore.setState({ askPhase: "drafting" });
      });
      await settle();
      await act(async () => {
        usePlayerStore.setState({ askPhase: "selecting", selection });
      });
      await settle();
    }

    await cancelOnce();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("60px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("232px");
    expect(frames.pending()).toBe(0);

    // Drafting's measurement frame is left queued so the inline selecting
    // values are still in place. The cancel commit and the coalesced rAF
    // then both see the same cached heights and write nothing.
    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", selection });
    });
    await frames.flush();

    expect(rootVarWrites(setProperty.mock.calls)).toEqual([]);
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("60px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("232px");
    setProperty.mockRestore();
  });

  test("resize, visualViewport resize, and orientationchange refresh the cache used by the next cancel", async () => {
    await renderLayer();
    await settle();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("232px");

    playerHeight = 140;
    barHeight = 48;
    const fresh = `${computeBottomOcclusion({ playerHeight, barHeight, panelHeight: 0 })}px`;
    expect(fresh).toBe("196px");

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(frames.pending()).toBeGreaterThan(0);
    await settle();

    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await settle();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", selection });
    });
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("48px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(fresh);
    await frames.flush();

    playerHeight = 150;
    barHeight = 40;
    const afterViewport = `${computeBottomOcclusion({ playerHeight, barHeight, panelHeight: 0 })}px`;
    await act(async () => {
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await settle();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await settle();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", selection });
    });
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(afterViewport);
    await settle();

    playerHeight = 120;
    barHeight = 36;
    const afterOrientation = `${computeBottomOcclusion({ playerHeight, barHeight, panelHeight: 0 })}px`;
    await act(async () => {
      window.dispatchEvent(new Event("orientationchange"));
    });
    await settle();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await settle();
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", selection });
    });
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("36px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(afterOrientation);
    expect(frames.pending()).toBeGreaterThan(0);
  });

  test("invalidate then cancel before rAF writes nothing; the flushed frame writes the fresh values", async () => {
    await renderLayer();
    await settle();

    playerHeight = 100;
    barHeight = 44;
    const fresh = `${computeBottomOcclusion({ playerHeight, barHeight, panelHeight: 0 })}px`;

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(frames.pending()).toBeGreaterThan(0);

    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting" });
    });
    await act(async () => {
      usePlayerStore.setState({ askPhase: "selecting", selection });
    });

    expect(rootVarWrites(setProperty.mock.calls)).toEqual([]);
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe("232px");

    await frames.flush();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("44px");
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-occlusion")).toBe(fresh);
    const afterFlush = rootVarWrites(setProperty.mock.calls);
    expect(afterFlush).toEqual([
      ["--ask-bottom-bar-h", "44px"],
      ["--ask-bottom-occlusion", fresh],
    ]);
    setProperty.mockRestore();
  });

  test("while askPhase is sending, --ask-bottom-bar-h stays 0px", async () => {
    await renderLayer();
    await settle();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("60px");

    await act(async () => {
      usePlayerStore.setState({ askPhase: "sending" });
    });
    await settle();

    expect(usePlayerStore.getState().askPhase).toBe("sending");
    expect(document.querySelector("[data-ask-layer]")).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(document.documentElement.style.getPropertyValue("--ask-bottom-bar-h")).toBe("0px");
  });

  test("mobile sending to selecting focuses a shortcut in the same act, before any rAF", async () => {
    await renderLayer();
    await settle();

    const shell = document.querySelector("[data-ask-layer]");
    expect(shell).not.toBeNull();

    await act(async () => {
      usePlayerStore.setState({ askPhase: "sending" });
    });
    await settle();
    // Waiting keeps this shell mounted and hides the chip bar, so selecting
    // can focus a chip in the same commit instead of remounting the layer.
    expect(document.querySelector("[data-ask-layer]")).toBe(shell);
    expect(document.querySelector("[data-ask-bottom-bar]")).toBeNull();
    expect(document.querySelector("[data-ask-shortcut]")).toBeNull();

    const lingering = document.createElement("button");
    lingering.textContent = "取消";
    document.body.append(lingering);
    lingering.focus();
    expect(document.activeElement).toBe(lingering);
    expect(frames.pending()).toBe(0);

    await act(async () => {
      finishAskCancelSync(null, () => {
        usePlayerStore.setState({ askPhase: "selecting", selection });
      });
    });

    const chip = document.activeElement as HTMLElement | null;
    expect(chip?.closest("[data-ask-shortcut]")).toBe(chip);
    expect(chip?.hasAttribute("data-ask-shortcut")).toBe(true);
    // The measure frame is queued, not flushed. Focus already landed.
    expect(frames.pending()).toBeGreaterThan(0);

    lingering.remove();
  });

  test("desktop drafting to selecting focuses the selection target in the same act and schedules no focus timer", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderLayer();
    await settle();

    const target = stage.querySelector<HTMLElement>('[data-ask-id="subtitle:s1"]')!;
    expect(target.hasAttribute("tabindex")).toBe(false);

    await act(async () => {
      usePlayerStore.setState({ askPhase: "drafting", selection });
    });
    await settle();

    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    document.body.append(cancel);
    cancel.focus();

    const nativeSetTimeout = window.setTimeout.bind(window);
    const scheduled: string[] = [];
    const setTimeoutSpy = vi.spyOn(window, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      scheduled.push(typeof callback === "function" ? callback.toString() : "");
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof window.setTimeout);

    await act(async () => {
      finishAskCancelSync(null, () => {
        usePlayerStore.setState({ askPhase: "selecting", selection });
      });
    });

    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    expect(scheduled.filter((source) => /focus|data-ask-layer|activeElement/.test(source))).toEqual([]);
    expect(frames.pending()).toBeGreaterThan(0);

    setTimeoutSpy.mockRestore();
    cancel.remove();
  });
});

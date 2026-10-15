// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exitAskAndFocusEntry } from "../components/board/ask-selection-layer";
import { getAskCodeMissNotice, setAskCodeMissNotice } from "../lib/ask/code-editor-registry";
import { usePlayerStore } from "../lib/player/store";

describe("exitAskAndFocusEntry", () => {
  beforeEach(() => {
    usePlayerStore.getState().reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    usePlayerStore.getState().reset();
    vi.restoreAllMocks();
  });

  test("with an entry button in DOM it gets focus after exit, selection cleared", async () => {
    const entry = document.createElement("button");
    entry.setAttribute("data-ask-entry", "");
    entry.tabIndex = 0;
    document.body.append(entry);

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    setAskCodeMissNotice("missed code notice");
    usePlayerStore.setState({
      askPhase: "selecting",
      selection: {
        mode: "single",
        bbox: { x: 10, y: 10, width: 20, height: 20 },
        targets: [{ kind: "step", id: "s1", stepId: "s1", text: "step 1" }],
      },
    });

    exitAskAndFocusEntry();

    expect(usePlayerStore.getState().askPhase).toBe("idle");
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(getAskCodeMissNotice()).toBeNull();
    expect(document.activeElement).toBe(entry);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(entry);
  });

  test("without an entry button in DOM nothing throws and selection is cleared", async () => {
    setAskCodeMissNotice("some notice");
    usePlayerStore.setState({
      askPhase: "selecting",
      selection: {
        mode: "region",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
        targets: [{ kind: "viz", id: "viz:s1", stepId: "s1", text: "viz" }],
      },
    });

    expect(() => {
      exitAskAndFocusEntry();
    }).not.toThrow();

    expect(usePlayerStore.getState().askPhase).toBe("idle");
    expect(usePlayerStore.getState().selection).toBeNull();
    expect(getAskCodeMissNotice()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("when exitAsk does not transition to idle (e.g. from sending), entry button is not focused", async () => {
    const entry = document.createElement("button");
    entry.setAttribute("data-ask-entry", "");
    document.body.append(entry);

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();

    usePlayerStore.setState({
      askPhase: "sending",
      selection: {
        mode: "single",
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        targets: [{ kind: "step", id: "s1", stepId: "s1", text: "step 1" }],
      },
    });

    exitAskAndFocusEntry();

    expect(usePlayerStore.getState().askPhase).toBe("sending");
    expect(document.activeElement).toBe(other);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(other);
  });

  test("at 390 with exit button in bar, persistent entry outside bar receives focus after exit", async () => {
    const persistent = document.createElement("button");
    persistent.setAttribute("data-ask-entry", "");
    persistent.tabIndex = 0;
    document.body.append(persistent);

    const bar = document.createElement("div");
    bar.setAttribute("data-ask-bottom-bar", "");
    const barExit = document.createElement("button");
    barExit.setAttribute("data-ask-entry", "");
    barExit.tabIndex = 0;
    bar.append(barExit);
    document.body.append(bar);

    barExit.focus();
    expect(document.activeElement).toBe(barExit);

    usePlayerStore.setState({ askPhase: "selecting" });

    exitAskAndFocusEntry();

    expect(usePlayerStore.getState().askPhase).toBe("idle");
    expect(document.activeElement).toBe(persistent);

    // Simulate bar unmount on idle
    bar.remove();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(persistent);
  });
});

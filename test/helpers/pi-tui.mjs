export function createTestTui(piTui, { width = 80, height = 24 } = {}) {
  if (typeof piTui.TuiMainScreen === "function") {
    let onInput;
    const terminal = {
      columns: width,
      rows: height,
      kittyProtocolActive: false,
      start(input) { onInput = input; },
      stop() {},
      async drainInput() {},
      write() {},
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const tui = new piTui.TuiMainScreen(terminal);
    tui.requestRender = () => {};
    tui.start();
    return {
      tui,
      dispatchInput(data) {
        onInput(data);
      },
    };
  }

  if (typeof piTui.TUI === "function") {
    const tui = new piTui.TUI({ width, height });
    tui.requestRender = () => {};
    return {
      tui,
      dispatchInput(data) {
        piTui.TUI.prototype.handleInput.call(tui, data);
      },
    };
  }

  throw new Error("Pi TUI module does not expose a constructible input host");
}

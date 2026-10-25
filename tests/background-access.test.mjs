import test from "node:test";
import assert from "node:assert/strict";

let serial = 0;
async function fixture({ restored = false, attachError = false, focusError = false, saveError = false } = {}) {
  const calls = [];
  const inputEvents = [];
  const store = restored ? { backgroundTabId: 7 } : {};
  const tabs = new Map([[7, { id: 7, url: "https://game.mahjongsoul.com/", active: false, discarded: false }],
    [8, { id: 8, url: "https://game.mahjongsoul.com/", active: false, discarded: false }]]);
  let attached = restored ? 7 : null;
  let pauseAttach;
  let releaseAttach;
  let screenshot = "AAAA";
  let layoutMetrics = { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 } };
  let captureAction;
  let disableAction;
  let detachAction;
  let inputAction;
  globalThis.chrome = {
    tabs: { async get(id) {
      calls.push(["getTab", id]);
      if (!tabs.has(id)) throw new Error("No tab");
      return { ...tabs.get(id) };
    } },
    storage: { session: {
      async get(key) { return Object.hasOwn(store, key) ? { [key]: store[key] } : {}; },
      async set(data) { if (saveError) throw new Error("Storage failed"); Object.assign(store, data); },
      async remove(key) { delete store[key]; },
    } },
    debugger: {
      async attach(target, version) {
        calls.push(["attach", target.tabId, version]);
        if (pauseAttach) await new Promise(resolve => { releaseAttach = resolve; });
        if (attachError || attached != null) throw new Error("Another debugger attached");
        attached = target.tabId;
      },
      async sendCommand(target, command, parameters) {
        calls.push([command, target.tabId, parameters]);
        if (attached !== target.tabId) throw new Error("Not attached by this extension");
        if (focusError && command === "Emulation.setFocusEmulationEnabled" && parameters.enabled) throw new Error("Emulation failed");
        if (disableAction && command === "Emulation.setFocusEmulationEnabled" && !parameters.enabled) await disableAction();
        if (command === "Input.dispatchMouseEvent") {
          inputEvents.push({ ...parameters, recordedAt: performance.now(), tabId: target.tabId });
          if (inputAction) await inputAction(parameters);
        }
        if (command === "Page.getLayoutMetrics") return layoutMetrics;
        if (command === "Page.captureScreenshot") {
          if (captureAction) await captureAction();
          return { data: screenshot };
        }
        return {};
      },
      async detach(target) {
        calls.push(["detach", target.tabId]);
        if (detachAction) await detachAction();
        if (attached !== target.tabId) throw new Error("Not attached by this extension");
        attached = null;
      },
    },
  };
  const module = await import("../extension/background-access.js?case=" + ++serial);
  return { ...module, calls, inputEvents, store, tabs,
    get attached() { return attached; },
    setAttached: value => { attached = value; },
    holdAttach: () => { pauseAttach = true; },
    get attachPending() { return Boolean(releaseAttach); },
    finishAttach: () => releaseAttach?.(),
    setScreenshot: value => { screenshot = value; },
    setLayoutMetrics: value => { layoutMetrics = value; },
    setCaptureAction: value => { captureAction = value; },
    setDisableAction: value => { disableAction = value; },
    setDetachAction: value => { detachAction = value; },
    setInputAction: value => { inputAction = value; },
  };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail("Timed out");
}

test("inactive game tabs attach once, enable focus emulation and capture their own target", async () => {
  const f = await fixture();
  await Promise.all([f.ensureBackgroundAccess(7), f.ensureBackgroundAccess(7)]);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, 1);
  assert.equal(f.store.backgroundTabId, 7);
  assert.equal(await f.captureBackgroundTab(7), "data:image/png;base64,AAAA");
  assert.deepEqual(f.calls.find(call => call[0] === "Page.captureScreenshot"),
    ["Page.captureScreenshot", 7, {
      format: "png", fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
    }]);
  await f.releaseBackgroundAccess();
  const disable = f.calls.findIndex(call => call[0] === "Emulation.setFocusEmulationEnabled" && call[2].enabled === false);
  const detach = f.calls.findIndex(call => call[0] === "detach");
  assert.ok(disable >= 0 && disable < detach);
  assert.equal(f.attached, null);
  assert.equal(f.store.backgroundTabId, undefined);
});

test("a suspended service worker restores its own recorded debugging connection", async () => {
  const f = await fixture({ restored: true });
  await f.ensureBackgroundAccess(7);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, 0);
  assert.ok(f.calls.some(call => call[0] === "Page.getLayoutMetrics"));
  assert.equal(await f.captureBackgroundTab(7), "data:image/png;base64,AAAA");
  await f.releaseBackgroundAccess();
});

test("switching the watched tab releases only the previous owned connection", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  await f.ensureBackgroundAccess(8);
  assert.equal(f.attached, 8);
  assert.equal(f.store.backgroundTabId, 8);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  await f.releaseBackgroundAccess(7);
  assert.equal(f.attached, 8);
  await f.releaseBackgroundAccess(8);
});

test("other origins, discarded tabs and closed tabs are rejected before capture or attach", async () => {
  for (const mutate of [
    f => { f.tabs.get(7).url = "https://game.mahjongsoul.com.evil.example/"; },
    f => { f.tabs.get(7).url = "http://game.mahjongsoul.com/"; },
    f => { f.tabs.get(7).discarded = true; },
    f => { f.tabs.delete(7); },
  ]) {
    const f = await fixture(); mutate(f);
    await assert.rejects(f.ensureBackgroundAccess(7));
    await assert.rejects(f.captureBackgroundTab(7));
    assert.equal(f.calls.some(call => call[0] === "attach"), false);
    assert.equal(f.calls.some(call => call[0] === "Page.captureScreenshot"), false);
  }
});

test("attach conflicts never detach another debugger", async () => {
  const f = await fixture({ attachError: true });
  await assert.rejects(f.ensureBackgroundAccess(7), /接続できません/);
  assert.equal(f.calls.some(call => call[0] === "detach"), false);
  assert.equal(f.store.backgroundTabId, undefined);
});

test("focus emulation or session persistence failure rolls back an acquired connection", async () => {
  for (const options of [{ focusError: true }, { saveError: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.ensureBackgroundAccess(7), /準備できません/);
    assert.equal(f.attached, null);
    assert.equal(f.store.backgroundTabId, undefined);
    assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  }
});

test("stop during an in-flight attach cancels preparation and releases it", async () => {
  const f = await fixture(); f.holdAttach();
  const prepared = f.ensureBackgroundAccess(7);
  await waitFor(() => f.attachPending);
  const stopped = f.releaseBackgroundAccess();
  f.finishAttach();
  await assert.rejects(prepared, /中止/);
  await stopped;
  assert.equal(f.attached, null);
  assert.equal(f.store.backgroundTabId, undefined);
});

test("browser detach is forgotten without reconnecting or detaching a replacement owner", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setAttached(null);
  assert.equal(await f.forgetBackgroundAccess(7), true);
  await assert.rejects(f.captureBackgroundTab(7), /接続を準備/);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 0);
});

test("navigation away blocks capture and cleanup does not run page commands on the new origin", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.tabs.get(7).url = "https://example.com/";
  const before = f.calls.length;
  await assert.rejects(f.captureBackgroundTab(7), /雀魂/);
  await f.releaseBackgroundAccess(7);
  const after = f.calls.slice(before);
  assert.equal(after.some(call => call[0] === "Page.captureScreenshot"), false);
  assert.equal(after.some(call => call[0] === "Emulation.setFocusEmulationEnabled"), false);
  assert.ok(after.some(call => call[0] === "detach"));
});

test("stale stored sessions recover, and malformed screenshot responses fail", async () => {
  const f = await fixture({ restored: true });
  f.setAttached(null);
  await f.ensureBackgroundAccess(7);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, 1);
  f.setScreenshot("not base64");
  await assert.rejects(f.captureBackgroundTab(7), /画面画像/);
  await f.releaseBackgroundAccess();
});

test("capture never implicitly attaches to a tab that was not prepared", async () => {
  const f = await fixture();
  await assert.rejects(f.captureBackgroundTab(7), /接続を準備/);
  assert.equal(f.calls.some(call => call[0] === "attach"), false);
});


test("intentional release notifications report no owned session to stop", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  await f.releaseBackgroundAccess(7);
  assert.equal(await f.forgetBackgroundAccess(7), false);
});

test("a delayed detach notification cannot destroy a newer live session on the same tab", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  await f.releaseBackgroundAccess(7);
  await f.ensureBackgroundAccess(7);
  assert.equal(await f.forgetBackgroundAccess(7), false);
  assert.equal(f.store.backgroundTabId, 7);
  assert.equal(f.attached, 7);
  assert.equal(await f.captureBackgroundTab(7), "data:image/png;base64,AAAA");
  await f.releaseBackgroundAccess(7);
});

test("a detached persisted owner is forgotten after service-worker restart", async () => {
  const f = await fixture({ restored: true });
  f.setAttached(null);
  assert.equal(await f.forgetBackgroundAccess(7), true);
  assert.equal(f.store.backgroundTabId, undefined);
  assert.equal(f.calls.some(call => call[0] === "attach"), false);
  assert.equal(f.calls.some(call => call[0] === "detach"), false);
});

test("a screenshot is rejected if the target navigates during capture", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setCaptureAction(() => { f.tabs.get(7).url = "https://example.com/"; });
  await assert.rejects(f.captureBackgroundTab(7), /雀魂/);
  await f.releaseBackgroundAccess(7);
});

function controlledDeadlines(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds !== 8000 && milliseconds !== 1000 && milliseconds !== 5000) return originalSetTimeout(callback, milliseconds, ...args);
    const id = Symbol("deadline");
    timers.set(id, { callback, milliseconds, args });
    return id;
  };
  globalThis.clearTimeout = id => {
    if (typeof id === "symbol") timers.delete(id);
    else originalClearTimeout(id);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return {
    pending: milliseconds => [...timers.values()].some(timer => timer.milliseconds === milliseconds),
    fire(milliseconds) {
      const entry = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds);
      assert.ok(entry, "Expected a pending deadline of " + milliseconds + " ms");
      timers.delete(entry[0]);
      entry[1].callback(...entry[1].args);
    },
  };
}

test("a screenshot timeout disposes ownership and releases the lifecycle queue", async t => {
  const clock = controlledDeadlines(t);
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  let lateResponse;
  f.setCaptureAction(() => new Promise(resolve => { lateResponse = resolve; }));
  const capture = f.captureBackgroundTab(7);
  const rejected = assert.rejects(capture, error => error.code === "BACKGROUND_CAPTURE_TIMEOUT");
  await waitFor(() => clock.pending(8000));
  clock.fire(8000);
  await rejected;
  assert.equal(f.attached, null);
  assert.equal(f.store.backgroundTabId, undefined);
  const disable = f.calls.findIndex(call => call[0] === "Emulation.setFocusEmulationEnabled" && !call[2].enabled);
  const detached = f.calls.findIndex(call => call[0] === "detach");
  assert.ok(disable >= 0 && disable < detached);
  // Later work can execute; the previous unresolved capture no longer owns the queue.
  f.setCaptureAction(null);
  await f.ensureBackgroundAccess(8);
  lateResponse();
  assert.equal(await f.captureBackgroundTab(8), "data:image/png;base64,AAAA");
  assert.equal(f.store.backgroundTabId, 8);
  await f.releaseBackgroundAccess(8);
});

test("unresponsive cleanup commands cannot hold the queue after screenshot timeout", async t => {
  const clock = controlledDeadlines(t);
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setCaptureAction(() => new Promise(() => {}));
  f.setDisableAction(() => new Promise(() => {}));
  f.setDetachAction(() => new Promise(() => {}));
  const capture = f.captureBackgroundTab(7);
  const rejected = assert.rejects(capture, error => error.code === "BACKGROUND_CAPTURE_TIMEOUT");
  await waitFor(() => clock.pending(8000));
  clock.fire(8000);
  await waitFor(() => f.calls.some(call => call[0] === "Emulation.setFocusEmulationEnabled" && !call[2].enabled));
  await waitFor(() => clock.pending(1000));
  clock.fire(1000);
  await waitFor(() => f.calls.some(call => call[0] === "detach"));
  await waitFor(() => clock.pending(1000));
  clock.fire(1000);
  await rejected;
  assert.equal(f.store.backgroundTabId, undefined);
  await assert.rejects(f.captureBackgroundTab(7), /接続を準備/);
  await f.releaseBackgroundAccess();
});

test("capture reads fresh CSS viewport metrics and does not scale them by DPR", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setLayoutMetrics({
    cssVisualViewport: { pageX: 12.5, pageY: 30.25, clientWidth: 640, clientHeight: 360, scale: 2 },
    visualViewport: { pageX: 25, pageY: 60.5, clientWidth: 1280, clientHeight: 720 },
  });
  await f.captureBackgroundTab(7);
  f.setLayoutMetrics({ cssVisualViewport: { pageX: 0, pageY: 10, clientWidth: 800, clientHeight: 600 } });
  await f.captureBackgroundTab(7);
  const captures = f.calls.filter(call => call[0] === "Page.captureScreenshot");
  assert.deepEqual(captures[0][2].clip, { x: 12.5, y: 30.25, width: 640, height: 360, scale: 1 });
  assert.deepEqual(captures[1][2].clip, { x: 0, y: 10, width: 800, height: 600, scale: 1 });
  assert.ok(captures.every(call => call[2].captureBeyondViewport === true));
  await f.releaseBackgroundAccess();
});

test("CSS layout viewport is used when CSS visual viewport is unavailable", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setLayoutMetrics({ cssLayoutViewport: { pageX: 40, pageY: 50, clientWidth: 400, clientHeight: 300 } });
  await f.captureBackgroundTab(7);
  const capture = f.calls.find(call => call[0] === "Page.captureScreenshot");
  assert.deepEqual(capture[2].clip, { x: 40, y: 50, width: 400, height: 300, scale: 1 });
  await f.releaseBackgroundAccess();
});

test("invalid or unbounded viewport metadata fails before requesting an image", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  const base = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 };
  for (const metrics of [
    {},
    { cssVisualViewport: { ...base, pageX: -1 } },
    { cssVisualViewport: { ...base, pageY: Infinity } },
    { cssVisualViewport: { ...base, clientWidth: 0 } },
    { cssVisualViewport: { ...base, clientHeight: NaN } },
    { cssVisualViewport: { ...base, clientWidth: 20000 } },
    { cssVisualViewport: { ...base, clientWidth: 10000, clientHeight: 10000 } },
  ]) {
    f.setLayoutMetrics(metrics);
    await assert.rejects(f.captureBackgroundTab(7), /表示範囲/);
  }
  assert.equal(f.calls.some(call => call[0] === "Page.captureScreenshot"), false);
  await f.releaseBackgroundAccess();
});

test("standard input honors the holding duration in CSS coordinates without activating the tab", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  let validations = 0;
  const before = f.calls.length;
  const result = await f.clickBackgroundTab(7, { x: 123.5, y: 456.25 }, 350, async () => { validations++; return true; });
  assert.deepEqual(f.inputEvents.map(event => event.type), ["mouseMoved", "mousePressed", "mouseReleased", "mouseMoved"]);
  assert.equal(f.inputEvents[1].x, 123.5);
  assert.equal(f.inputEvents[1].y, 456.25);
  assert.equal(f.inputEvents[1].button, "left");
  assert.equal(f.inputEvents[1].buttons, 1);
  assert.equal(f.inputEvents[2].buttons, 0);
  assert.equal(f.inputEvents[1].pointerType, "mouse");
  assert.equal(f.inputEvents[1].clickCount, 1);
  assert.ok(f.inputEvents[2].recordedAt - f.inputEvents[1].recordedAt >= 340);
  assert.equal(result.configuredHoldMs, 350);
  assert.ok(result.actualHoldMs >= 340);
  assert.ok(validations >= 4);
  assert.equal(f.calls.slice(before).some(call => ["attach", "detach", "Page.bringToFront"].includes(call[0])), false);
  assert.equal(f.attached, 7);
  await f.releaseBackgroundAccess();
});

test("invalid click parameters, missing connections and other origins never send input", async () => {
  const f = await fixture();
  for (const [point, holdMs, validate] of [
    [{ x: -1, y: 1 }, 100, () => true],
    [{ x: Infinity, y: 1 }, 100, () => true],
    [{ x: 1, y: 1 }, 99, () => true],
    [{ x: 1, y: 1 }, 2001, () => true],
    [{ x: 1, y: 1 }, 100, null],
  ]) await assert.rejects(f.clickBackgroundTab(7, point, holdMs, validate));
  await assert.rejects(f.clickBackgroundTab(7, { x: 1, y: 1 }, 100, () => true), /接続/);
  await f.ensureBackgroundAccess(7);
  f.tabs.get(7).url = "https://example.com/";
  await assert.rejects(f.clickBackgroundTab(7, { x: 1, y: 1 }, 100, () => true), /雀魂/);
  assert.equal(f.inputEvents.length, 0);
  await f.releaseBackgroundAccess();
});

test("page validation rejects a click before a press and prevents overlapping clicks", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  let validateRelease;
  const click = f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => new Promise(resolve => { validateRelease = resolve; }));
  await waitFor(() => Boolean(validateRelease));
  await assert.rejects(f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => true), /進行中/);
  validateRelease(false);
  await assert.rejects(click, /画面操作/);
  assert.equal(f.inputEvents.length, 0);
  await f.releaseBackgroundAccess();
});

test("stop during a held native click releases before detaching without waiting for the whole hold", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  const click = f.clickBackgroundTab(7, { x: 100, y: 100 }, 1500, () => true);
  const rejected = assert.rejects(click, /中止|解除/);
  await waitFor(() => f.inputEvents.some(event => event.type === "mousePressed"));
  const stopped = f.releaseBackgroundAccess(7);
  await rejected;
  await stopped;
  const pressed = f.inputEvents.find(event => event.type === "mousePressed");
  const released = f.inputEvents.find(event => event.type === "mouseReleased");
  assert.ok(released);
  assert.equal(released.x, -1);
  assert.equal(released.y, -1);
  assert.equal(released.clickCount, 0);
  assert.ok(released.recordedAt - pressed.recordedAt < 1000);
  const releaseIndex = f.calls.findIndex(call => call[0] === "Input.dispatchMouseEvent" && call[2].type === "mouseReleased");
  const detachIndex = f.calls.findIndex(call => call[0] === "detach");
  assert.ok(releaseIndex >= 0 && detachIndex > releaseIndex);
  assert.equal(f.attached, null);
});

test("a validation failure after pressing safely releases without an ordinary click", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  let checks = 0;
  await assert.rejects(f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => ++checks < 3), /画面操作/);
  assert.deepEqual(f.inputEvents.map(event => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(f.inputEvents.at(-1).clickCount, 0);
  assert.equal(f.inputEvents.at(-1).x, -1);
  await f.releaseBackgroundAccess();
});

test("a rejected press command is followed by safe release because it may already have been delivered", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setInputAction(parameters => {
    if (parameters.type === "mousePressed") throw new Error("Press transport rejected");
  });
  await assert.rejects(f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => true), /Press transport/);
  assert.deepEqual(f.inputEvents.map(event => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(f.inputEvents.at(-1).clickCount, 0);
  await f.releaseBackgroundAccess();
});

test("navigation during a held click never releases or moves on a different origin", async () => {
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setInputAction(parameters => {
    if (parameters.type === "mousePressed") f.tabs.get(7).url = "https://example.com/";
  });
  await assert.rejects(f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => true), /雀魂/);
  assert.deepEqual(f.inputEvents.map(event => event.type), ["mouseMoved", "mousePressed"]);
  assert.equal(f.attached, null);
  assert.equal(f.store.backgroundTabId, undefined);
});

test("native click timeout releases and detaches; a late old response cannot operate a replacement connection", async t => {
  const clock = controlledDeadlines(t);
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  let latePress;
  f.setInputAction(parameters => {
    if (parameters.type === "mousePressed") return new Promise(resolve => { latePress = resolve; });
  });
  const click = f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => true);
  const rejected = assert.rejects(click, error => error.code === "BACKGROUND_CLICK_TIMEOUT");
  await waitFor(() => Boolean(latePress));
  clock.fire(5000);
  await rejected;
  assert.equal(f.attached, null);
  assert.ok(f.inputEvents.some(event => event.type === "mouseReleased"));
  f.setInputAction(null);
  await f.ensureBackgroundAccess(8);
  const count = f.inputEvents.length;
  latePress();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.inputEvents.length, count);
  assert.equal(f.attached, 8);
  await f.releaseBackgroundAccess(8);
});

test("a hanging release is bounded and cannot prevent the lifecycle queue from being reused", async t => {
  const clock = controlledDeadlines(t);
  const f = await fixture();
  await f.ensureBackgroundAccess(7);
  f.setInputAction(parameters => parameters.type === "mouseReleased" ? new Promise(() => {}) : undefined);
  const click = f.clickBackgroundTab(7, { x: 100, y: 100 }, 100, () => true);
  const rejected = assert.rejects(click, error => error.code === "BACKGROUND_CLICK_TIMEOUT");
  await waitFor(() => f.inputEvents.some(event => event.type === "mouseReleased"));
  clock.fire(5000);
  await waitFor(() => f.inputEvents.filter(event => event.type === "mouseReleased").length === 2);
  await waitFor(() => clock.pending(1000));
  clock.fire(1000);
  await rejected;
  assert.equal(f.attached, null);
  f.setInputAction(null);
  await f.ensureBackgroundAccess(8);
  assert.equal(f.attached, 8);
  await f.releaseBackgroundAccess(8);
});

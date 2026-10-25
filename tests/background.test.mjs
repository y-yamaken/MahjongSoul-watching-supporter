import test from "node:test";
import assert from "node:assert/strict";

let serial = 0;
const settings = { names: ["雀士太郎"], intervalSeconds: 60 };
const viewport = { width: 1280, height: 720, devicePixelRatio: 1 };
const calibration = {
  tabId: 7, url: "https://game.mahjongsoul.com/", viewport,
  point: { x: .9, y: .9 }, anchor: { x: .8, y: .8, width: .1, height: .1 },
};
const text = new TextEncoder();
function varint(n) {
  const bytes = [];
  do { const part = n & 127; n = Math.floor(n / 128); bytes.push(part | (n ? 128 : 0)); } while (n);
  return bytes;
}
const field = (number, bytes) => [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
function packet(names = ["雀士太郎"], { uuid = "game-1", id = String(Math.random()), requestedAt = Date.now(), errorCode = 0 } = {}) {
  const game = [
    ...field(1, text.encode(uuid)),
    ...names.flatMap(name => field(4, field(4, text.encode(name)))),
  ];
  const response = errorCode ? field(1, [8, ...varint(errorCode)]) : (names.length ? field(2, game) : []);
  return { requestId: id, requestedAt, receivedAt: Math.max(Date.now(), requestedAt), filterId: 1, frame: [3, 1, 0, ...field(2, response)] };
}
async function waitFor(condition) {
  for (let i = 0; i < 600; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for background operation");
}
async function setup({ armFails = false, inspectionFails = false, active = true, hookReady = true, focused = true, minimized = false, attachFails = false, loseFocusAtClick = false, deliverResponse = true, observeRequest = true, advanceClock = null } = {}) {
  // The imported helper is shared by background-module instances; dispose its
  // previous fixture connection while the previous mock is still installed.
  if (globalThis.chrome?.debugger) {
    const helper = await import("../extension/background-access.js");
    await helper.releaseBackgroundAccess();
  }
  globalThis.createImageBitmap = async () => { assert.fail("Background monitoring must not decode screenshots"); };
  globalThis.OffscreenCanvas = class {
    constructor() { assert.fail("Background monitoring must not allocate screenshot canvases"); }
  };
  const session = { calibration: structuredClone(calibration), monitor: { enabled: false, tabId: 7 } };
  const local = { settings: structuredClone(settings), stateVersion: "background-v1" };
  const notifications = [];
  const sent = [];
  const events = {};
  const debuggerCalls = [];
  const windowActions = [];
  let attached = null;
  let emulated = false;
  let clicks = 0;
  let captureCount = 0;
  let alarm;
  let latest = null;
  let holdNext = false;
  let releaseStorage;
  let native = null;
  const storage = data => ({
    async get(keys) {
      const result = {};
      for (const key of typeof keys === "string" ? [keys] : keys) if (key in data) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) {
      if (holdNext && Object.keys(values).some(key => key.startsWith("live:"))) {
        holdNext = false;
        await new Promise(resolve => { releaseStorage = resolve; });
      }
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) { for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]; },
  });
  const event = name => ({ addListener(listener) { events[name] = listener; } });
  const tab = () => ({ id: 7, windowId: 2, url: calibration.url, active, discarded: false });
  const sendPage = (type, extra = {}, senderTab = tab()) => new Promise(resolve => events.message(
    { type, ...extra }, { id: "test-extension", frameId: 0, tab: senderTab }, resolve,
  ));
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: { id: "test-extension", onMessage: event("message") },
    tabs: {
      query: async () => [tab()], get: async () => tab(),
      captureVisibleTab: async () => { assert.fail("Background refresh must not capture the visible tab"); },
      async sendMessage(_id, message) {
        sent.push(message.type);
        if (message.type === "GET_PAGE_STATE") {
          if (inspectionFails) return { ok: false, error: "Inspection failed" };
          return {
            ok: true, url: calibration.url, viewport,
            canvasRect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
            visible: emulated || (active && !minimized), focused: emulated || focused, calibrating: false,
          };
        }
        if (message.type === "GET_LIVE_STATE") {
          if (!deliverResponse && clicks > 0 && advanceClock) advanceClock(11000);
          return { ok: true, hookReady, latest };
        }
        if (message.type === "ARM_PAGE" && armFails) throw new Error("Missing content script");
        if (message.type === "PREPARE_NATIVE_CLICK") {
          if (loseFocusAtClick || !(emulated || focused)) {
            loseFocusAtClick = false; focused = false;
            return { ok: false, code: "FOCUS_REQUIRED", error: "バックグラウンド実行を確認してください。" };
          }
          native = { token: message.token, press: false, release: false,
            point: { x: message.calibration.point.x * viewport.width, y: message.calibration.point.y * viewport.height } };
          return { ok: true, point: native.point, focused: true };
        }
        if (message.type === "VALIDATE_NATIVE_CLICK") {
          return { ok: Boolean(native && native.token === message.token) };
        }
        if (message.type === "END_NATIVE_CLICK") {
          const result = { ok: true, actualHoldMs: native?.release ? local.settings.clickHoldMs : null,
            trustedPress: native?.press === true, trustedRelease: native?.release === true,
            focusedBefore: true, focusedAfter: true };
          native = null;
          return result;
        }
        if (message.type === "DISARM_PAGE") native = null;
        return { ok: true };
      },
      onRemoved: event("removed"), onUpdated: event("updated"), update: async (...args) => { windowActions.push(["tab", ...args]); },
    },
    windows: {
      get: async () => ({ state: minimized ? "minimized" : "normal" }),
      update: async (...args) => { windowActions.push(["window", ...args]); },
    },
    debugger: {
      onDetach: event("detached"),
      async attach(target, version) {
        debuggerCalls.push(["attach", target.tabId, version]);
        if (attachFails || attached != null) throw new Error("Another debugger attached");
        attached = target.tabId;
      },
      async sendCommand(target, command, params) {
        debuggerCalls.push([command, target.tabId, params]);
        if (target.tabId !== attached) throw new Error("Not attached");
        if (command === "Emulation.setFocusEmulationEnabled") emulated = params.enabled;
        if (command === "Page.getLayoutMetrics") return { cssVisualViewport: {
          pageX: 0, pageY: 0, clientWidth: viewport.width, clientHeight: viewport.height,
        } };
        if (command === "Input.dispatchMouseEvent") {
          if (params.type === "mousePressed" && native) native.press = true;
          if (params.type === "mouseReleased" && native?.press && params.x === native.point.x && params.y === native.point.y) {
            native.release = true;
            clicks++;
            const received = packet(["雀士太郎"], { id: "auto-" + clicks });
            if (observeRequest) await sendPage("LIVE_REQUEST_SEEN", { request: {
              requestId: received.requestId, requestedAt: received.requestedAt, filterId: received.filterId,
            } });
            if (deliverResponse) {
              latest = received;
              await sendPage("LIVE_LIST_RECEIVED", { packet: latest });
            }
          }
        }
        if (command === "Page.captureScreenshot") {
          captureCount++;
          assert.fail("Production background checks must not use Page.captureScreenshot");
        }
        return {};
      },
      async detach(target) {
        debuggerCalls.push(["detach", target.tabId]);
        if (target.tabId !== attached) throw new Error("Not attached");
        attached = null;
        emulated = false;
      },
    },
    scripting: { executeScript: async () => [] },
    notifications: {
      getPermissionLevel: async () => "granted",
      create: async (id, details) => { notifications.push({ id, ...details }); return id; },
      onClicked: event("notificationClicked"),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: {
      get: async () => alarm, create: async (_name, value) => { alarm = value; },
      clear: async () => { alarm = null; }, onAlarm: event("alarm"),
    },
  };
  await import("../extension/background.js?test=" + ++serial);
  const send = (type, extra = {}) => new Promise(resolve => events.message({ type, ...extra }, { id: "test-extension" }, resolve));
  await send("GET_STATE");
  return {
    send, sendPage, session, local, notifications, sent, events, debuggerCalls, windowActions,
    get attached() { return attached; },
    get emulated() { return emulated; },
    detachExternally() {
      attached = null; emulated = false;
      events.detached({ tabId: 7 }, "canceled_by_user");
    },
    setFocus(value) { focused = value; },
    setInspectionFails(value) { inspectionFails = value; },
    monitor() { session.monitor = { enabled: true, tabId: 7, token: "test-token", startedAt: 0 }; },
    holdPacket() { holdNext = true; },
    release() { releaseStorage?.(); },
    get waitingOnStorage() { return Boolean(releaseStorage); },
    get clicks() { return clicks; }, get captureCount() { return captureCount; },
  };
}

test("start refreshes and exact wire name notifies once despite overlapping checks", async () => {
  const app = await setup();
  assert.equal((await app.send("START", { settings })).ok, true);
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.clicks, 1);
  assert.equal(app.notifications.length, 1);
  await Promise.all([app.send("CHECK_NOW"), app.send("CHECK_NOW"), app.send("CHECK_NOW")]);
  await waitFor(() => app.clicks === 2 && app.session.status.requestId === "auto-2" && app.session.status.lastAttempt.responseReceived);
  assert.equal(app.notifications.length, 1);
  await app.send("STOP");
});

test("all received players are checked regardless of the viewport", async () => {
  const app = await setup();
  app.monitor();
  const names = Array.from({ length: 120 }, (_, i) => "Player" + i);
  // Use 8 players per game to remain within protocol bounds.
  const games = [];
  for (let i = 0; i < 120; i += 8) {
    const people = names.slice(i, i + 8);
    if (i === 112) people[7] = "雀士太郎";
    games.push(...field(2, [...field(1, text.encode("g" + i)), ...people.flatMap(name => field(4, field(4, text.encode(name))))]));
  }
  const p = packet();
  p.frame = [3, 1, 0, ...field(2, games)];
  assert.equal((await app.sendPage("LIVE_LIST_RECEIVED", { packet: p })).ok, true);
  assert.equal(app.session.status.playerCount, 120);
  assert.equal(app.session.status.gameCount, 15);
  assert.deepEqual(app.session.status.matchedNames, ["雀士太郎"]);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.captureCount, 0);
});

test("duplicate packets and same game are suppressed; a new game notifies again", async () => {
  const app = await setup(); app.monitor();
  const p = packet();
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: p });
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: p });
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet() });
  assert.equal(app.notifications.length, 1);
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet(["雀士太郎"], { uuid: "game-2" }) });
  assert.equal(app.notifications.length, 2);
});

test("older responses cannot replace a newer requested list", async () => {
  const app = await setup(); app.monitor();
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet(["Other"], { requestedAt: 200 }) });
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet(["雀士太郎"], { requestedAt: 100 }) });
  assert.equal(app.session["live:7"].requestedAt, 200);
  assert.equal(app.notifications.length, 0);
});

test("stop while a received list is being saved prevents a late notification", async () => {
  const app = await setup(); app.monitor(); app.holdPacket();
  const incoming = app.sendPage("LIVE_LIST_RECEIVED", { packet: packet() });
  await waitFor(() => app.waitingOnStorage);
  await app.send("STOP");
  app.release();
  await incoming;
  assert.equal(app.notifications.length, 0);
  assert.equal(app.session.status.state, "stopped");
});

test("empty lists, server errors and malformed frames do not generate matches", async () => {
  const app = await setup(); app.monitor();
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet([]) });
  assert.equal(app.session.status.gameCount, 0);
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet([], { errorCode: 503 }) });
  assert.equal(app.session.status.state, "waiting");
  assert.match(app.session.status.message, /503/);
  const broken = packet(); broken.frame = [3, 1, 0, 18, 255];
  assert.equal((await app.sendPage("LIVE_LIST_RECEIVED", { packet: broken })).ok, false);
  assert.equal(app.notifications.length, 0);
});

test("other tabs and non-game senders cannot trigger the watched tab's notifications", async () => {
  const app = await setup(); app.monitor();
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet() }, { id: 8, url: calibration.url });
  const rejected = await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet() }, { id: 7, url: "https://example.com/" });
  assert.equal(rejected.ok, false);
  assert.equal(app.notifications.length, 0);
});

test("inactive and minimized game tabs refresh without activating any window", async () => {
  const app = await setup({ active: false, focused: false, minimized: true });
  assert.equal((await app.send("START", { settings })).ok, true);
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  assert.equal(app.captureCount, 0);
  assert.equal(app.clicks, 1);
  assert.equal(app.notifications.length, 1);
  assert.equal(app.attached, 7);
  assert.equal(app.emulated, true);
  assert.deepEqual(app.windowActions, []);
  assert.equal(app.debuggerCalls.some(call => call[0] === "Page.captureScreenshot"), false);
  await app.send("STOP");
});

test("start failure or missing network hook leaves monitoring stopped", async () => {
  for (const options of [{ armFails: true }, { hookReady: false }, { attachFails: true }]) {
    const app = await setup(options);
    const response = await app.send("START", { settings });
    assert.equal(response.ok, false);
    assert.equal(app.session.monitor.enabled, false);
    assert.equal(app.attached, null);
    if (options.attachFails) assert.equal(app.debuggerCalls.some(call => call[0] === "detach"), false);
  }
});

test("button-only calibration saves without screenshots; inspection failure does not enable start", async () => {
  const app = await setup();
  assert.equal((await app.send("CALIBRATE", { settings })).ok, true);
  assert.equal((await app.send("GET_STATE")).calibrated, false);
  assert.equal((await app.sendPage("CALIBRATION_DONE", { calibration })).ok, true);
  assert.equal((await app.send("GET_STATE")).calibrated, true);
  assert.equal("referenceAnchor" in app.session.calibration, false);
  assert.equal(app.captureCount, 0);
  const failure = await setup();
  await failure.send("CALIBRATE", { settings });
  failure.setInspectionFails(true);
  const response = await failure.sendPage("CALIBRATION_DONE", { calibration });
  assert.equal(response.ok, false);
  assert.match(response.error, /Inspection failed/);
  assert.equal((await failure.send("GET_STATE")).calibrated, false);
  assert.equal(failure.captureCount, 0);
});


test("request sequence prevents stale overwrite for requests sent in the same millisecond", async () => {
  const app = await setup(); app.monitor();
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet(["Other"], { requestedAt: 200, id: "socket:2" }) });
  await app.sendPage("LIVE_LIST_RECEIVED", { packet: packet(["雀士太郎"], { requestedAt: 200, id: "socket:1" }) });
  assert.equal(app.session["live:7"].requestId, "socket:2");
  assert.equal(app.notifications.length, 0);
});

test("timeout preserves holding-time diagnostics and separates missing request from missing response", async t => {
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  t.after(() => { Date.now = originalNow; });
  for (const observeRequest of [false, true]) {
    const app = await setup({ deliverResponse: false, observeRequest, advanceClock: ms => { offset += ms; } });
    await app.send("START", { settings: { ...settings, clickHoldMs: 1000 } });
    await waitFor(() => !app.session.monitor.enabled);
    assert.equal(app.session.status.lastAttempt.number, 1);
    assert.equal(app.session.status.lastAttempt.configuredHoldMs, 1000);
    assert.equal(app.session.status.lastAttempt.actualHoldMs, 1000);
    assert.equal(app.session.status.lastAttempt.requestObserved, observeRequest);
    assert.equal(app.session.status.lastAttempt.responseReceived, false);
    assert.match(app.session.status.message, observeRequest ? /一覧の応答/ : /更新要求を確認できず/);
    assert.equal(app.notifications.length, 0);
  }
});

test("a manual stop preserves the most recent successful attempt diagnostics", async () => {
  const app = await setup();
  await app.send("START", { settings: { ...settings, clickHoldMs: 1000 } });
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  await app.send("STOP");
  assert.equal(app.session.status.lastAttempt.actualHoldMs, 1000);
  assert.equal(app.session.status.lastAttempt.requestObserved, true);
  assert.equal(app.session.status.lastAttempt.responseReceived, true);
});

test("stopping disables background emulation and releases the connection", async () => {
  const app = await setup({ focused: false });
  await app.send("START", { settings });
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  assert.equal(app.session.backgroundTabId, 7);
  await app.send("STOP");
  assert.equal(app.session.monitor.enabled, false);
  assert.equal(app.attached, null);
  assert.equal(app.emulated, false);
  assert.equal(app.session.backgroundTabId, undefined);
  const disable = app.debuggerCalls.findIndex(call => call[0] === "Emulation.setFocusEmulationEnabled" && call[2].enabled === false);
  const detach = app.debuggerCalls.findIndex(call => call[0] === "detach");
  assert.ok(disable >= 0 && disable < detach, "turn off emulation before detaching");
  const previous = app.clicks;
  await app.sendPage("PAGE_FOCUSED");
  assert.equal(app.clicks, previous);
});

test("user cancellation of the browser connection stops monitoring without reconnecting", async () => {
  const app = await setup();
  await app.send("START", { settings });
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  const attaches = app.debuggerCalls.filter(call => call[0] === "attach").length;
  app.detachExternally();
  await waitFor(() => !app.session.monitor.enabled && app.session.backgroundTabId === undefined);
  assert.match(app.session.status.message, /解除/);
  await app.sendPage("PAGE_FOCUSED");
  assert.equal(app.debuggerCalls.filter(call => call[0] === "attach").length, attaches);
  assert.equal(app.attached, null);
});

test("cancelling point selection releases background access before monitoring starts", async () => {
  const app = await setup();
  await app.send("CALIBRATE", { settings });
  assert.equal(app.attached, 7);
  await app.sendPage("CALIBRATION_CANCELLED");
  assert.equal(app.attached, null);
  assert.equal(app.session.backgroundTabId, undefined);
  assert.equal(app.session.monitor.enabled, false);
});

test("the configured holding duration is used for Chrome input, not synthetic page clicks", async () => {
  const app = await setup();
  await app.send("START", { settings: { ...settings, clickHoldMs: 1000 } });
  await waitFor(() => app.session.status?.lastAttempt?.responseReceived);
  assert.equal(app.sent.includes("CLICK_REFRESH"), false);
  const inputs = app.debuggerCalls.filter(call => call[0] === "Input.dispatchMouseEvent").map(call => call[2]);
  assert.ok(inputs.some(input => input.type === "mousePressed" && input.button === "left" && input.buttons === 1));
  assert.ok(inputs.some(input => input.type === "mouseReleased" && input.button === "left" && input.buttons === 0));
  assert.equal(app.session.status.lastAttempt.inputMethod, "chrome");
  assert.equal(app.session.status.lastAttempt.trustedPress, true);
  assert.equal(app.session.status.lastAttempt.trustedRelease, true);
  assert.equal(app.session.status.lastAttempt.configuredHoldMs, 1000);
  await app.send("STOP");
});

test("unexpected automatic input is distinguished from manual operation and retains its evidence", async () => {
  const app = await setup(); app.monitor();
  app.session.status = { state: "refreshing", lastAttempt: { number: 1, configuredHoldMs: 1000 } };
  await app.sendPage("PAGE_INTERACTION", { reason: "interaction", detail: {
    event: "pointerdown", stage: "ready", x: 103, y: 200, expectedX: 100, expectedY: 200,
    button: 0, buttons: 1, key: "must-not-be-stored",
  } });
  assert.equal(app.session.monitor.enabled, false);
  assert.match(app.session.status.message, /自動クリック中/);
  assert.equal(app.session.status.lastAttempt.interruption.event, "pointerdown");
  assert.equal(app.session.status.lastAttempt.interruption.stage, "ready");
  assert.equal(app.session.status.lastAttempt.interruption.expectedX, 100);
  assert.equal("key" in app.session.status.lastAttempt.interruption, false);
});

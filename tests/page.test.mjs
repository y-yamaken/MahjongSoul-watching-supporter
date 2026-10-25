import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');

function fixture({ calibrationResponse = () => ({ ok: true }), animationDelay = 0, manualAnimation = false, focused = true } = {}) {
  const listeners = new Map();
  const documentListeners = new Map();
  const runtimeListeners = [];
  const sent = [];
  const mouseEvents = [];
  const hosts = [];
  const timers = new Map();
  const animationFrames = new Map();
  let frameId = 0;
  let overlay = null;
  let obstruction = null;
  let clock = 1000;

  class Element {
    constructor() {
      this.style = {};
      this.attributes = new Map();
      this.classList = { contains: () => false };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    remove() {
      const index = hosts.indexOf(this);
      if (index !== -1) hosts.splice(index, 1);
      if (overlay === this) overlay = null;
    }
    attachShadow() {
      const items = new Map();
      this.shadow = { querySelector: (name) => {
        if (!items.has(name)) items.set(name, new Element());
        return items.get(name);
      } };
      return this.shadow;
    }
  }
  class Canvas extends Element {
    id = 'unity-canvas';
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 100, top: 80, right: 1100, bottom: 680, width: 1000, height: 600 }; }
    dispatchEvent(event) {
      event.recordedAt = Date.now();
      mouseEvents.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
  }
  class MouseEvent {
    constructor(type, data) { Object.assign(this, data, { type, isTrusted: false }); }
    preventDefault() {}
    stopImmediatePropagation() {}
    composedPath() { return []; }
  }
  const canvas = new Canvas();
  const document = {
    visibilityState: 'visible',
    hasFocus: () => focused,
    body: { append: (host) => { hosts.push(host); if (host.attributes.has('data-mahjong-soul-watch-calibration')) overlay = host; } },
    querySelectorAll: () => [canvas],
    createElement: () => new Element(),
    elementFromPoint: (x, y) => obstruction || (x >= 100 && x <= 1100 && y >= 80 && y <= 680 ? canvas : new Element()),
    elementsFromPoint: (x, y) => [overlay, document.elementFromPoint(x, y)].filter(Boolean),
    addEventListener: (type, callback) => documentListeners.set(type, [...documentListeners.get(type) || [], callback]),
  };
  const context = {
    document,
    HTMLCanvasElement: Canvas,
    MouseEvent,
    location: { href: 'https://game.mahjongsoul.com/' },
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1.5,
    screenX: 20,
    screenY: 30,
    performance: { now: () => clock + performance.now() },
    requestAnimationFrame: (callback) => {
      if (manualAnimation) { animationFrames.set(++frameId, callback); return frameId; }
      return animationDelay ? setTimeout(callback, animationDelay) : queueMicrotask(callback);
    },
    cancelAnimationFrame: (frame) => manualAnimation ? animationFrames.delete(frame) : clearTimeout(frame),
    setTimeout: (callback, milliseconds) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
      if (milliseconds >= 1000) timer.unref();
      timers.set(timer, { callback, milliseconds });
      return timer;
    },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    addEventListener: (type, callback) => listeners.set(type, [...listeners.get(type) || [], callback]),
    chrome: { runtime: {
      id: 'test-extension',
      sendMessage: async (message) => {
        sent.push({ ...message, overlayPresent: Boolean(overlay) });
        return message.type === 'CALIBRATION_DONE' ? calibrationResponse(message) : { ok: true };
      },
      onMessage: { addListener: (callback) => runtimeListeners.push(callback) },
    } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const message = (type, fields = {}, sender = { id: 'test-extension' }) => new Promise((resolve) => {
    let responded = false;
    const pending = runtimeListeners[0]({ type, ...fields }, sender, (value) => { responded = true; resolve(value); });
    if (!responded && !pending) resolve(undefined);
  });
  const emit = (type, fields = {}, target = listeners) => {
    const event = {
      type,
      isTrusted: true,
      button: 0,
      clientX: 0,
      clientY: 0,
      prevented: false,
      stopped: false,
      composedPath: () => [],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...fields,
    };
    for (const callback of target.get(type) || []) callback(event);
    return event;
  };
  const calibration = {
    point: { x: 0.75, y: 0.125 },
    viewport: { width: 1200, height: 800, devicePixelRatio: 1.5 },
    url: 'https://game.mahjongsoul.com/',
  };
  return {
    context, canvas, document, documentListeners, runtimeListeners, sent, mouseEvents, hosts, calibration, message, emit,
    frame: () => {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback(clock);
    },
    get pendingFrames() { return animationFrames.size; },
    reinject: () => vm.runInContext(source, context),
    setObstruction: (value) => { obstruction = value; },
    setFocus: (value) => { focused = value; },
    advanceClock: (ms) => { clock += ms; },
    notice: () => hosts.find((host) => host.attributes.has('data-mahjong-soul-watch-notice')),
    fireTimer: (milliseconds) => {
      for (const [timer, entry] of timers) {
        if (entry.milliseconds !== milliseconds) continue;
        clearTimeout(timer);
        timers.delete(timer);
        entry.callback();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
test('reinjection does not duplicate listeners and rejects foreign messages', async () => {
  const f = fixture();
  f.reinject();
  assert.equal(f.runtimeListeners.length, 1);
  const state = await f.message('GET_PAGE_STATE');
  assert.equal(state.visible, true);
  assert.equal(state.canvasRect.width, 1000);
  assert.equal(await f.message('ARM_PAGE', {}, { id: 'another-extension' }), undefined);
  assert.equal((await f.message('CLICK_REFRESH', { calibration: f.calibration })).ok, false);
});


const nativeEvent = (f, type, fields = {}) => f.emit(type, {
  clientX: 900, clientY: 100, button: 0, buttons: ['pointerdown', 'mousedown'].includes(type) ? 1 : 0,
  pointerId: 1, isPrimary: true, ...fields,
});
async function prepare(f, token = 'native') {
  return f.message('PREPARE_NATIVE_CLICK', { calibration: f.calibration, token });
}
function press(f) {
  const pointer = nativeEvent(f, 'pointerdown');
  const mouse = nativeEvent(f, 'mousedown');
  return [pointer, mouse];
}
function release(f) {
  const pointer = nativeEvent(f, 'pointerup');
  const mouse = nativeEvent(f, 'mouseup');
  return [pointer, mouse];
}

test('a trusted press and release are observed without blocking the game or dispatching synthetic input', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  const prepared = await prepare(f);
  assert.equal(prepared.ok, true);
  assert.deepEqual({ ...prepared.point }, { x: 900, y: 100 }, 'positions remain CSS pixels at DPR 1.5');
  assert.equal(f.document.activeElement, f.canvas);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).stage, 'ready');
  const events = press(f);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).stage, 'pressed');
  f.advanceClock(1100);
  events.push(...release(f));
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).stage, 'released');
  nativeEvent(f, 'pointermove', { clientX: 0, clientY: 0, button: -1, buttons: 0 });
  nativeEvent(f, 'mousemove', { clientX: 0, clientY: 0, button: -1, buttons: 0 });
  for (const event of events) {
    assert.equal(event.prevented, false, 'native input must reach the game');
    assert.equal(event.stopped, false, 'native input must propagate');
  }
  const result = await f.message('END_NATIVE_CLICK', { token: 'native' });
  assert.equal(result.ok, true);
  assert.equal(result.trustedPress, true);
  assert.equal(result.trustedRelease, true);
  assert.ok(result.actualHoldMs >= 1100 && result.actualHoldMs < 1200);
  assert.equal(result.focusedBefore, true);
  assert.equal(result.focusedAfter, true);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
  assert.equal(f.mouseEvents.length, 0, 'page scripts never manufacture mouse events');
  assert.equal(f.sent.length, 0, 'expected browser input does not stop monitoring');
});

test('synthetic events cannot count as a received native press or release', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) nativeEvent(f, type, { isTrusted: false });
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).stage, 'ready');
  const result = await f.message('END_NATIVE_CLICK', { token: 'native' });
  assert.equal(result.trustedPress, false);
  assert.equal(result.trustedRelease, false);
  assert.equal(result.actualHoldMs, null);
});

test('unexpected positions, buttons and extra pointer presses stop monitoring', async () => {
  for (const fields of [
    { clientX: 903 },
    { button: 2, buttons: 2 },
    { isPrimary: false },
    { buttons: 3 },
  ]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    nativeEvent(f, 'pointerdown', fields);
    assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
    assert.equal((await prepare(f, 'again')).ok, false, 'manual input disarms monitoring');
  }
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  press(f);
  nativeEvent(f, 'pointerdown');
  assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
  assert.equal((await f.message('END_NATIVE_CLICK', { token: 'native' })).ok, false);
});

test('missing pointer press or duplicate mouse press cannot masquerade as a native click', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    if (duplicate) press(f);
    nativeEvent(f, 'mousedown');
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
    assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
  }
});

test('manual keys, scrolling and movement away while pressed remain interruption signals', async () => {
  for (const [type, fields] of [
    ['keydown', { key: 'a' }],
    ['wheel', {}],
    ['pointermove', { clientX: 910, buttons: 1 }],
    ['mousemove', { clientX: 910, buttons: 1 }],
    ['pointermove', { clientX: 900, buttons: 2 }],
    ['pointercancel', {}],
  ]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    press(f);
    nativeEvent(f, type, fields);
    assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
    assert.equal(f.mouseEvents.length, 0);
  }
});

test('a pointer release from another pointer or position invalidates the click', async () => {
  for (const fields of [{ pointerId: 9 }, { clientY: 110 }, { button: 2 }]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    press(f);
    nativeEvent(f, 'pointerup', fields);
    assert.equal((await f.message('END_NATIVE_CLICK', { token: 'native' })).ok, false);
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
  }
});

test('hidden, resized, navigated and obstructed pages cannot prepare native input', async () => {
  for (const alter of [
    f => { f.document.visibilityState = 'hidden'; },
    f => { f.context.innerWidth -= 1; },
    f => { f.context.devicePixelRatio = 2; },
    f => { f.context.location.href += '?changed'; },
    f => { f.setObstruction({}); },
  ]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    alter(f);
    assert.equal((await prepare(f)).ok, false);
    assert.equal(f.mouseEvents.length, 0);
  }
});

test('geometry and top-layer checks are repeated immediately before native input stages', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  f.setObstruction({});
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
  assert.equal((await f.message('END_NATIVE_CLICK', { token: 'native' })).ok, false);
  assert.equal(f.mouseEvents.length, 0);
});

test('expired guards no longer authorize browser input', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  f.fireTimer(5000);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
  nativeEvent(f, 'pointerdown');
  assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
});

test('stale tokens cannot end another guard and rearming invalidates the previous one', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f, 'first');
  assert.equal((await f.message('END_NATIVE_CLICK', { token: 'different' })).ok, false);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'first' })).ok, true);
  await f.message('ARM_PAGE');
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'first' })).ok, false);
  await prepare(f, 'second');
  assert.equal((await f.message('END_NATIVE_CLICK', { token: 'first' })).ok, false);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'second' })).ok, true);
  await f.message('END_NATIVE_CLICK', { token: 'second' });
});

test('stopping during popup-close delay prevents later preparation', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  const pending = prepare(f);
  await f.message('DISARM_PAGE');
  assert.equal((await pending).ok, false);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
  assert.equal(f.mouseEvents.length, 0);
});

test('two overlapping preparations cannot both authorize a click', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  const pending = prepare(f, 'one');
  assert.equal((await prepare(f, 'two')).ok, false);
  assert.equal((await pending).ok, true);
  await f.message('END_NATIVE_CLICK', { token: 'one' });
});

test('the calibration trailing-click suppression never swallows the prepared native press', async () => {
  const f = fixture();
  await finishCalibration(f);
  await f.message('ARM_PAGE');
  await prepare(f);
  const events = press(f);
  release(f);
  assert.equal(events.every(event => !event.prevented && !event.stopped), true);
  const result = await f.message('END_NATIVE_CLICK', { token: 'native' });
  assert.equal(result.trustedPress, true);
  assert.equal(result.trustedRelease, true);
});

test('an unfocused game waits and its focus return is debounced without disarming', async () => {
  const f = fixture({ focused: false });
  await f.message('ARM_PAGE');
  assert.equal((await prepare(f)).code, 'FOCUS_REQUIRED');
  assert.equal(f.mouseEvents.length, 0);
  f.setFocus(true);
  f.emit('focus');
  f.emit('focus');
  f.fireTimer(500);
  await flush();
  assert.equal(f.sent.filter(item => item.type === 'PAGE_FOCUSED').length, 1);
  assert.equal((await prepare(f)).ok, true);
  await f.message('END_NATIVE_CLICK', { token: 'native' });
});

test('blur and visibility loss invalidate held input without manufacturing a release', async () => {
  for (const hidden of [false, true]) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    press(f);
    if (hidden) {
      f.document.visibilityState = 'hidden';
      f.emit('visibilitychange', {}, f.documentListeners);
    } else {
      f.setFocus(false);
      f.emit('blur');
    }
    assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
    assert.equal(f.mouseEvents.length, 0, 'the background input owner is responsible for release cleanup');
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 0);
    f.setFocus(true);
    f.document.visibilityState = 'visible';
    assert.equal((await prepare(f, 'returned')).ok, true);
    await f.message('END_NATIVE_CLICK', { token: 'returned' });
  }
});

test('resize and navigation interrupt a prepared click', async () => {
  for (const type of ['resize', 'pagehide', 'popstate', 'hashchange']) {
    const f = fixture();
    await f.message('ARM_PAGE');
    await prepare(f);
    f.emit(type);
    assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).ok, false);
    assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 1);
  }
});

test('one click calibrates the refresh button without a list region', async () => {
  const f = fixture();
  assert.equal((await f.message('CALIBRATE_PAGE')).ok, true);
  assert.equal((await f.message('GET_PAGE_STATE')).calibrating, true);
  const outside = f.emit('pointerdown', { clientX: 50, clientY: 50 });
  assert.equal(outside.stopped, true);
  assert.equal(f.sent.length, 0);
  f.emit('pointerdown', { clientX: 900, clientY: 100 });
  assert.equal(f.sent.length, 0, 'save only after the pointer is released');
  f.emit('pointerup', { clientX: 900, clientY: 100 });
  const trailingClick = f.emit('click', { clientX: 900, clientY: 100 });
  assert.equal(trailingClick.stopped, true, 'the selecting click must not click the game');
  await flush();
  const saved = f.sent.find((message) => message.type === 'CALIBRATION_DONE');
  assert.ok(saved);
  assert.equal(saved.overlayPresent, false);
  assert.equal(saved.calibration.point.x, 0.75);
  assert.equal(saved.calibration.point.y, 0.125);
  assert.equal('region' in saved.calibration, false);
  assert.equal(saved.calibration.anchor.width, 64 / 1200);
  assert.equal(saved.calibration.anchor.height, 40 / 800);
  assert.equal(f.mouseEvents.length, 0);
  assert.equal((await f.message('GET_PAGE_STATE')).calibrating, false);
});

test('dragging or cancelling a pointer does not save an accidental refresh position', async () => {
  const f = fixture();
  await f.message('CALIBRATE_PAGE');
  f.emit('pointerdown', { clientX: 900, clientY: 100 });
  f.emit('pointerup', { clientX: 700, clientY: 300 });
  await flush();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.message('GET_PAGE_STATE')).calibrating, true);
  f.emit('pointerdown', { clientX: 900, clientY: 100 });
  f.emit('pointercancel');
  f.emit('pointerup', { clientX: 900, clientY: 100 });
  await flush();
  assert.equal(f.sent.length, 0);
  f.emit('pointerdown', { clientX: 900, clientY: 100 });
  f.emit('pointerup', { clientX: 900, clientY: 100 });
  await flush();
  assert.equal(f.sent.filter(message => message.type === 'CALIBRATION_DONE').length, 1);
});

test('escape and page resize cancel calibration without saving', async () => {
  const f = fixture();
  await f.message('CALIBRATE_PAGE');
  f.emit('keydown', { key: 'Escape' });
  assert.equal(f.hosts.length, 0);
  f.advanceClock(300);
  await f.message('CALIBRATE_PAGE');
  f.emit('resize');
  assert.equal(f.hosts.length, 0);
  await flush();
  assert.equal(f.sent.filter((message) => message.type === 'CALIBRATION_DONE').length, 0);
  assert.equal(f.sent.filter((message) => message.type === 'CALIBRATION_CANCELLED').length, 2);
});

test('calibration cancel control cancels without selecting a game position', async () => {
  const f = fixture();
  await f.message('CALIBRATE_PAGE');
  const cancelButton = f.hosts[0].shadow.querySelector('.cancel');
  f.emit('pointerdown', { clientX: 900, clientY: 100, composedPath: () => [cancelButton] });
  await flush();
  assert.equal(f.hosts.length, 0);
  assert.equal(f.sent.filter((message) => message.type === 'CALIBRATION_CANCELLED').length, 1);
  assert.equal(f.sent.filter((message) => message.type === 'CALIBRATION_DONE').length, 0);
  assert.equal(f.mouseEvents.length, 0);
});

async function finishCalibration(f) {
  await f.message('CALIBRATE_PAGE');
  f.emit('pointerdown', { clientX: 900, clientY: 100 });
  f.emit('pointerup', { clientX: 900, clientY: 100 });
  await flush();
}

test('calibration shows success only after saving is acknowledged and ARM removes the notice', async () => {
  let acknowledge;
  const f = fixture({ calibrationResponse: () => new Promise((resolve) => { acknowledge = resolve; }) });
  await finishCalibration(f);
  assert.equal(f.notice(), undefined, 'do not claim success while saving is pending');
  acknowledge({ ok: true });
  await flush();
  assert.equal(f.notice().attributes.get('data-mahjong-soul-watch-notice'), 'success');
  assert.equal(f.notice().textContent, '位置を保存しました。拡張機能で監視を開始してください。');
  assert.match(f.notice().style.cssText, /pointer-events:none/);
  await f.message('ARM_PAGE');
  assert.equal(f.notice(), undefined);
});

test('calibration displays failure for a rejected response, a closed channel, or no response', async () => {
  for (const calibrationResponse of [
    () => ({ ok: false, error: '保存失敗' }),
    () => { throw new Error('A listener indicated an asynchronous response, but the message channel closed'); },
    () => undefined,
  ]) {
    const f = fixture({ calibrationResponse });
    await finishCalibration(f);
    assert.equal(f.notice().attributes.get('data-mahjong-soul-watch-notice'), 'error');
    assert.equal(f.notice().textContent, '位置を保存できませんでした。拡張機能を開いて再指定してください。');
    assert.match(f.notice().style.cssText, /pointer-events:none/);
    await f.message('CALIBRATE_PAGE');
    assert.equal(f.notice(), undefined, 'a new calibration clears the old result');
  }
});

test('calibration times out after ten seconds and ignores a late success response', async () => {
  let acknowledge;
  const f = fixture({ calibrationResponse: () => new Promise((resolve) => { acknowledge = resolve; }) });
  await finishCalibration(f);
  assert.equal(f.notice(), undefined);
  f.fireTimer(10_000);
  await flush();
  assert.equal(f.notice().attributes.get('data-mahjong-soul-watch-notice'), 'error');
  acknowledge({ ok: true });
  await flush();
  assert.equal(f.notice().attributes.get('data-mahjong-soul-watch-notice'), 'error');
});

test('a stale save acknowledgement does not cover a new calibration', async () => {
  let acknowledge;
  const f = fixture({ calibrationResponse: () => new Promise((resolve) => { acknowledge = resolve; }) });
  await finishCalibration(f);
  await f.message('CALIBRATE_PAGE');
  acknowledge({ ok: true });
  await flush();
  assert.equal(f.notice(), undefined);
  assert.equal((await f.message('GET_PAGE_STATE')).calibrating, true);
});

test('disarming prevents pending focus recovery from restarting monitoring', async () => {
  const f = fixture({ focused: false });
  await f.message('ARM_PAGE');
  f.setFocus(true);
  f.emit('focus');
  await f.message('DISARM_PAGE');
  f.fireTimer(500);
  await flush();
  assert.equal(f.sent.filter(message => message.type === 'PAGE_FOCUSED').length, 0);
  f.emit('focus');
  f.fireTimer(500);
  await flush();
  assert.equal(f.sent.filter(message => message.type === 'PAGE_FOCUSED').length, 0);
});

test('focus followed by blur before debounce does not request a refresh', async () => {
  const f = fixture({ focused: false });
  await f.message('ARM_PAGE');
  f.setFocus(true);
  f.emit('focus');
  f.setFocus(false);
  f.emit('blur');
  f.fireTimer(500);
  await flush();
  assert.equal(f.sent.filter(message => message.type === 'PAGE_FOCUSED').length, 0);
});


test('an unexpected native event retains the failed stage and coordinates in diagnostics', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  nativeEvent(f, 'pointerdown', { clientX: 903 });
  const report = f.sent.find(item => item.type === 'PAGE_INTERACTION');
  assert.equal(report.detail.event, 'pointerdown');
  assert.equal(report.detail.stage, 'ready');
  assert.equal(report.detail.x, 903);
  assert.equal(report.detail.expectedX, 900);
  assert.equal(report.detail.buttons, 1);
});

test('button-free cursor movement cannot cancel an owned press or reach the game', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  press(f);
  for (const type of ['pointermove', 'mousemove']) {
    const moved = nativeEvent(f, type, { clientX: 1583, clientY: 302, button: -1, buttons: 0 });
    assert.equal(moved.stopped, true);
    assert.equal(moved.prevented, true);
  }
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'native' })).stage, 'pressed');
  f.advanceClock(1000);
  release(f);
  const result = await f.message('END_NATIVE_CLICK', { token: 'native' });
  assert.equal(result.trustedPress, true);
  assert.equal(result.trustedRelease, true);
  assert.equal(result.cursorMovesIgnored, 2);
  assert.ok(result.actualHoldMs >= 1000);
  assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 0);
});

test('cursor shielding covers preparation and release, then ends between clicks and after stopping', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  assert.equal(nativeEvent(f, 'pointermove', { clientX: 950, buttons: 0 }).stopped, false);
  await prepare(f);
  assert.equal(nativeEvent(f, 'pointermove', { clientX: 950, buttons: 0 }).stopped, true);
  assert.equal(nativeEvent(f, 'mousemove', { buttons: 0 }).stopped, false, 'the initial native move to the button reaches the game');
  press(f);
  release(f);
  assert.equal(nativeEvent(f, 'pointermove', { clientX: 950, buttons: 0 }).stopped, true);
  await f.message('END_NATIVE_CLICK', { token: 'native' });
  assert.equal(nativeEvent(f, 'pointermove', { clientX: 950, buttons: 0 }).stopped, false);
  await f.message('DISARM_PAGE');
  assert.equal(nativeEvent(f, 'pointermove', { clientX: 950, buttons: 0 }).stopped, false);
});

test('cursor boundary events and raw moves cannot change game hover state during a native click', async () => {
  const f = fixture();
  await f.message('ARM_PAGE');
  await prepare(f);
  for (const stage of ['ready', 'pressed', 'released']) {
    if (stage === 'pressed') press(f);
    if (stage === 'released') release(f);
    for (const type of ['pointerrawupdate', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
      'mouseover', 'mouseout', 'mouseenter', 'mouseleave']) {
      const moved = nativeEvent(f, type, { clientX: 950, buttons: 0 });
      assert.equal(moved.stopped, true, stage + ' ' + type);
    }
  }
  assert.equal((await f.message('END_NATIVE_CLICK', { token: 'native' })).ok, true);
  assert.equal(f.sent.filter(item => item.type === 'PAGE_INTERACTION').length, 0);
});

test('release shielding remains until the game has had three frames to consume mouseup', async () => {
  const f = fixture({ manualAnimation: true });
  await f.message('ARM_PAGE');
  await prepare(f);
  press(f);
  f.advanceClock(1000);
  release(f);
  let ended = false;
  const ending = f.message('END_NATIVE_CLICK', { token: 'native' }).then(result => { ended = true; return result; });
  for (let frame = 0; frame < 3; frame++) {
    assert.equal(ended, false);
    assert.equal(nativeEvent(f, 'mousemove', { clientX: 950, buttons: 0 }).stopped, true);
    f.frame();
    await flush();
  }
  const result = await ending;
  assert.equal(result.ok, true);
  assert.ok(result.actualHoldMs >= 1000);
  assert.equal(f.pendingFrames, 0);
  assert.equal(nativeEvent(f, 'mousemove', { clientX: 950, buttons: 0 }).stopped, false);
});

test('stopping or a stalled frame loop releases the cursor shield and resolves pending completion', async () => {
  for (const timeout of [false, true]) {
    const f = fixture({ manualAnimation: true });
    await f.message('ARM_PAGE');
    await prepare(f);
    press(f);
    release(f);
    const ending = f.message('END_NATIVE_CLICK', { token: 'native' });
    if (timeout) f.fireTimer(1000);
    else await f.message('DISARM_PAGE');
    assert.equal((await ending).ok, false);
    assert.equal(f.pendingFrames, 0);
    assert.equal(nativeEvent(f, 'mousemove', { clientX: 950, buttons: 0 }).stopped, false);
  }
});

test('a cancelled end cannot clear the cursor shield of a new click', async () => {
  const f = fixture({ manualAnimation: true });
  await f.message('ARM_PAGE');
  await prepare(f, 'old');
  press(f);
  release(f);
  const ending = f.message('END_NATIVE_CLICK', { token: 'old' });
  await f.message('ARM_PAGE');
  await prepare(f, 'new');
  assert.equal((await ending).ok, false);
  assert.equal((await f.message('VALIDATE_NATIVE_CLICK', { token: 'new' })).stage, 'ready');
  assert.equal(nativeEvent(f, 'mousemove', { clientX: 950, buttons: 0 }).stopped, true);
  await f.message('DISARM_PAGE');
});

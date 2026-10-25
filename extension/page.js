(() => {
  'use strict';

  const instanceKey = '__mahjongSoulWatchPageV1';
  if (globalThis[instanceKey]) return;
  globalThis[instanceKey] = true;

  let calibrationState = null;
  let armed = false;
  let interactionRevision = 0;
  let swallowInputUntil = 0;
  let calibrationNotice = null;
  let calibrationNoticeTimer;
  let calibrationRevision = 0;
  let focusRevision = 0;
  let focusTimer;
  let nativeGuard = null;
  let nativeTimer;
  let nativePreparation = null;

  const viewport = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  });
  const plainRect = (rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  const inside = (point, rect) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  const isCanvas = (element) => element instanceof HTMLCanvasElement;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getCanvas() {
    const candidates = [...document.querySelectorAll('canvas')].filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      return rect.width >= 100 && rect.height >= 100 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    return candidates.find((canvas) => canvas.id === 'unity-canvas') || candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0] || null;
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  async function saveCalibrationRequest(calibration) {
    let timeout;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: 'CALIBRATION_DONE', calibration }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('位置の保存がタイムアウトしました。')), 10_000);
        }),
      ]);
      if (response?.ok !== true) throw new Error(response?.error || '位置を保存できませんでした。');
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  function clearCalibrationNotice() {
    clearTimeout(calibrationNoticeTimer);
    calibrationNoticeTimer = undefined;
    calibrationNotice?.remove();
    calibrationNotice = null;
  }

  function showCalibrationNotice(success) {
    clearCalibrationNotice();
    if (!document.body) return;
    const notice = document.createElement('div');
    notice.setAttribute('data-mahjong-soul-watch-notice', success ? 'success' : 'error');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 48px);padding:12px 18px;border:1px solid #637987;border-radius:10px;background:#112331;color:#fff;box-shadow:0 5px 24px #0005;font:600 14px/1.6 system-ui,sans-serif;pointer-events:none;';
    notice.textContent = success
      ? '位置を保存しました。拡張機能で監視を開始してください。'
      : '位置を保存できませんでした。拡張機能を開いて再指定してください。';
    document.body.append(notice);
    calibrationNotice = notice;
    calibrationNoticeTimer = setTimeout(clearCalibrationNotice, 8_000);
  }

  function interrupt(reason, event = null) {
    const guard = nativeGuard;
    const finite = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const detail = {
      event: event?.type || reason,
      stage: guard?.stage || (nativePreparation ? 'preparing' : 'none'),
      x: finite(event?.clientX), y: finite(event?.clientY),
      expectedX: finite(guard?.point.x), expectedY: finite(guard?.point.y),
      button: finite(event?.button), buttons: finite(event?.buttons),
    };
    clearNativeGuard();
    interactionRevision += 1;
    if (!armed) return;
    armed = false;
    void send({ type: 'PAGE_INTERACTION', reason, detail });
  }

  function cancelCalibration(notify = true) {
    if (!calibrationState) return;
    calibrationState.host.remove();
    calibrationState = null;
    swallowInputUntil = performance.now() + 250;
    if (notify) void send({ type: 'CALIBRATION_CANCELLED' });
  }

  function getPageState() {
    const canvas = getCanvas();
    return {
      ok: true,
      url: location.href,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      viewport: viewport(),
      canvasRect: canvas ? plainRect(canvas.getBoundingClientRect()) : null,
      calibrating: Boolean(calibrationState),
    };
  }

  function currentViewportMatches(saved) {
    const current = viewport();
    return saved && current.width === saved.width && current.height === saved.height && Math.abs(current.devicePixelRatio - saved.devicePixelRatio) < 0.001;
  }

  function underneathOverlay(x, y) {
    return document.elementsFromPoint(x, y).find((element) => element !== calibrationState?.host) || null;
  }

  function markPoint(state, x, y) {
    state.marker.style.left = `${x - 7}px`;
    state.marker.style.top = `${y - 7}px`;
    state.marker.hidden = false;
  }

  async function saveCalibration(state) {
    const originalViewport = state.viewport;
    if (!currentViewportMatches(originalViewport) || state.url !== location.href) {
      state.title.textContent = '画面サイズが変わりました。位置を指定し直してください';
      state.step = 'point';
      state.point = null;
      state.marker.hidden = true;
      state.viewport = viewport();
      state.url = location.href;
      return;
    }
    const rect = state.canvas.getBoundingClientRect();
    const width = Math.min(64, Math.min(originalViewport.width, rect.right) - Math.max(0, rect.left));
    const height = Math.min(40, Math.min(originalViewport.height, rect.bottom) - Math.max(0, rect.top));
    const anchorX = clamp(state.point.x - width / 2, Math.max(0, rect.left), Math.min(originalViewport.width, rect.right) - width);
    const anchorY = clamp(state.point.y - height / 2, Math.max(0, rect.top), Math.min(originalViewport.height, rect.bottom) - height);
    const normalizedRect = (value) => ({
      x: value.x / originalViewport.width,
      y: value.y / originalViewport.height,
      width: value.width / originalViewport.width,
      height: value.height / originalViewport.height,
    });
    const calibration = {
      point: { x: state.point.x / originalViewport.width, y: state.point.y / originalViewport.height },
      anchor: normalizedRect({ x: anchorX, y: anchorY, width, height }),
      viewport: originalViewport,
      url: state.url,
    };
    const revision = calibrationRevision;
    cancelCalibration(false);
    await nextFrame();
    await nextFrame();
    if (revision !== calibrationRevision) return;
    try {
      await saveCalibrationRequest(calibration);
      if (revision === calibrationRevision) showCalibrationNotice(true);
    } catch {
      if (revision === calibrationRevision) showCalibrationNotice(false);
    }
  }

  function startCalibration() {
    calibrationRevision += 1;
    clearCalibrationNotice();
    interrupt('calibration');
    cancelCalibration(false);
    const canvas = getCanvas();
    if (!canvas || !document.body) return { ok: false, error: '雀魂の観戦一覧を開いてください。' };
    if (document.visibilityState !== 'visible') return { ok: false, error: '雀魂のタブを表示してください。' };

    const host = document.createElement('div');
    host.setAttribute('data-mahjong-soul-watch-calibration', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:block;pointer-events:auto;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { all: initial; }
      .surface { position: fixed; inset: 0; background: rgba(3, 13, 23, .14); cursor: crosshair; touch-action: none; user-select: none; }
      .prompt { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 20px; max-width: calc(100vw - 48px); padding: 14px 18px; border: 1px solid #637987; border-radius: 12px; background: #112331; color: #fff; box-shadow: 0 5px 30px #0006; font: 600 15px/1.5 system-ui, sans-serif; cursor: default; }
      .title { margin: 0; }
      .cancel { padding: 7px 13px; border: 1px solid #8fa4b1; border-radius: 7px; background: #223c4e; color: white; font: inherit; cursor: pointer; white-space: nowrap; }
      .hint { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px; background: #112331; color: #fff; font: 13px system-ui, sans-serif; pointer-events: none; }
      .marker { position: absolute; width: 14px; height: 14px; box-sizing: border-box; border: 3px solid #fff; outline: 2px solid #52e3bc; border-radius: 50%; background: #15866c; pointer-events: none; }
      [hidden] { display: none; }
    </style>
    <div class="surface" role="dialog" aria-modal="true" aria-label="更新ボタンを指定">
      <div class="prompt"><p class="title" role="status">更新ボタンの中央をクリック</p><button class="cancel" type="button">中止</button></div>
      <div class="marker" hidden></div><div class="hint">Escで中止</div>
    </div>`;
    calibrationState = {
      host,
      canvas,
      shadow,
      title: shadow.querySelector('.title'),
      marker: shadow.querySelector('.marker'),
      cancelButton: shadow.querySelector('.cancel'),
      step: 'point',
      point: null,
      viewport: viewport(),
      url: location.href,
    };
    document.body.append(host);
    return { ok: true };
  }

  function interceptCalibration(event) {
    const state = calibrationState;
    if (!state) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = event.composedPath();
    if (path.includes(state.cancelButton)) {
      if (event.type === 'pointerdown' || event.type === 'click') cancelCalibration();
      return true;
    }
    if (path.some((element) => element?.classList?.contains('prompt'))) return true;
    if (event.type === 'keydown') {
      if (event.key === 'Escape') cancelCalibration();
      return true;
    }
    if (event.type === 'pointerdown' && event.button === 0 && event.isPrimary !== false) {
      if (state.step === 'saving') return true;
      const point = { x: event.clientX, y: event.clientY };
      const canvas = underneathOverlay(point.x, point.y);
      if (canvas !== state.canvas || !inside(point, state.canvas.getBoundingClientRect())) {
        state.title.textContent = '雀魂の画面内を指定してください';
        return true;
      }
      if (state.step === 'point') {
        state.point = point;
        markPoint(state, point.x, point.y);
        state.step = 'point-up';
      }
    } else if (event.type === 'pointerup' && event.button === 0 && state.step === 'point-up') {
      const release = { x: event.clientX, y: event.clientY };
      const movement = Math.hypot(release.x - state.point.x, release.y - state.point.y);
      if (movement > 16 || !inside(release, state.canvas.getBoundingClientRect())) {
        state.step = 'point';
        state.point = null;
        state.marker.hidden = true;
        state.title.textContent = '更新ボタンの中央をクリック';
      } else {
        state.step = 'saving';
        void saveCalibration(state);
      }
    } else if (event.type === 'pointercancel' && state.step === 'point-up') {
      state.step = 'point';
      state.point = null;
      state.marker.hidden = true;
    }
    return true;
  }

  const focusRequired = () => ({
    ok: false, code: 'FOCUS_REQUIRED',
    error: 'バックグラウンド実行の接続を確認してください。',
  });
  function notifyFocusReturn() {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (armed && document.visibilityState === 'visible' && document.hasFocus()) {
        void send({ type: 'PAGE_FOCUSED' });
      }
    }, 500);
  }
  function clearNativeGuard() {
    nativeGuard?.cancelFinish?.();
    clearTimeout(nativeTimer);
    nativeTimer = undefined;
    nativeGuard = null;
    nativePreparation = null;
  }
  function checkNativePosition(calibration) {
    if (!armed) return { ok: false, error: '監視を開始してください。' };
    if (calibrationState) return { ok: false, error: '更新ボタンの指定を完了してください。' };
    if (document.visibilityState !== 'visible') return { ok: false, error: 'ゲーム画面の表示を確認できませんでした。' };
    if (!document.hasFocus()) return focusRequired();
    if (!currentViewportMatches(calibration?.viewport) || calibration?.url !== location.href) {
      return { ok: false, error: '表示が変わりました。位置を指定し直してください。' };
    }
    const savedPoint = calibration?.point;
    if (!Number.isFinite(savedPoint?.x) || !Number.isFinite(savedPoint?.y) ||
        savedPoint.x < 0 || savedPoint.x > 1 || savedPoint.y < 0 || savedPoint.y > 1) {
      return { ok: false, error: '更新ボタンの位置を指定してください。' };
    }
    const point = { x: savedPoint.x * innerWidth, y: savedPoint.y * innerHeight };
    const canvas = document.elementFromPoint(point.x, point.y);
    if (!isCanvas(canvas) || canvas !== getCanvas() || !inside(point, canvas.getBoundingClientRect())) {
      return { ok: false, error: '更新ボタンが別の画面に覆われています。' };
    }
    return { ok: true, point, canvas };
  }
  async function prepareNativeClick(calibration, token) {
    if (typeof token !== 'string' || !token || token.length > 128) {
      return { ok: false, error: 'クリックの準備情報が正しくありません。' };
    }
    if (nativeGuard || nativePreparation) return { ok: false, error: '更新操作が進行中です。' };
    if (!armed) return { ok: false, error: '監視を開始してください。' };
    const preparation = { token, revision: interactionRevision, focusRevision };
    nativePreparation = preparation;
    try {
      // Allow the initiating popup to close before the browser delivers input.
      await wait(100);
      if (nativePreparation !== preparation || preparation.revision !== interactionRevision ||
          preparation.focusRevision !== focusRevision) {
        return { ok: false, error: '画面操作を検出したため更新を中止しました。' };
      }
      const checked = checkNativePosition(calibration);
      if (!checked.ok) return checked;
      checked.canvas.focus({ preventScroll: true });
      if (!document.hasFocus()) return focusRequired();
      swallowInputUntil = 0;
      const guard = {
        token, point: checked.point, canvas: checked.canvas,
        calibration: {
          point: { ...calibration.point }, viewport: { ...calibration.viewport }, url: calibration.url,
        },
        revision: interactionRevision, focusRevision,
        deadline: performance.now() + 5000, stage: 'ready',
        pointerId: null, downAt: null, upAt: null,
        focusedBefore: null, focusedAfter: null, cursorMovesIgnored: 0,
      };
      nativeGuard = guard;
      nativeTimer = setTimeout(() => {
        if (nativeGuard === guard) clearNativeGuard();
      }, 5000);
      return { ok: true, point: { ...guard.point }, focused: document.hasFocus() };
    } finally {
      if (nativePreparation === preparation) nativePreparation = null;
    }
  }
  function nativeGuardValid(guard) {
    if (!guard || guard !== nativeGuard || performance.now() >= guard.deadline ||
        !armed || guard.revision !== interactionRevision || guard.focusRevision !== focusRevision) return false;
    const checked = checkNativePosition(guard.calibration);
    return checked.ok && checked.canvas === guard.canvas;
  }
  function validateNativeClick(token) {
    const guard = nativeGuard;
    if (!guard || token !== guard.token) return { ok: false, error: 'クリックの受付が終了しました。' };
    if (!nativeGuardValid(guard)) {
      clearNativeGuard();
      return { ok: false, error: '画面操作を検出したため更新を中止しました。' };
    }
    return { ok: true, stage: guard.stage };
  }
  function settleNativeRelease(guard) {
    // Unity consumes mouse state in its frame loop, after DOM mouseup returns.
    // Keep the cursor shield until subsequent frames have consumed the release.
    return new Promise((resolve) => {
      let frame;
      let timer;
      let frames = 0;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        guard.cancelFinish = null;
        resolve(ok);
      };
      guard.cancelFinish = () => finish(false);
      const tick = () => {
        if (!nativeGuardValid(guard)) return finish(false);
        if (++frames >= 3) return finish(true);
        frame = requestAnimationFrame(tick);
      };
      timer = setTimeout(() => finish(false), 1000);
      frame = requestAnimationFrame(tick);
    });
  }
  async function endNativeClick(token) {
    const guard = nativeGuard;
    if (!guard || guard.token !== token) {
      if (nativePreparation?.token === token) clearNativeGuard();
      return { ok: false, error: 'クリックの受付が終了しました。' };
    }
    if (guard.ending) return { ok: false, error: 'クリックの受付が終了しました。' };
    guard.ending = true;
    if (guard.stage === 'released' && !(await settleNativeRelease(guard))) {
      if (nativeGuard === guard) clearNativeGuard();
      return { ok: false, error: 'クリックの受付が終了しました。' };
    }
    const result = {
      ok: true,
      actualHoldMs: guard.downAt != null && guard.upAt != null ? Math.round(guard.upAt - guard.downAt) : null,
      trustedPress: guard.downAt != null,
      trustedRelease: guard.upAt != null,
      focusedBefore: guard.focusedBefore,
      focusedAfter: guard.focusedAfter,
      cursorMovesIgnored: guard.cursorMovesIgnored,
    };
    clearNativeGuard();
    return result;
  }
  function nativePointMatches(event, guard, buttons) {
    return event.button === 0 &&
      Math.abs(event.clientX - guard.point.x) <= 2 &&
      Math.abs(event.clientY - guard.point.y) <= 2 &&
      (event.buttons == null || event.buttons === buttons);
  }
  function observeNativeInput(event) {
    const guard = nativeGuard;
    if (!event.isTrusted || !guard) return false;
    if (!nativeGuardValid(guard)) {
      interrupt('native-invalidated', event);
      return false;
    }
    if (event.type === 'pointerdown') {
      if (guard.stage === 'ready' && event.isPrimary !== false && nativePointMatches(event, guard, 1)) {
        guard.stage = 'pressed';
        guard.pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
        return true;
      }
      interrupt('interaction', event);
      return false;
    }
    if (event.type === 'mousedown') {
      if (guard.stage === 'pressed' && guard.downAt == null && nativePointMatches(event, guard, 1)) {
        guard.downAt = performance.now();
        guard.focusedBefore = document.hasFocus();
        return true;
      }
      interrupt('interaction', event);
      return false;
    }
    if (event.type === 'pointerup') {
      if (guard.stage === 'pressed' && nativePointMatches(event, guard, 0) &&
          (guard.pointerId == null || guard.pointerId === event.pointerId)) return true;
      interrupt('interaction', event);
      return false;
    }
    if (event.type === 'mouseup') {
      if (guard.stage === 'pressed' && guard.downAt != null && nativePointMatches(event, guard, 0)) {
        guard.upAt = performance.now();
        guard.focusedAfter = document.hasFocus();
        guard.stage = 'released';
        return true;
      }
      interrupt('interaction', event);
      return false;
    }
    const cursorEvent = ['pointermove', 'pointerrawupdate', 'mousemove',
      'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
      'mouseover', 'mouseout', 'mouseenter', 'mouseleave'].includes(event.type);
    const atPoint = Math.abs(event.clientX - guard.point.x) <= 2 &&
      Math.abs(event.clientY - guard.point.y) <= 2;
    if (cursorEvent && event.buttons === 0 && !(guard.stage === 'ready' && atPoint)) {
      // The physical cursor is independent of Chrome's injected coordinates.
      // Shield the complete operation, including preparation and frame processing
      // after mouseup. Ending at mouseup lets a real move replace the game's
      // cursor position before Unity consumes the queued button release.
      guard.cursorMovesIgnored += 1;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    if (guard.stage === 'pressed' &&
        (event.type === 'pointermove' || event.type === 'mousemove' || event.type === 'pointercancel')) {
      if (event.type === 'pointercancel' ||
          Math.abs(event.clientX - guard.point.x) > 2 ||
          Math.abs(event.clientY - guard.point.y) > 2 ||
          (event.buttons != null && event.buttons !== 1)) {
        interrupt('interaction', event);
      }
    }
    return false;
  }

  const captureTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerrawupdate', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup'];
  for (const type of captureTypes) {
    window.addEventListener(type, (event) => {
      if (interceptCalibration(event)) return;
      if (event.isTrusted && performance.now() < swallowInputUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const expectedNativeInput = observeNativeInput(event);
      if (event.isTrusted && !expectedNativeInput && (type === 'pointerdown' || type === 'keydown' || type === 'wheel')) interrupt('interaction', event);
    }, { capture: true, passive: false });
  }
  window.addEventListener('blur', () => {
    clearNativeGuard();
    focusRevision += 1;
    interactionRevision += 1;
    clearTimeout(focusTimer);
  });
  window.addEventListener('focus', notifyFocusReturn);
  window.addEventListener('resize', () => { interrupt('resize'); cancelCalibration(); });
  window.addEventListener('pagehide', () => { interrupt('navigation'); cancelCalibration(); });
  window.addEventListener('popstate', () => { interrupt('navigation'); cancelCalibration(); });
  window.addEventListener('hashchange', () => { interrupt('navigation'); cancelCalibration(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      clearNativeGuard();
      interactionRevision += 1;
      focusRevision += 1;
      clearTimeout(focusTimer);
    } else {
      notifyFocusReturn();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    switch (message?.type) {
      case 'CALIBRATE_PAGE':
        respond(startCalibration());
        return false;
      case 'CANCEL_CALIBRATION':
        cancelCalibration();
        respond({ ok: true });
        return false;
      case 'GET_PAGE_STATE':
        respond(getPageState());
        return false;
      case 'ARM_PAGE':
        clearNativeGuard();
        interactionRevision += 1;
        calibrationRevision += 1;
        clearCalibrationNotice();
        armed = true;
        respond({ ok: true });
        return false;
      case 'DISARM_PAGE':
        clearNativeGuard();
        clearTimeout(focusTimer);
        armed = false;
        interactionRevision += 1;
        respond({ ok: true });
        return false;
      case 'PREPARE_NATIVE_CLICK':
        prepareNativeClick(message.calibration, message.token).then(respond, () => respond({ ok: false, error: '更新ボタンの準備ができませんでした。' }));
        return true;
      case 'VALIDATE_NATIVE_CLICK':
        respond(validateNativeClick(message.token));
        return false;
      case 'END_NATIVE_CLICK':
        endNativeClick(message.token).then(respond, () => respond({ ok: false, error: 'クリックの受付が終了しました。' }));
        return true;
      case 'CLICK_REFRESH':
        respond({ ok: false, error: '拡張機能と雀魂のページを再読み込みしてください。' });
        return false;
      default:
        return false;
    }
  });
})();

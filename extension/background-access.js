import { isGameUrl } from "./core.js";

let current = null;
let lifecycle = Promise.resolve();
const preparations = new Set();
const storedKey = "backgroundTabId";
const CAPTURE_TIMEOUT_MS = 8000;
const CLEANUP_TIMEOUT_MS = 1000;
const CLICK_TIMEOUT_MS = 5000;
let activeClick = null;
let clickPending = false;

function withTimeout(operation, milliseconds, errorFactory) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(errorFactory()), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
function captureTimeoutError() {
  const error = new Error("雀魂の画面取得が8秒以内に完了しなかったため、監視を停止しました。");
  error.code = "BACKGROUND_CAPTURE_TIMEOUT";
  return error;
}

function serialize(operation) {
  const task = lifecycle.then(operation);
  lifecycle = task.catch(() => {});
  return task;
}
function target(connection) { return { tabId: connection.tabId }; }
function owns(connection) { return current === connection && !connection.forgotten; }
function cancelled(request) {
  if (request.cancelled) throw new Error("バックグラウンド更新の準備を中止しました。");
}
async function validTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("雀魂のタブを開いてください。");
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch (cause) { throw new Error("雀魂のタブが閉じられました。", { cause }); }
  if (!isGameUrl(tab.url)) throw new Error("バックグラウンド更新は雀魂のタブだけで使用できます。");
  if (tab.discarded) throw new Error("雀魂のタブが休止しています。再読み込みしてください。");
  return tab;
}
async function clearStored(tabId) {
  const stored = await chrome.storage.session.get(storedKey);
  if (stored[storedKey] === tabId) await chrome.storage.session.remove(storedKey);
}
async function dispose(connection, bounded = false) {
  const finish = operation => bounded
    ? withTimeout(operation, CLEANUP_TIMEOUT_MS, () => new Error("接続の終了処理が時間内に完了しませんでした。"))
    : operation;
  if (!owns(connection)) return;
  connection.stopping = true;
  try {
    // Never run page commands after the tab has navigated to another origin.
    try {
      await finish(validTab(connection.tabId));
      if (owns(connection)) {
        await finish(chrome.debugger.sendCommand(target(connection), "Emulation.setFocusEmulationEnabled", { enabled: false }));
      }
    } catch { /* Detach below also clears the browser's emulation state. */ }
  } finally {
    if (owns(connection)) {
      // Forget ownership before detach so its notification cannot revive this session.
      current = null;
      connection.forgotten = true;
      try {
        // Clear the persisted owner before detach can emit a delayed onDetach.
        await finish(clearStored(connection.tabId));
      } finally {
        await finish(chrome.debugger.detach(target(connection))).catch(() => {});
      }
    }
  }
}
async function restoreStored() {
  if (current) return current;
  const stored = await chrome.storage.session.get(storedKey);
  const tabId = stored[storedKey];
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  try {
    await validTab(tabId);
    // Only this extension's own debugging connection can accept this command.
    await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
    current = { tabId, stopping: false, forgotten: false };
    return current;
  } catch {
    // A stale record must not leave our old connection on a different page.
    try { await clearStored(tabId); }
    finally { await chrome.debugger.detach({ tabId }).catch(() => {}); }
    return null;
  }
}

export function ensureBackgroundAccess(tabId) {
  const request = { tabId, cancelled: false };
  preparations.add(request);
  return serialize(async () => {
    let connection = null;
    let attachedHere = false;
    try {
      cancelled(request);
      await validTab(tabId);
      cancelled(request);
      await restoreStored();
      cancelled(request);
      if (current && current.tabId !== tabId) await dispose(current);
      cancelled(request);
      if (current) {
        try {
          await chrome.debugger.sendCommand(target(current), "Page.getLayoutMetrics", {});
          connection = current;
        } catch {
          await dispose(current);
        }
      }
      cancelled(request);
      if (!connection) {
        try { await chrome.debugger.attach({ tabId }, "1.3"); }
        catch (cause) {
          throw new Error("ブラウザーの操作機能に接続できませんでした。雀魂の開発者ツールや、同じタブを操作している拡張機能を閉じてください。", { cause });
        }
        connection = { tabId, stopping: false, forgotten: false };
        current = connection;
        attachedHere = true;
      }
      cancelled(request);
      await validTab(tabId);
      if (!owns(connection) || connection.stopping) throw new Error("バックグラウンド更新の接続が解除されました。");
      await chrome.debugger.sendCommand(target(connection), "Emulation.setFocusEmulationEnabled", { enabled: true });
      cancelled(request);
      if (!owns(connection) || connection.stopping) throw new Error("バックグラウンド更新の接続が解除されました。");
      await chrome.storage.session.set({ [storedKey]: tabId });
      cancelled(request);
      return { tabId };
    } catch (error) {
      // An attach failure must never detach a different debugger.
      if (connection && owns(connection)) await dispose(connection).catch(() => {});
      if (request.cancelled) throw new Error("バックグラウンド更新の準備を中止しました。", { cause: error });
      if (attachedHere && !error.message.startsWith("バックグラウンド")) {
        throw new Error("バックグラウンド更新を準備できませんでした。", { cause: error });
      }
      throw error;
    } finally {
      preparations.delete(request);
    }
  });
}

export function releaseBackgroundAccess(tabId = null) {
  if (activeClick && (tabId == null || activeClick.tabId === tabId)) activeClick.cancel();
  for (const request of preparations) {
    if (tabId == null || request.tabId === tabId) request.cancelled = true;
  }
  if (current && (tabId == null || current.tabId === tabId)) current.stopping = true;
  return serialize(async () => {
    const connection = current || await restoreStored();
    if (connection && (tabId == null || connection.tabId === tabId)) await dispose(connection);
  });
}

export function forgetBackgroundAccess(tabId) {
  const pendingAtNotice = [...preparations].filter(request => request.tabId === tabId);
  return serialize(async () => {
    const stored = await chrome.storage.session.get(storedKey);
    const recorded = stored[storedKey] === tabId;
    const connection = current?.tabId === tabId ? current : null;
    if (!connection && !recorded) return false;
    try {
      await validTab(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
      // A working owned connection can belong to a later explicit START.
      // Do not let the old session's delayed notification destroy that connection.
      return false;
    } catch { /* The browser really removed this extension's connection. */ }
    for (const request of pendingAtNotice) request.cancelled = true;
    if (connection && current === connection) {
      connection.forgotten = true;
      current = null;
    }
    if (recorded) await clearStored(tabId);
    return true;
  });
}

function viewportClip(metrics) {
  const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
  if (!viewport) throw new Error("雀魂の表示範囲を取得できませんでした。");
  const { pageX: x, pageY: y, clientWidth: width, clientHeight: height } = viewport;
  if (![x, y, width, height].every(Number.isFinite) ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      width > 16384 || height > 16384 || width * height > 34_000_000) {
    throw new Error("雀魂の表示範囲が正しくありません。ウィンドウを開き直してください。");
  }
  // CSS coordinates; do not multiply these by the device pixel ratio.
  return { x, y, width, height, scale: 1 };
}

export function captureBackgroundTab(tabId) {
  return serialize(async () => {
    await validTab(tabId);
    const connection = current || await restoreStored();
    if (!connection || connection.tabId !== tabId || connection.stopping || !owns(connection)) {
      throw new Error("バックグラウンド更新の接続を準備してください。");
    }
    // This captures the watched tab, never whichever tab happens to be visible.
    let result;
    try {
      result = await withTimeout((async () => {
        const metrics = await chrome.debugger.sendCommand(target(connection), "Page.getLayoutMetrics", {});
        const clip = viewportClip(metrics);
        if (!owns(connection) || connection.stopping) throw new Error("画面取得中に監視が停止しました。");
        await validTab(tabId);
        if (!owns(connection) || connection.stopping) throw new Error("画面取得中に監視が停止しました。");
        return chrome.debugger.sendCommand(target(connection), "Page.captureScreenshot", {
          format: "png", fromSurface: true, captureBeyondViewport: true, clip,
        });
      })(), CAPTURE_TIMEOUT_MS, captureTimeoutError);
    } catch (error) {
      if (error.code === "BACKGROUND_CAPTURE_TIMEOUT") {
        // A stalled screenshot must not hold the lifecycle queue indefinitely.
        // Promise.race ignores any later screenshot result from this old session.
        await dispose(connection, true).catch(() => {});
      }
      throw error;
    }
    if (!owns(connection) || connection.stopping) throw new Error("画面取得中に監視が停止しました。");
    await validTab(tabId);
    if (!owns(connection) || connection.stopping) throw new Error("画面取得中に監視が停止しました。");
    if (typeof result?.data !== "string" || !result.data || result.data.length > 23_999_978 ||
        result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) {
      throw new Error("雀魂の画面画像を取得できませんでした。");
    }
    return "data:image/png;base64," + result.data;
  });
}


function clickTimeoutError() {
  const error = new Error("クリック操作が5秒以内に完了しなかったため、監視を停止しました。");
  error.code = "BACKGROUND_CLICK_TIMEOUT";
  return error;
}

/**
 * Use Chrome's input path while retaining the extension-owned background session.
 * validate must only inspect the page; attachment lifecycle remains owned here.
 */
export function clickBackgroundTab(tabId, point, holdMs, validate) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
      !Number.isInteger(holdMs) || holdMs < 100 || holdMs > 2000 || typeof validate !== "function") {
    return Promise.reject(new Error("更新ボタンの位置と押下時間を確認してください。"));
  }
  if (clickPending) return Promise.reject(new Error("更新操作が進行中です。"));
  clickPending = true;
  const position = { x: point.x, y: point.y };
  return serialize(async () => {
    let connection = null;
    let pressed = false;
    let pressedAt = 0;
    let releasedAt = 0;
    let abortResolve;
    const aborted = new Promise(resolve => { abortResolve = resolve; });
    const operation = {
      tabId, aborted: false, error: null,
      cancel(error = new Error("クリック操作を中止しました。")) {
        if (this.aborted) return;
        this.aborted = true;
        this.error = error;
        abortResolve();
      },
    };
    activeClick = operation;
    const assertCurrent = () => {
      if (operation.aborted) throw operation.error;
      if (!connection || connection.tabId !== tabId || !owns(connection) || connection.stopping) {
        throw new Error("クリック操作の接続が解除されました。");
      }
    };
    const interruptible = promise => Promise.race([
      promise,
      aborted.then(() => { throw operation.error; }),
    ]);
    const delay = milliseconds => {
      let timer;
      const waiting = new Promise(resolve => { timer = setTimeout(resolve, milliseconds); });
      return interruptible(waiting).finally(() => clearTimeout(timer));
    };
    const check = async () => {
      assertCurrent();
      await interruptible(validTab(tabId));
      assertCurrent();
      if (!(await interruptible(validate()))) throw new Error("画面操作を検出したため更新を中止しました。");
      assertCurrent();
    };
    const command = async (type, x, y, button, buttons, clickCount = 0) => {
      assertCurrent();
      // Recheck after the caller's validation callback, which can run asynchronously.
      await interruptible(validTab(tabId));
      assertCurrent();
      if (type === "mousePressed") {
        // A rejected transport may already have delivered the press.
        pressed = true;
        pressedAt = performance.now();
      }
      await interruptible(chrome.debugger.sendCommand(target(connection), "Input.dispatchMouseEvent", {
        type, x, y, button, buttons, clickCount, pointerType: "mouse",
      }));
      if (type === "mouseReleased") {
        releasedAt = performance.now();
        pressed = false;
      }
    };
    const releaseSafely = async () => {
      if (!pressed || !connection || !owns(connection)) return;
      try {
        await withTimeout(validTab(tabId), CLEANUP_TIMEOUT_MS, () => new Error("クリック解放先を確認できませんでした。"));
        if (!owns(connection)) return;
        // Release outside the refresh control; never target a replacement session.
        await withTimeout(chrome.debugger.sendCommand(target(connection), "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: -1, y: -1, button: "left",
          buttons: 0, clickCount: 0, pointerType: "mouse",
        }), CLEANUP_TIMEOUT_MS, () => new Error("クリックを時間内に解放できませんでした。"));
        pressed = false;
      } catch { /* Detach below resets an input session that cannot be released safely. */ }
    };
    try {
      const work = (async () => {
        await interruptible(validTab(tabId));
        connection = current || await interruptible(restoreStored());
        await check();
        await command("mouseMoved", position.x, position.y, "none", 0);
        await delay(50);
        await check();
        await command("mousePressed", position.x, position.y, "left", 1, 1);
        await delay(holdMs);
        await check();
        await command("mouseReleased", position.x, position.y, "left", 0, 1);
        await delay(100);
        await check();
        await command("mouseMoved", 0, 0, "none", 0);
        return { configuredHoldMs: holdMs, actualHoldMs: Math.round(releasedAt - pressedAt) };
      })();
      return await withTimeout(work, CLICK_TIMEOUT_MS, () => {
        const error = clickTimeoutError();
        operation.cancel(error);
        return error;
      });
    } finally {
      operation.cancel();
      await releaseSafely();
      // Stop/timeout or a failed release must not leave an input session pressed.
      if (connection && owns(connection) &&
          (pressed || operation.error?.code === "BACKGROUND_CLICK_TIMEOUT")) {
        await dispose(connection, true).catch(() => {});
      }
      if (activeClick === operation) activeClick = null;
    }
  }).finally(() => { clickPending = false; });
}

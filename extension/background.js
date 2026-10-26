import {
  DEFAULT_SETTINGS, ALARM_NAME, isGameUrl, validateSettings, validateCalibration,
  sameViewport, summarizeLiveGames, matchLiveGames, notificationPlan, validateLivePacket, isOlderLivePacket,
} from "./core.js";
import { decodeLiveListFrame } from "./network-protocol.js";
import { ensureBackgroundAccess, releaseBackgroundAccess, forgetBackgroundAccess, clickBackgroundTab } from "./background-access.js";

let epoch = 0;
let running = false;
let pendingFocusResume = null;
let controlQueue = Promise.resolve();
let networkQueue = Promise.resolve();
let statusQueue = Promise.resolve();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const initialStatus = { state: "stopped", message: "更新ボタンを指定してください。", checkedAt: null, matchedNames: [] };
const liveKey = tabId => "live:" + tabId;
const requestKey = tabId => "live-request:" + tabId;
function reportUnexpected(error) { console.error("観戦ウォッチ", error); }

async function initialize() {
  const { settings, stateVersion } = await chrome.storage.local.get(["settings", "stateVersion"]);
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  if (stateVersion !== "background-v1") {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.session.remove(["monitor", "status", "calibration", "pendingCalibration", "presence"]);
    await chrome.storage.local.set({ stateVersion: "background-v1" });
  }
  const { monitor, status } = await chrome.storage.session.get(["monitor", "status"]);
  if (!status) await chrome.storage.session.set({ status: initialStatus });
  if (monitor?.enabled && !(await chrome.alarms.get(ALARM_NAME))) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: (settings?.intervalSeconds ?? 60) / 60 });
  }
}
const ready = initialize();

async function state() {
  const { settings } = await chrome.storage.local.get("settings");
  const session = await chrome.storage.session.get(["monitor", "status", "calibration", "backgroundTabId"]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const snapshot = tab?.id ? (await chrome.storage.session.get(liveKey(tab.id)))[liveKey(tab.id)] : null;
  return {
    ok: true, settings: settings ?? DEFAULT_SETTINGS,
    monitor: session.monitor ?? { enabled: false, tabId: null },
    status: session.monitor?.enabled ? (session.status ?? initialStatus) : {
      ...(session.status ?? initialStatus),
      ...(snapshot?.errorCode === 0 ? summarizeLiveGames(snapshot.games) : {}),
    },
    calibrated: Boolean(session.calibration && tab?.id === session.calibration.tabId),
    backgroundAttached: Number.isInteger(session.backgroundTabId),
  };
}

async function isCurrent(run) {
  if (run.epoch !== epoch) return false;
  const { monitor } = await chrome.storage.session.get("monitor");
  return monitor?.enabled && monitor.token === run.token && run.epoch === epoch;
}
function statusFor(run, patch) {
  const task = statusQueue.then(async () => {
    if (run && !(await isCurrent(run))) return;
    const { status } = await chrome.storage.session.get("status");
    if (run && run.epoch !== epoch) return;
    const current = status ?? initialStatus;
    const update = typeof patch === "function" ? patch(current) : patch;
    await chrome.storage.session.set({ status: { ...current, ...update } });
  });
  statusQueue = task.catch(() => {});
  return task;
}
async function stop(message = "監視を停止しました。") {
  epoch += 1;
  const { monitor, status, pendingCalibration } = await chrome.storage.session.get(["monitor", "status", "pendingCalibration"]);
  await chrome.storage.session.set({
    monitor: { enabled: false, tabId: monitor?.tabId ?? null },
    status: { ...initialStatus, ...status, state: "stopped", message },
  });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.action.setBadgeText({ text: "" });
  if (monitor?.tabId) await chrome.tabs.sendMessage(monitor.tabId, { type: "DISARM_PAGE" }).catch(() => {});
  await chrome.storage.session.remove("pendingCalibration");
  if (pendingCalibration?.tabId) {
    await chrome.tabs.sendMessage(pendingCalibration.tabId, { type: "CANCEL_CALIBRATION" }).catch(() => {});
  }
  await releaseBackgroundAccess().catch(reportUnexpected);
}
async function activeGameTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isGameUrl(tab.url)) throw new Error("雀魂の観戦一覧を開き、そのタブで拡張機能を開いてください。");
  return tab;
}
async function pageMessage(tabId, message) {
  let result;
  try { result = await chrome.tabs.sendMessage(tabId, message); }
  catch { throw new Error("雀魂のページを再読み込みし、更新ボタンを指定し直してください。"); }
  if (!result?.ok) {
    const error = new Error(result?.error || "ゲーム画面に接続できませんでした。");
    error.code = result?.code;
    throw error;
  }
  return result;
}
async function stablePage(tabId) {
  await sleep(250);
  let previous = null;
  let unchanged = 0;
  for (let count = 0; count < 15; count += 1) {
    const page = await pageMessage(tabId, { type: "GET_PAGE_STATE" });
    unchanged = previous && sameViewport(previous.viewport, page.viewport) ? unchanged + 1 : 0;
    if (unchanged >= 2) return page;
    previous = page;
    await sleep(100);
  }
  throw new Error("画面サイズが安定してから、更新ボタンを指定してください。");
}
async function inspectGamePage(tabId, calibration, requireFocus = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGameUrl(tab.url) || tab.discarded) throw new Error("雀魂のタブを再読み込みしてください。");
  const { backgroundTabId } = await chrome.storage.session.get("backgroundTabId");
  if (backgroundTabId !== tabId) throw new Error("バックグラウンド実行を開始し直してください。");
  // Check the connection without taking screenshots or changing viewport state.
  await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
  const page = await pageMessage(tabId, { type: "GET_PAGE_STATE" });
  if (!page.visible || page.calibrating || (requireFocus && page.focused !== true)) {
    throw new Error("バックグラウンド実行を確認できません。監視を開始し直してください。");
  }
  if (calibration && (!sameViewport(calibration.viewport, page.viewport) || calibration.url !== page.url)) {
    throw new Error("画面サイズが変わりました。更新ボタンを指定し直してください。");
  }
  const rect = page.canvasRect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width < 100 || rect.height < 100) {
    throw new Error("雀魂のゲーム画面を確認できませんでした。");
  }
  if (calibration) {
    const x = calibration.point.x * page.viewport.width;
    const y = calibration.point.y * page.viewport.height;
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) {
      throw new Error("更新ボタンの位置を指定し直してください。");
    }
  }
  return page;
}

async function calibrate(settings) {
  const saved = validateSettings(settings);
  const tab = await activeGameTab();
  await stop();
  await chrome.storage.local.set({ settings: saved });
  try {
    await ensureBackgroundAccess(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page.js"] });
    await stablePage(tab.id);
    await chrome.storage.session.remove("calibration");
    await chrome.storage.session.set({
      pendingCalibration: { tabId: tab.id },
      status: { ...initialStatus, message: "更新ボタンの中央をクリックしてください。" },
    });
    await pageMessage(tab.id, { type: "CALIBRATE_PAGE" });
    return state();
  } catch (error) {
    await stop(error.message);
    throw error;
  }
}
async function calibrationDone(message, sender) {
  const { pendingCalibration } = await chrome.storage.session.get("pendingCalibration");
  if (pendingCalibration?.tabId !== sender.tab.id) throw new Error("更新ボタンを指定し直してください。");
  const calibration = validateCalibration(message.calibration);
  await statusFor(null, { state: "calibrating", message: "位置を保存しています。" });
  await inspectGamePage(sender.tab.id, calibration);
  const { referenceAnchor: _legacyAnchor, ...coordinates } = calibration;
  const current = await chrome.storage.session.get("pendingCalibration");
  if (current.pendingCalibration?.tabId !== sender.tab.id) throw new Error("位置指定が中止されました。");
  await chrome.storage.session.set({
    calibration: { ...coordinates, tabId: sender.tab.id },
    status: { ...initialStatus, message: "位置を保存しました。監視を開始してください。" },
  });
  await chrome.storage.session.remove("pendingCalibration");
  return { ok: true };
}

async function recordRequest(tabId, request) {
  if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 160 ||
      !Number.isSafeInteger(request.requestedAt) || request.requestedAt <= 0 ||
      !Number.isInteger(request.filterId) || request.filterId < 0 || request.filterId > 0xffffffff) {
    throw new Error("更新要求の形式を確認できませんでした。");
  }
  const key = requestKey(tabId);
  const previous = (await chrome.storage.session.get(key))[key];
  if (previous?.requestId === request.requestId) return { ok: true };
  if (!isOlderLivePacket(previous, request)) await chrome.storage.session.set({ [key]: request });
  return { ok: true };
}
function patchAttempt(run, patch) {
  return statusFor(run, current => ({ lastAttempt: { ...current.lastAttempt, ...patch } }));
}

function queuePacket(tabId, packet) {
  const task = networkQueue.then(() => acceptPacket(tabId, packet));
  networkQueue = task.catch(() => {});
  return task;
}
async function acceptPacket(tabId, packet) {
  validateLivePacket(packet);
  const decoded = decodeLiveListFrame(new Uint8Array(packet.frame));
  const key = liveKey(tabId);
  const previous = (await chrome.storage.session.get(key))[key];
  if (isOlderLivePacket(previous, packet)) return { ok: true };
  const snapshot = {
    requestId: packet.requestId, requestedAt: packet.requestedAt, receivedAt: packet.receivedAt,
    filterId: packet.filterId, errorCode: decoded.errorCode, games: decoded.games,
  };
  await chrome.storage.session.set({ [key]: snapshot });
  await processSnapshot(tabId, snapshot);
  return { ok: true };
}
async function processSnapshot(tabId, snapshot) {
  const { monitor } = await chrome.storage.session.get("monitor");
  if (!monitor?.enabled || monitor.tabId !== tabId || snapshot.requestedAt < monitor.startedAt) return;
  const run = { token: monitor.token, epoch };
  if (snapshot.errorCode) {
    await statusFor(run, { state: "waiting", message: "観戦一覧の取得に失敗しました（" + snapshot.errorCode + "）。" });
    return;
  }
  const { settings } = await chrome.storage.local.get("settings");
  const matches = matchLiveGames(snapshot.games, settings.names);
  const { notifiedGames = {}, notificationTabs = {} } = await chrome.storage.session.get(["notifiedGames", "notificationTabs"]);
  const plan = notificationPlan(notifiedGames, matches, Date.now());
  if (!(await isCurrent(run))) return;
  if (plan.fresh.length) {
    const id = "spectator-" + crypto.randomUUID();
    const tabs = Object.fromEntries(Object.entries(notificationTabs).slice(-49));
    tabs[id] = tabId;
    await chrome.storage.session.set({ notificationTabs: tabs });
    if (!(await isCurrent(run))) return;
    const names = [...new Set(plan.fresh.map(match => match.nickname))];
    await chrome.notifications.create(id, {
      type: "basic", iconUrl: "icons/icon128.png", title: "観戦一覧で見つかりました",
      message: names.join("、"), contextMessage: "雀魂 観戦ウォッチ",
    });
  }
  if (!(await isCurrent(run))) return;
  await chrome.storage.session.set({ notifiedGames: plan.next });
  await statusFor(run, {
    state: "running", waitReason: null, message: matches.length ? "指定ユーザーを検出しました。" : "監視中",
    checkedAt: snapshot.receivedAt, matchedNames: [...new Set(matches.map(match => match.nickname))],
    requestId: snapshot.requestId, filterId: snapshot.filterId,
    ...summarizeLiveGames(snapshot.games),
  });
}

async function start(settings) {
  if (running) throw new Error("前回の更新が終了してから、監視を開始してください。");
  const saved = validateSettings(settings);
  const tab = await activeGameTab();
  const { calibration } = await chrome.storage.session.get("calibration");
  if (!calibration || calibration.tabId !== tab.id) throw new Error("先に更新ボタンを指定してください。");
  const startEpoch = ++epoch;
  try {
    await ensureBackgroundAccess(tab.id);
    const page = await stablePage(tab.id);
    if (!sameViewport(calibration.viewport, page.viewport) || page.url !== calibration.url) throw new Error("更新ボタンを指定し直してください。");
    let liveState;
    try { liveState = await chrome.tabs.sendMessage(tab.id, { type: "GET_LIVE_STATE" }); } catch {}
    if (!liveState?.ok || !liveState.hookReady) throw new Error("通信監視を準備するため、雀魂のページを再読み込みしてください。");
    if (await chrome.notifications.getPermissionLevel() !== "granted") throw new Error("Chromeの通知を許可してください。");
    await chrome.storage.local.set({ settings: saved });
    if (epoch !== startEpoch) return state();
    await chrome.storage.session.set({
      monitor: { enabled: true, tabId: tab.id, token: crypto.randomUUID(), startedAt: Date.now() },
      status: { ...initialStatus, state: "running", message: "監視を開始しました。" },
    });
    await pageMessage(tab.id, { type: "ARM_PAGE" });
    if (epoch !== startEpoch) { await stop(); return state(); }
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: saved.intervalSeconds / 60 });
    await chrome.action.setBadgeBackgroundColor({ color: "#16786b" });
    await chrome.action.setBadgeText({ text: "ON" });
    if (epoch !== startEpoch) { await stop(); return state(); }
    void check().catch(reportUnexpected);
    return state();
  } catch (error) {
    await stop(error.message);
    throw error;
  }
}

async function check() {
  if (running) return;
  running = true;
  let run;
  try {
    const { monitor, calibration } = await chrome.storage.session.get(["monitor", "calibration"]);
    if (!monitor?.enabled || !calibration) return;
    run = { token: monitor.token, epoch };
    const tabId = monitor.tabId;
    await inspectGamePage(tabId, calibration, true);
    if (!(await isCurrent(run))) return;
    const previous = (await chrome.storage.session.get(liveKey(tabId)))[liveKey(tabId)];
    const { settings } = await chrome.storage.local.get("settings");
    const { status } = await chrome.storage.session.get("status");
    await statusFor(run, {
      state: "refreshing", waitReason: null, message: "一覧を更新しています。",
      lastAttempt: {
        number: (status?.lastAttempt?.number ?? 0) + 1,
        configuredHoldMs: settings.clickHoldMs ?? 500,
        actualHoldMs: null, focusedBefore: null, focusedAfter: null,
        requestObserved: false, responseReceived: false,
      },
    });
    await pageMessage(tabId, { type: "ARM_PAGE" });
    if (!(await isCurrent(run))) return;
    const requestedAfter = Date.now();
    const inputToken = crypto.randomUUID();
    let clickFailure;
    let input;
    try {
      const prepared = await pageMessage(tabId, { type: "PREPARE_NATIVE_CLICK", calibration, token: inputToken });
      await clickBackgroundTab(tabId, prepared.point, settings.clickHoldMs ?? 500, async () => {
        if (!(await isCurrent(run))) return false;
        const result = await pageMessage(tabId, { type: "VALIDATE_NATIVE_CLICK", token: inputToken });
        return result.ok;
      });
    } catch (error) { clickFailure = error; }
    try { input = await pageMessage(tabId, { type: "END_NATIVE_CLICK", token: inputToken }); }
    catch (error) { if (!clickFailure) clickFailure = error; }
    await patchAttempt(run, {
      inputMethod: "chrome",
      actualHoldMs: Number.isFinite(input?.actualHoldMs) ? input.actualHoldMs : null,
      trustedPress: input?.trustedPress === true, trustedRelease: input?.trustedRelease === true,
      cursorMovesIgnored: Number.isSafeInteger(input?.cursorMovesIgnored) && input.cursorMovesIgnored >= 0 ? input.cursorMovesIgnored : 0,
      focusedBefore: typeof input?.focusedBefore === "boolean" ? input.focusedBefore : null,
      focusedAfter: typeof input?.focusedAfter === "boolean" ? input.focusedAfter : null,
    });
    if (clickFailure) throw clickFailure;
    if (!input.trustedPress || !input.trustedRelease) throw new Error("Chromeの押下・解放がゲーム画面へ届いたことを確認できませんでした。");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!(await isCurrent(run))) return;
      // Pulling the bridge's latest packet also recovers a lost runtime message.
      const liveState = await chrome.tabs.sendMessage(tabId, { type: "GET_LIVE_STATE" }).catch(() => null);
      const latest = liveState?.latest;
      if (liveState?.latestRequest?.requestedAt >= requestedAfter) await recordRequest(tabId, liveState.latestRequest);
      if (latest && latest.requestId !== previous?.requestId && latest.requestedAt >= requestedAfter) {
        await queuePacket(tabId, latest);
        await patchAttempt(run, { requestObserved: true, responseReceived: true });
        return;
      }
      const received = (await chrome.storage.session.get(liveKey(tabId)))[liveKey(tabId)];
      if (received && received.requestId !== previous?.requestId && received.requestedAt >= requestedAfter) {
        await patchAttempt(run, { requestObserved: true, responseReceived: true });
        return;
      }
      await sleep(200);
    }
    if (await isCurrent(run)) {
      const sent = (await chrome.storage.session.get(requestKey(tabId)))[requestKey(tabId)];
      const requestObserved = Boolean(sent && sent.requestedAt >= requestedAfter);
      await patchAttempt(run, { requestObserved, responseReceived: false });
      await stop(requestObserved
        ? "更新要求を検出しましたが、一覧の応答を確認できず停止しました。"
        : "クリック後の更新要求を確認できず停止しました。「動作確認」の診断を確認してください。");
    }
  } catch (error) {
    if (run && await isCurrent(run)) {
      if (["BACKGROUND_CAPTURE_TIMEOUT", "BACKGROUND_CLICK_TIMEOUT"].includes(error.code)) {
        await stop(error.message);
      } else {
        await statusFor(run, {
          state: "waiting", waitReason: error.code === "FOCUS_REQUIRED" ? "focus" : null,
          message: error.message || "次の更新で再試行します。",
        });
      }
    }
  } finally {
    running = false;
    const resumeTabId = pendingFocusResume;
    pendingFocusResume = null;
    if (resumeTabId != null) void resumeOnFocus(resumeTabId).catch(reportUnexpected);
  }
}
async function resumeOnFocus(tabId) {
  const { monitor, status } = await chrome.storage.session.get(["monitor", "status"]);
  if (!monitor?.enabled || monitor.tabId !== tabId) return;
  if (running) { pendingFocusResume = tabId; return; }
  if (status?.state === "waiting" && status.waitReason === "focus") void check().catch(reportUnexpected);
}

async function testNotification() {
  if (await chrome.notifications.getPermissionLevel() !== "granted") throw new Error("Chromeの通知を許可してください。");
  await chrome.notifications.create("spectator-test", { type: "basic", iconUrl: "icons/icon128.png", title: "雀魂 観戦ウォッチ", message: "テスト通知です。" });
  return state();
}
async function handleMessage(message, sender) {
  await ready;
  if (sender.tab) {
    if (!isGameUrl(sender.tab.url) || (sender.frameId != null && sender.frameId !== 0)) throw new Error("対象外のページです。");
    switch (message.type) {
      case "PAGE_FOCUSED":
        await resumeOnFocus(sender.tab.id);
        return { ok: true };
      case "LIVE_REQUEST_SEEN": return recordRequest(sender.tab.id, message.request);
      case "LIVE_LIST_RECEIVED": return queuePacket(sender.tab.id, message.packet);
      case "CALIBRATION_DONE": return calibrationDone(message, sender);
      case "PAGE_INTERACTION": {
        const { monitor } = await chrome.storage.session.get("monitor");
        if (monitor?.enabled && monitor.tabId === sender.tab.id) {
          const supplied = message.detail;
          const number = value => Number.isFinite(value) && Math.abs(value) <= 100000 ? value : null;
          const detail = supplied && typeof supplied === "object" ? {
            event: typeof supplied.event === "string" ? supplied.event.slice(0, 32) : "unknown",
            stage: ["ready", "pressed", "released", "preparing", "none"].includes(supplied.stage) ? supplied.stage : "none",
            x: number(supplied.x), y: number(supplied.y),
            expectedX: number(supplied.expectedX), expectedY: number(supplied.expectedY),
            button: number(supplied.button), buttons: number(supplied.buttons),
          } : null;
          await statusFor(null, current => current.lastAttempt && detail
            ? { lastAttempt: { ...current.lastAttempt, interruption: detail } }
            : {});
          const messageText = message.reason === "resize"
            ? "画面サイズの変更を検出したため停止しました。"
            : message.reason === "navigation"
              ? "ページの移動を検出したため停止しました。"
              : detail && detail.stage !== "none"
                ? "自動クリック中に想定外の入力を検出したため停止しました。"
                : "ゲーム画面の入力を検出したため停止しました。";
          await stop(messageText);
        }
        return { ok: true };
      }
      case "CALIBRATION_CANCELLED": {
        const { pendingCalibration } = await chrome.storage.session.get("pendingCalibration");
        if (pendingCalibration?.tabId === sender.tab.id) {
          await chrome.storage.session.remove("pendingCalibration");
          await statusFor(null, { state: "stopped", message: "位置指定をキャンセルしました。" });
          await releaseBackgroundAccess(sender.tab.id).catch(reportUnexpected);
        }
        return { ok: true };
      }
      default: throw new Error("対応していない操作です。");
    }
  }
  switch (message.type) {
    case "GET_STATE": return state();
    case "CALIBRATE": return calibrate(message.settings);
    case "START": return start(message.settings);
    case "STOP": await stop(); return state();
    case "CHECK_NOW": void check().catch(reportUnexpected); return state();
    case "TEST_NOTIFICATION": return testNotification();
    default: throw new Error("対応していない操作です。");
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target === "offscreen") return false;
  const controlled = ["START", "STOP", "CALIBRATE"].includes(message?.type) && !sender.tab;
  const task = controlled ? controlQueue.then(() => handleMessage(message ?? {}, sender)) : handleMessage(message ?? {}, sender);
  if (controlled) controlQueue = task.catch(() => {});
  task.then(sendResponse, error => {
    const messageText = error.message || "操作に失敗しました。";
    if (message?.type === "CALIBRATION_DONE") void statusFor(null, { state: "stopped", message: "位置を保存できませんでした。" + messageText }).catch(reportUnexpected);
    sendResponse({ ok: false, error: messageText });
  }).catch(reportUnexpected);
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void ready.then(check).catch(reportUnexpected);
});
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId == null) return;
  void ready.then(async () => {
    const wasOwned = await forgetBackgroundAccess(source.tabId);
    if (!wasOwned) return;
    await stop("Chromeのバックグラウンド接続が解除されたため停止しました。");
    const { calibration } = await chrome.storage.session.get("calibration");
    if (calibration?.tabId === source.tabId) await chrome.storage.session.remove("calibration");
  }).catch(reportUnexpected);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void ready.then(async () => {
    const { monitor, calibration } = await chrome.storage.session.get(["monitor", "calibration"]);
    if (monitor?.tabId === tabId) await stop("雀魂のタブを閉じたため停止しました。");
    if (calibration?.tabId === tabId) await chrome.storage.session.remove("calibration");
    await chrome.storage.session.remove([liveKey(tabId), requestKey(tabId)]);
    await releaseBackgroundAccess(tabId).catch(() => {});
  }).catch(reportUnexpected);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading" && !change.url) return;
  void ready.then(async () => {
    const { monitor, calibration } = await chrome.storage.session.get(["monitor", "calibration"]);
    if (monitor?.enabled && monitor.tabId === tabId) await stop("ページが移動したため停止しました。更新ボタンを指定し直してください。");
    if (calibration?.tabId === tabId) await chrome.storage.session.remove("calibration");
    await chrome.storage.session.remove([liveKey(tabId), requestKey(tabId)]);
    await releaseBackgroundAccess(tabId).catch(() => {});
  }).catch(reportUnexpected);
});
chrome.notifications.onClicked.addListener(notificationId => {
  void (async () => {
    const { notificationTabs = {} } = await chrome.storage.session.get("notificationTabs");
    const tabId = notificationTabs[notificationId];
    if (tabId === undefined) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isGameUrl(tab.url)) return;
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    } catch {}
  })().catch(reportUnexpected);
});


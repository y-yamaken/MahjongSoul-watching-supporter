const elements = {
  form: document.querySelector("#settings-form"),
  fields: document.querySelector("#settings-fields"),
  names: document.querySelector("#names"),
  interval: document.querySelector("#interval"),
  hold: document.querySelector("#hold-seconds"),
  calibrate: document.querySelector("#calibrate"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  check: document.querySelector("#check-now"),
  test: document.querySelector("#test-notification"),
  stateLabel: document.querySelector("#state-label"),
  message: document.querySelector("#status-message"),
  checkedAt: document.querySelector("#checked-at"),
  matches: document.querySelector("#matched-names"),
  errorPanel: document.querySelector("#error-panel"),
  errorMessage: document.querySelector("#error-message"),
  retry: document.querySelector("#retry"),
  receivedNames: document.querySelector("#received-names"),
  gameCount: document.querySelector("#game-count"),
  playerCount: document.querySelector("#player-count"),
  diagnostics: document.querySelector("#click-diagnostics"),
  copyDiagnostics: document.querySelector("#copy-diagnostics"),
};

let state = null;
let busy = false;
let initialized = false;
let readSequence = 0;
let refreshTimer;

function renderControls() {
  const enabled = state?.monitor?.enabled === true;
  const unavailable = !initialized || busy;
  elements.fields.disabled = unavailable || enabled;
  elements.calibrate.disabled = unavailable || enabled;
  elements.start.disabled = unavailable || enabled || !state?.calibrated;
  elements.stop.disabled = unavailable || (!enabled && !state?.backgroundAttached);
  elements.check.disabled = unavailable || !enabled || ["checking", "refreshing"].includes(state?.status?.state);
  elements.test.disabled = unavailable;
  elements.retry.disabled = busy;
  elements.calibrate.textContent = state?.calibrated ? "更新ボタンを指定し直す" : "更新ボタンを指定";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("ja-JP") : "—";
}

function renderState(nextState) {
  state = nextState;
  const enabled = state.monitor?.enabled === true;
  const status = state.status ?? {};
  elements.stateLabel.textContent = enabled ? (status.state === "waiting" ? "待機中" : "監視中") : "停止中";
  elements.stateLabel.dataset.running = String(enabled);
  elements.message.textContent = status.message || (state.calibrated ? "監視を開始できます" : "更新ボタンを指定してください");
  const time = typeof status.checkedAt === "number" ? new Date(status.checkedAt) : null;
  const validTime = time && Number.isFinite(time.getTime());
  elements.checkedAt.textContent = validTime
    ? time.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  if (validTime) {
    elements.checkedAt.dateTime = time.toISOString();
    elements.checkedAt.title = time.toLocaleString("ja-JP");
  } else {
    elements.checkedAt.removeAttribute("datetime");
    elements.checkedAt.removeAttribute("title");
  }
  const names = Array.isArray(status.matchedNames) ? status.matchedNames : [];
  elements.matches.hidden = names.length === 0;
  elements.matches.textContent = names.length ? `検出　${names.join("、")}` : "";
  elements.receivedNames.value = Array.isArray(status.receivedNames)
    ? status.receivedNames.filter(name => typeof name === "string").join("\n")
    : "";
  elements.gameCount.textContent = count(status.gameCount);
  elements.playerCount.textContent = count(status.playerCount);
  const attempt = status.lastAttempt;
  const flag = value => value === true ? "あり" : value === false ? "なし" : "未計測";
  const seconds = value => Number.isFinite(value) ? (value / 1000).toFixed(2) + "秒" : "未計測";
  elements.diagnostics.value = attempt ? [
    "0.3.4　更新" + attempt.number + "回目",
    "押下 " + seconds(attempt.actualHoldMs) + "（設定 " + seconds(attempt.configuredHoldMs) + "）" +
      (attempt.inputMethod === "chrome" ? (attempt.trustedPress && attempt.trustedRelease ? " Chrome入力確認済み" : " Chrome入力未確認") : "") +
      (attempt.cursorMovesIgnored > 0 ? " 移動除外 " + attempt.cursorMovesIgnored + "件" : ""),
    "画面のフォーカス　開始 " + flag(attempt.focusedBefore) + "　解放 " + flag(attempt.focusedAfter),
    "通信　要求 " + flag(attempt.requestObserved) + "　応答 " + flag(attempt.responseReceived),
    "状態　" + (status.message || "") + (attempt.interruption
      ? " イベント=" + attempt.interruption.event + " 段階=" + attempt.interruption.stage +
        " 座標=" + attempt.interruption.x + "," + attempt.interruption.y +
        " 予定=" + attempt.interruption.expectedX + "," + attempt.interruption.expectedY
      : ""),
  ].join("\n") : "監視を開始すると診断を表示します。";
  renderControls();
}

function showError(message, canRetry = false) {
  elements.errorMessage.textContent = message;
  elements.errorPanel.hidden = false;
  elements.retry.hidden = !canRetry;
}

function clearError() {
  elements.errorPanel.hidden = true;
  elements.errorMessage.textContent = "";
  elements.retry.hidden = true;
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok !== true) {
    throw new Error(response?.error || "拡張機能と通信できませんでした。再読込してください。");
  }
  return response;
}

async function refreshState() {
  const sequence = ++readSequence;
  try {
    const result = await send({ type: "GET_STATE" });
    if (sequence !== readSequence) return;
    if (!initialized) {
      elements.names.value = (result.settings?.names ?? []).join("\n");
      elements.interval.value = String(result.settings?.intervalSeconds ?? 300);
      elements.hold.value = String((result.settings?.clickHoldMs ?? 500) / 1000);
      initialized = true;
      clearError();
    }
    renderState(result);
  } catch (error) {
    if (sequence !== readSequence) return;
    showError(error.message, true);
    renderControls();
  }
}

function readSettings() {
  if (!elements.form.reportValidity()) return null;
  const names = [...new Set(elements.names.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) {
    showError("ユーザー名を入力してください。");
    elements.names.focus();
    return null;
  }
  const intervalSeconds = Number(elements.interval.value);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) {
    showError("更新間隔は30〜3600秒で入力してください。");
    elements.interval.focus();
    return null;
  }
  const clickHoldMs = Math.round(Number(elements.hold.value) * 1000);
  if (!Number.isInteger(clickHoldMs) || clickHoldMs < 100 || clickHoldMs > 2000) {
    showError("押下時間は0.1〜2秒で入力してください。");
    elements.hold.focus();
    return null;
  }
  return { names, intervalSeconds, clickHoldMs };
}

async function perform(type, includeSettings = false) {
  if (busy) return;
  clearError();
  const settings = includeSettings ? readSettings() : undefined;
  if (includeSettings && !settings) return;
  busy = true;
  renderControls();
  try {
    const response = await send({ type, ...(settings ? { settings } : {}) });
    if (type === "CALIBRATE" || ((type === "START" || type === "CHECK_NOW") && response.monitor?.enabled)) {
      window.close();
      return;
    }
    if (response.monitor && response.settings) renderState(response);
    await refreshState();
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    renderControls();
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform("START", true);
});
elements.calibrate.addEventListener("click", () => void perform("CALIBRATE", true));
elements.stop.addEventListener("click", () => void perform("STOP"));
elements.check.addEventListener("click", () => void perform("CHECK_NOW"));
elements.test.addEventListener("click", () => void perform("TEST_NOTIFICATION"));
elements.copyDiagnostics.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.diagnostics.value);
    elements.copyDiagnostics.textContent = "コピーしました";
  } catch {
    elements.diagnostics.focus();
    elements.diagnostics.select();
    showError("診断欄を選択してコピーしてください。");
  }
});
elements.retry.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  clearError();
  renderControls();
  await refreshState();
  busy = false;
  renderControls();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local" && areaName !== "session") return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshState(), 80);
});

void refreshState();

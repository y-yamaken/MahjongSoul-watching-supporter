export const DEFAULT_SETTINGS = Object.freeze({ names: [], intervalSeconds: 60, clickHoldMs: 500 });
export const ALARM_NAME = "watch-spectators";
export const GAME_ORIGIN = "https://game.mahjongsoul.com";

export function isGameUrl(value) {
  try { return new URL(value).origin === GAME_ORIGIN; } catch { return false; }
}

export function validateSettings(input) {
  const raw = Array.isArray(input?.names) ? input.names : [];
  if (raw.some(name => typeof name !== "string")) throw new Error("ユーザー名を文字で入力してください。");
  const names = [...new Set(raw.map(name => name.trim()).filter(Boolean))];
  if (!names.length) throw new Error("ユーザー名を1人以上入力してください。");
  if (names.length > 30 || names.some(name => name.length > 80 || /[\r\n]/u.test(name))) {
    throw new Error("ユーザー名は1行1人、30人まで入力してください。");
  }
  const intervalSeconds = Number(input?.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) {
    throw new Error("更新間隔を30〜3600秒の整数にしてください。");
  }
  const clickHoldMs = Number(input?.clickHoldMs ?? 500);
  if (!Number.isInteger(clickHoldMs) || clickHoldMs < 100 || clickHoldMs > 2000) {
    throw new Error("押下時間を0.1〜2秒にしてください。");
  }
  return { names, intervalSeconds, clickHoldMs };
}

// OCR inserts spaces inside Japanese names. No substring or edit-distance matching.
export function normalizeName(value) {
  return String(value).normalize("NFKC").replace(/\s+/gu, "");
}

export function findMatches(text, names) {
  const lines = new Set(String(text).split(/[\r\n]+/u).map(normalizeName).filter(Boolean));
  return names.filter(name => lines.has(normalizeName(name)));
}

// Require two consecutive successful misses before re-arming a user's notification.
export function nextPresence(previous, matchedNames, names) {
  const matched = new Set(matchedNames);
  const next = {};
  const notify = [];
  for (const name of names) {
    const before = previous?.[name];
    if (matched.has(name)) {
      if (!before?.present) notify.push(name);
      Object.defineProperty(next, name, { value: { present: true, misses: 0 }, enumerable: true });
    } else {
      const misses = Math.min(2, (before?.misses ?? 0) + 1);
      Object.defineProperty(next, name, {
        value: { present: Boolean(before?.present && misses < 2), misses }, enumerable: true,
      });
    }
  }
  return { next, notify };
}

export function validateCalibration(calibration) {
  const c = calibration;
  const unit = n => Number.isFinite(n) && n >= 0 && n <= 1;
  const rect = r => r && [r.x, r.y, r.width, r.height].every(unit) &&
    r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001;
  if (!c || !unit(c.point?.x) || !unit(c.point?.y) || !rect(c.anchor) ||
      !Number.isFinite(c.viewport?.width) || c.viewport.width < 100 ||
      !Number.isFinite(c.viewport?.height) || c.viewport.height < 100 ||
      !Number.isFinite(c.viewport?.devicePixelRatio) || c.viewport.devicePixelRatio <= 0 ||
      !isGameUrl(c.url)) {
    throw new Error("画面位置を指定し直してください。");
  }
  return c;
}

export function sameViewport(left, right) {
  return left && right && left.width === right.width && left.height === right.height &&
    left.devicePixelRatio === right.devicePixelRatio;
}

// Exact wire names: no OCR whitespace folding, width folding, or substring matching.
export function matchLiveGames(games, names) {
  const wanted = new Set(names);
  const found = new Map();
  for (const game of games) {
    if (!game.uuid) continue;
    for (const player of game.players) {
      if (!wanted.has(player.nickname)) continue;
      const match = { uuid: game.uuid, nickname: player.nickname };
      found.set(JSON.stringify([match.uuid, match.nickname]), match);
    }
  }
  return [...found.values()];
}

export function summarizeLiveGames(games) {
  const names = games.flatMap(game => game.players.map(player => player.nickname));
  return { gameCount: games.length, playerCount: names.length, receivedNames: [...new Set(names)] };
}

export function notificationPlan(previous, matches, now) {
  const entries = Object.entries(previous).filter(([, time]) => Number.isFinite(time) && now - time < 86400000);
  const seen = new Map(entries);
  const fresh = [];
  for (const match of matches) {
    const key = JSON.stringify([match.uuid, match.nickname]);
    if (!seen.has(key)) {
      fresh.push(match);
      seen.set(key, now);
    }
  }
  const bounded = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(-4000);
  return { fresh, next: Object.fromEntries(bounded) };
}

export function validateLivePacket(packet) {
  if (!packet || typeof packet.requestId !== "string" || !packet.requestId || packet.requestId.length > 160 ||
      !Number.isFinite(packet.requestedAt) || !Number.isFinite(packet.receivedAt) ||
      packet.requestedAt < 0 || packet.receivedAt < packet.requestedAt ||
      !Number.isInteger(packet.filterId) || packet.filterId < 0 || packet.filterId > 0xffffffff ||
      !Array.isArray(packet.frame) || packet.frame.length < 3 || packet.frame.length > 2 * 1024 * 1024 ||
      !packet.frame.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("観戦一覧の通信形式を確認できませんでした。");
  }
  return packet;
}

export function isOlderLivePacket(previous, current) {
  if (!previous) return false;
  if (previous.requestedAt !== current.requestedAt) return previous.requestedAt > current.requestedAt;
  const priorSplit = previous.requestId.lastIndexOf(":");
  const nextSplit = current.requestId.lastIndexOf(":");
  if (priorSplit < 0 || nextSplit < 0 ||
      previous.requestId.slice(0, priorSplit) !== current.requestId.slice(0, nextSplit)) return false;
  const priorSequence = Number(previous.requestId.slice(priorSplit + 1));
  const nextSequence = Number(current.requestId.slice(nextSplit + 1));
  return Number.isSafeInteger(priorSequence) && Number.isSafeInteger(nextSequence) && priorSequence > nextSequence;
}

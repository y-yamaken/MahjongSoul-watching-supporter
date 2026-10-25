import test from "node:test";
import assert from "node:assert/strict";
import { validateSettings, findMatches, nextPresence, validateCalibration, isGameUrl, sameViewport } from "../extension/core.js";

test("settings reject unsafe/ambiguous intervals and normalize only boundary whitespace", () => {
  assert.deepEqual(validateSettings({ names: [" 雀士 ", "雀士", ""], intervalSeconds: 60 }), { names: ["雀士"], intervalSeconds: 60, clickHoldMs: 500 });
  for (const seconds of [0, 29, 30.1, 3601, NaN]) {
    assert.throws(() => validateSettings({ names: ["雀士"], intervalSeconds: seconds }));
  }
  assert.throws(() => validateSettings({ names: [], intervalSeconds: 60 }));
  assert.throws(() => validateSettings({ names: ["a\nb"], intervalSeconds: 60 }));
});
test("OCR matching supports Japanese spacing but rejects substrings and case changes", () => {
  assert.deepEqual(findMatches("雀 士 太 郎\nＡＢＣ123\nPlayerLong\nOther rank\n", ["雀士太郎", "ABC123", "Player", "abc123", "Other"]), ["雀士太郎", "ABC123"]);
});
test("notification remains suppressed until two successful missing scans", () => {
  let result = nextPresence({}, ["雀士"], ["雀士"]);
  assert.deepEqual(result.notify, ["雀士"]);
  result = nextPresence(result.next, ["雀士"], ["雀士"]);
  assert.deepEqual(result.notify, []);
  result = nextPresence(result.next, [], ["雀士"]);
  result = nextPresence(result.next, ["雀士"], ["雀士"]);
  assert.deepEqual(result.notify, []);
  result = nextPresence(result.next, [], ["雀士"]);
  result = nextPresence(result.next, [], ["雀士"]);
  result = nextPresence(result.next, ["雀士"], ["雀士"]);
  assert.deepEqual(result.notify, ["雀士"]);
});
test("prototype-like player names are normal data", () => {
  const result = nextPresence({}, ["__proto__", "constructor"], ["__proto__", "constructor"]);
  assert.deepEqual(result.notify, ["__proto__", "constructor"]);
  assert.deepEqual(nextPresence(result.next, ["__proto__", "constructor"], ["__proto__", "constructor"]).notify, []);
});
test("only the official Japanese origin is supported; calibration bounds are checked", () => {
  assert.equal(isGameUrl("https://game.mahjongsoul.com/"), true);
  assert.equal(isGameUrl("https://game.mahjongsoul.com.evil.test/"), false);
  assert.equal(isGameUrl("http://game.mahjongsoul.com/"), false);
  const c = { point: { x: .9, y: .9 }, region: { x: 0, y: 0, width: .8, height: .8 }, anchor: { x: .8, y: .8, width: .1, height: .1 }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 }, url: "https://game.mahjongsoul.com/" };
  assert.equal(validateCalibration(c), c);
  assert.throws(() => validateCalibration({ ...c, point: { x: -1, y: 0 } }));
  assert.throws(() => validateCalibration({ ...c, anchor: { x: .9, y: 0, width: .8, height: 1 } }));
  assert.equal(sameViewport(c.viewport, { ...c.viewport, devicePixelRatio: 2 }), false);
});


test("click hold defaults to half a second and accepts a bounded longer hold", () => {
  const input = { names: ["雀士"], intervalSeconds: 60 };
  assert.equal(validateSettings(input).clickHoldMs, 500);
  assert.equal(validateSettings({ ...input, clickHoldMs: 1000 }).clickHoldMs, 1000);
  for (const clickHoldMs of [0, 99, 2001, NaN]) assert.throws(() => validateSettings({ ...input, clickHoldMs }));
});

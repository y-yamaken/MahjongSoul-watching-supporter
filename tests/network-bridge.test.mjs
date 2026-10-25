import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../extension/network-bridge.js", import.meta.url), "utf8");
const channel = "mahjong-soul-watch-network-v1";

function setup() {
  const listeners = new Map();
  const outgoing = [];
  const posts = [];
  let extensionListener;
  const location = { origin: "https://game.mahjongsoul.com" };
  const window = {
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback); listeners.set(type, callbacks);
    },
    postMessage(message, origin) { assert.equal(origin, location.origin); posts.push(message); },
  };
  const chrome = { runtime: {
    id: "fixture-extension",
    onMessage: { addListener: callback => { extensionListener = callback; } },
    async sendMessage(message) { outgoing.push(message); return { ok: true }; },
  } };
  const context = vm.createContext({ window, location, chrome, ArrayBuffer, Uint8Array });
  vm.runInContext(source, context);
  return {
    outgoing, posts, context,
    emit(data, options = {}) {
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: options.foreignSource ? {} : window, origin: options.origin ?? location.origin, data });
      }
    },
    state(senderId = chrome.runtime.id) {
      let result;
      const returned = extensionListener({ type: "GET_LIVE_STATE" }, { id: senderId }, value => { result = value; });
      assert.equal(returned, false);
      return result;
    },
    hide() { for (const listener of listeners.get("pagehide") ?? []) listener(); },
  };
}

function packet() {
  const now = Date.now();
  return { channel, type: "LIVE_LIST", requestId: "socket-1:1", requestedAt: now, receivedAt: now,
    filterId: 3, frame: new Uint8Array([3, 1, 0, 18, 0]).buffer };
}

test("bridge validates the channel, reports readiness, caches one packet and serializes the buffer", () => {
  const app = setup();
  assert.equal(app.state().hookReady, false);
  app.emit({ channel, type: "HOOK_READY" });
  assert.equal(app.state().hookReady, true);
  app.emit(packet());
  assert.equal(app.outgoing.length, 1);
  const result = app.state();
  assert.equal(result.latest.requestId, "socket-1:1");
  assert.deepEqual(Array.from(result.latest.frame), [3, 1, 0, 18, 0]);
  assert.equal(app.outgoing[0].type, "LIVE_LIST_RECEIVED");
  app.emit({ ...packet(), requestId: "socket-1:2" });
  assert.equal(app.state().latest.requestId, "socket-1:2");
  app.hide();
  assert.equal(app.state().latest, null);
});

test("bridge rejects wrong origins, senders, frames, timestamps and oversized metadata", () => {
  const app = setup();
  app.emit(packet(), { foreignSource: true });
  app.emit(packet(), { origin: "https://elsewhere.example" });
  for (const invalid of [
    { channel: "another-extension" },
    { requestId: "x".repeat(129) },
    { filterId: -1 }, { filterId: 0x100000000 },
    { requestedAt: 0 }, { receivedAt: Date.now() + 120_000 },
    { frame: [3, 1, 0] },
    { frame: new Uint8Array([2, 1, 0]).buffer },
    { frame: new ArrayBuffer(2 * 1024 * 1024 + 1) },
  ]) app.emit({ ...packet(), ...invalid });
  assert.equal(app.outgoing.length, 0);
  assert.equal(app.state("different-extension"), undefined);
});

test("bridge deduplicates the latest packet and reinjection does not duplicate listeners", () => {
  const app = setup();
  vm.runInContext(source, app.context);
  const message = packet();
  app.emit(message); app.emit(message);
  assert.equal(app.outgoing.length, 1);
  assert.ok(app.posts.every(message => message.type === "GET_HOOK_STATE"));
});


test("bridge relays only request metadata, deduplicates it and clears it on pagehide", () => {
  const app = setup();
  assert.equal(app.state().latestRequest, null);
  const message = { ...packet(), type: "LIVE_REQUEST", ignoredField: "not-relayed" };
  app.emit(message); app.emit(message);
  assert.equal(app.outgoing.length, 1);
  assert.equal(app.outgoing[0].type, "LIVE_REQUEST_SEEN");
  assert.deepEqual(Object.keys(app.outgoing[0].request).sort(), ["filterId", "requestId", "requestedAt"]);
  assert.equal(app.state().latestRequest.requestId, message.requestId);
  assert.equal(app.state().latest, null);
  app.emit({ ...message, requestId: "socket-1:0", requestedAt: message.requestedAt - 1 });
  assert.equal(app.outgoing.length, 1, "older request diagnostics must not replace newer ones");
  app.hide();
  assert.equal(app.state().latestRequest, null);
});

test("bridge rejects foreign and malformed request diagnostics", () => {
  const app = setup();
  const message = { ...packet(), type: "LIVE_REQUEST" };
  app.emit(message, { foreignSource: true });
  app.emit(message, { origin: "https://elsewhere.example" });
  for (const change of [
    { channel: "wrong" }, { requestId: "" }, { requestId: "x".repeat(129) },
    { requestedAt: 0 }, { requestedAt: Date.now() + 120_000 }, { requestedAt: 1.5 },
    { filterId: -1 }, { filterId: 0x100000000 },
  ]) app.emit({ ...message, ...change });
  assert.equal(app.outgoing.length, 0);
  assert.equal(app.state().latestRequest, null);
});

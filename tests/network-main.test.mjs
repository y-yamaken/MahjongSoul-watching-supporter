import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { LiveListCapturer, MAX_FRAME_BYTES, NETWORK_CHANNEL } from "../extension/network-protocol.js";
const source = (await readFile(new URL("../src/network-main.js", import.meta.url), "utf8")).replace(/^import[^\n]+\n/m, "");
const encode = value => new TextEncoder().encode(value);
const request = index => {
  const name = encode(".lq.Lobby.fetchGameLiveList");
  return Uint8Array.from([2, index, 0, 10, name.length, ...name, 18, 2, 8, 3]);
};
const response = index => Uint8Array.from([3, index, 0, 18, 0]);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function setup() {
  const windowListeners = new Map();
  const sent = [];
  const posts = [];
  let chainedCalls = 0;
  class FakeSocket {
    listeners = new Map();
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener); this.listeners.set(type, list);
    }
    emit(type, data) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(data) { sent.push({ socket: this, data }); return "native-result"; }
  }
  const native = FakeSocket.prototype.send;
  FakeSocket.prototype.send = function (...args) { chainedCalls++; return native.apply(this, args); };
  const location = { origin: "https://game.mahjongsoul.com" };
  const window = {
    WebSocket: FakeSocket,
    addEventListener(type, callback) {
      const callbacks = windowListeners.get(type) ?? [];
      callbacks.push(callback); windowListeners.set(type, callbacks);
    },
    postMessage(message, origin) { assert.equal(origin, location.origin); posts.push(message); },
  };
  const context = vm.createContext({
    window, location, crypto, Symbol, Uint8Array, ArrayBuffer, Blob, Promise, WeakMap,
    LiveListCapturer, MAX_FRAME_BYTES, NETWORK_CHANNEL,
  });
  vm.runInContext(source, context);
  return {
    FakeSocket, posts, sent, window, context,
    get chainedCalls() { return chainedCalls; },
    dispatch(message) { for (const listener of windowListeners.get("message") ?? []) listener({ source: window, origin: location.origin, data: message }); },
  };
}

test("MAIN preserves the original send chain and captures only matched response frames", async () => {
  const app = setup();
  const a = new app.FakeSocket();
  const b = new app.FakeSocket();
  const bytes = request(7);
  assert.equal(a.send(bytes.subarray(0)), "native-result");
  bytes.fill(0);
  b.send(request(7));
  a.emit("message", response(6).buffer);
  const original = response(7).buffer;
  a.emit("message", original);
  b.emit("message", response(7).buffer);
  await settle();
  const packets = app.posts.filter(message => message.type === "LIVE_LIST");
  assert.equal(packets.length, 2);
  assert.notEqual(packets[0].requestId, packets[1].requestId);
  assert.equal(packets[0].filterId, 3);
  assert.equal(app.chainedCalls, 2);
  assert.equal(original.byteLength, 5, "the game's received buffer was not transferred");
  assert.notEqual(packets[0].frame, original);
  assert.equal(new Uint8Array(packets[0].frame)[0], 3);
});

test("Blob requests and ArrayBuffer responses retain socket event order", async () => {
  const app = setup();
  const socket = new app.FakeSocket();
  class DelayedBlob extends Blob {
    async arrayBuffer() { await new Promise(resolve => setTimeout(resolve, 10)); return super.arrayBuffer(); }
  }
  socket.send(new DelayedBlob([request(4)]));
  socket.emit("message", response(4).buffer);
  await settle();
  assert.equal(app.posts.filter(message => message.type === "LIVE_LIST").length, 1);
});

test("duplicate injection does not wrap twice and GET_HOOK_STATE replies", () => {
  const app = setup();
  const patched = app.FakeSocket.prototype.send;
  vm.runInContext(source, app.context);
  assert.equal(app.FakeSocket.prototype.send, patched);
  app.dispatch({ channel: NETWORK_CHANNEL, type: "GET_HOOK_STATE" });
  assert.equal(app.posts.filter(message => message.type === "HOOK_READY").length, 2);
});

test("text and oversized frames are passed to the game without capture", async () => {
  const app = setup();
  const socket = new app.FakeSocket();
  socket.send("text");
  socket.send(new Uint8Array(MAX_FRAME_BYTES + 1));
  socket.emit("message", new ArrayBuffer(MAX_FRAME_BYTES + 1));
  await settle();
  assert.equal(app.sent.length, 2);
  assert.equal(app.posts.filter(message => message.type === "LIVE_LIST").length, 0);
});


test("reused indexes in oversized sends cannot capture unrelated responses", async () => {
  const app = setup();
  const socket = new app.FakeSocket();
  socket.send(request(1));
  const oversized = new Uint8Array(MAX_FRAME_BYTES + 1);
  oversized.set([2, 1, 0]);
  socket.send(oversized);
  socket.emit("message", response(1).buffer);
  await settle();
  assert.equal(app.posts.filter(message => message.type === "LIVE_LIST").length, 0);
});

test("a rejected Blob conversion never rejects the game send call", async () => {
  const app = setup();
  const socket = new app.FakeSocket();
  class FailedBlob extends Blob {
    arrayBuffer() { return Promise.reject(new Error("conversion failed")); }
  }
  assert.equal(socket.send(new FailedBlob([request(1)])), "native-result");
  socket.emit("message", response(1).buffer);
  await settle();
  assert.equal(app.posts.filter(message => message.type === "LIVE_LIST").length, 0);
});

test("MAIN publishes request diagnostics before an answer without exposing request bytes", async () => {
  const app = setup();
  const socket = new app.FakeSocket();
  socket.send(request(3));
  await settle();
  const requests = app.posts.filter(message => message.type === "LIVE_REQUEST");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].filterId, 3);
  assert.equal(requests[0].channel, NETWORK_CHANNEL);
  assert.equal("frame" in requests[0], false);
  assert.equal(app.posts.filter(message => message.type === "LIVE_LIST").length, 0);
  socket.emit("message", response(3).buffer);
  await settle();
  const answer = app.posts.find(message => message.type === "LIVE_LIST");
  assert.equal(answer.requestId, requests[0].requestId);
});

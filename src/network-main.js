// WebSocket prototype chaining is based on MahjongSoul-review-supporter
// src/entrypoints/main-world.content.ts (Apache-2.0). No messages are sent to game servers.
import { LiveListCapturer, MAX_FRAME_BYTES, NETWORK_CHANNEL } from "../extension/network-protocol.js";

(() => {
  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket?.prototype) return;
  const prototype = NativeWebSocket.prototype;
  const installed = Symbol.for("mahjong-soul-watch-network-v1-installed");
  if (prototype[installed]) return;
  const originalSend = prototype.send;
  const originalAddListener = prototype.addEventListener;
  const sockets = new WeakMap();
  const pageId = crypto.randomUUID();
  let socketNumber = 0;

  function post(message) {
    try { window.postMessage({ channel: NETWORK_CHANNEL, ...message }, location.origin); }
    catch { /* The game remains usable if the extension bridge has gone away. */ }
  }
  function ready() { post({ type: "HOOK_READY" }); }
  function copiedBytes(data, direction) {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > MAX_FRAME_BYTES) {
        return direction === "send" ? new Uint8Array(data, 0, 3).slice() : null;
      }
      return new Uint8Array(data).slice();
    }
    if (ArrayBuffer.isView(data)) {
      if (data.byteLength > MAX_FRAME_BYTES) {
        return direction === "send" ? new Uint8Array(data.buffer, data.byteOffset, 3).slice() : null;
      }
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    }
    if (data instanceof Blob) {
      if (data.size > MAX_FRAME_BYTES && direction !== "send") return null;
      const bounded = data.size > MAX_FRAME_BYTES ? data.slice(0, 3) : data;
      // Handle rejection immediately, even while an earlier queued Blob is still pending.
      return bounded.arrayBuffer().then(buffer => new Uint8Array(buffer), () => null);
    }
    return null;
  }
  function enqueue(state, direction, data) {
    const observedAt = Date.now();
    const copied = copiedBytes(data, direction);
    if (!copied) return;
    if (state.queued >= 256) {
      state.capturer.reset();
      state.generation += 1;
      // Consume an already-started Blob conversion even when this item is dropped.
      if (copied instanceof Promise) void copied.catch(() => {});
      return;
    }
    state.queued += 1;
    const generation = state.generation;
    state.queue = state.queue.then(async () => {
      const bytes = await copied;
      if (generation !== state.generation) return;
      if (direction === "send") state.capturer.observeSend(bytes, observedAt);
      else state.capturer.observeReceive(bytes, observedAt);
    }).catch(() => {}).finally(() => { state.queued -= 1; });
  }
  function getState(socket) {
    let state = sockets.get(socket);
    if (state) return state;
    state = {
      queue: Promise.resolve(),
      queued: 0,
      generation: 0,
      capturer: new LiveListCapturer({
        idPrefix: pageId + ":" + ++socketNumber,
        onPacket: packet => post({ type: "LIVE_LIST", ...packet }),
        onRequest: request => post({ type: "LIVE_REQUEST", ...request }),
      }),
    };
    sockets.set(socket, state);
    originalAddListener.call(socket, "message", event => {
      try { enqueue(state, "receive", event.data); } catch {}
    });
    originalAddListener.call(socket, "close", () => state.capturer.reset());
    return state;
  }

  try {
    prototype.send = function (...args) {
      try { enqueue(getState(this), "send", args[0]); } catch {}
      return originalSend.apply(this, args);
    };
    Object.defineProperty(prototype, installed, { value: true });
  } catch { return; }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.channel === NETWORK_CHANNEL && event.data.type === "GET_HOOK_STATE") ready();
  });
  ready();
})();


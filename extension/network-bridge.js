(() => {
  const instanceKey = "__mahjongSoulWatchNetworkBridgeV1";
  if (globalThis[instanceKey]) return;
  globalThis[instanceKey] = true;
  const channel = "mahjong-soul-watch-network-v1";
  const maximumBytes = 2 * 1024 * 1024;
  let hookReady = false;
  let latest = null;
  let latestRequest = null;

  function requestHookState() {
    try { window.postMessage({ channel, type: "GET_HOOK_STATE" }, location.origin); } catch {}
  }
  function requestFrom(message) {
    if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 128 ||
        !Number.isSafeInteger(message.requestedAt) || message.requestedAt <= 0 ||
        message.requestedAt > Date.now() + 60_000 ||
        !Number.isSafeInteger(message.filterId) || message.filterId < 0 || message.filterId > 0xffffffff) return null;
    return { requestId: message.requestId, requestedAt: message.requestedAt, filterId: message.filterId };
  }
  function packetFrom(message) {
    const request = requestFrom(message);
    if (!request ||
        !Number.isSafeInteger(message.receivedAt) || message.receivedAt < request.requestedAt ||
        message.receivedAt - request.requestedAt > 60_000 ||
        message.receivedAt > Date.now() + 60_000 ||
        !(message.frame instanceof ArrayBuffer) || message.frame.byteLength < 3 ||
        message.frame.byteLength > maximumBytes) return null;
    const bytes = new Uint8Array(message.frame);
    if (bytes[0] !== 3) return null;
    return { ...request, receivedAt: message.receivedAt, frame: Array.from(bytes) };
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.channel !== channel) return;
    if (event.data.type === "HOOK_READY") { hookReady = true; return; }
    if (event.data.type === "LIVE_REQUEST") {
      const request = requestFrom(event.data);
      if (!request || request.requestId === latestRequest?.requestId ||
          request.requestedAt < (latestRequest?.requestedAt ?? 0)) return;
      latestRequest = request;
      try {
        void chrome.runtime.sendMessage({ type: "LIVE_REQUEST_SEEN", request }).catch(() => {});
      } catch {}
      return;
    }
    if (event.data.type !== "LIVE_LIST") return;
    const packet = packetFrom(event.data);
    if (!packet || packet.requestId === latest?.requestId) return;
    latest = packet;
    try {
      void chrome.runtime.sendMessage({ type: "LIVE_LIST_RECEIVED", packet }).catch(() => {});
    } catch {}
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "GET_LIVE_STATE") return false;
    requestHookState();
    respond({ ok: true, hookReady, latest, latestRequest });
    return false;
  });
  window.addEventListener("pagehide", () => { latest = null; latestRequest = null; hookReady = false; });
  window.addEventListener("pageshow", requestHookState);
  requestHookState();
})();


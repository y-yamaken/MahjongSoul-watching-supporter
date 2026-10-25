// Adapted from MahjongSoul-review-supporter (Apache-2.0):
// src/lib/ws-capture.ts and src/lib/record-decode.ts.
// The capture target, per-socket tracking and bounded decoder are specific to this extension.
// Wire field numbers come from its bundled Mahjong Soul liqi.json snapshot.
export const NETWORK_CHANNEL = "mahjong-soul-watch-network-v1";
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const REQUEST_TTL_MS = 60_000;
const MAX_PENDING = 128;
const METHOD = ".lq.Lobby.fetchGameLiveList";
const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail() { throw new Error("観戦一覧の通信形式を読み取れませんでした。"); }

class Reader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FRAME_BYTES) fail();
    this.bytes = bytes;
    this.position = 0;
  }
  get done() { return this.position === this.bytes.length; }
  uint32() {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      if (this.position >= this.bytes.length) fail();
      const byte = this.bytes[this.position++];
      if (index === 4 && (byte & 0xf0)) fail();
      value += (byte & 0x7f) * 2 ** (7 * index);
      if (!(byte & 0x80)) return value;
    }
    fail();
  }
  tag() {
    const tag = this.uint32();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (!field || ![0, 1, 2, 5].includes(wire)) fail();
    return { field, wire };
  }
  bytesField(wire) {
    if (wire !== 2) fail();
    const length = this.uint32();
    if (length > this.bytes.length - this.position) fail();
    const value = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  string(wire, maxLength) {
    const bytes = this.bytesField(wire);
    if (bytes.length > maxLength * 4) fail();
    const value = utf8.decode(bytes);
    if (value.length > maxLength) fail();
    return value;
  }
  number(wire) {
    if (wire !== 0) fail();
    return this.uint32();
  }
  skip(wire) {
    if (wire === 0) {
      for (let index = 0; index < 10; index += 1) {
        if (this.position >= this.bytes.length) fail();
        const byte = this.bytes[this.position++];
        if (index === 9 && byte > 1) fail();
        if (!(byte & 0x80)) return;
      }
      fail();
    }
    if (wire === 2) { this.bytesField(wire); return; }
    const length = wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || length > this.bytes.length - this.position) fail();
    this.position += length;
  }
}

function wrapper(bytes) {
  const reader = new Reader(bytes);
  let name = "";
  let data = new Uint8Array();
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) name = reader.string(wire, 256);
    else if (field === 2) data = reader.bytesField(wire);
    else reader.skip(wire);
  }
  return { name, data };
}

function parseFilter(bytes) {
  const reader = new Reader(bytes);
  let filterId = 0;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) filterId = reader.number(wire);
    else reader.skip(wire);
  }
  return filterId;
}

function readError(bytes) {
  const reader = new Reader(bytes);
  let code = 0;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) code = reader.number(wire);
    else reader.skip(wire);
  }
  return code;
}

function readPlayer(bytes) {
  const reader = new Reader(bytes);
  let nickname = "";
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 4) nickname = reader.string(wire, 256);
    else reader.skip(wire);
  }
  return { nickname };
}

function readGame(bytes) {
  const reader = new Reader(bytes);
  let uuid = "";
  let startTime = 0;
  const players = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) uuid = reader.string(wire, 256);
    else if (field === 2) startTime = reader.number(wire);
    else if (field === 4) {
      if (players.length >= 16) fail();
      players.push(readPlayer(reader.bytesField(wire)));
    } else reader.skip(wire);
  }
  if (!uuid) fail();
  return { uuid, players, startTime };
}

export function decodeLiveListFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3 ||
      bytes.length > MAX_FRAME_BYTES || bytes[0] !== 3) fail();
  const outer = wrapper(bytes.subarray(3));
  if (outer.name && outer.name !== ".lq.ResGameLiveList" && outer.name !== "lq.ResGameLiveList") fail();
  const reader = new Reader(outer.data);
  const games = [];
  let errorCode = 0;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) errorCode = readError(reader.bytesField(wire));
    else if (field === 2) {
      if (games.length >= 2000) fail();
      games.push(readGame(reader.bytesField(wire)));
    } else reader.skip(wire);
  }
  return { errorCode, games };
}

let nextCapturer = 0;
export class LiveListCapturer {
  constructor({ now = Date.now, onPacket = () => {}, onRequest = () => {}, idPrefix = String(++nextCapturer) } = {}) {
    this.now = now;
    this.onPacket = onPacket;
    this.onRequest = onRequest;
    this.idPrefix = idPrefix;
    this.sequence = 0;
    this.pending = new Map();
  }
  reset() { this.pending.clear(); }
  prune() {
    const now = this.now();
    for (const [index, entry] of this.pending) {
      if (now - entry.requestedAt > REQUEST_TTL_MS || entry.requestedAt > now + 1000) this.pending.delete(index);
    }
  }
  observeSend(bytes, requestedAt = this.now()) {
    this.prune();
    if (!(bytes instanceof Uint8Array) || bytes.length < 3 || bytes[0] !== 2) return;
    const index = bytes[1] | bytes[2] << 8;
    // Reused indexes from any RPC invalidate an older watched request.
    this.pending.delete(index);
    if (bytes.length > MAX_FRAME_BYTES || !Number.isSafeInteger(requestedAt) || requestedAt <= 0) return;
    try {
      const outer = wrapper(bytes.subarray(3));
      if (outer.name !== METHOD) return;
      const filterId = parseFilter(outer.data);
      while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
      const entry = {
        requestId: this.idPrefix + ":" + ++this.sequence,
        requestedAt,
        filterId,
      };
      this.pending.set(index, entry);
      // Report only the matching method's bounded metadata, never other payloads.
      try { this.onRequest({ ...entry }); } catch { /* Diagnostics cannot break capture. */ }
    } catch { /* A failed observer must not affect the game. */ }
  }
  observeReceive(bytes, receivedAt = this.now()) {
    this.prune();
    if (!(bytes instanceof Uint8Array) || bytes.length < 3 || bytes[0] !== 3) return;
    const index = bytes[1] | bytes[2] << 8;
    const entry = this.pending.get(index);
    if (!entry) return;
    this.pending.delete(index);
    if (bytes.length > MAX_FRAME_BYTES || !Number.isSafeInteger(receivedAt) ||
        receivedAt < entry.requestedAt || receivedAt - entry.requestedAt > REQUEST_TTL_MS) return;
    const packet = { ...entry, receivedAt, frame: bytes.slice().buffer };
    try { this.onPacket(packet); } catch { /* Keep the original game handlers running. */ }
  }
}


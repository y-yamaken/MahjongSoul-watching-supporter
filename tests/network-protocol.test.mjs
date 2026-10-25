import test from "node:test";
import assert from "node:assert/strict";
import { decodeLiveListFrame, LiveListCapturer, MAX_FRAME_BYTES } from "../extension/network-protocol.js";

const text = value => new TextEncoder().encode(value);
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
function varint(value) {
  const bytes = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return bytes;
}
const numberField = (field, value) => concat(varint(field * 8), varint(value));
const bytesField = (field, value) => concat(varint(field * 8 + 2), varint(value.length), value);
const stringField = (field, value) => bytesField(field, text(value));
const wrapper = (data, name = "") => concat(name ? stringField(1, name) : [], bytesField(2, data));
const response = (index, body = []) => concat([3, index & 255, index >> 8], wrapper(body));
const request = (index, name = ".lq.Lobby.fetchGameLiveList", filterId = 3) =>
  concat([2, index & 255, index >> 8], wrapper(numberField(1, filterId), name));
const player = name => concat(numberField(1, 12345), stringField(4, name), numberField(9, 1));
const game = (id, names) => concat(stringField(1, id), numberField(2, 1_700_000_000),
  bytesField(3, numberField(1, 42)), ...names.map(name => bytesField(4, player(name))));
const liveList = (...games) => concat(...games.map(value => bytesField(2, value)));

test("decodes exact Japanese nicknames, UUIDs and start times from a real-shaped protobuf frame", () => {
  const result = decodeLiveListFrame(response(0x1234, liveList(
    game("match-one", ["雀士太郎", "ＡＢＣ", "A B", "__proto__"]),
    game("match-two", ["OtherPlayer"]),
  )));
  assert.deepEqual(result, {
    errorCode: 0,
    games: [
      { uuid: "match-one", startTime: 1_700_000_000, players: [{ nickname: "雀士太郎" }, { nickname: "ＡＢＣ" }, { nickname: "A B" }, { nickname: "__proto__" }] },
      { uuid: "match-two", startTime: 1_700_000_000, players: [{ nickname: "OtherPlayer" }] },
    ],
  });
});

test("an empty list is a successful response; server error codes are preserved", () => {
  assert.deepEqual(decodeLiveListFrame(response(4)), { errorCode: 0, games: [] });
  assert.deepEqual(decodeLiveListFrame(response(4, bytesField(1, numberField(1, 102)))), { errorCode: 102, games: [] });
});

test("unknown protobuf fields of supported wire types are skipped", () => {
  const unknown = concat(numberField(30, 8), varint(31 * 8 + 1), Array(8).fill(0xff),
    bytesField(32, [8, 1]), varint(33 * 8 + 5), [1, 2, 3, 4]);
  const result = decodeLiveListFrame(response(8, concat(unknown, liveList(game("valid", ["テスト"])) )));
  assert.equal(result.games[0].players[0].nickname, "テスト");
});

test("malformed and oversized frames fail without partial results", () => {
  const badUtf8Player = bytesField(4, [0xff]);
  const cases = [
    new Uint8Array(), new Uint8Array([3, 1]), request(1),
    new Uint8Array(MAX_FRAME_BYTES + 1),
    concat([3, 1, 0], [0x12, 0x80]),
    response(1, [0x12, 0x7f, 0]),
    response(1, [0]),
    response(1, bytesField(2, bytesField(4, badUtf8Player))),
    response(1, bytesField(2, concat(stringField(1, "x"), bytesField(4, badUtf8Player)))),
    response(1, bytesField(2, numberField(1, 4))),
    concat([3, 1, 0], wrapper([], ".lq.OtherResponse")),
  ];
  for (const bytes of cases) assert.throws(() => decodeLiveListFrame(bytes));
});

test("request identity uses Wrapper.name exactly and rejects unrelated data containing the method", () => {
  const packets = [];
  const capture = new LiveListCapturer({ now: () => 1000, onPacket: value => packets.push(value) });
  for (const name of [".lq.Lobby.fetchGameLiveListExtra", ".lq.Lobby.login", "fetchGameLiveList"]) {
    capture.observeSend(request(1, name));
    capture.observeReceive(response(1));
  }
  capture.observeSend(concat([2, 1, 0], wrapper(text(".lq.Lobby.fetchGameLiveList"), ".lq.Lobby.login")));
  capture.observeReceive(response(1));
  assert.equal(packets.length, 0);
  capture.observeSend(request(257));
  capture.observeReceive(response(257));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].filterId, 3);
});

test("multiple requests may complete out of order, and sockets may reuse indexes independently", () => {
  const packets = [];
  const a = new LiveListCapturer({ now: () => 1000, idPrefix: "socket-a", onPacket: value => packets.push(value) });
  const b = new LiveListCapturer({ now: () => 1000, idPrefix: "socket-b", onPacket: value => packets.push(value) });
  a.observeSend(request(1, undefined, 7));
  a.observeSend(request(2, undefined, 8));
  b.observeSend(request(1, undefined, 9));
  a.observeReceive(response(2));
  b.observeReceive(response(1));
  a.observeReceive(response(1));
  assert.deepEqual(packets.map(value => value.filterId), [8, 9, 7]);
  assert.equal(new Set(packets.map(value => value.requestId)).size, 3);
  a.observeReceive(response(1));
  assert.equal(packets.length, 3);
});

test("index reuse by another RPC invalidates the old watched request", () => {
  const packets = [];
  const capture = new LiveListCapturer({ now: () => 1000, onPacket: value => packets.push(value) });
  capture.observeSend(request(1));
  capture.observeSend(request(1, ".lq.Lobby.heatbeat"));
  capture.observeReceive(response(1));
  assert.equal(packets.length, 0);
});

test("requests expire after sixty seconds and the pending collection is bounded", () => {
  let now = 1000;
  const packets = [];
  const capture = new LiveListCapturer({ now: () => now, onPacket: value => packets.push(value) });
  capture.observeSend(request(1));
  now += 60_001;
  capture.observeReceive(response(1));
  assert.equal(packets.length, 0);
  for (let index = 0; index < 129; index++) capture.observeSend(request(index));
  assert.equal(capture.pending.size, 128);
  capture.observeReceive(response(0));
  assert.equal(packets.length, 0);
  capture.observeReceive(response(128));
  assert.equal(packets.length, 1);
});

test("captured bytes are copied and observer exceptions cannot affect the sender", () => {
  let packet;
  const capture = new LiveListCapturer({ now: () => 1000, onPacket: value => { packet = value; throw new Error("consumer failure"); } });
  capture.observeSend(request(1));
  const bytes = response(1);
  assert.doesNotThrow(() => capture.observeReceive(bytes));
  bytes.fill(99);
  assert.equal(new Uint8Array(packet.frame)[0], 3);
});

test("malformed sends remove reused pending indexes but never throw", () => {
  let count = 0;
  const capture = new LiveListCapturer({ now: () => 1000, onPacket: () => count++ });
  capture.observeSend(request(1));
  assert.doesNotThrow(() => capture.observeSend(new Uint8Array([2, 1, 0, 0x0a, 0x7f])));
  capture.observeReceive(response(1));
  assert.equal(count, 0);
  assert.doesNotThrow(() => capture.observeSend(request(2, ".lq.Lobby.fetchGameLiveList", 0xffffffff)));
  capture.observeReceive(response(2));
  assert.equal(count, 1);
});


test("request diagnostics include only the exact target method's identity, time and filter", () => {
  const requests = [];
  const capture = new LiveListCapturer({
    now: () => 3000, idPrefix: "socket-a", onRequest: value => requests.push(value),
  });
  for (const name of [".lq.Lobby.login", ".lq.Lobby.fetchGameLiveListExtra", "fetchGameLiveList"]) {
    capture.observeSend(request(1, name));
  }
  capture.observeSend(new Uint8Array([2, 1, 0, 10, 127]));
  assert.equal(requests.length, 0);
  capture.observeSend(request(2, undefined, 7));
  assert.deepEqual(requests, [{ requestId: "socket-a:1", requestedAt: 3000, filterId: 7 }]);
  assert.equal("frame" in requests[0], false);
});

test("throwing or mutating the request diagnostic callback cannot break the response capture", () => {
  const packets = [];
  const capture = new LiveListCapturer({
    now: () => 3000, idPrefix: "socket-b",
    onRequest: value => { value.requestId = "changed"; value.filterId = 99; throw new Error("diagnostic failure"); },
    onPacket: value => packets.push(value),
  });
  assert.doesNotThrow(() => capture.observeSend(request(2, undefined, 7)));
  capture.observeReceive(response(2));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].requestId, "socket-b:1");
  assert.equal(packets[0].filterId, 7);
});

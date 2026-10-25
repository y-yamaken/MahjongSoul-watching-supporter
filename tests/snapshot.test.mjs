import test from "node:test";
import assert from "node:assert/strict";
import { snapshotImage } from "../extension/snapshot.js";

const anchor = { x: .1, y: .2, width: .3, height: .4 };
const payload = { dataUrl: "data:image/png;base64,AQIDBA==", anchor };

function mockImageApi(t, { width = 1000, height = 500, contextAvailable = true, drawError = false } = {}) {
  const originalBitmap = globalThis.createImageBitmap;
  const originalCanvas = globalThis.OffscreenCanvas;
  const activity = { decoded: 0, disposed: 0, canvases: 0, blob: null, draw: null };
  const bitmap = { width, height, close() { activity.disposed++; } };
  globalThis.createImageBitmap = async blob => {
    activity.decoded++;
    activity.blob = blob;
    return bitmap;
  };
  globalThis.OffscreenCanvas = class {
    constructor(canvasWidth, canvasHeight) {
      activity.canvases++;
      assert.equal(canvasWidth, 32);
      assert.equal(canvasHeight, 16);
    }
    getContext(kind, options) {
      assert.equal(kind, "2d");
      assert.equal(options.willReadFrequently, true);
      if (!contextAvailable) return null;
      return {
        drawImage(...args) {
          activity.draw = args;
          if (drawError) throw new Error("draw failure");
        },
        getImageData(x, y, imageWidth, imageHeight) {
          assert.deepEqual([x, y, imageWidth, imageHeight], [0, 0, 32, 16]);
          const data = new Uint8ClampedArray(32 * 16 * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 25; data[i + 1] = 50; data[i + 2] = 100; data[i + 3] = 255;
          }
          return { data };
        },
      };
    }
  };
  t.after(() => {
    if (originalBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalBitmap;
    if (originalCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = originalCanvas;
  });
  return { activity, bitmap };
}

test("service-worker snapshot decodes locally, crops the anchor and disposes the bitmap", async t => {
  const { activity, bitmap } = mockImageApi(t);
  const response = await snapshotImage(payload);
  assert.equal(response.ok, true);
  assert.equal(response.anchorSignature.length, 1536);
  assert.deepEqual(response.anchorSignature.slice(0, 6), [25, 50, 100, 25, 50, 100]);
  assert.equal(response.anchorSimilarity, null);
  assert.equal(activity.blob.type, "image/png");
  assert.deepEqual([...new Uint8Array(await activity.blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(activity.draw, [bitmap, 100, 100, 300, 201, 0, 0, 32, 16]);
  assert.equal(activity.disposed, 1);
});

test("JPEG snapshots and reference signatures use the same comparison as OCR", async t => {
  const { activity } = mockImageApi(t);
  const referenceAnchor = Array.from({ length: 1536 }, (_, index) => [25, 50, 100][index % 3]);
  const response = await snapshotImage({
    ...payload, dataUrl: payload.dataUrl.replace("image/png", "image/jpeg"), referenceAnchor,
  });
  assert.equal(activity.blob.type, "image/jpeg");
  assert.equal(response.anchorSimilarity, 1);
  assert.equal(activity.disposed, 1);
});

test("invalid payload, image sources, anchors and references fail before image decoding", async t => {
  const { activity } = mockImageApi(t);
  for (const input of [
    null,
    { ...payload, dataUrl: "https://example.com/private.png" },
    { ...payload, dataUrl: "data:image/png;base64,A" },
    { ...payload, anchor: { x: .9, y: 0, width: .2, height: .5 } },
    { ...payload, referenceAnchor: [1, 2] },
  ]) {
    await assert.rejects(snapshotImage(input));
  }
  assert.equal(activity.decoded, 0);
  assert.equal(activity.canvases, 0);
});

test("oversized source images are released without allocating a canvas", async t => {
  const { activity } = mockImageApi(t, { width: 16385, height: 100 });
  await assert.rejects(snapshotImage(payload), /大きすぎ/);
  assert.equal(activity.canvases, 0);
  assert.equal(activity.disposed, 1);
});

test("an unavailable canvas context releases its decoded bitmap", async t => {
  const { activity } = mockImageApi(t, { contextAvailable: false });
  await assert.rejects(snapshotImage(payload), /処理できません/);
  assert.equal(activity.disposed, 1);
});

test("drawing failures still release the decoded bitmap", async t => {
  const { activity } = mockImageApi(t, { drawError: true });
  await assert.rejects(snapshotImage(payload), /draw failure/);
  assert.equal(activity.disposed, 1);
});


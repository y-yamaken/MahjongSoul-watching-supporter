import test from "node:test";
import assert from "node:assert/strict";
import { validateDataUrl, validateRegion, pixelRegion, signatureSimilarity, signatureFromRgba, SIGNATURE_LENGTH, recognitionSize } from "../extension/ocr-utils.js";

test("only bounded PNG/JPEG data URLs are accepted", () => {
  assert.equal(validateDataUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  for (const value of ["https://example.com/image.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,AAA", "data:image/png;base64,AAAA\n", null]) {
    assert.throws(() => validateDataUrl(value));
  }
});

test("crop coordinates stay within the image at fractional edges", () => {
  assert.deepEqual(pixelRegion({ x: 0.25, y: 0.1, width: 0.5, height: 0.5 }, 1920, 1080), { x: 480, y: 108, width: 960, height: 540 });
  const crop = pixelRegion({ x: 0.333, y: 0, width: 0.667, height: 1 }, 100, 50);
  assert.equal(crop.x + crop.width, 100);
  assert.equal(crop.height, 50);
});

test("invalid/empty/out-of-range crops and oversized images fail", () => {
  for (const region of [null, {}, { x: -0.1, y: 0, width: 0.5, height: 1 }, { x: 0.9, y: 0, width: 0.5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: NaN, width: 1, height: 1 }]) {
    assert.throws(() => validateRegion(region));
  }
  assert.throws(() => pixelRegion({ x: 0, y: 0, width: 1, height: 1 }, 10000, 10000));
});

test("RGB signatures omit alpha and compare normalized absolute difference", () => {
  const rgba = new Uint8ClampedArray(32 * 16 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([10, 20, 30, 255], i);
  const signature = signatureFromRgba(rgba);
  assert.equal(signature.length, SIGNATURE_LENGTH);
  assert.deepEqual(signature.slice(0, 3), [10, 20, 30]);
  assert.equal(signatureSimilarity(signature, signature), 1);
  assert.equal(signatureSimilarity(new Array(SIGNATURE_LENGTH).fill(0), new Array(SIGNATURE_LENGTH).fill(255)), 0);
  assert.equal(signatureSimilarity(signature, null), null);
  assert.throws(() => signatureSimilarity(signature, [10, 20, 30]));
  assert.throws(() => signatureSimilarity(signature, new Array(SIGNATURE_LENGTH).fill(NaN)));
});

test("OCR resize improves small text without allocating unbounded canvases", () => {
  assert.deepEqual(recognitionSize(800, 400), { width: 1600, height: 800 });
  const large = recognitionSize(7680, 4320);
  assert.ok(large.width <= 4096 && large.height <= 4096);
  assert.ok(large.width * large.height <= 12_010_000);
});

import test from "node:test";
import assert from "node:assert/strict";

let serial = 0;
async function setup({ rejectRecognition = false } = {}) {
  let listener;
  const activity = { calls: 0, working: 0, maxWorking: 0, terminated: 0, options: null, parameters: null };
  globalThis.chrome = { runtime: {
    id: "test-extension",
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (handler) => { listener = handler; } },
  } };
  globalThis.Image = class {
    naturalWidth = 1920;
    naturalHeight = 1080;
    set src(_value) { queueMicrotask(() => this.onload()); }
    decode() { throw new Error("Image.decode must not be used in an offscreen document"); }
  };
  globalThis.document = { createElement(type) {
    assert.equal(type, "canvas");
    return {
      width: 0, height: 0,
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(32 * 16 * 4).fill(128) }) }),
      toDataURL: () => "data:image/png;base64,AAAA",
    };
  } };
  globalThis.Tesseract = { async createWorker(languages, engine, options) {
    assert.equal(languages, "jpn+eng");
    assert.equal(engine, 1);
    activity.options = options;
    return {
      async setParameters(parameters) { activity.parameters = parameters; },
      async terminate() { activity.terminated += 1; },
      async recognize() {
        activity.calls += 1;
        activity.working += 1;
        activity.maxWorking = Math.max(activity.maxWorking, activity.working);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activity.working -= 1;
        if (rejectRecognition) throw new Error("OCR fixture failure");
        return { data: { text: "テスト雀士\nPlayer123", confidence: 93 } };
      },
    };
  } };
  await import(`../extension/offscreen.js?test=${++serial}`);
  return {
    activity,
    listener,
    send(type, payload) {
      return new Promise((resolve) => {
        assert.equal(listener({ target: "offscreen", type, payload }, { id: "test-extension" }, resolve), true);
      });
    },
  };
}
const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.6 };
const anchor = { x: 0.9, y: 0.9, width: 0.05, height: 0.05 };
const payload = { dataUrl: "data:image/png;base64,AAAA", region, anchor };

test("SNAPSHOT returns a 32x16 RGB signature and preview without starting OCR", async () => {
  const { send, activity } = await setup();
  const response = await send("SNAPSHOT", payload);
  assert.equal(response.ok, true);
  assert.equal(response.anchorSignature.length, 1536);
  assert.equal(response.anchorSimilarity, null);
  assert.equal(response.previewDataUrl, payload.dataUrl);
  assert.equal(activity.calls, 0);
  const match = await send("SNAPSHOT", { ...payload, referenceAnchor: response.anchorSignature });
  assert.equal(match.anchorSimilarity, 1);
});

test("ANALYZE jobs are serialized and configure only local OCR resources", async () => {
  const { send, activity } = await setup();
  const responses = await Promise.all([send("ANALYZE", payload), send("ANALYZE", payload)]);
  assert.equal(activity.maxWorking, 1);
  assert.equal(activity.calls, 2);
  assert.equal(activity.options.workerBlobURL, false);
  assert.equal(activity.options.gzip, false);
  for (const key of ["workerPath", "corePath", "langPath"]) assert.match(activity.options[key], /^chrome-extension:\/\/test-extension\//);
  assert.deepEqual(activity.parameters, { tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
  for (const response of responses) {
    assert.equal(response.ok, true);
    assert.equal(response.text, "テスト雀士\nPlayer123");
    assert.equal(response.confidence, 93);
  }
});

test("invalid input and failed OCR return bounded error responses", async () => {
  const { send, activity } = await setup({ rejectRecognition: true });
  const invalid = await send("ANALYZE", { ...payload, dataUrl: "https://example.com/image.png" });
  assert.equal(invalid.ok, false);
  assert.equal(activity.calls, 0);
  const failed = await send("ANALYZE", payload);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "OCR fixture failure");
  assert.equal(activity.terminated, 1);
});

test("messages from other senders or for other components are ignored", async () => {
  const { listener } = await setup();
  const unexpected = () => assert.fail("Unrelated message must not be answered");
  assert.equal(listener({ target: "offscreen", type: "ANALYZE", payload }, { id: "different-extension" }, unexpected), false);
  assert.equal(listener({ target: "background", type: "ANALYZE", payload }, { id: "test-extension" }, unexpected), false);
  assert.equal(listener({ target: "offscreen", type: "UNKNOWN", payload }, { id: "test-extension" }, unexpected), false);
});


test("PING replies synchronously without starting OCR or joining its queue", async () => {
  const { listener, activity } = await setup();
  let response;
  const result = listener({ target: "offscreen", type: "PING" }, { id: "test-extension" }, value => { response = value; });
  assert.equal(result, false);
  assert.deepEqual(response, { ok: true });
  assert.equal(activity.calls, 0);
});

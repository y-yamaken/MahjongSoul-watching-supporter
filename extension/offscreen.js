import {
  SIGNATURE_WIDTH, SIGNATURE_HEIGHT, MAX_IMAGE_PIXELS,
  validateDataUrl, validateRegion, pixelRegion,
  signatureFromRgba, signatureSimilarity, recognitionSize,
} from "./ocr-utils.js";

let workerPromise = null;
let queue = Promise.resolve();

function canvas(width, height) {
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  return result;
}

async function loadScreenshot(dataUrl) {
  validateDataUrl(dataUrl);
  const image = new Image();
  // Offscreen documents can receive load while Image.decode() never resolves.
  // Subscribe before assigning src so cached images cannot race the handlers.
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("画面画像を読み込めませんでした。"));
    image.src = dataUrl;
  });
  if (!image.naturalWidth || !image.naturalHeight ||
      image.naturalWidth > 16384 || image.naturalHeight > 16384 ||
      image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) {
    throw new Error("画面画像が大きすぎます。ウィンドウを小さくしてください。");
  }
  return image;
}

function cropImage(image, region, outputSize) {
  const crop = pixelRegion(region, image.naturalWidth, image.naturalHeight);
  const result = canvas(outputSize?.width ?? crop.width, outputSize?.height ?? crop.height);
  const context = result.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("画面画像を処理できませんでした。");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, result.width, result.height);
  return result;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!globalThis.Tesseract) throw new Error("OCRファイルを準備してから拡張機能を読み込み直してください。");
      const worker = await globalThis.Tesseract.createWorker("jpn+eng", 1, {
        workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
        corePath: chrome.runtime.getURL("vendor/core"),
        langPath: chrome.runtime.getURL("vendor/lang"),
        workerBlobURL: false,
        gzip: false,
        cacheMethod: "none",
        legacyCore: false,
        legacyLang: false,
        errorHandler: () => {},
      });
      try {
        await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
      } catch (error) {
        await worker.terminate();
        throw error;
      }
      return worker;
    })();
    const current = workerPromise;
    current.catch(() => { if (workerPromise === current) workerPromise = null; });
  }
  return workerPromise;
}

function resetWorker() {
  const abandoned = workerPromise;
  workerPromise = null;
  abandoned?.then((worker) => worker.terminate()).catch(() => {});
}

async function analyze(type, payload) {
  if (!payload || typeof payload !== "object") throw new Error("画面画像がありません。");
  validateRegion(payload.region);
  if (payload.anchor != null) validateRegion(payload.anchor, "更新ボタンの範囲");
  const image = await loadScreenshot(payload.dataUrl);
  const region = pixelRegion(payload.region, image.naturalWidth, image.naturalHeight);
  const cropped = cropImage(image, payload.region, recognitionSize(region.width, region.height));
  let anchorSignature = [];
  let anchorSimilarity = null;
  if (payload.anchor) {
    const anchor = cropImage(image, payload.anchor, { width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT });
    anchorSignature = signatureFromRgba(anchor.getContext("2d").getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT).data);
    anchorSimilarity = signatureSimilarity(anchorSignature, payload.referenceAnchor);
  } else if (payload.referenceAnchor != null) {
    throw new Error("更新ボタンの範囲を指定してください。");
  }
  const common = { ok: true, anchorSignature, anchorSimilarity };
  if (type === "SNAPSHOT") return { ...common, previewDataUrl: cropped.toDataURL("image/png") };

  const worker = await getWorker();
  const { data } = await worker.recognize(cropped, {}, { text: true });
  return {
    ...common,
    text: typeof data.text === "string" ? data.text.slice(0, 100_000) : "",
    confidence: Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, data.confidence)) : 0,
  };
}

async function runWithTimeout(type, payload) {
  let timeout;
  try {
    return await Promise.race([
      analyze(type, payload),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          resetWorker();
          reject(new Error("文字の読み取りが45秒以内に完了しませんでした。読み取り範囲を小さくしてください。"));
        }, 45_000);
      }),
    ]);
  } catch (error) {
    resetWorker();
    return { ok: false, error: error instanceof Error ? error.message : "画面の読み取りに失敗しました。" };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "offscreen") return false;
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (!["ANALYZE", "SNAPSHOT"].includes(message.type)) return false;
  const task = queue.then(() => runWithTimeout(message.type, message.payload));
  queue = task.then(() => {}, () => {});
  task.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
  return true;
});

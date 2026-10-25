import {
  SIGNATURE_WIDTH, SIGNATURE_HEIGHT,
  validateDataUrl, validateRegion, validateSignature, pixelRegion,
  signatureFromRgba, signatureSimilarity,
} from "./ocr-utils.js";

// This small image check runs inside the extension service worker. It does not
// need the OCR document, an Image element, or a runtime message round trip.
export async function snapshotImage(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("画面画像がありません。");
  }
  validateDataUrl(payload.dataUrl);
  validateRegion(payload.anchor, "更新ボタンの範囲");
  if (payload.referenceAnchor != null) validateSignature(payload.referenceAnchor);

  const separator = payload.dataUrl.indexOf(",");
  const mimeType = payload.dataUrl.slice(5, payload.dataUrl.indexOf(";"));
  const decoded = atob(payload.dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    // pixelRegion also rejects oversized or invalid source dimensions.
    const crop = pixelRegion(payload.anchor, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("更新ボタンの画像を処理できませんでした。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap, crop.x, crop.y, crop.width, crop.height,
      0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT,
    );
    const imageData = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
    const anchorSignature = signatureFromRgba(imageData.data);
    return {
      ok: true,
      anchorSignature,
      anchorSimilarity: signatureSimilarity(anchorSignature, payload.referenceAnchor),
    };
  } finally {
    bitmap.close();
  }
}


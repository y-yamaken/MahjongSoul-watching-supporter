export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 16;
export const SIGNATURE_LENGTH = SIGNATURE_WIDTH * SIGNATURE_HEIGHT * 3;
export const MAX_IMAGE_PIXELS = 34_000_000;
export const MAX_DATA_URL_LENGTH = 24_000_000;

export function validateDataUrl(value) {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_LENGTH ||
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("画面画像の形式またはサイズを確認してください。");
  }
  const encoded = value.slice(value.indexOf(",") + 1);
  if (encoded.length % 4 !== 0) throw new Error("画面画像が破損しています。");
  return value;
}

export function validateRegion(region, label = "読み取り範囲") {
  if (!region || typeof region !== "object") throw new Error(`${label}を指定してください。`);
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > 1.000001 || y + height > 1.000001) {
    throw new Error(`${label}が画面の範囲外です。`);
  }
  return { x, y, width, height };
}

export function pixelRegion(region, imageWidth, imageHeight) {
  const normalized = validateRegion(region);
  if (![imageWidth, imageHeight].every(Number.isInteger) ||
      imageWidth <= 0 || imageHeight <= 0 ||
      imageWidth > 16384 || imageHeight > 16384 ||
      imageWidth * imageHeight > MAX_IMAGE_PIXELS) {
    throw new Error("画面画像が大きすぎます。ウィンドウを小さくしてください。");
  }
  const x = Math.floor(normalized.x * imageWidth);
  const y = Math.floor(normalized.y * imageHeight);
  const right = Math.min(imageWidth, Math.ceil((normalized.x + normalized.width) * imageWidth));
  const bottom = Math.min(imageHeight, Math.ceil((normalized.y + normalized.height) * imageHeight));
  if (right <= x || bottom <= y) throw new Error("読み取り範囲が小さすぎます。");
  return { x, y, width: right - x, height: bottom - y };
}

export function validateSignature(signature) {
  if (!Array.isArray(signature) || signature.length !== SIGNATURE_LENGTH ||
      !signature.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error("画面の基準画像を設定し直してください。");
  }
  return signature;
}

export function signatureFromRgba(rgba) {
  if (!rgba || rgba.length !== SIGNATURE_WIDTH * SIGNATURE_HEIGHT * 4) {
    throw new Error("画面の基準画像を読み取れませんでした。");
  }
  const signature = [];
  for (let i = 0; i < rgba.length; i += 4) {
    signature.push(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  return validateSignature(signature);
}

export function signatureSimilarity(current, reference) {
  validateSignature(current);
  if (reference == null) return null;
  validateSignature(reference);
  let difference = 0;
  for (let i = 0; i < SIGNATURE_LENGTH; i += 1) {
    difference += Math.abs(current[i] - reference[i]);
  }
  return 1 - difference / (SIGNATURE_LENGTH * 255);
}

export function recognitionSize(width, height) {
  const scale = Math.min(2, 4096 / width, 4096 / height, Math.sqrt(12_000_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

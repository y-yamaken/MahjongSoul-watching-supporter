import { copyFile, mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, "extension", "vendor");
const commit = "87416418657359cb625c412a48b6e1d6d41c29bd";
const hashes = {
  "jpn.traineddata": "1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d",
  "eng.traineddata": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
  LICENSE: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
};
const inventory = [];
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function record(path, source) {
  const buffer = await readFile(path);
  inventory.push({ path: relative(destination, path).replaceAll("\\", "/"), source, bytes: buffer.length, sha256: sha256(buffer) });
}

async function copyPackage(name, expectedVersion, outputDirectory, files) {
  const packageDirectory = join(root, "node_modules", name);
  const info = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (info.version !== expectedVersion) throw new Error(`${name} must be ${expectedVersion}; found ${info.version}`);
  await mkdir(join(destination, outputDirectory), { recursive: true });
  for (const file of files) {
    const output = join(destination, outputDirectory, file.split("/").at(-1));
    await copyFile(join(packageDirectory, file), output);
    await record(output, `npm:${name}@${expectedVersion}/${file}`);
  }
  const legalFiles = (await readdir(packageDirectory)).filter((name) => /^(?:LICENSE|NOTICE|COPYING)(?:[.\-_]|$)/i.test(name));
  for (const file of legalFiles) {
    if (!(await stat(join(packageDirectory, file))).isFile()) continue;
    const output = join(destination, "licenses", `${name}-${file}`);
    await copyFile(join(packageDirectory, file), output);
    await record(output, `npm:${name}@${expectedVersion}/${file}`);
  }
  if (!legalFiles.length) throw new Error(`${name} package is missing license files.`);
}

async function downloadModel(file) {
  const folder = file === "LICENSE" ? "licenses" : "lang";
  const output = join(destination, folder, file === "LICENSE" ? "tessdata_fast-LICENSE" : file);
  const source = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${commit}/${file}`;
  let buffer;
  try {
    const existing = await readFile(output);
    if (sha256(existing) === hashes[file]) buffer = existing;
  } catch { /* Download when the verified local file is absent. */ }
  if (!buffer) {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
    if (sha256(buffer) !== hashes[file]) throw new Error(`${file}: SHA256 mismatch; the downloaded file was not saved.`);
    await writeFile(output, buffer);
  }
  await record(output, source);
}

await mkdir(join(destination, "licenses"), { recursive: true });
await mkdir(join(destination, "lang"), { recursive: true });
await copyPackage("tesseract.js", "6.0.1", "tesseract", [
  "dist/tesseract.min.js", "dist/worker.min.js",
  "dist/tesseract.min.js.LICENSE.txt", "dist/worker.min.js.LICENSE.txt",
]);
await copyPackage("tesseract.js-core", "6.0.0", "core", [
  "tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm",
]);
await Promise.all(Object.keys(hashes).map(downloadModel));
inventory.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(destination, "inventory.json"), JSON.stringify({ modelCommit: commit, files: inventory }, null, 2) + "\n", "utf8");
await writeFile(join(destination, "README.md"), `# OCRの同梱ファイル\n\nTesseract.js 6.0.1 / Tesseract.js-core 6.0.0 / tessdata_fast ${commit}。\n\nブラウザーでの処理は、このフォルダーのローカルファイルのみを使用します。\n各ファイルの取得元とSHA256は inventory.json、ライセンスは licenses/ を参照してください。\n\n生成コマンド: node scripts/prepare-vendor.mjs\n`, "utf8");
console.log(`Prepared ${inventory.length} verified local OCR files in extension/vendor.`);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const extensionPath = fileURLToPath(new URL("../extension", import.meta.url));
const executablePath = process.env.CHROMIUM_PATH || chromium.executablePath();
const context = await chromium.launchPersistentContext("", {
  executablePath, channel: "chromium", headless: true,
  args: [
    "--disable-extensions-except=" + extensionPath,
    "--load-extension=" + extensionPath,
    "--no-first-run", "--disable-background-networking",
  ],
});
const errors = [];
try {
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  assert.equal(new URL(serviceWorker.url()).protocol, "chrome-extension:");
  const samplePage = await context.newPage();
  const dataUrl = await samplePage.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600; canvas.height = 420;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1600, 420);
    ctx.fillStyle = "#111"; ctx.font = "bold 56px Meiryo, sans-serif";
    ctx.fillText("観戦通知", 50, 100);
    ctx.fillText("Player123", 50, 210);
    return canvas.toDataURL("image/png");
  });
  const helpersSource = (await readFile(new URL("../extension/ocr-utils.js", import.meta.url), "utf8")).replaceAll("export ", "");
  const snapshotFile = await readFile(new URL("../extension/snapshot.js", import.meta.url), "utf8");
  const snapshotSource = snapshotFile.slice(snapshotFile.indexOf(";") + 1).replaceAll("export ", "");
  const workerSnapshot = await serviceWorker.evaluate("(async()=>{" + helpersSource + snapshotSource + "const result=await snapshotImage(" + JSON.stringify({dataUrl,anchor:{x:0,y:0,width:.2,height:.2}}) + ");return {ok:result.ok,length:result.anchorSignature.length};})()");
  assert.deepEqual(workerSnapshot, { ok: true, length: 1536 });
  const result = await serviceWorker.evaluate(async ({ dataUrl }) => {
    const url = chrome.runtime.getURL("offscreen.html");
    const before = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (!before.length) {
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Independent local extension test" });
    }
    const start = performance.now();
    const payload = {
      dataUrl, region: { x: 0, y: 0, width: 1, height: 1 },
      anchor: { x: 0, y: 0, width: .2, height: .2 },
    };
    const response = await Promise.race([
      chrome.runtime.sendMessage({ target: "offscreen", type: "SNAPSHOT", payload }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SNAPSHOT timeout")), 15_000)),
    ]);
    return { response, elapsedMs: Math.round(performance.now() - start) };
  }, { dataUrl });
  assert.equal(result.response.ok, true, result.response.error);
  assert.equal(result.response.anchorSignature.length, 1536);
  assert.match(result.response.previewDataUrl, /^data:image\/png;base64,/);
  const recognized = await serviceWorker.evaluate(async dataUrl => {
    return chrome.runtime.sendMessage({
      target: "offscreen", type: "ANALYZE",
      payload: { dataUrl, region: { x: 0, y: 0, width: 1, height: 1 }, anchor: { x: 0, y: 0, width: .2, height: .2 } },
    });
  }, dataUrl);
  assert.equal(recognized.ok, true, recognized.error);
  assert.ok(recognized.text.replace(/\s/g, "").includes("観戦通知"));
  assert.ok(recognized.text.includes("Player123"));
  console.log(JSON.stringify({
    extensionLoaded: true, extensionId,
    workerSnapshot,
    recognizedText: recognized.text.trim(),
    snapshot: { ok: result.response.ok, signatureLength: result.response.anchorSignature.length, elapsedMs: result.elapsedMs },
    errors,
  }, null, 2));
} finally {
  await context.close();
}


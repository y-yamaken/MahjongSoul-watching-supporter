import http from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const extension = fileURLToPath(new URL("../extension/", import.meta.url));
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const html = `<!doctype html><html><meta charset="utf-8"><title>Local OCR smoke test</title><script src="/vendor/tesseract/tesseract.min.js"></script><script src="/harness.js"></script><script type="module" src="/start.js"></script></html>`;
const harness = `globalThis.chrome = {runtime: {id:'local-ocr-test', getURL: path => new URL('/'+path, location.origin).href, onMessage: {addListener: listener => {globalThis.ocrListener=listener;}}}};`;
const start = `import '/offscreen.js';
const sample = document.createElement('canvas');
sample.width=1600; sample.height=420;
const context=sample.getContext('2d');
context.fillStyle='#ffffff';context.fillRect(0,0,sample.width,sample.height);
context.fillStyle='#111111';context.font='bold 56px Meiryo, sans-serif';
context.fillText('雀魂テスト',50,100);
context.fillText('Player123',50,210);
context.fillText('観戦通知',50,320);
document.body.append(sample);
globalThis.ocrListener({target:'offscreen',type:'ANALYZE',payload:{dataUrl:sample.toDataURL('image/png'),region:{x:0,y:0,width:1,height:1},anchor:{x:0,y:0,width:0.2,height:0.2}}},{id:'local-ocr-test'},response=>{globalThis.smokeResult=response;});`;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".traineddata": "application/octet-stream" };
const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    response.setHeader("Content-Security-Policy", "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
    if (path === "/" || path === "/harness.js" || path === "/start.js") {
      response.setHeader("Content-Type", path === "/" ? types[".html"] : types[".js"]);
      response.end(path === "/" ? html : path === "/harness.js" ? harness : start);
      return;
    }
    const file = resolve(extension, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(resolve(extension) + sep)) throw new Error("Path outside extension");
    response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "mahjongsoul-ocr-smoke-"));
const browser = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  let debugPort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { debugPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await pause(100); }
  }
  if (!debugPort) throw new Error("Temporary Chrome profile did not start its debugger within 10 seconds.");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const externalRequests = [];
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const job = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) job?.reject(new Error(message.error.message)); else job?.resolve(message.result);
    }
    if (message.method === "Network.requestWillBeSent") {
      const url = message.params.request.url;
      if (/^https?:/.test(url) && !url.startsWith(origin + "/")) externalRequests.push(url);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await command("Network.enable");
  await command("Runtime.enable");
  await command("Page.navigate", { url: origin });
  let result;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await pause(500);
    const evaluation = await command("Runtime.evaluate", { expression: "JSON.stringify(globalThis.smokeResult || null)", returnByValue: true });
    result = JSON.parse(evaluation.result.value ?? "null");
    if (result) break;
    if (errors.length) throw new Error(errors.join("\n"));
  }
  assert.ok(result, "OCR did not return within 60 seconds");
  assert.equal(result.ok, true, result.error);
  const compactText = result.text.replace(/\s/g, "");
  assert.ok(compactText.includes("観戦通知"), `Japanese text not recognized: ${result.text}`);
  assert.ok(compactText.includes("Player123"), `English text not recognized: ${result.text}`);
  assert.equal(result.anchorSignature.length, 1536);
  assert.deepEqual(externalRequests, [], "OCR attempted to request remote resources");
  assert.deepEqual(errors, [], "Browser reported a JavaScript error");
  console.log(JSON.stringify({ ok: true, text: result.text.trim(), confidence: result.confidence, anchorSignatureLength: result.anchorSignature.length, externalRequests: externalRequests.length, csp: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" }, null, 2));
} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", resolve); setTimeout(resolve, 3000).unref(); } });
  server.closeAllConnections();
  server.close();
  const resolvedProfile = resolve(profile);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + sep) && resolvedProfile.split(sep).at(-1).startsWith("mahjongsoul-ocr-smoke-")) {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

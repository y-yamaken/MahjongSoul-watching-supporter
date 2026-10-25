import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const extension = fileURLToPath(new URL("../extension/", import.meta.url));
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const html = (await readFile(join(extension, "popup.html"), "utf8")).replace('<script type="module"', '<script src="/harness.js"></script><script type="module"');
const harness = `globalThis.chrome={runtime:{sendMessage:async()=>({ok:true,settings:{names:['サンプル雀士','Player123'],intervalSeconds:60},monitor:{enabled:false},status:{state:'ready',message:'監視を開始できます'},calibrated:true})},storage:{onChanged:{addListener(){}}}};`;
const start = "";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".traineddata": "application/octet-stream", ".css": "text/css; charset=utf-8", ".png": "image/png" };
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
const profile = await mkdtemp(join(tmpdir(), "mahjongsoul-popup-smoke-"));
const browser = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  let debugPort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { debugPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await pause(100); }
  }
  if (!debugPort) throw new Error("Temporary Chrome profile did not start its debugger within 10 seconds.");
  await pause(2000);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const realExtension = null;
  const popupUrl = realExtension ? new URL("popup.html", realExtension.url).href : origin;
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
  await command("Emulation.setDeviceMetricsOverride", { width: 360, height: 600, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: popupUrl });
  await pause(1200);
  const evaluation = await command("Runtime.evaluate", { expression: `JSON.stringify({title:document.title,state:document.querySelector('#state-label')?.textContent,bodyWidth:document.body.scrollWidth,viewportWidth:innerWidth,height:document.body.scrollHeight,errors:document.querySelector('#error-panel')?.hidden===false?document.querySelector('#error-message').textContent:null,start:document.querySelector('#start')?.getBoundingClientRect().toJSON(),notes:document.querySelector('.notes')?.getBoundingClientRect().toJSON()})`, returnByValue: true });
  const layout = JSON.parse(evaluation.result.value);
  assert.equal(layout.bodyWidth, layout.viewportWidth, "Popup overflows horizontally");
  assert.ok(layout.start.bottom <= 600, "Start action is clipped");
  assert.equal(layout.errors, null, "Popup shows startup error");
  assert.deepEqual(errors, [], "Popup JavaScript error");
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  const outputDirectory = fileURLToPath(new URL("../test-results/", import.meta.url));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "popup.png"), Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ actualExtensionLoaded: Boolean(realExtension), mode: realExtension ? "actual-extension" : "popup-with-fake-chrome-api", screenshot: join(outputDirectory,"popup.png"), layout }, null, 2));

} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", resolve); setTimeout(resolve, 3000).unref(); } });
  server.closeAllConnections();
  server.close();
  const resolvedProfile = resolve(profile);
  if (resolvedProfile.startsWith(resolve(tmpdir()) + sep) && resolvedProfile.split(sep).at(-1).startsWith("mahjongsoul-popup-smoke-")) {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

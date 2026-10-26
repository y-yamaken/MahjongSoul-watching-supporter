import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
// Reuse the pinned development dependency's WebSocket server; do not launch Playwright.
const { wsServer: WebSocketServer } = require(join(dirname(require.resolve("playwright-core")), "lib/utilsBundle.js"));
const sourceExtension = fileURLToPath(new URL("../extension", import.meta.url));
const fullPeriodicTest = true;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hiddenName = "背景で検出する雀士";
const browserZoom = Number(process.env.SMOKE_ZOOM || 1);
assert.ok(browserZoom >= 0.5 && browserZoom <= 2);
const players = Array.from({ length: 30 }, (_, index) => index === 29 ? hiddenName : "FixturePlayer" + index);
const varint = value => {
  const bytes = [];
  do { const part = value & 127; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
};
const field = (number, value) => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
};
const requestFrame = Buffer.concat([
  Buffer.from([2, 1, 0]),
  field(1, ".lq.Lobby.fetchGameLiveList"), field(2, [8, 1]),
]);
function responseFrame(index) {
  const games = [];
  for (let offset = 0; offset < players.length; offset += 4) {
    games.push(field(2, Buffer.concat([
      field(1, "background-fixture-" + offset),
      ...players.slice(offset, offset + 4).map(name => field(4, field(4, name))),
    ])));
  }
  return Buffer.concat([Buffer.from([3, index & 255, index >> 8]), field(1, ""), field(2, Buffer.concat(games))]);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const job = this.pending.get(message.id);
        if (!job) return;
        this.pending.delete(message.id);
        clearTimeout(job.timer);
        if (message.error) job.reject(new Error(message.error.message));
        else job.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map(arg => arg.description || arg.value || arg.type).join(" "));
      }
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDP(socket);
  }
  command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) {
    return (await this.command("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  }
  async evaluate(sessionId, expression) {
    const result = await this.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}
async function until(read, predicate, label, attempts = 150) {
  let result;
  for (let index = 0; index < attempts; index++) {
    result = await read();
    if (predicate(result)) return result;
    await pause(50);
  }
  throw new Error(label + ": " + JSON.stringify(result));
}

let origin;
let responses = 0;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end([
    '<!doctype html><html><meta charset="utf-8"><title>Background fixture</title>',
    '<style>html,body{margin:0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>',
    '<canvas id="unity-canvas" tabindex="0"></canvas><script>',
    "const canvas=document.getElementById('unity-canvas'),ctx=canvas.getContext('2d');",
    "function draw(){canvas.width=innerWidth;canvas.height=innerHeight;ctx.fillStyle='#edf5f3';ctx.fillRect(0,0,innerWidth,innerHeight);ctx.font='24px sans-serif';ctx.fillStyle='#123d38';ctx.fillText('FixturePlayer0',40,60);ctx.fillText('FixturePlayer1',40,110);ctx.fillStyle='#16786b';ctx.fillRect(innerWidth*.75,innerHeight*.75,innerWidth*.2,innerHeight*.1);ctx.fillStyle='white';ctx.fillText('更新',innerWidth*.82,innerHeight*.815)}draw();addEventListener('resize',draw);",
    "window.fixture={connected:false,refreshes:0,received:0,presses:0,releases:0,clicks:0,cancelled:0,lastHoldMs:0,trustedPresses:0,trustedReleases:0,ignoredSynthetic:0,nativeTrace:[]};",
    "for(const type of ['pointerdown','mousedown','pointerup','mouseup'])window.addEventListener(type,e=>{if(e.isTrusted&&fixture.nativeTrace.length<20)fixture.nativeTrace.push({type,x:e.clientX,y:e.clientY,button:e.button,buttons:e.buttons,isPrimary:e.isPrimary,width:innerWidth,height:innerHeight,dpr:devicePixelRatio});},{capture:true});",
    "const ws=new WebSocket(" + JSON.stringify(origin?.replace("http:", "ws:") + "/socket") + ");ws.binaryType='arraybuffer';let index=0;",
    "ws.addEventListener('open',()=>fixture.connected=true);ws.addEventListener('message',()=>fixture.received++);",
    "function refresh(){const bytes=new Uint8Array(" + JSON.stringify([...requestFrame]) + ");index++;bytes[1]=index&255;bytes[2]=index>>8;ws.send(bytes);fixture.refreshes++}",
    "let cursor={x:-1,y:-1},down=false,up=false,pressed=false,pressedAt=0,releaseFrames=0;",
    "canvas.addEventListener('mousemove',e=>{if(!e.isTrusted)return;cursor={x:e.clientX,y:e.clientY}});",
    "canvas.addEventListener('mousedown',e=>{if(!e.isTrusted){fixture.ignoredSynthetic++;return}fixture.trustedPresses++;cursor={x:e.clientX,y:e.clientY};down=true;pressedAt=performance.now()});",
    "canvas.addEventListener('mouseup',e=>{if(!e.isTrusted){fixture.ignoredSynthetic++;return}fixture.trustedReleases++;cursor={x:e.clientX,y:e.clientY};up=true;releaseFrames=3;fixture.lastHoldMs=performance.now()-pressedAt});",
    "function frame(){const focused=document.hasFocus()&&document.activeElement===canvas;const inside=cursor.x>=innerWidth*.75&&cursor.x<=innerWidth*.95&&cursor.y>=innerHeight*.75&&cursor.y<=innerHeight*.85;",
    "if(down){fixture.presses++;pressed=focused&&inside}if(up&&--releaseFrames<=0){fixture.releases++;if(pressed&&focused&&inside){fixture.clicks++;refresh()}else fixture.cancelled++;pressed=false;up=false}down=false;requestAnimationFrame(frame)}requestAnimationFrame(frame);",
    "</script></html>",
  ].join("\n"));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
const webSockets = new WebSocketServer({ server, path: "/socket" });
webSockets.on("connection", socket => {
  socket.on("message", data => {
    const bytes = Buffer.from(data);
    assert.equal(bytes[0], 2);
    assert.ok(bytes.includes(Buffer.from(".lq.Lobby.fetchGameLiveList")));
    responses++;
    socket.send(responseFrame(bytes[1] | bytes[2] << 8));
  });
});

const temporary = await mkdtemp(join(tmpdir(), "mahjongsoul-background-smoke-"));
const extension = join(temporary, "extension");
const profile = join(temporary, "profile");
let browser;
let cdp;
try {
  await cp(sourceExtension, extension, { recursive: true });
  const manifestPath = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.permissions.includes("debugger"), "Build the background-enabled extension first");
  const originalOrigin = "https://game.mahjongsoul.com";
  manifest.host_permissions = [origin + "/*"];
  for (const script of manifest.content_scripts) script.matches = [origin + "/*"];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const corePath = join(extension, "core.js");
  await writeFile(corePath, (await readFile(corePath, "utf8")).replaceAll(originalOrigin, origin));
  const backgroundPath = join(extension, "background.js");
  // Test-only aliases exercise the real SW-owned connection without granting
  // normal extension tabs additional commands in the shipped message handler.
  await writeFile(backgroundPath, (await readFile(backgroundPath, "utf8")) +
    "\nglobalThis.__backgroundSmokeEvents=[];chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='PAGE_INTERACTION')globalThis.__backgroundSmokeEvents.push({type:message.type,reason:message.reason,at:Date.now(),tabId:sender.tab?.id});return false;});globalThis.__backgroundSmokeApi = { ensureBackgroundAccess, stop };\n");
  await writeFile(join(extension, "controller.html"), '<!doctype html><meta charset="utf-8"><title>Background smoke controller</title><p>Active test tab</p>\n');
  browser = spawn(process.env.CHROMIUM_PATH || chromium.executablePath(), [
    "--headless=new", "--remote-debugging-port=0", "--window-size=1280,900",
    "--user-data-dir=" + profile, "--disable-extensions-except=" + extension, "--load-extension=" + extension,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  const debug = await until(async () => {
    try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); } catch { return null; }
  }, Boolean, "Chromium did not start");
  cdp = await CDP.connect("ws://127.0.0.1:" + debug[0] + debug[1]);
  const installed = await until(async () => {
    const extensions = (await cdp.command("Extensions.getExtensions")).extensions;
    return extensions.find(item => typeof item.path === "string" && resolve(item.path).toLowerCase() === resolve(extension).toLowerCase());
  }, Boolean, "The temporary unpacked extension was not installed");
  assert.equal(installed.name, manifest.name);
  const extensionId = installed.id;
  const swTarget = await until(async () => {
    return (await cdp.command("Target.getTargets")).targetInfos.find(target => target.type === "service_worker" && target.url === "chrome-extension://" + extensionId + "/background.js");
  }, Boolean, "The temporary extension service worker was not found");
  const swSession = await cdp.attach(swTarget.targetId);
  await cdp.command("Runtime.enable", {}, swSession);
  await cdp.command("Runtime.runIfWaitingForDebugger", {}, swSession);
  await until(() => cdp.evaluate(swSession, "typeof globalThis.chrome?.notifications?.create === 'function'"), Boolean, "Extension APIs not initialized");
  await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications=[];const originalCreate=chrome.notifications.create.bind(chrome.notifications);chrome.notifications.create=async(...args)=>{const result=await originalCreate(...args);globalThis.__backgroundSmokeNotifications.push(args);return result;};true");
  await cdp.evaluate(swSession, "globalThis.__backgroundDebuggerCommands=[];globalThis.__backgroundFocusStates=[];globalThis.__passiveMoveCount=0;const originalCommand=chrome.debugger.sendCommand.bind(chrome.debugger);chrome.debugger.sendCommand=async(...args)=>{globalThis.__backgroundDebuggerCommands.push(args[1]);if(args[1]==='Emulation.setFocusEmulationEnabled')globalThis.__backgroundFocusStates.push(args[2]?.enabled);const result=await originalCommand(...args);if(args[1]==='Input.dispatchMouseEvent'&&['mousePressed','mouseReleased'].includes(args[2]?.type)){const target=args[0],p=args[2];for(const delay of [0,8,16,24,32,40,48,56,64])setTimeout(()=>{globalThis.__passiveMoveCount++;originalCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.max(10,p.x-300)+delay,y:Math.max(10,p.y-100),button:'none',buttons:0,pointerType:'mouse'}).catch(()=>{});},delay);}return result;};true");
  const gameTarget = (await cdp.command("Target.createTarget", { url: origin + "/", background: false })).targetId;
  const gameSession = await cdp.attach(gameTarget);
  await cdp.command("Runtime.enable", {}, gameSession);
  await until(() => cdp.evaluate(gameSession, "Boolean(window.fixture?.connected)"), Boolean, "Fixture WebSocket did not connect");

  const controllerTarget = (await cdp.command("Target.createTarget", { url: "chrome-extension://" + extensionId + "/controller.html", background: false })).targetId;
  const controllerSession = await cdp.attach(controllerTarget);
  await cdp.command("Runtime.enable", {}, controllerSession);
  await cdp.command("Target.activateTarget", { targetId: controllerTarget });
  await until(() => cdp.evaluate(controllerSession, "typeof globalThis.chrome?.storage?.session === 'object'"), Boolean, "Controller not loaded");
  assert.equal(await cdp.evaluate(controllerSession, "chrome.runtime.getManifest().name"), manifest.name);
  await pause(100);
  const baseline = await cdp.evaluate(gameSession, "({focused:document.hasFocus(),visibility:document.visibilityState})");
  assert.equal(baseline.focused, false, "Raw CDP must not inject Playwright's focus emulation");
  assert.equal(baseline.visibility, "hidden", "The fixture must really be a background tab before attachment");
  const rejectedSynthetic = await cdp.evaluate(gameSession, "(()=>{const target=document.getElementById('unity-canvas');const point={bubbles:true,clientX:innerWidth*.85,clientY:innerHeight*.8,button:0};target.dispatchEvent(new MouseEvent('mousedown',{...point,buttons:1}));target.dispatchEvent(new MouseEvent('mouseup',{...point,buttons:0}));return {ignored:fixture.ignoredSynthetic,presses:fixture.trustedPresses,releases:fixture.trustedReleases}})()");
  assert.deepEqual(rejectedSynthetic, { ignored: 2, presses: 0, releases: 0 });
  // Release only our own observer session before the extension connects its debugger.
  await cdp.command("Target.detachFromTarget", { sessionId: gameSession });

  const tab = await cdp.evaluate(controllerSession, "(async()=>{await chrome.runtime.sendMessage({type:'GET_STATE'});return (await chrome.tabs.query({url:" + JSON.stringify(origin + "/*") + "}))[0]})()");
  assert.ok(tab?.id);
  const activeBefore = await cdp.evaluate(controllerSession, "(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()");
  assert.notEqual(activeBefore, tab.id);
  await cdp.evaluate(swSession, "(async()=>{await __backgroundSmokeApi.ensureBackgroundAccess(" + tab.id + ");return true})()");
  await cdp.evaluate(swSession, "chrome.tabs.setZoom(" + tab.id + "," + browserZoom + ")");
  await pause(250);
  const pageState = () => cdp.evaluate(controllerSession, "(async()=> (await chrome.scripting.executeScript({target:{tabId:" + tab.id + "},world:'MAIN',func:()=>({focused:document.hasFocus(),visibility:document.visibilityState,width:innerWidth,height:innerHeight,fixture:{...window.fixture}})}))[0].result)()");
  const emulated = await pageState();
  assert.equal(emulated.focused, true);
  assert.equal(emulated.visibility, "visible");

  const calibration = await cdp.evaluate(swSession, "(async()=>{const tabId=" + tab.id + ";await chrome.scripting.executeScript({target:{tabId},files:['page.js']});const page=await chrome.tabs.sendMessage(tabId,{type:'GET_PAGE_STATE'});const c={tabId,url:" + JSON.stringify(origin + "/") + ",viewport:page.viewport,canvasRect:page.canvasRect,point:{x:.85,y:.8},anchor:{x:.85-32/page.viewport.width,y:.8-20/page.viewport.height,width:64/page.viewport.width,height:40/page.viewport.height}};await chrome.storage.local.set({settings:{names:[" + JSON.stringify(hiddenName) + "],intervalSeconds:60,clickHoldMs:2000}});await chrome.storage.session.set({calibration:c,monitor:{enabled:true,tabId,token:'background-smoke',startedAt:Date.now()},status:{state:'running',message:'Background smoke',checkedAt:null,matchedNames:[]}});await chrome.tabs.sendMessage(tabId,{type:'ARM_PAGE'});return {viewport:c.viewport,point:c.point};})()");
  assert.ok(calibration.viewport.width > 0);
  assert.ok(calibration.viewport.height > 0);
  await cdp.evaluate(controllerSession, "(async()=>{await chrome.scripting.executeScript({target:{tabId:" + tab.id + "},world:'ISOLATED',func:()=>{globalThis.__backgroundResizeEvents=[{phase:'before',width:innerWidth,height:innerHeight,at:Date.now()}];window.addEventListener('resize',()=>globalThis.__backgroundResizeEvents.push({phase:'resize',width:innerWidth,height:innerHeight,at:Date.now()}));}});return true})()");
  const resizeEvidence = () => cdp.evaluate(controllerSession, "(async()=> (await chrome.scripting.executeScript({target:{tabId:" + tab.id + "},world:'ISOLATED',func:()=>({events:globalThis.__backgroundResizeEvents,after:{width:innerWidth,height:innerHeight}})}))[0].result)()");
  const holds = [];
  const fixtureHolds = [];
  const attempts = [];
  const configuredHolds = [2000, 200];
  let previousCheckedAt = 0;
  for (let count = 1; count <= 2; count++) {
    const expectedHoldMs = configuredHolds[count - 1];
    await cdp.evaluate(swSession, "(async()=>{const {settings}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,clickHoldMs:" + expectedHoldMs + "}});return true})()");
    if (fullPeriodicTest) {
      await cdp.evaluate(controllerSession, "(async()=>{await chrome.alarms.create('watch-spectators',{when:Date.now()+1000});return true})()");
    } else {
      const click = await cdp.evaluate(controllerSession, "(async()=>{const {calibration}=await chrome.storage.session.get('calibration');return chrome.tabs.sendMessage(" + tab.id + ",{type:'CLICK_REFRESH',calibration,holdMs:1000})})()");
      assert.equal(click.ok, true, click.error);
      assert.ok(click.actualHoldMs >= 950);
      holds.push(click.actualHoldMs);
    }
    let status;
    try {
      status = await until(
        () => cdp.evaluate(controllerSession, "(async()=>(await chrome.storage.session.get('status')).status)()"),
        state => state?.checkedAt > previousCheckedAt && state?.matchedNames?.includes(hiddenName) &&
          (!fullPeriodicTest || state.lastAttempt?.number === count && state.lastAttempt.responseReceived &&
            state.lastAttempt.trustedPress === true && state.lastAttempt.trustedRelease === true),
        "Background refresh " + count + " failed", 240,
      );
    } catch (error) {
      console.error("BACKGROUND_DIAGNOSTICS", JSON.stringify({
        interactionEvents: await cdp.evaluate(swSession, "globalThis.__backgroundSmokeEvents"),
        resize: await resizeEvidence(),
        state: await cdp.evaluate(controllerSession, "chrome.storage.session.get(['monitor','status','backgroundTabId'])"),
        page: await pageState(), errors: cdp.errors,
      }, null, 2));
      throw error;
    }
    previousCheckedAt = status.checkedAt;
    assert.deepEqual(status.matchedNames, [hiddenName]);
    assert.equal(status.gameCount, 8);
    assert.equal(status.playerCount, 30);
    if (fullPeriodicTest) {
      assert.equal(status.lastAttempt.configuredHoldMs, expectedHoldMs);
      assert.ok(status.lastAttempt.actualHoldMs >= (expectedHoldMs === 200 ? 180 : 1950), "The configured native hold must reach the page: " + JSON.stringify(status.lastAttempt));
      if (expectedHoldMs === 200) assert.ok(status.lastAttempt.actualHoldMs < 1000, "A changed short hold must not retain the previous two-second duration");
      assert.equal(status.lastAttempt.trustedPress, true);
      assert.equal(status.lastAttempt.trustedRelease, true);
      assert.ok(status.lastAttempt.cursorMovesIgnored >= 1, "The injected passive cursor update must be excluded during the hold");
      holds.push(status.lastAttempt.actualHoldMs);
      attempts.push(status.lastAttempt);
      const delivered = await pageState();
      assert.ok(delivered.fixture.lastHoldMs >= (expectedHoldMs === 200 ? 180 : 1950));
      if (expectedHoldMs === 200) assert.ok(delivered.fixture.lastHoldMs < 1000);
      fixtureHolds.push(Math.round(delivered.fixture.lastHoldMs));
    }
    const active = await cdp.evaluate(controllerSession, "(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()");
    assert.equal(active, activeBefore, "Refreshing must not select the watched tab");
    const watched = await cdp.evaluate(controllerSession, "chrome.tabs.get(" + tab.id + ")");
    assert.equal(watched.active, false);
  }
  const evidence = await pageState();
  assert.equal(evidence.fixture.clicks, 2);
  assert.equal(evidence.fixture.cancelled, 0);
  assert.equal(evidence.fixture.trustedPresses, 2);
  assert.equal(evidence.fixture.trustedReleases, 2);
  assert.equal(evidence.fixture.ignoredSynthetic, 2);
  assert.equal(responses, 2);
  const viewportEvidence = await resizeEvidence();
  const interactionEvents = await cdp.evaluate(swSession, "globalThis.__backgroundSmokeEvents");
  const notifications = await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications.length");
  assert.equal(notifications, 1);
  // Exercise an automatic stop through the real content-script message path.
  const failMonitoring = () => cdp.evaluate(controllerSession, "(async()=>{await chrome.scripting.executeScript({target:{tabId:" + tab.id + "},world:'ISOLATED',func:()=>chrome.runtime.sendMessage({type:'PAGE_INTERACTION',reason:'native-invalidated',detail:{event:'pointermove',stage:'pressed'}})});return true})()");
  await failMonitoring();
  let stopNotices = await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications.filter(args=>args[1].title==='監視が停止しました')");
  assert.equal(stopNotices.length, 1);
  assert.match(stopNotices[0][1].message, /自動クリック中/);
  await failMonitoring();
  assert.equal(await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications.length"), 2, "the stopped run must not notify twice");
  // Re-enable a monitored session without dismissing the previous stop toast.
  // The next failure must create a new Windows tag and retain sound enabled.
  await cdp.evaluate(swSession, "(async()=>{await __backgroundSmokeApi.ensureBackgroundAccess(" + tab.id + ");await chrome.storage.session.set({monitor:{enabled:true,tabId:" + tab.id + ",token:crypto.randomUUID(),startedAt:Date.now()}});return true})()");
  await failMonitoring();
  stopNotices = await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications.filter(args=>args[1].title==='監視が停止しました')");
  assert.equal(stopNotices.length, 2);
  assert.notEqual(stopNotices[0][0], stopNotices[1][0], "new failures must not reuse a Windows toast tag");
  assert.ok(stopNotices.every(args => args[1].silent === false));
  const stoppedTabs = await cdp.evaluate(swSession, "(async()=>(await chrome.storage.session.get('stoppedNotificationTabs')).stoppedNotificationTabs)()");
  assert.ok(stopNotices.every(args => stoppedTabs[args[0]] === tab.id));
  await failMonitoring();
  assert.equal(await cdp.evaluate(swSession, "globalThis.__backgroundSmokeNotifications.length"), 3);
  await pause(150);
  const afterStop = await pageState();
  const session = await cdp.evaluate(controllerSession, "chrome.storage.session.get(['backgroundTabId','monitor'])");
  const connectionReleased = await cdp.evaluate(swSession, "(async()=>{try{await chrome.debugger.sendCommand({tabId:" + tab.id + "},'Page.getLayoutMetrics',{});return false}catch{return true}})()");
  // Native input may leave the renderer's logical focused flag set in headless
  // Chrome even after emulation is disabled. Verify the actual released resources
  // and active-tab state instead of forcing an additional focus-changing action.
  assert.equal(afterStop.visibility, "hidden");
  const focusStates = await cdp.evaluate(swSession, "globalThis.__backgroundFocusStates");
  assert.ok(focusStates.includes(true));
  assert.equal(focusStates.at(-1), false, "STOP must explicitly disable focus emulation");
  const activeAfterStop = await cdp.evaluate(controllerSession, "(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()");
  assert.equal(activeAfterStop, activeBefore, "STOP must not activate the game tab");
  assert.equal(session.backgroundTabId, undefined);
  assert.equal(session.monitor.enabled, false);
  assert.equal(connectionReleased, true);
  const debuggerCommands = await cdp.evaluate(swSession, "globalThis.__backgroundDebuggerCommands");
  assert.equal(debuggerCommands.includes("Page.captureScreenshot"), false, "Background monitoring must not take screenshots");
  assert.ok(debuggerCommands.includes("Input.dispatchMouseEvent"), "The browser input API must generate the click");
  assert.deepEqual(cdp.errors, []);
  console.log(JSON.stringify({
    extensionLoaded: true, rawCdpWithoutPlaywrightDefaults: true, browserZoom,
    baseline, duringMonitoring: { focused: emulated.focused, visibility: emulated.visibility },
    watchedTabStayedInactive: true, activeTabUnchanged: true,
    passiveCursorUpdates: await cdp.evaluate(swSession, "globalThis.__passiveMoveCount"),
    screenCaptureUsed: false,
    backgroundClicks: evidence.fixture.clicks, configuredHoldMs: configuredHolds, clickHoldMs: holds,
    deliveredMouseHoldMs: fixtureHolds, trustedPresses: evidence.fixture.trustedPresses,
    trustedReleases: evidence.fixture.trustedReleases, ignoredSynthetic: evidence.fixture.ignoredSynthetic,
    attempts, websocketResponses: responses,
    scope: fullPeriodicTest ? "raw CDP full periodic background test" : "raw CDP component test",
    periodicAlarmRefreshes: fullPeriodicTest ? 2 : 0,
    viewportEvidence, interactionEvents,
    hiddenPlayerDetected: hiddenName, matchNotificationsCreated: notifications, stopNotificationsCreated: stopNotices.length,
    afterStop: { focused: afterStop.focused, visibility: afterStop.visibility },
    focusEmulationDisabled: focusStates.at(-1) === false,
    debuggerReleased: connectionReleased, monitorStopped: session.monitor.enabled === false,
    fixtureOrigin: "localhost-only", gameServerRequests: 0, errors: cdp.errors,
  }, null, 2));
} finally {
  cdp?.close();
  if (browser) {
    browser.kill();
    await new Promise(resolve => {
      if (browser.exitCode !== null) resolve();
      else { browser.once("exit", resolve); setTimeout(resolve, 3000).unref(); }
    });
  }
  for (const socket of webSockets.clients) socket.terminate();
  await new Promise(resolve => webSockets.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const verified = resolve(temporary);
  if (verified.startsWith(resolve(tmpdir()) + sep) && verified.split(sep).at(-1).startsWith("mahjongsoul-background-smoke-")) {
    await rm(verified, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}


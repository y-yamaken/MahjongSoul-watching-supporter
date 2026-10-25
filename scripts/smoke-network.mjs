import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const gameUrl = "https://game.mahjongsoul.com/";
const socketUrl = "wss://game.mahjongsoul.com/watch-test-socket";
const hiddenName = "画面外の雀士";
const receivedNames = Array.from({ length: 30 }, (_, index) =>
  index === 29 ? hiddenName : index < 2 ? "表示雀士" + (index + 1) : "FixturePlayer" + (index + 1));
const extensionPath = fileURLToPath(new URL("../extension", import.meta.url));

function varint(number) {
  const bytes = [];
  do { bytes.push((number & 127) | (number > 127 ? 128 : 0)); number = Math.floor(number / 128); } while (number);
  return Buffer.from(bytes);
}
function field(number, value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}
function listRequest(index) {
  const body = Buffer.concat([field(1, ".lq.Lobby.fetchGameLiveList"), field(2, Buffer.from([8, 1]))]);
  return Buffer.concat([Buffer.from([2, index & 255, (index >> 8) & 255]), body]);
}
function listResponse(index) {
  const games = [];
  for (let offset = 0; offset < receivedNames.length; offset += 4) {
    const players = receivedNames.slice(offset, offset + 4).map(name => field(4, field(4, name)));
    games.push(field(2, Buffer.concat([field(1, "fixture-game-" + offset / 4), ...players])));
  }
  const wrapper = Buffer.concat([field(1, ""), field(2, Buffer.concat(games))]);
  return Buffer.concat([Buffer.from([3, index & 255, (index >> 8) & 255]), wrapper]);
}

const html = [
  '<!doctype html><html lang="ja"><meta charset="utf-8"><title>観戦一覧の通信テスト</title>',
  '<style>html,body{margin:0;overflow:hidden}canvas{display:block;width:1280px;height:720px}</style>',
  '<canvas id="unity-canvas" width="1280" height="720" tabindex="0"></canvas><script>',
  // Some game scripts consume pointer events at window capture. The extension's
  // own observer must run first, without preventing those game handlers.
  "window.addEventListener('pointerdown',event=>{if(event.target.id==='unity-canvas')event.stopImmediatePropagation()},{capture:true});",
  "const canvas=document.getElementById('unity-canvas');const context=canvas.getContext('2d');",
  "context.fillStyle='#edf5f3';context.fillRect(0,0,1280,720);context.fillStyle='#123d38';context.font='30px sans-serif';",
  "context.fillText('表示雀士1',50,100);context.fillText('表示雀士2',50,160);",
  "context.fillStyle='#16786b';context.fillRect(1030,600,180,70);context.fillStyle='white';context.fillText('更新',1090,645);",
  "const socket=new WebSocket(" + JSON.stringify(socketUrl) + ");socket.binaryType='arraybuffer';let index=0;",
  "window.fixture={visibleNames:['表示雀士1','表示雀士2'],refreshes:0,received:0,sampledPresses:0,sampledReleases:0,completedClicks:0,cancelledClicks:0,focusFrames:0,lastHoldMs:null,trustedPresses:0,trustedReleases:0,ignoredSynthetic:0};",
  "window.requestFixtureList=()=>{const request=new Uint8Array(" + JSON.stringify([...listRequest(0)]) + ");",
  "index++;request[1]=index&255;request[2]=(index>>8)&255;socket.send(request);window.fixture.refreshes++;};",
  "socket.addEventListener('open',()=>{window.fixture.connected=true});",
  "socket.addEventListener('message',()=>{window.fixture.received++});",
  // Unity-style input polling: a DOM click alone never refreshes the fixture.
  "let cursor={x:-1,y:-1},pendingDown=false,pendingUp=false,pressed=false,downAt=null;",
  "canvas.addEventListener('mousemove',event=>{if(!event.isTrusted)return;cursor={x:event.clientX,y:event.clientY};});",
  "canvas.addEventListener('mousedown',event=>{if(!event.isTrusted){window.fixture.ignoredSynthetic++;return}window.fixture.trustedPresses++;downAt=performance.now();cursor={x:event.clientX,y:event.clientY};pendingDown=true;});",
  "canvas.addEventListener('mouseup',event=>{if(!event.isTrusted){window.fixture.ignoredSynthetic++;return}window.fixture.trustedReleases++;if(downAt!==null)window.fixture.lastHoldMs=performance.now()-downAt;downAt=null;cursor={x:event.clientX,y:event.clientY};pendingUp=true;});",
  "function inputFrame(){const focused=document.hasFocus()&&document.activeElement===canvas;",
  "window.fixture.hasFocus=document.hasFocus();window.fixture.canvasFocused=document.activeElement===canvas;if(focused)window.fixture.focusFrames++;",
  "const inside=cursor.x>=1030&&cursor.x<=1210&&cursor.y>=600&&cursor.y<=670;",
  "if(pendingDown){window.fixture.sampledPresses++;pressed=inside&&focused;}",
  "if(pendingUp){window.fixture.sampledReleases++;if(pressed&&inside&&focused){window.fixture.completedClicks++;window.requestFixtureList();}else window.fixture.cancelledClicks++;pressed=false;}",
  "pendingDown=false;pendingUp=false;requestAnimationFrame(inputFrame);}requestAnimationFrame(inputFrame);",
  "</script></html>",
].join("\n");

const context = await chromium.launchPersistentContext("", {
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  channel: "chromium", headless: true, viewport: { width: 1280, height: 720 },
  args: [
    "--disable-extensions-except=" + extensionPath, "--load-extension=" + extensionPath,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--disable-background-networking",
  ],
});
const errors = [];
let mockedResponses = 0;
try {
  await context.route("https://game.mahjongsoul.com/**", route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  // This route supplies every frame locally and never opens an upstream socket.
  await context.routeWebSocket(socketUrl, socket => {
    socket.onMessage(message => {
      const frame = Buffer.from(message);
      assert.equal(frame[0], 2);
      assert.ok(frame.includes(Buffer.from(".lq.Lobby.fetchGameLiveList")));
      const index = frame[1] | (frame[2] << 8);
      mockedResponses++;
      socket.send(listResponse(index));
    });
  });
  const serviceWorker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(serviceWorker.url()).host;
  const game = await context.newPage();
  game.on("pageerror", error => errors.push(error.message));
  await game.goto(gameUrl);
  await game.waitForFunction(() => window.fixture?.connected);
  const visible = await game.evaluate(() => window.fixture.visibleNames);
  assert.equal(visible.length, 2);
  assert.ok(!visible.includes(hiddenName));
  const rejectedSynthetic = await game.evaluate(() => {
    const canvas = document.getElementById("unity-canvas");
    const point = { bubbles: true, clientX: 1120, clientY: 635, button: 0 };
    canvas.dispatchEvent(new MouseEvent("mousedown", { ...point, buttons: 1 }));
    canvas.dispatchEvent(new MouseEvent("mouseup", { ...point, buttons: 0 }));
    return { ignored: window.fixture.ignoredSynthetic, presses: window.fixture.trustedPresses, releases: window.fixture.trustedReleases };
  });
  assert.deepEqual(rejectedSynthetic, { ignored: 2, presses: 0, releases: 0 });

  const tab = await serviceWorker.evaluate(async gameUrl => {
    return (await chrome.tabs.query({ url: gameUrl + "*" }))[0];
  }, gameUrl);
  assert.ok(tab?.id, "The isolated fixture tab must be found");

  await serviceWorker.evaluate(() => {
    globalThis.__networkSmokeNotifications = [];
    const create = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = async (...args) => {
      const result = await create(...args);
      globalThis.__networkSmokeNotifications.push({ id: result, options: args.at(-1) });
      return result;
    };
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  async function openPopup() {
    const tabs = (await browserSession.send("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos;
    const target = tabs.find(item => item.url === gameUrl);
    assert.ok(target, "The fixture needs a top-level tab target");
    await browserSession.send("Extensions.triggerAction", { id: extensionId, targetId: target.targetId });
    let popupTarget;
    for (let attempt = 0; attempt < 100; attempt++) {
      popupTarget = (await browserSession.send("Target.getTargets")).targetInfos.find(item =>
        item.url === "chrome-extension://" + extensionId + "/popup.html");
      if (popupTarget) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(popupTarget, "The real extension action must open its popup");
    const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId: popupTarget.targetId, flatten: false });
    let nextId = 0;
    const pending = new Map();
    const listener = event => {
      if (event.sessionId !== sessionId) return;
      const item = JSON.parse(event.message);
      const job = pending.get(item.id);
      if (!job) return;
      pending.delete(item.id);
      clearTimeout(job.timer);
      if (item.error) job.reject(new Error(item.error.message)); else job.resolve(item.result);
    };
    browserSession.on("Target.receivedMessageFromTarget", listener);
    async function evaluate(expression) {
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Popup evaluation timed out")), 5000);
        pending.set(id, { resolve, reject, timer });
        void browserSession.send("Target.sendMessageToTarget", {
          sessionId, message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }),
        }).catch(reject);
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("['停止中','監視中','待機中'].includes(document.querySelector('#state-label')?.textContent)")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      evaluate,
      async close() {
        browserSession.off("Target.receivedMessageFromTarget", listener);
        const remaining = (await browserSession.send("Target.getTargets")).targetInfos;
        if (remaining.some(target => target.targetId === popupTarget.targetId)) {
          await browserSession.send("Target.closeTarget", { targetId: popupTarget.targetId });
        }
      },
    };
  }
  const settingsPopup = await openPopup();
  await settingsPopup.evaluate("document.querySelector('#names').value = " + JSON.stringify(hiddenName));
  await settingsPopup.evaluate("document.querySelector('#interval').value = '60'");
  await settingsPopup.evaluate("document.querySelector('#hold-seconds').value = '1.0'");
  await settingsPopup.evaluate("document.querySelector('#calibrate').click()");
  await game.locator("[data-mahjong-soul-watch-calibration]").waitFor();
  await game.mouse.click(1120, 635);
  await game.locator('[data-mahjong-soul-watch-notice="success"]').waitFor({ timeout: 5000 });

  const startPopup = await openPopup();
  let startEnabled = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    startEnabled = await startPopup.evaluate("!document.querySelector('#start').disabled");
    if (startEnabled) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(startEnabled, true, "Saving the update point must enable Start");
  await startPopup.evaluate("document.querySelector('#start').click()");
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await serviceWorker.evaluate(async () => (await chrome.storage.session.get("status")).status);
    if (status?.matchedNames?.includes(hiddenName) && status.lastAttempt?.responseReceived && status.lastAttempt?.actualHoldMs >= 950 && status.lastAttempt.trustedPress && status.lastAttempt.trustedRelease) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const clickEvidence = await game.evaluate(() => ({ ...window.fixture }));
  assert.ok(clickEvidence.lastHoldMs >= 950, "The configured 1.0-second click must hold for at least 950 ms: " + clickEvidence.lastHoldMs);
  assert.equal(status.lastAttempt?.number, 1);
  assert.equal(status.lastAttempt?.configuredHoldMs, 1000);
  assert.ok(status.lastAttempt?.actualHoldMs >= 950, "Missing measured hold diagnostics: " + JSON.stringify(status));
  assert.equal(status.lastAttempt?.requestObserved, true);
  assert.equal(status.lastAttempt?.responseReceived, true);
  assert.equal(status.lastAttempt?.trustedPress, true);
  assert.equal(status.lastAttempt?.trustedRelease, true);
  const firstAttempt = { ...status.lastAttempt };
  assert.equal(clickEvidence.completedClicks, 1, "The refresh must pass frame-polled press/release processing: " + JSON.stringify(clickEvidence));
  assert.equal(clickEvidence.cancelledClicks, 0, "The simulated pointer must stay on the button through the release frame");
  assert.ok(clickEvidence.focusFrames > 0, "The game canvas must regain focus after the popup closes");
  assert.ok(status?.matchedNames?.includes(hiddenName), "The 30th, off-screen player must be detected: " + JSON.stringify(status));
  assert.equal(status.gameCount, 8);
  assert.equal(status.playerCount, 30);
  assert.ok(status.receivedNames.includes(hiddenName));
  const firstNotifications = await serviceWorker.evaluate(() => globalThis.__networkSmokeNotifications);
  assert.equal(firstNotifications.length, 1, "A matching game should notify once");
  assert.ok(firstNotifications[0].options.message.includes(hiddenName));

  await startPopup.close();
  const firstCheckedAt = status.checkedAt;
  // Validate the full popup flow with another tab selected. The dedicated
  // raw-CDP smoke verifies focus behavior without Playwright's defaults.
  const otherTab = await context.newPage();
  await otherTab.goto("about:blank");
  await otherTab.bringToFront();
  const inactiveBefore = await serviceWorker.evaluate(async id => !(await chrome.tabs.get(id)).active, tab.id);
  assert.equal(inactiveBefore, true);
  await serviceWorker.evaluate(async () => {
    await chrome.alarms.create("watch-spectators", { when: Date.now() + 1000 });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    status = await serviceWorker.evaluate(async () => (await chrome.storage.session.get("status")).status);
    if (status.checkedAt > firstCheckedAt && status.lastAttempt?.number === 2 && status.lastAttempt?.responseReceived && status.lastAttempt?.actualHoldMs >= 950 && status.lastAttempt.trustedPress && status.lastAttempt.trustedRelease) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(status.checkedAt > firstCheckedAt, "The background alarm must refresh the inactive game tab: " + JSON.stringify(status));
  const finalClickEvidence = await game.evaluate(() => ({ ...window.fixture }));
  assert.equal(finalClickEvidence.completedClicks, 2, "Both initial and background refreshes must click the button: " + JSON.stringify(finalClickEvidence));
  assert.equal(finalClickEvidence.sampledPresses, 2);
  assert.equal(finalClickEvidence.sampledReleases, 2);
  assert.equal(finalClickEvidence.cancelledClicks, 0);
  assert.ok(finalClickEvidence.lastHoldMs >= 950);
  assert.equal(status.lastAttempt?.number, 2);
  assert.equal(status.lastAttempt?.configuredHoldMs, 1000);
  assert.ok(status.lastAttempt?.actualHoldMs >= 950, "Missing measured hold diagnostics: " + JSON.stringify(status));
  assert.equal(status.lastAttempt?.requestObserved, true);
  assert.equal(status.lastAttempt?.responseReceived, true);
  assert.equal(status.lastAttempt?.trustedPress, true);
  assert.equal(status.lastAttempt?.trustedRelease, true);
  assert.equal(finalClickEvidence.trustedPresses, 2);
  assert.equal(finalClickEvidence.trustedReleases, 2);
  assert.equal(finalClickEvidence.ignoredSynthetic, 2);
  const finalNotifications = await serviceWorker.evaluate(() => globalThis.__networkSmokeNotifications);
  assert.equal(finalNotifications.length, 1, "The same match must not notify again");
  assert.equal(mockedResponses, 2);
  const inactiveAfter = await serviceWorker.evaluate(async id => !(await chrome.tabs.get(id)).active, tab.id);
  assert.equal(inactiveAfter, true, "Background refresh must not activate the game tab");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    extensionLoaded: true, extensionId, popupCalibrationAndStart: true, visiblePlayers: visible.length,
    receivedGames: status.gameCount, receivedPlayers: status.playerCount,
    offscreenPlayerDetected: hiddenName, notificationsCreated: finalNotifications.length,
    framePolledRefreshClicks: finalClickEvidence.completedClicks, alarmDrivenRefreshes: 1,
    gameTabStayedInactive: inactiveBefore && inactiveAfter,
    focusStateTest: "full popup flow; use smoke-background.mjs for raw-CDP focus verification",
    configuredIntervalSeconds: 60, configuredHoldMs: 1000,
    firstClickHoldMs: Math.round(clickEvidence.lastHoldMs),
    secondClickHoldMs: Math.round(finalClickEvidence.lastHoldMs),
    firstAttempt, secondAttempt: status.lastAttempt,
    sampledPresses: finalClickEvidence.sampledPresses, sampledReleases: finalClickEvidence.sampledReleases,
    cancelledClicks: finalClickEvidence.cancelledClicks, canvasFocusConfirmed: finalClickEvidence.focusFrames > 0,
    trustedPresses: finalClickEvidence.trustedPresses, trustedReleases: finalClickEvidence.trustedReleases,
    ignoredSynthetic: finalClickEvidence.ignoredSynthetic,
    websocketResponses: mockedResponses, gameServerRequests: 0, errors,
  }, null, 2));
} finally {
  await context.close();
}


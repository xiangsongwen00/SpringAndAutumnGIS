import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run with a Vite dev server. No virtual-time budget: it can expire before
// actual Worker messages arrive, incorrectly leaving a regression RUNNING.
const url = process.env.VECTOR_TEST_URL ?? 'http://127.0.0.1:5173/test/vector-orientation.html';
const chrome = process.env.CHROME_PATH ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const profile = await mkdtemp(join(tmpdir(), 'sag-vector-browser-'));
const processHandle = spawn(chrome, ['--headless', '--no-first-run', '--disable-extensions',
  `--window-size=${process.env.VECTOR_WINDOW_SIZE ?? '1280,800'}`,
  '--disable-background-networking', '--disable-gpu-sandbox', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, url], { windowsHide: true, stdio: 'ignore' });
let launchError;
processHandle.on('error', (error) => { launchError = error; });
const deadline = Date.now() + 60000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
let socket;
const pending = new Map();
let nextId = 0;
try {
  let port;
  while (!port && Date.now() < deadline) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { await pause(); }
  }
  assert.ok(port, 'Chrome DevTools did not start');
  let page;
  while (!page && Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((target) => target.type === 'page' && target.url === url);
    if (!page) await pause();
  }
  assert.ok(page, 'Regression page did not open');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  const evaluate = (expression) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  if (process.env.VECTOR_APP_AUDIT === '1') {
    let appState;
    let settledAt = 0;
    do {
      if (process.env.VECTOR_TERRAIN_OFF === '1') {
        await evaluate('(()=>{const b=document.querySelector("#terrain-toggle");if(b?.textContent.includes("关闭地形")) b.click();})()');
      }
      const response = await evaluate('({selected:document.querySelector("#selected-value")?.textContent,imagery:document.querySelector("#imagery-value")?.textContent,terrain:document.querySelector("#terrain-value")?.textContent,fps:document.querySelector("#fps-value")?.textContent})');
      appState = response.result?.result?.value;
      const labelsVisible = Number(appState?.imagery?.match(/底图点注记\s+(\d+)\//)?.[1]) > 0;
      const terrainSettled = appState?.terrain?.includes('关闭') ||
        !appState?.terrain?.includes('粗层覆盖中') && appState?.terrain?.includes('0 加载');
      const imagerySettled = appState?.imagery?.includes('0 加载 · 0 排队');
      const settled = labelsVisible && terrainSettled && imagerySettled;
      if (!settled) settledAt = 0;
      else settledAt ||= Date.now();
      if (labelsVisible && (process.env.VECTOR_WAIT_SETTLED !== '1' || settledAt && Date.now() - settledAt >= 2000)) break;
      await pause();
    } while (Date.now() < deadline);
    console.log(JSON.stringify(appState));
    assert.ok(Number(appState?.imagery?.match(/底图点注记\s+(\d+)\//)?.[1]) > 0, 'Real Esri point labels did not become visible');
    if (process.env.VECTOR_TERRAIN_OFF === '1') {
      assert.ok(appState?.terrain?.includes('关闭'), 'Terrain-off audit must actually disable terrain');
      assert.ok(Number(appState?.selected) < 315, 'Flat top-down audit must leave budget headroom');
    }
    if (process.env.VECTOR_WAIT_SETTLED === '1') {
      assert.ok(settledAt && Date.now() - settledAt >= 2000, 'Real map did not settle before the audit deadline');
    }
    if (process.env.VECTOR_SCREENSHOT_PATH) {
      const screenshot = await new Promise((resolve) => {
        const id = ++nextId; pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
      });
      await writeFile(process.env.VECTOR_SCREENSHOT_PATH, Buffer.from(screenshot.result.data, 'base64'));
      console.log(`Screenshot saved: ${process.env.VECTOR_SCREENSHOT_PATH}`);
    }
  } else {
  let state;
  do {
    const response = await evaluate('({status:document.querySelector("#result")?.dataset.status,text:document.querySelector("#result")?.textContent})');
    state = response.result?.result?.value;
    if (state?.status) break;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(state?.status, 'passed', state?.text ?? 'Browser regression timed out');
  console.log(state.text);
  }
} finally {
  socket?.close();
  if (processHandle.exitCode === null && !launchError) {
    const exited = new Promise((resolve) => processHandle.once('exit', resolve));
    processHandle.kill();
    await exited;
  }
  // Exact mkdtemp-owned profile only; never delete a user's Chrome profile.
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

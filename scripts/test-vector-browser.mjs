import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run with a Vite dev server. No virtual-time budget: it can expire before
// actual Worker messages arrive, incorrectly leaving a regression RUNNING.
const url = process.env.VECTOR_TEST_URL ?? 'http://127.0.0.1:5173/test/vector-orientation.html';
const initialUrl = process.env.VECTOR_COLD_START === '1' ? 'about:blank' : url;
const chrome = process.env.CHROME_PATH ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const profile = await mkdtemp(join(tmpdir(), 'sag-vector-browser-'));
const gpuArguments = process.env.VECTOR_GPU_MODE === 'hardware' ? [] :
  ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const processHandle = spawn(chrome, ['--headless', '--no-first-run', '--disable-extensions',
  `--window-size=${process.env.VECTOR_WINDOW_SIZE ?? '1280,800'}`,
  '--disable-background-networking', '--disable-gpu-sandbox', ...gpuArguments, '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, initialUrl], { windowsHide: true, stdio: 'ignore' });
let launchError;
processHandle.on('error', (error) => { launchError = error; });
const deadline = Date.now() + Math.max(1000, Number(process.env.VECTOR_AUDIT_TIMEOUT_MS ?? 60000));
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
    page = targets.find((target) => target.type === 'page' && target.url === initialUrl);
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
  const command = (method, params) => new Promise((resolve) => {
    const id = ++nextId; pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  if (process.env.VECTOR_COLD_START === '1') {
    await command('Page.enable', {});
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__coldAudit={frames:[],longTasks:[],firstTextureMs:null};
      window.__coldSampling=true;
      new PerformanceObserver(list=>{if(window.__coldSampling)window.__coldAudit.longTasks.push(...list.getEntries().map(e=>({startMs:e.startTime,durationMs:e.duration})));}).observe({type:'longtask',buffered:true});
      let previous;function sample(now){if(previous!==undefined&&window.__coldAudit.frames.length<10000)window.__coldAudit.frames.push(now-previous);previous=now;
      if(window.__coldAudit.firstTextureMs===null&&Number(document.querySelector('#imagery-value')?.textContent.match(/纹理\\s+(\\d+)\\s+就绪/)?.[1])>0)window.__coldAudit.firstTextureMs=now;
      if(window.__coldSampling)requestAnimationFrame(sample);}requestAnimationFrame(sample);
    ` });
    await command('Page.navigate', { url });
  }
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
      const requiredContent = process.env.VECTOR_REQUIRE_LABELS === '0' ? Number(appState?.selected) > 0 : labelsVisible;
      const terrainSettled = appState?.terrain?.includes('关闭') ||
        !appState?.terrain?.includes('粗层覆盖中') && appState?.terrain?.includes('0 加载') &&
        (!appState?.terrain?.includes('排队') || appState?.terrain?.includes('0 排队')) &&
        (!appState?.terrain?.includes('待提交') || appState?.terrain?.includes('0 待提交')) &&
        (!appState?.terrain?.includes('地表准备') || appState?.terrain?.includes('0 地表准备'));
      const imagerySettled = appState?.imagery?.includes('0 加载 · 0 排队');
      const settled = requiredContent && terrainSettled && imagerySettled;
      if (!settled) settledAt = 0;
      else settledAt ||= Date.now();
      if (requiredContent && (process.env.VECTOR_WAIT_SETTLED !== '1' || settledAt && Date.now() - settledAt >= 2000)) break;
      await pause();
    } while (Date.now() < deadline);
    console.log(JSON.stringify(appState));
    if (process.env.VECTOR_OBSERVE_SECONDS) {
      const observations = [];
      const until = Date.now() + Number(process.env.VECTOR_OBSERVE_SECONDS) * 1000;
      while (Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const observed = await evaluate('({terrain:document.querySelector("#terrain-value")?.textContent,fps:document.querySelector("#fps-value")?.textContent})');
        observations.push({ second: observations.length + 1, ...observed.result?.result?.value });
      }
      console.log(`Loading observations: ${JSON.stringify(observations)}`);
    }
    if (process.env.VECTOR_COLD_START === '1') {
      const startup = await evaluate('(()=>{window.__coldSampling=false;const s=window.__coldAudit;const a=s.frames.sort((x,y)=>x-y);return {firstTextureMs:s.firstTextureMs,observedSettledMs:performance.now(),frames:a.length,p95Ms:a[Math.floor(a.length*.95)],p99Ms:a[Math.floor(a.length*.99)],longTasks:s.longTasks.length,longTaskMaxMs:Math.max(0,...s.longTasks.map(t=>t.durationMs)),largestLongTasks:s.longTasks.sort((x,y)=>y.durationMs-x.durationMs).slice(0,5),phases:Object.fromEntries(["lodMs","terrainMs","surfaceMs","featureMs","renderSubmitMs"].map(key=>{const p=(window.__coldFrameAudit??[]).map(s=>s[key]).sort((x,y)=>x-y);return [key,{p95:p[Math.floor(p.length*.95)]??null,max:p.at(-1)??null}]})),resourceEntries:performance.getEntriesByType("resource").length};})()');
      assert.ok(startup.result?.result?.value, JSON.stringify(startup));
      console.log(`Cold start: ${JSON.stringify(startup.result?.result?.value)}`);
    }
    if (process.env.VECTOR_REQUIRE_LABELS !== '0') {
      assert.ok(Number(appState?.imagery?.match(/底图点注记\s+(\d+)\//)?.[1]) > 0, 'Real Esri point labels did not become visible');
    } else assert.ok(Number(appState?.selected) > 0, 'Real terrain scene did not become visible');
    if (process.env.VECTOR_TERRAIN_OFF === '1') {
      assert.ok(appState?.terrain?.includes('关闭'), 'Terrain-off audit must actually disable terrain');
      const pitch = Number(new URL(url).searchParams.get('pitch') ?? -90);
      assert.ok(Number(appState?.selected) < (pitch <= -55 ? 315 : 351), 'Terrain-off audit tile budget');
    }
    if (process.env.VECTOR_WAIT_SETTLED === '1') {
      assert.ok(settledAt && Date.now() - settledAt >= 2000, 'Real map did not settle before the audit deadline');
    }
    const rendererInfo = await evaluate('(()=>{const gl=document.querySelector("canvas")?.getContext("webgl2");const ext=gl?.getExtension("WEBGL_debug_renderer_info");return {renderer:gl?.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER),buffer:gl?[gl.drawingBufferWidth,gl.drawingBufferHeight]:null};})()');
    console.log(JSON.stringify(rendererInfo.result?.result?.value));
    if (process.env.VECTOR_STABILITY_SECONDS) {
      const first = appState?.terrain?.match(/LOD重选(\d+)次/)?.[1];
      const until = Date.now() + Number(process.env.VECTOR_STABILITY_SECONDS) * 1000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const response = await evaluate('({selected:document.querySelector("#selected-value")?.textContent,terrain:document.querySelector("#terrain-value")?.textContent,imagery:document.querySelector("#imagery-value")?.textContent,fps:document.querySelector("#fps-value")?.textContent})');
        appState = response.result?.result?.value;
        assert.equal(appState?.terrain?.match(/LOD重选(\d+)次/)?.[1], first, 'Settled stationary view must not keep reselecting LOD');
      }
      console.log(`Stationary stable: ${JSON.stringify(appState)}`);
    }
    if (process.env.VECTOR_ZOOM_SWEEP === '1') {
      const box = (await evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.75};})()')).result.result.value;
      await evaluate('(()=>{window.__vectorAuditFrames=[];let previous=performance.now();window.__vectorAuditSampling=true;function sample(now){window.__vectorAuditFrames.push(now-previous);previous=now;if(window.__vectorAuditSampling)requestAnimationFrame(sample);}requestAnimationFrame(sample);})()');
      for (const deltaY of [120, 120, -120, -120, 120, -120]) {
        await new Promise((resolve) => {
          const id = ++nextId; pending.set(id, resolve);
          socket.send(JSON.stringify({ id, method: 'Input.dispatchMouseEvent', params: {
            type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY
          } }));
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const report = await evaluate('(()=>{window.__vectorAuditSampling=false;const a=window.__vectorAuditFrames.sort((x,y)=>x-y);return {frames:a.length,medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)],maximumMs:a.at(-1),selected:document.querySelector("#selected-value")?.textContent,terrain:document.querySelector("#terrain-value")?.textContent,imagery:document.querySelector("#imagery-value")?.textContent};})()');
      console.log(`Zoom sweep: ${JSON.stringify(report.result?.result?.value)}`);
    }
    if (process.env.VECTOR_MOTION_SWEEP === '1') {
      if (process.env.VECTOR_CPU_PROFILE === '1') {
        await command('Profiler.enable', {}); await command('Profiler.start', {});
      }
      const box = (await evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x+r.width*.45,y:r.y+r.height*.65};})()')).result.result.value;
      const dispatch = (params) => new Promise((resolve) => {
        const id = ++nextId; pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method: 'Input.dispatchMouseEvent', params }));
      });
      await evaluate('(()=>{window.__motionFrames=[];window.__motionLongTasks=[];let previous=performance.now();window.__motionSampling=true;window.__motionObserver=new PerformanceObserver(list=>window.__motionLongTasks.push(...list.getEntries().map(e=>e.duration)));window.__motionObserver.observe({type:"longtask",buffered:false});function sample(now){window.__motionFrames.push(now-previous);previous=now;if(window.__motionSampling)requestAnimationFrame(sample);}requestAnimationFrame(sample);})()');
      // Physical pointer events: left pans, right rotates, middle changes pitch.
      for (const [button, buttons, dx, dy] of [['left', 1, 220, 70], ['right', 2, 180, -70], ['middle', 4, 0, 60]]) {
        await dispatch({ type: 'mousePressed', x: box.x, y: box.y, button, buttons, clickCount: 1 });
        for (let step = 1; step <= 24; step++) {
          await dispatch({ type: 'mouseMoved', x: box.x + dx * step / 24, y: box.y + dy * step / 24, button, buttons });
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await dispatch({ type: 'mouseReleased', x: box.x + dx, y: box.y + dy, button, buttons: 0, clickCount: 1 });
      }
      for (const deltaY of [-240, -240, -240, 240, 240, 240]) {
        await dispatch({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      const motion = await evaluate('(()=>{window.__motionSampling=false;window.__motionObserver.disconnect();const a=window.__motionFrames.sort((x,y)=>x-y);return {frames:a.length,medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)],p99Ms:a[Math.floor(a.length*.99)],maximumMs:a.at(-1),longTasks:window.__motionLongTasks.length,longTaskMaxMs:Math.max(0,...window.__motionLongTasks)};})()');
      if (process.env.VECTOR_CPU_PROFILE === '1') {
        const { profile } = (await command('Profiler.stop', {})).result;
        const costs = new Map();
        for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
          const id = profile.samples[i]; costs.set(id, (costs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
        }
        console.log(`CPU hotspots (profiling overhead, not acceptance FPS): ${JSON.stringify(profile.nodes
          .map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url,
            line: node.callFrame.lineNumber + 1, selfMs: costs.get(node.id) ?? 0 }))
          .sort((a, b) => b.selfMs - a.selfMs).slice(0, 20))}`);
      }
      const stoppedAt = Date.now();
      let recoveredAt = 0;
      let fpsRecoveredAt = null;
      let fpsSince = null;
      let recoveredState;
      let quietSince = 0;
      while (Date.now() - stoppedAt < 30000) {
        recoveredState = (await evaluate('({selected:document.querySelector("#selected-value")?.textContent,terrain:document.querySelector("#terrain-value")?.textContent,imagery:document.querySelector("#imagery-value")?.textContent,fps:document.querySelector("#fps-value")?.textContent})')).result.result.value;
        if (parseFloat(recoveredState.fps) < 50) fpsSince = null;
        else fpsSince ??= Date.now();
        if (fpsRecoveredAt === null && fpsSince !== null && Date.now() - fpsSince >= 1000) fpsRecoveredAt = fpsSince - stoppedAt;
        const quiet = parseFloat(recoveredState.fps) >= 50 && recoveredState.imagery?.includes('0 加载 · 0 排队') &&
          (recoveredState.terrain?.includes('关闭') || ['0 加载', '0 排队', '0 待提交', '0 地表准备'].every(token => recoveredState.terrain?.includes(token)));
        if (!quiet) quietSince = 0;
        else quietSince ||= Date.now();
        if (quietSince && Date.now() - quietSince >= 1000) { recoveredAt = quietSince - stoppedAt; break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const phases = await evaluate('(()=>{const samples=window.__terrainFrameAudit??[];return Object.fromEntries(["lodMs","terrainMs","surfaceMs","featureMs","renderSubmitMs"].map(key=>{const a=samples.map(s=>s[key]).sort((x,y)=>x-y);return [key,{samples:a.length,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null}]}));})()');
      console.log(`Motion sweep: ${JSON.stringify({ ...motion.result.result.value, phases: phases.result.result.value, fpsRecoveryMs: fpsRecoveredAt, contentSettledMs: recoveredAt || null, final: recoveredState })}`);
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

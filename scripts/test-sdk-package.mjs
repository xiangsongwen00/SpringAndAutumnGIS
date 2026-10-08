import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve('.');
const consumer = await mkdtemp(join(tmpdir(), 'sag-sdk-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: process.platform === 'win32' && command.endsWith('.cmd') });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} failed (${code})\n${output}`)));
  });
}
console.log(`Independent consumer workspace: ${consumer}`);
const packed = await run(npm, ['pack', '--json', '--pack-destination', consumer], root);
const metadata = JSON.parse(packed.slice(packed.lastIndexOf('\n[') + 1))[0];
assert.ok(metadata.files.every(file => !/\.geojson$|(?:En|Enlabel)\.json$|token\.json$/.test(file.path)), 'demo/test data leaked into package');
assert.ok(metadata.files.some(file => file.path === 'dist/sdk/Viewer.d.ts'));
const archive = join(consumer, metadata.filename);
await cp(join(root, 'examples/sdk-consumer'), consumer, { recursive: true });
console.log(await run(npm, ['install', '--no-audit', '--no-fund', archive], consumer));
const require = createRequire(join(consumer, 'package.json'));
assert.equal(typeof require('spring-and-autumn-gis').Viewer.create, 'function', 'CJS export must be loadable');
console.log(await run(npm, ['run', 'build'], consumer));
const vite = join(consumer, 'node_modules/vite/bin/vite.js');
const port = 5197;
const server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: consumer, windowsHide: true, stdio: 'pipe' });
let serverError = ''; server.stderr.on('data', data => { serverError += data; }); server.stdout.on('data', () => {});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Consumer preview failed: ${serverError}`);
    try { ready = (await fetch(`http://127.0.0.1:${port}`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'consumer preview did not start');
  console.log(await run(process.execPath, [join(root, 'scripts/test-vector-browser.mjs')], root,
    { ...process.env, VECTOR_TEST_URL: `http://127.0.0.1:${port}/`, VECTOR_APP_AUDIT: '0', VECTOR_COLD_START: '0' }));
  const manifest = JSON.parse(await readFile(join(consumer, 'node_modules/spring-and-autumn-gis/package.json'), 'utf8'));
  assert.ok(manifest.peerDependencies.three);
  console.log(`SDK package passed: ${(metadata.size / 1024 / 1024).toFixed(2)} MiB packed, ${(metadata.unpackedSize / 1024 / 1024).toFixed(2)} MiB unpacked; ${archive}`);
} finally { server.kill(); }
// Retain the isolated install/build/tgz for inspection; no publishing or global npm install.

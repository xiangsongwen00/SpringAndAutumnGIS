const pageUrl = process.argv[2] ?? 'http://localhost:5173/';
const debuggerUrl = process.argv[3] ?? 'http://127.0.0.1:9223/json';
const pages = await (await fetch(debuggerUrl)).json();
const page = pages.find((candidate) =>
  candidate.type === 'page' && candidate.url.startsWith(pageUrl)
);
if (!page) throw new Error(`No browser page found for ${pageUrl}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let sequence = 0;
const pending = new Map();
const errors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  const logEntry = message.method === 'Log.entryAdded' ? message.params?.entry : null;
  const consoleError = message.method === 'Runtime.consoleAPICalled' &&
    message.params?.type === 'error';
  const failedAdminTile = message.method === 'Network.responseReceived' &&
    message.params?.response?.url.includes('adminxian') &&
    message.params.response.status >= 400;
  if (
    message.method === 'Runtime.exceptionThrown' ||
    consoleError ||
    failedAdminTile ||
    (logEntry && logEntry.source !== 'network')
  ) errors.push(message);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await call('Runtime.enable');
await call('Log.enable');
await call('Network.enable');
await call('Runtime.evaluate', {
  expression: `(() => {
    const checkbox = document.querySelector(
      '[data-layer-toggle="local-geoserver-adminxian-wmts"]'
    );
    if (!checkbox.checked) checkbox.click();
  })()`
});
await new Promise((resolve) => setTimeout(resolve, 5000));
const evaluation = await call('Runtime.evaluate', {
  expression: `JSON.stringify({
    checked: document.querySelector(
      '[data-layer-toggle="local-geoserver-adminxian-wmts"]'
    )?.checked,
    status: document.querySelector(
      '[data-layer-status="local-geoserver-adminxian-wmts"]'
    )?.textContent,
    canvas: Boolean(document.querySelector('canvas'))
  })`,
  returnByValue: true
});
socket.close();

const result = JSON.parse(evaluation.result.value);
if (!result.canvas || !result.checked || !result.status?.includes('已叠加')) {
  throw new Error(`Surface overlay did not become ready: ${JSON.stringify(result)}`);
}
if (errors.length > 0) throw new Error(`Surface overlay runtime errors: ${JSON.stringify(errors)}`);
console.log(`Surface overlay browser smoke check passed: ${JSON.stringify(result)}`);

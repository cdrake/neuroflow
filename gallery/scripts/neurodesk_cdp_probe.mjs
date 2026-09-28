// Read the live state of a Neurodesk Webapps job started with --remote-debugging-port:
// status text, progress, WebGPU adapter, and console output.
// Usage: node gallery/scripts/neurodesk_cdp_probe.mjs [port]   (default 9223; Node 22+)
// Start the suite with --remote-debugging-port=9223, or the adapter with NEURODESK_DEBUG_PORT=9223.
const port = process.argv[2] || '9223';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
console.log('targets:', targets.map((t) => `${t.type} ${t.url}`).join('\n         '));
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.log('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const logs = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Log.entryAdded') logs.push(`log.${m.params.entry.level}: ${m.params.entry.text}`);
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await send('Log.enable');
const expr = `(async () => {
  const $ = (id) => document.getElementById(id);
  let adapter = null, adapterError = null;
  try { const a = await navigator.gpu?.requestAdapter(); adapter = a ? (a.info?.vendor || 'yes') + ' ' + (a.info?.architecture || '') : 'none'; } catch (e) { adapterError = String(e); }
  return JSON.stringify({
    url: location.href, visibility: document.visibilityState, hidden: document.hidden,
    status: $('statusText')?.textContent, progress: $('progress')?.value, elapsed: $('elapsed')?.textContent,
    viewerError: $('viewerError')?.hidden ? null : $('viewerError')?.textContent,
    processDisabled: $('processButton')?.disabled, saveDisabled: $('saveBtn')?.disabled,
    webgpu: Boolean(navigator.gpu), adapter, adapterError,
  }, null, 2);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(r.result?.value ?? JSON.stringify(r));
await new Promise((res) => setTimeout(res, 3000));
console.log(logs.length ? logs.join('\n') : '(no console messages in 3 s)');
ws.close();

// Database-free Chromium benchmark: real components/CSS, synthetic 200 ms APIs.
// Usage: node scripts/performance/kds-benchmark.mjs baseline|after [baseline-file] [output-directory]
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const label = process.argv[2];
if (!['baseline', 'after'].includes(label)) throw new Error('Use baseline or after');
const baselineRef = process.argv[3] ?? '.tmp/kds-status/KdsClient.before.tsx';
const cpuRate = Number(process.env.KDS_BENCH_CPU ?? 4);
const out = resolve(process.argv[4] ?? '.tmp/kds-status'); await mkdir(out, { recursive: true });
const bundle = await build({ absWorkingDir: resolve('.'), tsconfig: resolve('tsconfig.json'), entryPoints: [resolve('scripts/performance/kds-fixture.tsx')], bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
  // Reproducible baseline without checking out files or changing the worktree.
  b.onLoad({ filter: /apps[\\/]web[\\/].*\.(ts|tsx)$/ }, async a => {
    const path = a.path.slice(resolve('.').length + 1).replaceAll('\\', '/');
    const contents = await readFile(label === 'baseline' && path.endsWith('KdsClient.tsx') ? baselineRef : a.path, 'utf8');
    return { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: resolve(a.path, '..') };
  });
  b.onResolve({ filter: /^next\/(navigation|link)$|\/AppLogo$|\/QuickLockButton$|\/LogoutButton$/ }, a => ({ path: a.path, namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useRouter=()=>({push:path=>window.bench.navigate(path),prefetch:()=>{}}); export const AppLogo=()=>null; export const QuickLockButton=()=>null; export const LogoutButton=()=>null; export default ()=>null;' }));
  b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: resolve('node_modules/react-dom/profiling.js'), namespace: 'node-fs' }));
  b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', external: true }));
  // Node resolves files without esbuild's parent-directory scan (restricted
  // Windows workspaces can read this repo but cannot enumerate its parent).
  b.onResolve({ filter: /.*/ }, a => {
    const candidate = a.path.startsWith('.') ? resolve(a.resolveDir, a.path) : a.path;
    const typed = ['.ts', '.tsx'].map(ext => candidate + ext).find(existsSync);
    return { path: typed ?? require.resolve(candidate, { paths: [a.resolveDir || resolve('.')] }), namespace: 'node-fs' };
  });
  b.onLoad({ filter: /.*/, namespace: 'node-fs' }, async a => ({ contents: await readFile(a.path, 'utf8'), loader: a.path.endsWith('.tsx') ? 'tsx' : a.path.endsWith('.ts') ? 'ts' : a.path.endsWith('.json') ? 'json' : 'js', resolveDir: resolve(a.path, '..') }));
} }] });
const cssDir = 'apps/web/.next/static/css';
const css = (await Promise.all((await readdir(cssDir)).filter(f => f.endsWith('.css')).map(f => readFile(`${cssDir}/${f}`, 'utf8')))).join('\n').replace(/@import[^;]+;/g, '');
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
  else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${out}/chrome-${label}-${Date.now()}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error(`Chrome startup timed out: ${buffer}`)), 20000);
    browser.stderr.on('data', data => { buffer += data; const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    browser.on('error', error => { clearTimeout(timeout); reject(error); });
    browser.on('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}: ${buffer}`)); });
  });
  console.log(`${label}: Chrome started`);
  ws = new WebSocket(endpoint, { handshakeTimeout: 10000 });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  console.log(`${label}: CDP connected`);
  let seq = 0; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 30000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(m.params)); });
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const runs = [];
  for (let run = 0; run < 3; run++) {
    await call('Page.navigate', { url: `http://127.0.0.1:${port}` });
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 50)); if (await evaluate('!!window.bench && !!document.querySelector("section")')) break; }
    if (!await evaluate('!!window.bench')) throw new Error(await evaluate('document.body.innerText'));
    const result = await evaluate(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const row=id=>[...document.querySelector('#'+id).querySelectorAll('div.bg-graphite-800.p-3')].find(el=>el.textContent.includes('Dish 0-0'));
      const mounting=performance.now();
      while(!row('a') || !row('b')) { if(performance.now()-mounting>15000)throw Error(document.body.innerText); await wait(25); }
      const results=[];
      for(const action of ['accept','ready']) {
        const current=row('a'), ri=bench.renders.length, qi=bench.requests.length;
        const start=performance.now();current.querySelector('button').click();
        await frames();const firstPaintMs=performance.now()-start;
        const localText=row('a')?.textContent ?? 'removed';
        while(!bench.requests.slice(qi).find(r=>r.method==='POST' && r.end)) await wait(10);
        const post=bench.requests.slice(qi).find(r=>r.method==='POST');
        await frames();
        const confirmationMs=performance.now()-start;
        const stateMatches=()=>action==='accept'?/U pripremi|Prihvaćeno/.test(row('b')?.textContent??''):!row('b')?.textContent.includes('Dish 0-0') || !row('b')?.querySelector('button');
        while(!stateMatches()){if(performance.now()-start>12000)break;await wait(20);}
        await frames();
        const secondDeviceMs=performance.now()-start;
        const renders=bench.renders.slice(ri).filter(r=>r.id==='a' && r.commitTime<=start+confirmationMs);
        results.push({action,firstPaintMs,firstCommitMs:renders[0]?.commitTime-start,localText,serverResponseMs:post.end-start,confirmationMs,secondDeviceMs,secondDeviceTimedOut:!stateMatches(),
          reactMs:renders.reduce((sum,r)=>sum+r.actualDuration,0),commits:renders.length,
          mutationRequests:bench.requests.slice(qi).filter(r=>r.method==='POST').length,
          actionRequests:bench.requests.slice(qi).filter(r=>r.url.includes('/advance')).length});
      }
      return results;
    })()`);
    runs.push(result); console.log(`${label} run ${run + 1} complete`);
  }
  await writeFile(`${out}/${label}.json`, JSON.stringify({ baselineRef, source: label === 'baseline' ? baselineRef : 'worktree', bundleSha256: createHash('sha256').update(bundle.outputFiles[0].text).digest('hex'), cssSha256: createHash('sha256').update(css).digest('hex'), cpuRate, environment: 'Chrome headless, production React profiling build, 1400x1000, two terminals each with 24 tickets/96 items; synthetic 800ms API and 1200ms history/printing; not physical devices or live server', runs }, null, 2));
  console.log(`Results: ${out}/${label}.json`);
} finally { ws?.close(); browser.kill(); server.close(); }

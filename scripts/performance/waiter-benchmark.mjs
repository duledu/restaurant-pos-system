// Database-free Chromium benchmark: real components/CSS, synthetic 200 ms APIs.
// Usage: node scripts/performance/waiter-benchmark.mjs baseline|after
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
const label = process.argv[2];
if (!['baseline', 'after'].includes(label)) throw new Error('Use baseline or after');
const out = resolve('.tmp/waiter-hot-path'); await mkdir(out, { recursive: true });
const bundle = await build({ entryPoints: ['scripts/performance/waiter-fixture.tsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture', setup(b) {
  // Reproducible baseline without checking out files or changing the worktree.
  if (label === 'baseline') b.onLoad({ filter: /apps[\\/]web[\\/].*\.(ts|tsx)$/ }, async a => {
    const path = a.path.slice(resolve('.').length + 1).replaceAll('\\', '/');
    const contents = execFileSync('git', ['show', `717d59d9b8d5dfad54468ef4c4cbe543a68e95db:${path}`], { encoding: 'utf8' });
    return { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: resolve(a.path, '..') };
  });
  b.onResolve({ filter: /^next\/navigation$|\/AppLogo$|\/QuickLockButton$|\/LogoutButton$/ }, a => ({ path: a.path, namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useRouter=()=>({push:path=>window.bench.navigate(path)}); export const AppLogo=()=>null; export const QuickLockButton=()=>null; export const LogoutButton=()=>null;' }));
  b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: resolve('node_modules/react-dom/profiling.js') }));
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
const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${out}/chrome-${label}-${Date.now()}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = ''; browser.stderr.on('data', data => { buffer += data; const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); }); browser.on('error', reject); browser.on('exit', code => reject(new Error(`Chrome exited ${code}`)));
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.once('open', r));
  let seq = 0; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(m.params)); });
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setCPUThrottlingRate', { rate: 4 });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const runs = [];
  for (let run = 0; run < 3; run++) {
    await call('Page.navigate', { url: `http://127.0.0.1:${port}` });
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 50)); if (await evaluate('!!window.bench && !!document.querySelector("section")')) break; }
    if (!await evaluate('!!window.bench')) throw new Error(await evaluate('document.body.innerText'));
    const result = await evaluate(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      const named=prefix=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith(prefix));
      const input=value=>{const el=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const results=[];
      const count=()=>Number(document.querySelector('.fixed.bottom-0 > div:first-child > span')?.textContent.split(' ')[0] ?? 0);
      async function measure(action,fn,usable=false,delta){
        const beforeCount=count();
        const index=bench.renders.length,requestIndex=bench.requests.length;let start=performance.now(),marked=false;
        const mark=()=>{if(!marked){start=performance.now();marked=true;}};
        document.addEventListener('click',mark,true);document.addEventListener('input',mark,true);
        try{fn();}finally{document.removeEventListener('click',mark,true);document.removeEventListener('input',mark,true);}await frames();
        if(usable)while(!document.querySelector('.fixed.bottom-0')&&!button('Započni porudžbinu')){if(performance.now()-start>10000)throw new Error('Order did not become usable');await frames();}
        const end=performance.now(), renders=bench.renders.slice(index);
        if(delta!==undefined && count()!==beforeCount+delta)throw new Error(action+' count mismatch: '+beforeCount+' -> '+count());
        const visibleCommit=usable?renders.find(r=>r.usableOrder||r.inspectedEmpty):renders[0];
        results.push({action,start,firstCommitMs:renders[0]?.commitTime-start,commitMs:visibleCommit?visibleCommit.commitTime-start:0,frameMs:end-start,reactMs:renders.reduce((s,r)=>s+r.actualDuration,0),commits:renders.length,requests:bench.requests.slice(requestIndex).map(r=>({method:r.method,url:r.url,start:r.start-start,end:r.duration?r.start+r.duration-start:null}))});
      }
      await measure('occupied cold open',()=>button('Table 1')?.click() || bench.navigate('/waiter/tables/1'),true);
      await wait(500);
      await measure('item add',()=>[...document.querySelectorAll('button')].find(b=>b.firstElementChild?.textContent==='Drink 12').click(),false,1);await wait(700);
      await measure('rapid +1',()=>named('Povećaj').click(),false,1);
      for(let i=0;i<4;i++){named('Povećaj').click();await frames();}
      await measure('decrement',()=>named('Umanji').click(),false,-1);await wait(700);
      await measure('remove draft',()=>named('Ukloni').click());await wait(250);
      await measure('category switch',()=>button('Category 1').click());
      await measure('search 240 results',()=>input('Drink'));
      await measure('clear search',()=>input(''));
      button('Category 0').click();await frames();
      await measure('modifier open',()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Drink 0')).click());
      await measure('modifier confirm',()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Dodaj')&&b.textContent.includes('RSD')).click(),false,1);await wait(700);
      await measure('quick +1',()=>named('Brzo dodaj').click(),false,1);await wait(700);
      await measure('repeat last round',()=>button('Ponovi poslednju rundu').click(),false,3);await wait(900);
      await measure('back to tables',()=>bench.navigate('/waiter/tables'));
      await measure('empty cold open',()=>bench.navigate('/waiter/tables/24'),true);await wait(500);
      await measure('back from empty',()=>bench.navigate('/waiter/tables'));
      await measure('cached reopen A',()=>bench.navigate('/waiter/tables/1'),true);await wait(500);
      await measure('switch A to B',()=>bench.navigate('/waiter/tables/24'),true);await wait(500);
      await measure('switch B to A',()=>bench.navigate('/waiter/tables/1'),true);await wait(500);
      const idleIndex=bench.renders.length;await wait(5500);const idle=bench.renders.slice(idleIndex);
      const readyStart=performance.now(),readyIndex=bench.renders.length;bench.ready();while(!document.body.textContent.includes('Spremno')){if(performance.now()-readyStart>10000)throw new Error('READY did not arrive');await wait(50);}
      const readyDetectionMs=performance.now()-readyStart,readyRenders=bench.renders.slice(readyIndex);
      bench.navigate('/waiter/tables');await frames();const traceIndex=bench.requests.length;
      bench.navigate('/waiter/tables/1');await wait(550);
      for(const id of [12,24,36]){[...document.querySelectorAll('button')].find(b=>b.firstElementChild?.textContent==='Drink '+id).click();await wait(250);}
      bench.navigate('/waiter/tables');await frames();bench.navigate('/waiter/tables/2');await wait(550);bench.navigate('/waiter/tables/1');await wait(550);
      return {results,idle:{commits:idle.length,reactMs:idle.reduce((s,r)=>s+r.actualDuration,0)},readyDetectionMs,readyReactMs:readyRenders.reduce((s,r)=>s+r.actualDuration,0),navigationTrace:bench.requests.slice(traceIndex),requests:bench.requests,renders:bench.renders};
    })()`);
    runs.push(result); console.log(`${label} run ${run + 1} complete`);
  }
  await writeFile(`${out}/${label}.json`, JSON.stringify({ environment: 'Chrome headless, production React profiling build, 4x CPU throttle, 412x915, 240 menu items/12 categories, 24 tables/80 submitted rows, synthetic 200ms API, external fonts disabled; not Android', runs }, null, 2));
  console.log(`Results: .tmp/waiter-hot-path/${label}.json`);
} finally { ws?.close(); browser.kill(); server.close(); }

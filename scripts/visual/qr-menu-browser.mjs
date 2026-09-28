import {build} from 'esbuild';
// Isolated, database-free Chromium visual QA. Stock photos are LOCAL FIXTURES.
// Run after a Next build; no restaurant business data is ever written.
import {readFileSync,readdirSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
const out=resolve('.tmp/qr-menu');mkdirSync(out,{recursive:true});
mkdirSync(out+'/assets',{recursive:true});
const photos={breakfast:'photo-1525351484163-7529414344d8',salad:'photo-1540189549336-e6e99c3679fe',pasta:'photo-1551183053-bf91a1d81141',coffee:'photo-1509042239860-f550ce710b93',wine:'photo-1510812431401-41d2bd2722f3'};
for(const [name,id] of Object.entries(photos))if(!existsSync(out+'/assets/'+name+'.jpg')){
 const response=await fetch(`https://images.unsplash.com/${id}?auto=format&fit=crop&w=${name==='breakfast'?1200:800}&q=80`,{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Fixture image HTTP '+response.status);
 writeFileSync(out+'/assets/'+name+'.jpg',Buffer.from(await response.arrayBuffer()));
}
const bundle=await build({entryPoints:['scripts/visual/qr-menu-fixture.tsx'],bundle:true,write:false,outdir:out,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'local-fonts',setup(b){
 b.onResolve({filter:/^next\/font\/google$/},a=>({path:a.path,namespace:'font-stub'}));
 b.onLoad({filter:/.*/,namespace:'font-stub'},()=>({contents:'const font = () => ({variable:""});export {font as Playfair_Display,font as Inter,font as Outfit,font as Cormorant_Garamond,font as Fredoka};'}));
}}]});
const builtCss=readdirSync('apps/web/.next/static/css',{recursive:true}).filter(f=>f.endsWith('.css')).map(f=>readFileSync('apps/web/.next/static/css/'+f,'utf8')).join('\n');
const faces=[...new Set(builtCss.match(/@font-face\s*\{[^}]+\}/g)??[])].join('\n').replaceAll('../media/','/fonts/').replaceAll('/_next/static/media/','/fonts/');
const font=(name)=>faces.match(new RegExp('font-family:\\s*(["\']?__'+name+'_[^;"\']+)'))?.[1]?.replace(/["']/g,'');
const vars=Object.entries({'elegant':'Playfair_Display','body':'Inter','modern':'Outfit','classic':'Cormorant_Garamond','casual':'Fredoka'}).map(([key,name])=>`--font-menu-${key}:"${font(name)}"`).join(';');
if(vars.includes('undefined'))throw new Error('Missing real Next font assets: '+vars);
const css=`${faces}\n:root{${vars}}*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{color:inherit}a{color:inherit}img{display:block} ${bundle.outputFiles.find(f=>f.path.endsWith('.css')).text}`;
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;
const server=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://local').pathname;
 if(pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js);}
 else if(pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
 else if(pathname.startsWith('/fonts/')){res.setHeader('Content-Type','font/woff2');res.end(readFileSync('apps/web/.next/static/media/'+basename(pathname)));}
 else if(pathname.startsWith('/assets/')){res.setHeader('Content-Type','image/jpeg');res.end(readFileSync(out+'/assets/'+basename(pathname)));}
 else if(pathname==='/real-menu.json'){res.setHeader('Content-Type','application/json');res.end(readFileSync(out+'/real-menu.json'));}
 else if(pathname.endsWith('.jpg')){res.writeHead(404);res.end();}
 else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="sr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOCAL VISUAL FIXTURE — not PREPROD</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${out}/chrome-${Date.now()}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws,send;
try{
 const endpoint=await new Promise((r,j)=>{let buffer='';browser.stderr.on('data',d=>{buffer+=d;const m=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)r(m[1]);});browser.on('error',j);browser.on('exit',c=>j(new Error('Chrome exit '+c)));});
 ws=new WebSocket(endpoint);await new Promise(r=>ws.once('open',r));let sequence=0;const pending=new Map(),errors=[];
 ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const call=(method,params)=>send(method,params,sessionId);await call('Runtime.enable');
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await wait(100);}throw new Error('Timeout '+expression);};
 const navigate=async(query='',width=390)=>{await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<640});await call('Page.navigate',{url:query.startsWith('http')?query:base+'/'+query});await until('!!document.querySelector("main section") || !!document.querySelector("main h2")');await evaluate('document.fonts.ready');await wait(300);};
 const shot=async(name,full=false)=>{const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:full,...(full?{clip:{x:0,y:0,width:await evaluate('innerWidth'),height:await evaluate('document.documentElement.scrollHeight'),scale:1}}:{})});writeFileSync(out+'/'+name+'.png',Buffer.from(r.data,'base64'));};
 const layout=()=>evaluate(`({width:document.documentElement.clientWidth,visualWidth:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,images:[...document.images].filter(i=>i.getBoundingClientRect().top<innerHeight).map(i=>({loaded:i.complete&&i.naturalWidth>0,width:i.width,height:i.height})),smallTargets:[...document.querySelectorAll('button,nav a')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&(r.width<44||r.height<44)}).map(b=>b.textContent),rowHeights:[...document.querySelectorAll('main button')].slice(0,5).map(b=>Math.round(b.getBoundingClientRect().height))})`);
 const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(120);};
 const fill=async value=>{await evaluate(`(()=>{const i=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(150);};
 const key=async name=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:name==='Escape'?27:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name});await wait(100);};
 const assert=async(expression,message)=>{if(!await evaluate(expression)){console.log('Assertion evidence',await evaluate('({scrollY,viewport:innerHeight,bodyHeight:document.documentElement.scrollHeight,active:document.querySelector("nav [aria-current=true]")?.textContent,nav:document.querySelector("nav")?.getBoundingClientRect().toJSON(),sections:[...document.querySelectorAll("main section")].map(s=>({id:s.id,rect:s.getBoundingClientRect().toJSON()}))})'));throw new Error(message);}};
 const results=[];
 for(const width of [390,360,412,768,1440]){
   await navigate('',width);results.push({case:'fixture-kitchen',...await layout()});await shot('golden-'+width);
   if(width===390){await shot('golden-390-full',true);await evaluate('document.querySelector("main button").focus()');await click('main button');await assert('!!document.querySelector("dialog[open]")','Detail did not open');await shot('detail-390');await key('Tab');await key('Tab');await assert('document.querySelector("dialog").contains(document.activeElement)','Focus escaped dialog');await key('Escape');await assert('!document.querySelector("dialog") && document.activeElement===document.querySelector("main button")','Escape/focus restoration failed');results.push({case:'native-dialog',open:true,focusTrapped:true,escape:true,focusRestored:true});}
   await click('[role="group"] button:nth-child(2)');await assert('document.querySelector("main").textContent.includes("Espresso") && !document.querySelector("main").textContent.includes("Omlet")','Mode filter failed');results.push({case:'fixture-bar',...await layout()});await shot('bar-'+width);
 }
 await navigate();await click('[aria-label="Pretraga menija"]');await fill('pljeskavica');await assert('document.querySelectorAll("main button").length===1','Search filter failed');await shot('long-name-390');results.push({case:'long-name-search',...await layout()});
 await fill('nothing-matches');await assert('document.querySelector("main").textContent.includes("Nema rezultata")','Empty search missing');await shot('search-empty-390');await key('Escape');await assert('document.activeElement?.getAttribute("aria-label")==="Pretraga menija"','Search focus not restored');results.push({case:'search',filter:true,empty:true,escape:true,focusRestored:true});
 await click('nav a[href$="-grill"]');await assert('document.querySelector("nav [aria-current=true]").textContent==="Roštilj"','Active category failed');await shot('category-scroll-390');results.push({case:'category-scroll',...await layout()});
 for(const theme of ['LIGHT','WARM','ELEGANT','DARK'])for(const width of [360,390,412]){await navigate('?theme='+theme,width);results.push({case:'theme-'+theme,...await layout()});if(width===390)await shot('theme-'+theme+'-390');}
 for(const font of ['ELEGANT','MODERN','CLASSIC','CASUAL']){await navigate('?font='+font);results.push({case:'font-'+font,...await layout()});await shot('font-'+font+'-390');}
 if(existsSync(out+'/real-menu.json'))for(const width of [360,390,412,768,1440]){await navigate('?real',width);await assert('document.querySelectorAll("main button").length===73','Real kitchen count');results.push({case:'real-data-kitchen',...await layout()});await shot('real-'+width);await click('[role="group"] button:nth-child(2)');await assert('document.querySelectorAll("main button").length===62','Real bar count');results.push({case:'real-data-bar',...await layout()});}
 await navigate('?broken');await assert('!document.querySelector("header img") && !document.querySelector("main button").querySelector("img")','Failed image fallback');results.push({case:'broken-images',...await layout()});await shot('broken-images-390');
 await navigate('?empty');results.push({case:'empty-menu',...await layout()});await shot('empty-menu-390');
 await navigate('?preview',1440);results.push({case:'admin-preview-container',...await layout()});await assert('document.querySelector("header").getBoundingClientRect().height===264','Preview used desktop hero');await shot('admin-preview-1440');
 await navigate();await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await assert('getComputedStyle(document.querySelector("main button")).transitionDuration==="0s"','Reduced motion');results.push({case:'reduced-motion',pass:true});
 await evaluate('document.querySelector("[data-theme]").style.zoom=2');results.push({case:'text-zoom-200',...await layout()});await shot('zoom-200-390');
 const runtime=process.argv.find(arg=>arg.startsWith('--runtime='))?.slice('--runtime='.length);
 if(runtime){
   if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(runtime))throw new Error('Runtime checks are local-only');
   for(const width of [360,390,412,768,1440]){
     await navigate(runtime+'/m/masa',width);await assert('document.querySelectorAll("main button").length===73','Next route kitchen count');results.push({case:'next-runtime-kitchen',...await layout()});await shot('next-real-'+width);
     await click('[role="group"] button:nth-child(2)');await assert('document.querySelectorAll("main button").length===62','Next route bar count');results.push({case:'next-runtime-bar',...await layout()});if(width===390)await shot('next-real-bar-390');
   }
 }
 const report={source:'Actual component and CSS; isolated local stock photo fixture; real Next-generated fonts. real-data cases use unmodified PREPROD public snapshot. next-runtime cases use the actual local Next route with PREPROD read-only menu data.',results,errors,fonts:vars};
 writeFileSync(out+'/browser-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({cases:results.length,errors,layoutFailures:results.filter(r=>r.overflow||r.smallTargets?.length),runtime:runtime??'not requested',fonts:vars},null,2));
 if(errors.length||results.some(r=>r.overflow||r.smallTargets?.length))process.exitCode=1;
}finally{if(send)try{await send('Browser.close');}catch{}ws?.close();browser.kill();await new Promise(r=>server.close(r));}

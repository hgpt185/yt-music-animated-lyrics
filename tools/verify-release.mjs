// Development only: verify a release in an isolated Chrome CDP profile.
// Start isolated test Chrome with --remote-debugging-port=9338 --enable-unsafe-extension-debugging.
// For headless hover checks also use:
// --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4
// node tools/verify-release.mjs /absolute/unpacked/path /absolute/assets/path
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]);
const assets=path.resolve(process.argv[3]);fs.mkdirSync(assets,{recursive:true});
const base=`http://127.0.0.1:${process.env.YTMAL_TEST_PORT||9338}`;
async function connect(url){const ws=new WebSocket(url);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pending=new Map(),events=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}else events.get(m.method)?.(m.params);});return{ws,on:(event,fn)=>events.set(event,fn),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));})};}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const info=await(await fetch(base+'/json/version')).json();const b=await connect(info.webSocketDebuggerUrl);
const extension=await b.send('Extensions.loadUnpacked',{path:root});
const tabs=async()=>await(await fetch(base+'/json/list')).json();
async function open(url){const {targetId}=await b.send('Target.createTarget',{url});await pause(200);return{targetId,...await connect((await tabs()).find(t=>t.id===targetId).webSocketDebuggerUrl)};}
const popup=await open(`chrome-extension://${extension.id}/popup.html`);
const evalIn=async(client,expression)=>{const r=await client.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const manifest=await evalIn(popup,'chrome.runtime.getManifest()');assert.equal(manifest.manifest_version,3);assert.ok(manifest.description.length<=132);
await evalIn(popup,"chrome.storage.local.clear().then(()=>chrome.runtime.sendMessage({type:'YTMAL_GET_LYRICS',payload:{}}))");
const workerTarget=(await tabs()).find(t=>t.url===`chrome-extension://${extension.id}/background.js`);assert.ok(workerTarget);const worker=await connect(workerTarget.webSocketDebuggerUrl);
const track={videoId:'demolyrics1',title:'Morning Light',artist:'Animation Demo',album:'',duration:60};
const texts=['Let the morning find us here','Hold this moment a little longer','Every sound is turning into light','And we keep moving through the night','Stay here while the world slows down','See the colors of the morning sky','Let the music lead us home'];
const lines=texts.map((text,i)=>({text,startMs:i*5000,endMs:(i+1)*5000,words:text.split(' ').map((text,j,words)=>({text,startMs:i*5000+j*5000/words.length,endMs:i*5000+(j+1)*5000/words.length}))}));
await evalIn(worker,`setCachedResult(ytmalTrackKey(${JSON.stringify(track)}),${JSON.stringify({ok:true,source:'preview',syncMode:'word',lines})})`);
const page=await open('about:blank');const errors=[];page.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails));await page.send('Runtime.enable');await page.send('Page.bringToFront');
await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
// Original, explicitly illustrative lyrics and a silent media clock for store screenshots.
const samples=8000*60,wav=Buffer.alloc(44+samples,128);wav.write('RIFF',0);wav.writeUInt32LE(36+samples,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(8000,28);wav.writeUInt16LE(1,32);wav.writeUInt16LE(8,34);wav.write('data',36);wav.writeUInt32LE(samples,40);
const icon=fs.readFileSync(path.join(root,'icons/icon512.png')).toString('base64');
const html=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font-family:Arial,sans-serif}header{height:80px;padding:0 40px;border-bottom:1px solid #242424;display:flex;align-items:center;justify-content:space-between;font-size:22px;font-weight:700}header span{font-size:13px;font-weight:400;color:#aaa}main{height:640px;display:grid;grid-template-columns:1fr 520px;gap:80px;padding:0 60px}section{align-self:center;width:400px;justify-self:center}section img{width:340px;height:340px;display:block;margin:0 auto 24px}h1{font-size:28px;margin:0 0 8px}section p{margin:0;color:#aaa;font-size:17px}ytmusic-player-page{display:block;height:640px;min-width:0}#tab-renderer{position:relative;min-height:640px!important;width:100%}footer{height:80px;border-top:1px solid #242424;display:flex;gap:24px;align-items:center;padding:0 60px;color:#aaa;font-size:13px}footer strong{color:white;font-size:15px}footer button{background:#303030;color:white;border:1px solid #555;border-radius:20px;padding:10px 18px;font:inherit;cursor:pointer}video{display:none}</style><header>Animated Lyrics<span>Playback preview · Original illustrative lyrics</span></header><ytmusic-app><main><section><img src="data:image/png;base64,${icon}" alt="Animated Lyrics icon"><h1>Morning Light</h1><p>Animation Demo</p></section><ytmusic-player-page><div id="tab-renderer" page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"></div></ytmusic-player-page></main><div id="movie_player"><video muted preload="auto" src="data:audio/wav;base64,${wav.toString('base64')}"></video></div></ytmusic-app><footer><button id="play">Play preview</button><strong>Morning Light</strong><span>Illustrative word timing · Click any lyric to seek</span></footer><script>const p=document.querySelector('#movie_player'),v=p.querySelector('video');p.getVideoData=()=>({video_id:'demolyrics1',title:'Morning Light',author:'Animation Demo'});p.getPlayerResponse=()=>({videoDetails:{videoId:'demolyrics1',title:'Morning Light',author:'Animation Demo',lengthSeconds:'60'}});v.addEventListener('loadedmetadata',()=>{v.currentTime=7});document.querySelector('#play').onclick=()=>v.paused?v.play():v.pause();</script>`;
await page.send('Fetch.enable',{patterns:[{urlPattern:'https://music.youtube.com/*',resourceType:'Document'}]});page.on('Fetch.requestPaused',e=>page.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(html).toString('base64')}));
await page.send('Page.navigate',{url:'https://music.youtube.com/watch?v=demolyrics1'});
const mode=()=>evalIn(page,`document.querySelector('#ytmal-shadow-host')?.shadowRoot?.querySelector('[data-ytmal-sync-indicator]')?.textContent`);
for(let i=0;i<50&&await mode()!=='Word sync';i++)await pause(100);assert.equal(await mode(),'Word sync');await pause(400);
const row=`document.querySelector('#ytmal-shadow-host').shadowRoot.querySelector('[data-line-index="2"]')`;
const inspect=()=>evalIn(page,`(()=>{const e=${row},r=e.getBoundingClientRect(),s=getComputedStyle(e),w=getComputedStyle(e.querySelector(".blyrics--word:not(.blyrics-word-highlight)"));return{x:r.x+20,y:r.y+r.height/2,background:s.backgroundColor,textColor:w.color,cursor:s.cursor,transition:w.transitionDuration}})()`);
const before=await inspect();assert.ok(before.y>80&&before.y<720);await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:before.x,y:before.y});await pause(220);const hover=await inspect();assert.equal(hover.cursor,'pointer');assert.equal(hover.background,before.background);assert.equal(hover.background,"rgba(0, 0, 0, 0)");assert.notEqual(hover.textColor,before.textColor);
const screenshot=async name=>{const s=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(assets,name),Buffer.from(s.data,'base64'));};
await screenshot('word-sync-1280x800.png');
await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:before.x,y:before.y,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:before.x,y:before.y,button:'left',clickCount:1});await pause(150);const seekTime=await evalIn(page,"document.querySelector('video').currentTime");assert.ok(Math.abs(seekTime-10)<.2);
assert.equal(await evalIn(page,"document.querySelector('#ytmal-shadow-host').shadowRoot.querySelector('[data-ytmal-sync-toggle]')"), null);
assert.equal(await evalIn(popup,"document.querySelectorAll('#retry-word-sync, details, #lookup-report, #copy-report').length"),0);
await evalIn(page,"document.querySelector('video').pause();document.querySelector('video').currentTime=7");
await evalIn(popup,"document.querySelector('#sync-mode-toggle').click()");await pause(250);assert.equal(await mode(),'Line sync');await screenshot('line-sync-1280x800.png');
await page.send('Page.reload');for(let i=0;i<50&&await mode()!=='Line sync';i++)await pause(100);assert.equal(await mode(),'Line sync');
await popup.send('Emulation.setDeviceMetricsOverride',{width:330,height:560,deviceScaleFactor:1,mobile:false});await popup.send('Page.bringToFront');
await evalIn(popup,"document.querySelector('#sync-mode-toggle').focus()");
await popup.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await popup.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(250);assert.equal(await mode(),'Word sync');
const popupState=await evalIn(popup,"({text:document.querySelector('#sync-mode-status').textContent,button:document.querySelector('#sync-mode-toggle').textContent,overflow:document.body.scrollHeight>innerHeight})");assert.equal(popupState.overflow,false);
const popupImage=await popup.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/ytmal-popup-settings.png',Buffer.from(popupImage.data,'base64'));
await page.send('Page.bringToFront');
await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});const reduced=await inspect();assert.equal(reduced.transition,'0s');
await page.send('Emulation.setEmulatedMedia',{features:[]});
const privacy=await open(`chrome-extension://${extension.id}/privacy.html`);const privacyTitle=await evalIn(privacy,'document.querySelector("h1").textContent');assert.equal(privacyTitle,'Privacy policy');
// The required store tile reuses the existing extension icon; it adds no new branding.
const promo=await open('about:blank');await promo.send('Emulation.setDeviceMetricsOverride',{width:440,height:280,deviceScaleFactor:1,mobile:false});await promo.send('Page.setDocumentContent',{frameId:(await promo.send('Page.getFrameTree')).frameTree.frame.id,html:`<body style="margin:0;background:#90233e;display:grid;place-items:center;height:100vh"><img width="208" height="208" src="data:image/png;base64,${icon}" alt="Animated Lyrics"></body>`});await pause(150);const tile=await promo.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(assets,'promo-440x280.png'),Buffer.from(tile.data,'base64'));fs.copyFileSync(path.join(root,'icons/icon128.png'),path.join(assets,'icon128.png'));
assert.equal(errors.length,0);
const report={browser:info.Browser,version:manifest.version,zipRuntimeLoaded:true,fixture:'Original illustrative lyrics; actual bundled renderer, metadata bridge, mode toggle and seek handler. Providers are bypassed through a seeded cache in this test profile.',wordAndLineModes:true,popupControl:true,onScreenModeControl:false,diagnosticControls:false,preferenceSurvivesReload:true,popupState,hoverBefore:before,hoverAfter:hover,clickSeekSeconds:seekTime,reducedMotionTransition:reduced.transition,privacyPage:true,pageExceptions:errors};
fs.writeFileSync(path.join(assets,'../browser-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
for(const client of [worker,popup,page,privacy,promo])client.ws.close();b.ws.close();

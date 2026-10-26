// Real bundled parsers + worker provider pipeline, isolated HTTP fixtures.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const track={videoId:'video-a',title:'Morning Light',artist:'The Travelers',album:'Daybreak',duration:200};
const ttml='<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">Morning</span> <span begin="2s" end="3s">light</span></p></div></body></tt>';
const lineTtml='<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s">Morning light</p></div></body></tt>';
const qrc='<?xml version="1.0"?><QrcInfos><LyricInfo><Lyric_1 LyricContent="[ti:Morning Light]\n[ar:The Travelers]\n[1000,2000]Hello (1000,1000)world(2000,1000)"/></LyricInfo></QrcInfos>';
const lineResult={ok:true,source:'lrclib',syncMode:'line',lines:[{text:'Line fallback',startMs:1000,endMs:3000}]};
const catalogRecord={track_name:track.title,artist_name:track.artist,album_name:track.album,duration:200,isrc:'USABC1234567',timing_type:'word'};
const unisonRecord={videoId:'video-a',song:track.title,artist:track.artist,duration:200,format:'ttml',syncType:'richsync',lyrics:ttml};
const response=(body,status=200,headers={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers});
function worker(route=()=>response({},404)){
 const requests=[],storage={};
 const context=vm.createContext({
  console:{warn(){},debug(){}},URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
  fetch:async(url,options)=>{requests.push({url,options});return route(new URL(url),options);},importScripts(){},
  chrome:{runtime:{onMessage:{addListener(){}}},storage:{local:{
   async get(key){return key===null?{...storage}:{[key]:storage[key]};},
   async set(values){Object.assign(storage,values);},async remove(keys){for(const k of [keys].flat())delete storage[k];},
  }}},
 });
 for(const file of ['vendor/yaml.min.js','vendor/parsers.min.js','shared.js','providers.js','background.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 return {context,requests,storage};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('TTML word cues parse inside a worker without DOM APIs, with exact whitespace and timing',()=>{
 const {context:c}=worker();assert.equal(c.DOMParser,undefined);
 const result=c.ytmalParseProviderText(ttml,'ttml',track,'fixture');
 assert.equal(result.syncMode,'word');assert.equal(result.lines[0].text,'Morning light');
 assert.deepEqual(plain(result.lines[0].words.map(w=>[w.startMs,w.endMs])),[[1000,2000],[2000,3000]]);
 assert.equal(result.lines[0].rendererLyric.parts.map(p=>p.words).join(''),'Morning light');
 assert.equal(c.ytmalRendererLyrics(result.lines,'word')[0],result.lines[0].rendererLyric);
});
test('line TTML does not become word sync and enhanced LRC does',()=>{
 const {context:c}=worker();
 assert.equal(c.ytmalParseProviderText(lineTtml,'ttml',track,'fixture').syncMode,'line');
 assert.equal(c.ytmalParseProviderText('[00:01.00]<00:01.00>Morning <00:02.00>light<00:03.00>','lrc',track,'fixture').syncMode,'word');
});
test('QQ envelope uses real word times and rejects metadata for another song',()=>{
 const {context:c}=worker();const result=c.ytmalParseProviderText(qrc,'qrc',track,'qq');
 assert.equal(result.syncMode,'word');assert.equal(result.lines[0].words[1].startMs,2000);
 assert.equal(c.ytmalParseProviderText(qrc.replace('ti:Morning Light','ti:Different Song'),'qrc',track,'qq'),null);
});
test('malformed, untimed, external-entity and incompatible-duration documents are rejected',()=>{
 const {context:c}=worker();
 for(const text of ['not xml','<tt/>','<!DOCTYPE tt [<!ENTITY test "x">]>'+ttml,ttml.replace('3s','300s')])assert.equal(c.ytmalParseProviderText(text,'ttml',track,'fixture'),null);
});
test('Better Lyrics word timing wins before a line-only LRCLIB result',async()=>{
 const {context:c,requests}=worker(url=>url.pathname==='/getLyrics'?response({ttml}):response({},404));
 let lrclibCalled=false;c.fetchLrclibLyrics=async()=>{lrclibCalled=true;return lineResult;};
 const result=await c.fetchLyrics(track);
 assert.equal(result.syncMode,'word');assert.equal(result.source,'betterlyrics');assert.equal(lrclibCalled,false);
 const url=new URL(requests.find(r=>new URL(r.url).pathname==='/getLyrics').url);
 assert.equal(url.searchParams.get('al'),'Daybreak');assert.equal(url.searchParams.get('d'),'200');
 assert.equal(requests[0].options.credentials,'omit');
});
test('a cache miss requiring authentication can fall through to QQ word timing',async()=>{
 const {context:c}=worker(url=>url.pathname==='/qq/getLyrics'?response({lyrics:qrc,provider:'qq'}):response({},401));
 assert.equal((await c.fetchWordProviderLyrics(track)).source,'qq');
});
test('catalog word timings are fetched only after title/artist/version/duration validation',async()=>{
 const {context:c,requests}=worker(url=>url.hostname==='lyrics-api.binimum.org'?response({results:[
  {...catalogRecord,track_name:'Different Song',isrc:'USABC1234568'},
  {...catalogRecord,artist_name:'Different Artist',isrc:'USABC1234569'},
  {...catalogRecord,track_name:'Morning Light (Live)',isrc:'USABC1234570'},
  {...catalogRecord,duration:240,isrc:'USABC1234571'},catalogRecord,
 ]}):url.hostname==='lrc.red'?response(ttml):response({},404));
 const result=await c.fetchWordProviderLyrics(track);assert.equal(result.source,'binimum');assert.equal(result.syncMode,'word');
 assert.deepEqual(requests.filter(r=>new URL(r.url).hostname==='lrc.red'&&new URL(r.url).pathname.startsWith('/s/')).map(r=>new URL(r.url).pathname),['/s/USABC1234567.ttml']);
});
test('a catalog gateway outage still finds word timing through direct ISRC lookup',async()=>{
 const {context:c}=worker(url=>url.hostname==='lrc.red'
  ? url.pathname==='/match.json' ? response({hits:[{...catalogRecord,title:track.title,artist:track.artist}]})
  : response({title:track.title,artist:track.artist,duration:200,source:ttml})
  : response({},503));
 const result=await c.fetchWordProviderLyrics(track);assert.equal(result.source,'lrc-red');assert.equal(result.syncMode,'word');
});
test('direct ISRC lookup validates both the catalog hit and returned song identity',async()=>{
 const {context:c}=worker(url=>url.hostname==='lrc.red'
  ? url.pathname==='/match.json' ? response({hits:[{...catalogRecord,title:track.title,artist:track.artist}]})
  : response({title:'Another Song',artist:track.artist,duration:200,source:ttml})
  : response({},404));
 assert.equal(await c.fetchWordProviderLyrics(track),null);
});
test('catalog-supplied arbitrary URLs cannot be requested',async()=>{
 const {context:c,requests}=worker(url=>url.hostname==='lyrics-api.binimum.org'?response({results:[{...catalogRecord,lyricsUrl:'http://127.0.0.1/private',isrc:'invalid'}]}):response({},404));
 assert.equal(await c.fetchWordProviderLyrics(track),null);
 assert.ok(requests.every(r=>!r.url.includes('127.0.0.1')));
});
test('soundtrack subtitle and collaboration delimiter differences match without admitting remixes or bands with a shared prefix',()=>{
 const {context:c}=worker();
 const song={title:'Sunflower',artist:'Post Malone & Swae Lee',album:'Spider-Man: Into the Spider-Verse (Soundtrack)',duration:158};
 const record={track_name:'Sunflower (Spider-Man: Into the Spider-Verse)',artist_name:'Post Malone, Swae Lee',duration:158};
 assert.equal(c.ytmalProviderMatches(record,song),true);
 assert.equal(c.ytmalProviderMatches({...record,track_name:'Sunflower (Remix)'},song),false);
 assert.equal(c.ytmalProviderMatches({title:'Morning Light',artist:'Florence and the Machine',duration:200},{...track,artist:'Florence'}),false);
});
test('Unison word data requires success and matching identity, regardless of its claimed sync type',async()=>{
 const {context:c}=worker(url=>url.hostname==='unison.boidu.dev'?response({success:true,data:unisonRecord}):response({},404));
 const result=await c.fetchWordProviderLyrics(track);assert.equal(result.source,'unison');assert.equal(result.syncMode,'word');assert.equal(result.cacheAllowed,false);
 for(const body of [{success:false,data:unisonRecord},{success:true,data:{...unisonRecord,song:'Wrong Song'}},{success:true,data:{...unisonRecord,lyrics:'no timings'}}]){
  const {context:d}=worker(url=>url.hostname==='unison.boidu.dev'?response(body):response({},404));
  assert.equal(await d.fetchWordProviderLyrics(track),null);
 }
});
test('a line-only Unison video entry still searches for a matching word-timed community entry',async()=>{
 const {context:c}=worker(url=>url.hostname==='unison.boidu.dev'?response({success:true,data:url.pathname==='/lyrics/search'?[unisonRecord]:{...unisonRecord,lyrics:lineTtml,syncType:'linesync'}}):response({},404));
 assert.equal((await c.fetchWordProviderLyrics(track)).syncMode,'word');
});
test('a falsely labeled richsync community entry cannot hide real word cues in another entry',async()=>{
 const {context:c}=worker(url=>url.hostname==='unison.boidu.dev'?response({success:true,data:url.pathname==='/lyrics/search'?[unisonRecord]:{...unisonRecord,lyrics:lineTtml,syncType:'richsync'}}):response({},404));
 assert.equal((await c.fetchWordProviderLyrics(track)).syncMode,'word');
});
test('a fast line result cannot hide a later valid word result',async()=>{
 let release;const late=new Promise(resolve=>release=resolve);const {context:c}=worker();
 c.ytmalFetchBetterLyrics=async()=>({...lineResult,source:'betterlyrics'});
 c.ytmalFetchBinimum=async()=>late;c.ytmalFetchUnison=async()=>null;
 const pending=c.fetchWordProviderLyrics(track);await new Promise(setImmediate);
 release({ok:true,source:'binimum',syncMode:'word',lines:[]});assert.equal((await pending).source,'binimum');
});
test('an unavailable word source cannot keep the lyric lookup pending past its budget',async()=>{
 const {context:c}=worker();const timers=new Map();let next=0,signal;
 c.setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;};c.clearTimeout=id=>timers.delete(id);
 c.ytmalFetchBetterLyrics=async()=>lineResult;
 c.ytmalFetchBinimum=async(_track,s)=>{signal=s;return new Promise(()=>{});};
 c.ytmalFetchUnison=async()=>null;c.ytmalFetchLrcRed=async()=>null;
 const pending=c.fetchWordProviderLyrics(track);await new Promise(setImmediate);
 const deadline=[...timers.values()].find(timer=>timer.ms===8000);assert.ok(deadline);deadline.fn();
 assert.equal((await pending).syncMode,'line');assert.equal(signal.aborted,true);
});
test('authentication errors and provider outages preserve the LRCLIB/YouTube fallback',async()=>{
 const {context:c}=worker(()=>response({error:'API key required'},401));
 c.fetchLrclibLyrics=async()=>lineResult;assert.equal((await c.fetchLyrics(track)).source,'lrclib');
 c.fetchLrclibLyrics=async()=>null;c.fetchYouTubeTimedLyrics=async()=>({...lineResult,source:'youtube'});
 assert.equal((await c.fetchLyrics(track)).source,'youtube');
});
test('low confidence results are not accepted as rich sync',async()=>{
 const {context:c}=worker(url=>url.pathname==='/getLyrics'?response({ttml,score:.2}):response({},404));
 assert.equal(await c.fetchWordProviderLyrics(track),null);
});
test('provider retry-after is honored and independent origins remain available',async()=>{
 const {context:c,requests}=worker(()=>response({},429,{'Retry-After':'120'}));
 await c.ytmalProviderRequest('https://api.betterlyrics.org/getLyrics');
 await c.ytmalProviderRequest('https://api.betterlyrics.org/qq/getLyrics');
 await c.ytmalProviderRequest('https://unison.boidu.dev/lyrics');assert.equal(requests.length,2);
});
test('aborted and oversized responses are never parsed',async()=>{
 const {context:c,requests}=worker(()=>response('x',200,{'Content-Length':'3000000'}));
 const controller=new AbortController();controller.abort();
 assert.equal(await c.ytmalProviderRequest('https://api.betterlyrics.org/getLyrics',controller.signal),null);assert.equal(requests.length,0);
 assert.equal(await c.ytmalProviderRequest('https://api.betterlyrics.org/getLyrics'),null);
});
test('line caches refresh promptly, old selection caches expire, and Unison data is not persisted',async()=>{
 const {context:c,storage}=worker();
 await c.setCachedResult('community',{...lineResult,source:'unison',cacheAllowed:false});assert.equal(Object.keys(storage).length,0);
 await c.setCachedResult('line',lineResult);const entry=storage.ytmal_cache_line;
 entry.timestamp=Date.now()-16*60*1000;assert.equal(await c.getCachedResult('line'),null);
 await c.setCachedResult('old',lineResult);storage.ytmal_cache_old.lookupVersion=2;assert.equal(await c.getCachedResult('old'),null);
 await c.setCachedResult('word',{...lineResult,syncMode:'word'});storage.ytmal_cache_word.timestamp=Date.now()-16*60*1000;assert.equal((await c.getCachedResult('word')).syncMode,'word');
});
test('packaged worker loads local parsers/providers and declares only their specific hosts',()=>{
 const source=fs.readFileSync(path.join(root,'background.js'),'utf8');
 assert.match(source,/importScripts\([^;]*vendor\/parsers.min.js[^;]*providers.js/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 for(const host of ['api.betterlyrics.org','unison.boidu.dev','lyrics-api.binimum.org','lrc.red'])assert.ok(manifest.host_permissions.includes(`https://${host}/*`));
 assert.ok(!manifest.host_permissions.includes('<all_urls>'));
 assert.match(fs.readFileSync(path.join(root,'vendor/parsers.LICENSE.txt'),'utf8'),/@braccato\/parsers 0.4.0/);
 assert.doesNotMatch(fs.readFileSync(path.join(root,'vendor/parsers.min.js'),'utf8'),/\beval\s*\(|new Function\s*\(/);
});

test('QQ starts independently even while the TTML endpoint is still pending',async()=>{
 const {context:c}=worker((url,options)=>url.pathname==='/getLyrics'
  ? new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))
  : url.pathname==='/qq/getLyrics' ? response({lyrics:qrc}) : response({},404));
 const result=await c.fetchWordProviderLyrics(track);
 assert.equal(result.source,'qq');assert.equal(result.syncMode,'word');
});
test('a forced retry bypasses a fresh line cache and replaces it with real word cues',async()=>{
 const {context:c,storage}=worker(url=>url.pathname==='/getLyrics'?response({ttml}):response({},404));
 const key=c.ytmalTrackKey(track);
 await c.setCachedResult(key,lineResult);
 assert.equal((await c.handleLyricsRequest(track)).syncMode,'line');
 const result=await c.handleLyricsRequest(track,true);
 assert.equal(result.syncMode,'word');assert.equal((await c.getCachedResult(key)).syncMode,'word');
 assert.equal(storage.ytmal_last_lookup.version,'2.1.6');
 assert.equal(storage.ytmal_last_lookup.track.title,track.title);
 assert.ok(storage.ytmal_last_lookup.wordCues>0);
});
test('line fallbacks retain HTTP failure diagnostics without tokens or query strings',async()=>{
 const {context:c}=worker(()=>response({},401));c.fetchLrclibLyrics=async()=>lineResult;
 const result=await c.fetchLyrics(track);
 assert.equal(result.syncMode,'line');
 assert.ok(result.providerAttempts.length>=4);
 assert.ok(result.providerAttempts.every(attempt=>attempt.status===401&&attempt.outcome==='HTTP 401'));
 assert.ok(result.providerAttempts.every(attempt=>!attempt.endpoint.includes('?')));
});

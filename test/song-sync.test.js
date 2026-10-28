// Song-change tests: execute the real content controller with fake media/DOM metadata.
// Run: node test/song-sync.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const trackA = {videoId:'a',title:'Morning Light',artist:'The Travelers',album:'Daybreak',duration:200};
const trackB = {videoId:'b',title:'Evening Song',artist:'Other Artist',album:'Nightfall',duration:210};
const lyrics = (text, syncMode='line') => ({ok:true,source:'fixture',syncMode,lines:[{text,startMs:0,endMs:1000}]});
const flush = () => new Promise(setImmediate);

function content({playerData=true,bridgeData=null,preferredSyncMode}={}) {
  const preferences={enabled:true,preferredSyncMode};
  let onStorageChange;
  const listeners=new Map();
  class CustomEvent { constructor(type,options={}) { this.type=type;this.detail=options.detail; } }
  let snapshot = {...trackA};
  let barId = '';
  let playerOverride = null;
  let timerId = 0;
  const timers = new Map(), requests = [];
  const location = {href:'https://music.youtube.com/watch?v=a',search:'?v=a'};
  const titleNode = {
    get textContent(){return snapshot.title;},
    closest(){return barId ? {href:`https://music.youtube.com/watch?v=${barId}`} : null;},
    querySelector(){return null;},
  };
  const bar = {querySelector(selector){
    if(selector==='.title') return titleNode;
    if(selector==='.byline') return {textContent:[snapshot.artist,snapshot.album].filter(Boolean).join(' • ')};
    return null;
  }};
  const video = {isConnected:true,paused:true,currentTime:0,
    get duration(){return snapshot.duration;},addEventListener(){},removeEventListener(){}};
  const player = playerData ? {getVideoData(){return playerOverride || {video_id:snapshot.videoId,title:snapshot.title,author:snapshot.artist};}} : {};
  const document = {
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(listener);},
    dispatchEvent(event){for(const listener of listeners.get(event.type)||[])listener(event);},
    querySelector(selector){return ({'#movie_player':player,'ytmusic-player-bar':bar,'video':video})[selector] || null;},
    getElementById(){return null;},
  };
  const context = vm.createContext({
    console,document,location,URL,URLSearchParams,CustomEvent,
    window:{setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}},
    chrome:{storage:{local:{get(_key,cb){cb(preferences);},async set(values){Object.assign(preferences,values);}},onChanged:{addListener(listener){onStorageChange=listener;}}},
      runtime:{sendMessage(message){return new Promise(resolve=>requests.push({payload:message.payload,refresh:message.refresh,resolve}));}}},
  });
  if (bridgeData) {
    const mainPlayer={
      getVideoData(){return bridgeData;},
      getPlayerResponse(){return {videoDetails:{videoId:bridgeData.video_id,title:bridgeData.title,author:bridgeData.author,lengthSeconds:'212'}};},
    };
    const mainDocument={...document,querySelector(selector){return selector==='#movie_player'?mainPlayer:document.querySelector(selector);}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'player-metadata.js'),'utf8'),{document:mainDocument,CustomEvent});
  }
  vm.runInContext(fs.readFileSync(path.join(root,'shared.js'),'utf8'),context,{filename:'shared.js'});
  // Prevent browser boot; expose only the existing controller to this VM test.
  const source = fs.readFileSync(path.join(root,'content.js'),'utf8')
    .replace('waitForApp().then(start);','')
    .replace(/\}\)\(\);\s*$/, 'globalThis.controller = {state,cache,syncSong,getNowPlaying,paintCurrentLyrics,updateActiveLine};\n})();');
  vm.runInContext(source,context,{filename:'content.js'});
  return {
    context,controller:context.controller,requests,preferences,
    setPreference(mode){preferences.preferredSyncMode=mode;onStorageChange({preferredSyncMode:{newValue:mode}},"local");},
    setMetadata(value){snapshot={...value};},
    setPlayerData(value){playerOverride=value;},
    setURL(id){location.search=id?`?v=${id}`:'';location.href=`https://music.youtube.com/watch${location.search}`;},
    setBarId(id){barId=id;},
    setTime(seconds){video.currentTime=seconds;},
    async settle(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await flush();},
  };
}

test('a rapid song change invalidates the previous request before the new lookup starts', async () => {
  const app = content();
  app.controller.syncSong();await app.settle();
  assert.equal(app.requests.length,1);
  app.setMetadata(trackB);app.setURL('b');app.controller.syncSong();
  assert.equal(app.controller.state.lines.length,0,'old lyrics clear immediately');
  app.requests[0].resolve(lyrics('A'));await flush();
  assert.equal(app.controller.state.lines.length,0,'late A response cannot repaint B');
  assert.equal(app.controller.cache.size,0,'late A response cannot enter the cache');
  await app.settle();
  app.requests[1].resolve(lyrics('B','word'));await flush();
  assert.equal(app.controller.state.lines[0].text,'B');
  assert.equal(app.controller.state.syncMode,'word');
});

test('a late response is rejected even before the observer notices the new song', async () => {
  const app = content();
  app.controller.syncSong();await app.settle();
  app.setMetadata(trackB);app.setURL('b');
  app.requests[0].resolve(lyrics('A'));await flush();
  assert.equal(app.controller.state.videoId,'b');
  assert.equal(app.controller.state.lines.length,0);
  assert.equal(app.controller.cache.size,0);
  await app.settle();
  assert.equal(app.requests[1].payload.title,trackB.title);
});

test('metadata arriving later for the same video triggers a fresh lookup and upgrades line sync', async () => {
  const app = content();
  app.setMetadata({...trackA,title:'',artist:'',album:'',duration:0});
  app.controller.syncSong();await app.settle();
  app.requests[0].resolve(lyrics('Native fallback'));await flush();
  app.setMetadata(trackA);app.controller.syncSong();await app.settle();
  assert.equal(app.requests.length,2);
  assert.equal(app.requests[1].payload.title,trackA.title);
  app.requests[1].resolve(lyrics('Word lyrics','word'));await flush();
  assert.equal(app.controller.state.syncMode,'word');
  assert.equal(app.controller.state.lines[0].text,'Word lyrics');
});

test('an old player bar cannot be queried as metadata for a new URL/video ID', async () => {
  const app = content({playerData:false});
  app.controller.syncSong();await app.settle();
  app.requests[0].resolve(lyrics('A'));await flush();
  app.setURL('b');app.controller.syncSong();await app.settle();
  assert.equal(app.requests[1].payload.videoId,'b');
  assert.equal(app.requests[1].payload.title,'','do not query LRCLIB with the old title');
  assert.equal(app.requests[1].payload.artist,'');
  assert.equal(app.controller.state.lines.length,0);
  app.requests[1].resolve(lyrics('B native'));await flush();
  app.setMetadata(trackB);app.controller.syncSong();await app.settle();
  assert.equal(app.requests[2].payload.title,trackB.title);
  app.requests[2].resolve(lyrics('B words','word'));await flush();
  assert.equal(app.controller.state.lines[0].text,'B words');
});

test('a stale player-bar link cannot attach its title to a newer URL', async () => {
  const app = content({playerData:false});
  app.setBarId('a');app.setURL('b');
  app.controller.syncSong();await app.settle();
  assert.equal(app.requests[0].payload.videoId,'b');
  assert.equal(app.requests[0].payload.title,'');
});

test('metadata changes during the settle window replace the pending lookup', async () => {
  const app = content();
  app.controller.syncSong();
  app.setMetadata(trackB);app.setURL('b');app.controller.syncSong();
  await app.settle();
  assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].payload.videoId,'b');
});

test('returning to a song reuses only its exact video/metadata cache', async () => {
  const app = content();
  app.controller.syncSong();await app.settle();app.requests[0].resolve(lyrics('A'));await flush();
  app.setMetadata(trackB);app.setURL('b');app.controller.syncSong();await app.settle();
  app.requests[1].resolve(lyrics('B'));await flush();
  app.setMetadata(trackA);app.setURL('a');app.controller.syncSong();await app.settle();
  assert.equal(app.requests.length,2);
  assert.equal(app.controller.state.lines[0].text,'A');
});

test('clearing the video identity invalidates pending lyrics instead of showing the last song', async () => {
  const app = content();
  app.controller.syncSong();await app.settle();
  app.setMetadata({videoId:'',title:'',artist:'',album:'',duration:0});app.setURL('');app.controller.syncSong();
  app.requests[0].resolve(lyrics('A'));await flush();
  assert.equal(app.controller.state.videoId,null);
  assert.equal(app.controller.state.lines.length,0);
});


test('the renderer receives every media-clock sample across consecutive lines and backward seeks', () => {
  const app = content();
  const ticks=[];
  const state=app.controller.state;
  state.shadowRoot={querySelector(){return null;}};
  state.renderer={lines:[],tick(time,options){ticks.push({time,...options});},resumeAutoscroll(){}};
  state.lines=[{text:'First',startMs:0,endMs:1000},{text:'Second',startMs:1000,endMs:2000}];
  app.setTime(0.5);app.controller.updateActiveLine(false);
  app.setTime(1.5);app.controller.updateActiveLine(false);
  app.setTime(0.25);app.controller.updateActiveLine(true);
  assert.deepEqual(ticks.map(tick=>tick.time),[0.5,1.5,0.25]);
  assert.equal(ticks[2].isPlaying,false,'paused seeks freeze at the actual media time');
  assert.equal(ticks[2].smoothScroll,false,'seeks reposition immediately');
  assert.equal(ticks[2].playbackRate,1);
  assert.ok(Math.abs(ticks[2].eventCreationTime-Date.now())<1000,'snapshots use epoch time, not performance.now');
});

test('a new player ID/title never borrows artist or album from the old player bar', () => {
  const app = content();
  app.setPlayerData({video_id:'b',title:trackB.title,author:trackB.artist});
  const meta=app.controller.getNowPlaying();
  assert.equal(meta.videoId,'b');
  assert.equal(meta.title,trackB.title);
  assert.equal(meta.artist,trackB.artist);
  assert.equal(meta.album,'');
});

test('the matching player bar artist takes precedence over a YouTube channel name', () => {
  const app = content();
  app.setPlayerData({video_id:'a',title:trackA.title,author:'Music Label Channel'});
  assert.equal(app.controller.getNowPlaying().artist,trackA.artist);
});

test('line sync automatically retries with a cache bypass and upgrades when word sources recover',async()=>{
 const app=content();app.controller.syncSong();await app.settle();
 app.requests[0].resolve(lyrics('Line fallback'));await flush();
 assert.equal(app.controller.state.syncMode,'line');
 await app.settle();
 assert.equal(app.requests.length,2);assert.equal(app.requests[1].payload.title,trackA.title);assert.equal(app.requests[1].refresh,true);
 app.requests[1].resolve(lyrics('Recovered word timing','word'));await flush();
 assert.equal(app.controller.state.syncMode,'word');
 await app.settle();assert.equal(app.requests.length,2,'successful word sync stops retries');
});
test('a failed retry keeps the current lyrics visible and retries again later',async()=>{
 const app=content();app.controller.syncSong();await app.settle();
 app.requests[0].resolve(lyrics('Line fallback'));await flush();await app.settle();
 app.requests[1].resolve({ok:false,syncMode:'none',lines:[]});await flush();
 assert.equal(app.controller.state.lines[0].text,'Line fallback');
 await app.settle();assert.equal(app.requests.length,3);
});


test('MAIN-world bridge supplies metadata when isolated player methods and player-bar text are unavailable',async()=>{
 const page={video_id:'zDKG9LhxjFQ',title:'Sailor Song',author:'Gigi Perez'};
 const app=content({playerData:false,bridgeData:page});
 app.setMetadata({videoId:page.video_id,title:'',artist:'',album:'',duration:212});app.setURL(page.video_id);
 app.controller.syncSong();await app.settle();
 assert.equal(app.requests[0].payload.title,'Sailor Song');
 assert.equal(app.requests[0].payload.artist,'Gigi Perez');
 assert.equal(app.requests[0].payload.metadataSource,'player-bridge');
});
test('a stale bridge snapshot cannot attach the previous song to a new video ID',()=>{
 const app=content({playerData:false,bridgeData:{video_id:'zDKG9LhxjFQ',title:'Sailor Song',author:'Gigi Perez'}});
 app.setMetadata({videoId:'y4FiCl-tUJc',title:'',artist:'',album:'',duration:178});app.setURL('y4FiCl-tUJc');
 const meta=app.controller.getNowPlaying();
 assert.equal(meta.videoId,'y4FiCl-tUJc');assert.equal(meta.title,'');assert.equal(meta.artist,'');
});


test('display preference toggles locally without refetching or destroying available word cues',async()=>{
 const app=content();app.controller.syncSong();await app.settle();
 const result=lyrics('Word data','word');result.lines[0].words=[{text:'Word',startMs:0,endMs:500}];
 app.requests[0].resolve(result);await flush();
 app.setPreference(app.controller.state.preferredSyncMode==='word'?'line':'word');
 assert.equal(app.controller.state.syncMode,'line');assert.equal(app.preferences.preferredSyncMode,'line');
 assert.equal(app.controller.state.availableSyncMode,'word');
 assert.equal(app.controller.state.lines[0].words.length,1);
 app.setPreference(app.controller.state.preferredSyncMode==='word'?'line':'word');
 assert.equal(app.controller.state.syncMode,'word');assert.equal(app.preferences.preferredSyncMode,'word');
 assert.equal(app.requests.length,1);
});
test('a saved line preference survives song changes and line-only songs cannot enable invented word timing',async()=>{
 const app=content({preferredSyncMode:'line'});app.controller.syncSong();await app.settle();
 app.requests[0].resolve(lyrics('Word source','word'));await flush();
 assert.equal(app.controller.state.syncMode,'line');assert.equal(app.controller.state.availableSyncMode,'word');
 app.setMetadata(trackB);app.setURL('b');app.controller.syncSong();await app.settle();
 app.requests[1].resolve(lyrics('Line source','line'));await flush();
 app.setPreference(app.controller.state.preferredSyncMode==='word'?'line':'word');
 assert.equal(app.controller.state.syncMode,'line');assert.equal(app.preferences.preferredSyncMode,'word');
});

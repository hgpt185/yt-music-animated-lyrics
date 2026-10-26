// Lookup integration tests: real parsers and selection logic, mocked providers/storage.
// Run: node test/lookup.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

const track = { videoId: 'video-a', title: 'Morning Light', artist: 'The Travelers', album: 'Daybreak', duration: 200 };
const wordFile = JSON.stringify({
  version: '1.0',
  lines: [{ text: 'Morning light', start_ms: 1000, end_ms: 3000, words: [
    { text: 'Morning ', start_ms: 1000, end_ms: 2000 },
    { text: 'light', start_ms: 2000, end_ms: 3000 },
  ] }],
});
const lineFile = JSON.stringify({version:'1.0', lines:[{text:'Only line cues',start_ms:1000,end_ms:3000}]});
const lineRecord = (overrides = {}) => ({trackName:track.title,artistName:track.artist,albumName:track.album,duration:200,syncedLyrics:'[00:01.00]Exact line',...overrides});
const wordRecord = (overrides = {}) => ({...lineRecord(),hasWordSync:true,lyricsfile:wordFile,...overrides});

function worker({exact = null, search = [], youtube = null} = {}) {
  const calls = [], youtubeCalls = [], storage = {};
  const context = vm.createContext({
    console: {warn() {},log() {}}, URLSearchParams,
    importScripts() {},
    chrome: {
      runtime:{onMessage:{addListener() {}}},
      storage:{local:{
        async get(key) {return key === null ? {...storage} : {[key]:storage[key]};},
        async set(values) {Object.assign(storage,values);},
        async remove(keys) {for(const key of [keys].flat())delete storage[key];},
      }},
    },
  });
  for(const name of ['vendor/yaml.min.js','shared.js','background.js']) {
    vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context,{filename:name});
  }
  // This suite isolates the existing LRCLIB/YouTube pipeline.
  context.fetchWordProviderLyrics = async () => null;
  context.lrclibJson = async (url) => {
    calls.push(url);
    return url.startsWith('/api/get?') ? exact : search;
  };
  context.fetchYouTubeTimedLyrics = async (videoId) => {
    youtubeCalls.push(videoId);
    return typeof youtube === 'function' ? youtube(videoId) : youtube;
  };
  return {context,calls,youtubeCalls,storage};
}

test('exact word cues win immediately without an unnecessary search', async () => {
  const {context,calls} = worker({exact:wordRecord()});
  const result = await context.fetchLyrics(track);
  assert.equal(result.syncMode,'word');
  assert.equal(calls.length,1);
  assert.equal(result.lines[0].words.length,2);
});

test('search word sync beats exact line sync, including a word-only record', async () => {
  const {context,calls} = worker({exact:lineRecord(),search:[wordRecord({syncedLyrics:null,duration:202})]});
  const result = await context.fetchLyrics(track);
  assert.equal(result.syncMode,'word');
  assert.ok(calls.some(url=>url.startsWith('/api/search?')));
});

test('a valid word match wins after malformed and falsely labeled word candidates', async () => {
  const {context} = worker({search:[
    wordRecord({lyricsfile:'not a lyrics document',duration:200}),
    wordRecord({lyricsfile:lineFile,duration:201}),
    wordRecord({syncedLyrics:null,duration:202}),
  ]});
  const result = await context.fetchLyrics(track);
  assert.equal(result.syncMode,'word');
  assert.equal(result.lines[0].words.length,2);
});

test('actual word cues are used even if hasWordSync metadata is absent or false', async () => {
  for(const hasWordSync of [undefined,false]) {
    const {context} = worker({exact:lineRecord(),search:[wordRecord({hasWordSync,syncedLyrics:null})]});
    assert.equal((await context.fetchLyrics(track)).syncMode,'word');
  }
});

test('exact line fallback survives unavailable search and invalid word data', async () => {
  for(const search of [null,[],[wordRecord({lyricsfile:'invalid'})],[wordRecord({lyricsfile:lineFile})]]) {
    const {context} = worker({exact:lineRecord(),search});
    const result = await context.fetchLyrics(track);
    assert.equal(result.syncMode,'line');
    assert.equal(result.lines[0].text,'Exact line');
  }
});

test('an exact Lyricsfile with no word cues also searches for word sync', async () => {
  const {context} = worker({exact:wordRecord({lyricsfile:lineFile}),search:[wordRecord()]});
  assert.equal((await context.fetchLyrics(track)).syncMode,'word');
});

test('an unrelated title or artist cannot outrank the correct line-synced song', async () => {
  const {context} = worker({exact:lineRecord(),search:[
    wordRecord({trackName:'Another Song'}),
    wordRecord({artistName:'Someone Else'}),
    wordRecord({trackName:undefined,artistName:undefined}),
  ]});
  const result = await context.fetchLyrics(track);
  assert.equal(result.syncMode,'line');
  assert.equal(result.lines[0].text,'Exact line');
});

test('different live/remix versions and incompatible durations are rejected', async () => {
  const {context} = worker({exact:lineRecord(),search:[
    wordRecord({trackName:'Morning Light (Live)'}),
    wordRecord({trackName:'Morning Light - Remix'}),
    wordRecord({duration:260}),
  ]});
  assert.equal((await context.fetchLyrics(track)).syncMode,'line');
});

test('presentation labels and punctuation differences still match the same song', async () => {
  const {context} = worker({search:[wordRecord({trackName:'MORNING LIGHT (Official Video)'})]});
  assert.equal((await context.fetchLyrics({...track,title:'Morning Light [Official Audio]'})).syncMode,'word');
});

test('Lyricsfile metadata for a different song cannot masquerade as word sync', async () => {
  const file = JSON.parse(wordFile);
  file.metadata = {title:'Another Song',artist:track.artist};
  const {context} = worker({exact:lineRecord(),search:[wordRecord({lyricsfile:JSON.stringify(file)})]});
  assert.equal((await context.fetchLyrics(track)).syncMode,'line');
});

test('wrong exact matches and wrong search results fall back to the current YouTube video', async () => {
  const youtube = {ok:true,source:'youtube',syncMode:'line',lines:[{text:'Correct native lyrics',startMs:0,endMs:1000}]};
  const {context,youtubeCalls} = worker({exact:wordRecord({trackName:'Wrong'}),search:[wordRecord({artistName:'Wrong'})],youtube});
  const result = await context.fetchLyrics(track);
  assert.equal(result.source,'youtube');
  assert.deepEqual(youtubeCalls,[track.videoId]);
});

test('old selection-policy caches are refreshed once, then the word result is reused', async () => {
  const {context,storage,calls} = worker({exact:lineRecord(),search:[wordRecord()]});
  const key = 'ytmal_cache_' + context.ytmalTrackKey(track);
  storage[key] = {timestamp:Date.now(),found:true,result:{ok:true,syncMode:'line',lines:[]}};
  const result = await context.handleLyricsRequest(track);
  assert.equal(result.syncMode,'word');
  assert.equal(typeof storage[key].lookupVersion,'number');
  const count = calls.length;
  assert.equal((await context.handleLyricsRequest(track)).syncMode,'word');
  assert.equal(calls.length,count);
});

test('videos with identical or missing metadata never share YouTube fallback caches', async () => {
  const {context,youtubeCalls} = worker({youtube:videoId=>({ok:true,source:'youtube',syncMode:'line',lines:[{text:videoId,startMs:0,endMs:1000}]})});
  for(const metadata of [{title:'',artist:'',album:'',duration:0},track]) {
    const a = {...metadata,videoId:'a'}, b = {...metadata,videoId:'b'};
    const first = await context.handleLyricsRequest(a);
    const second = await context.handleLyricsRequest(b);
    assert.equal(first.lines[0].text,'a');
    assert.equal(second.lines[0].text,'b');
  }
  assert.deepEqual(youtubeCalls,['a','b','a','b']);
});

test('negative cache entries for one video cannot suppress a different video', async () => {
  const {context,youtubeCalls} = worker({youtube:videoId=>videoId==='b'?{ok:true,source:'youtube',syncMode:'line',lines:[{text:'B',startMs:0}]}:null});
  assert.equal((await context.handleLyricsRequest({...track,videoId:'a'})).ok,false);
  assert.equal((await context.handleLyricsRequest({...track,videoId:'b'})).ok,true);
  assert.deepEqual(youtubeCalls,['a','b']);
});


test('band names sharing a first word are not confused with each other or solo artists', async () => {
  const {context} = worker({exact:lineRecord({artistName:'Florence & The Machine'}),search:[wordRecord({artistName:'Florence'})]});
  const result = await context.fetchLyrics({...track,artist:'Florence & The Machine'});
  assert.equal(result.syncMode,'line');
});

test('symbol-only track titles keep distinct identities', () => {
  const {context} = worker();
  assert.equal(context.ytmalIsMatchingTrack(wordRecord({trackName:'∞'}),{...track,title:'★'}),false);
  assert.equal(context.ytmalIsMatchingTrack(wordRecord({trackName:'∞'}),{...track,title:'∞'}),true);
});

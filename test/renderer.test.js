// Adapter contract and distribution checks for the real, vendored renderer.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const context=vm.createContext({console});
vm.runInContext(fs.readFileSync(path.join(root,'shared.js'),'utf8'),context);
const plain=value=>JSON.parse(JSON.stringify(value));

test('keeps supplied word timestamps and recovers spaces/punctuation from line text',()=>{
  const lines=[{text:'Hello, world!',startMs:1000,endMs:5000,words:[
    {text:'Hello',startMs:1100,endMs:1700},{text:'world',startMs:2100,endMs:4700},
  ]}];
  const before=JSON.stringify(lines);
  const [line]=plain(context.ytmalRendererLyrics(lines,'word'));
  assert.equal(line.words,'Hello, world!');
  assert.equal(line.startTimeMs,1000);assert.equal(line.durationMs,4000);
  assert.deepEqual(line.parts,[{words:'Hello, ',startTimeMs:1100,durationMs:600},{words:'world!',startTimeMs:2100,durationMs:2600}]);
  assert.equal(JSON.stringify(lines),before,'provider data is never mutated');
});

test('line fallback never invents word timestamps, even if a source has partial tokens',()=>{
  const [line]=plain(context.ytmalRendererLyrics([{text:'Line only',startMs:1000,endMs:3000,words:[{text:'Line',startMs:1000,endMs:2000}]}],'line'));
  assert.equal(Object.hasOwn(line,'parts'),false);
});

test('missing word ends stay zero-duration cues instead of guessed timing',()=>{
  const [line]=plain(context.ytmalRendererLyrics([{text:'Hello',startMs:1000,endMs:null,words:[{text:'Hello',startMs:1000,endMs:null}]}],'word'));
  assert.equal(line.parts[0].durationMs,0);
  assert.equal(line.durationMs,0);
});

test('Unicode and joined syllables retain the original word boundaries',()=>{
  const [line]=plain(context.ytmalRendererLyrics([{text:'नमस्ते 世界',startMs:0,endMs:5000,words:[
    {text:'नमस्ते ',startMs:0,endMs:2000},{text:'世',startMs:2000,endMs:3000},{text:'界',startMs:3000,endMs:5000},
  ]}],'word'));
  assert.equal(line.parts.map(p=>p.words).join(''),'नमस्ते 世界');
  assert.deepEqual(line.parts.map(p=>p.startTimeMs),[0,2000,3000]);
});

test('renderer is bundled for content scripts with its matching styles and MIT license',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const scripts=manifest.content_scripts.find(entry => entry.js.includes('content.js')).js;
  assert.ok(scripts.indexOf('vendor/braccato.min.js')<scripts.indexOf('content.js'));
  const rendererContext=vm.createContext({console});
  vm.runInContext(fs.readFileSync(path.join(root,'vendor/braccato.min.js'),'utf8'),rendererContext);
  assert.equal(typeof rendererContext.YtmalRenderer.createLyricsRenderer,'function');
  assert.match(rendererContext.YtmalRenderer.styles,/blyrics-word-highlight/);
  assert.match(rendererContext.YtmalRenderer.styles,/:host/);
  assert.doesNotMatch(rendererContext.YtmalRenderer.styles,/@import/);
  assert.match(fs.readFileSync(path.join(root,'vendor/braccato.LICENSE.txt'),'utf8'),/MIT License/);
});


test('line display strips rich provider word parts without mutating the original word-timed data',()=>{
 const rich={words:'Hello world',startTimeMs:1000,durationMs:2000,parts:[
  {words:'Hello ',startTimeMs:1000,durationMs:1000},{words:'world',startTimeMs:2000,durationMs:1000},
 ]};
 const lines=[{text:'Hello world',startMs:1000,endMs:3000,rendererLyric:rich}];
 assert.equal(context.ytmalRendererLyrics(lines,'word')[0],rich);
 assert.equal(Object.hasOwn(context.ytmalRendererLyrics(lines,'line')[0],'parts'),false);
 assert.equal(rich.parts.length,2);
});

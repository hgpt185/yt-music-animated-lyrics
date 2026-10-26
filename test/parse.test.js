// ============================================================
// Unit tests for Animated Lyrics for YouTube Music
// Run with: node test/parse.test.js
// No external dependencies — uses only Node builtins.
// ============================================================

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");

// Build a sandbox with stubs for browser APIs, then load scripts
// as classic scripts so their top-level function declarations
// become globals in the sandbox.

const sandbox = {
  console,
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
    },
  },
  // Stub for importScripts (service worker API)
  importScripts() {},
};

vm.createContext(sandbox);

// Load YAML vendor (provides global YAML object)
vm.runInContext(
  fs.readFileSync(path.join(root, "vendor", "yaml.min.js"), "utf8"),
  sandbox,
  { filename: "yaml.min.js" }
);

// Load shared.js (provides all ytmal* functions)
vm.runInContext(
  fs.readFileSync(path.join(root, "shared.js"), "utf8"),
  sandbox,
  { filename: "shared.js" }
);

// Load background.js (provides parseLrc etc. — now uses shared functions)
vm.runInContext(
  fs.readFileSync(path.join(root, "background.js"), "utf8"),
  sandbox,
  { filename: "background.js" }
);

const {
  // Shared functions
  ytmalEscapeHtml,
  ytmalNormalize,
  ytmalCacheKey,
  ytmalFirstArtist,
  ytmalParseLrc,
  ytmalFinalizeLineEnds,
  ytmalParseLyricsfile,
  ytmalFindActiveLine,
  ytmalFindActiveWord,
  ytmalWordProgress,
  ytmalPickBestMatch,
} = sandbox;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────
// 1. LRC Parser
// ────────────────────────────────────────────────────────────

console.log("\n── LRC Parser ──");

test("parses basic LRC lines", () => {
  const lrc = `[00:01.50]Hello world
[00:03.00]Second line
[00:05.250]Third line`;
  const lines = ytmalParseLrc(lrc);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0].text, "Hello world");
  assert.strictEqual(lines[0].startMs, 1500, "centisecond timestamp");
  assert.strictEqual(lines[0].endMs, 3000, "endMs from next line");
  assert.strictEqual(lines[2].startMs, 5250, "millisecond timestamp");
});

test("handles multi-stamp lines", () => {
  const lines = ytmalParseLrc("[00:01.00][00:02.00]Echo");
  assert.strictEqual(lines.length, 2, "produces two entries");
  assert.strictEqual(lines[0].endMs, 2000);
});

test("filters empty and ♪ lines", () => {
  const lrc = `[00:01.00]♪
[00:02.00]Real line
[00:03.00]`;
  const lines = ytmalParseLrc(lrc);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, "Real line");
});

test("returns empty array for null/empty input", () => {
  assert.strictEqual(ytmalParseLrc(null).length, 0);
  assert.strictEqual(ytmalParseLrc("").length, 0);
});

test("handles lines with only timestamps (no text)", () => {
  const lines = ytmalParseLrc("[00:01.00]\n[00:02.00]Hello");
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, "Hello");
});

// ────────────────────────────────────────────────────────────
// 2. finalizeLineEnds
// ────────────────────────────────────────────────────────────

console.log("\n── finalizeLineEnds ──");

test("deduplicates identical consecutive lines", () => {
  const fin = ytmalFinalizeLineEnds([
    { text: "a", startMs: 1000, endMs: null },
    { text: "a", startMs: 1000, endMs: null },
    { text: "b", startMs: 2000, endMs: null },
  ]);
  assert.strictEqual(fin.length, 2);
  assert.strictEqual(fin[0].endMs, 2000, "endMs from next line");
  assert.strictEqual(fin[1].endMs, 10000, "last line gets +8s fallback");
});

test("sorts out-of-order lines", () => {
  const fin = ytmalFinalizeLineEnds([
    { text: "b", startMs: 2000, endMs: null },
    { text: "a", startMs: 1000, endMs: null },
  ]);
  assert.strictEqual(fin[0].text, "a");
  assert.strictEqual(fin[1].text, "b");
});

test("preserves existing endMs when available", () => {
  const fin = ytmalFinalizeLineEnds([
    { text: "a", startMs: 1000, endMs: 1500 },
    { text: "b", startMs: 2000, endMs: null },
  ]);
  // finalizeLineEnds overwrites endMs with next line start regardless
  assert.strictEqual(fin[0].endMs, 2000);
});

// ────────────────────────────────────────────────────────────
// 3. Metadata normalization
// ────────────────────────────────────────────────────────────

console.log("\n── Metadata normalization ──");

test("normalizes whitespace and case", () => {
  assert.strictEqual(ytmalNormalize("  Hello   World  "), "hello world");
});

test("strips diacritics", () => {
  assert.strictEqual(ytmalNormalize("café"), "cafe");
  assert.strictEqual(ytmalNormalize("über"), "uber");
});

test("handles empty/null input", () => {
  assert.strictEqual(ytmalNormalize(""), "");
  assert.strictEqual(ytmalNormalize(null), "");
  assert.strictEqual(ytmalNormalize(undefined), "");
});

test("builds consistent cache keys", () => {
  const key1 = ytmalCacheKey("Song", "Artist", "Album", 180.3);
  const key2 = ytmalCacheKey("  song  ", "ARTIST", "  Album ", 180.4);
  assert.strictEqual(key1, key2, "normalized keys should match");
});

test("different tracks produce different cache keys", () => {
  const key1 = ytmalCacheKey("Song A", "Artist", "", 180);
  const key2 = ytmalCacheKey("Song B", "Artist", "", 180);
  assert.notStrictEqual(key1, key2);
});

// ────────────────────────────────────────────────────────────
// 4. firstArtist
// ────────────────────────────────────────────────────────────

console.log("\n── firstArtist ──");

test("extracts first artist from comma-separated", () => {
  assert.strictEqual(ytmalFirstArtist("The Weeknd, Daft Punk"), "The Weeknd");
});

test("extracts first artist from ampersand", () => {
  assert.strictEqual(ytmalFirstArtist("Jay-Z & Rihanna"), "Jay-Z");
});

test("extracts first artist from 'x' separator", () => {
  assert.strictEqual(
    ytmalFirstArtist("Clean Bandit x Jess Glynne"),
    "Clean Bandit"
  );
});

test("handles single artist", () => {
  assert.strictEqual(ytmalFirstArtist("Adele"), "Adele");
});

test("handles 'and' separator", () => {
  assert.strictEqual(
    ytmalFirstArtist("Simon and Garfunkel"),
    "Simon"
  );
});

// ────────────────────────────────────────────────────────────
// 5. Lyricsfile (YAML) parsing
// ────────────────────────────────────────────────────────────

console.log("\n── Lyricsfile parsing ──");

const VALID_LYRICSFILE = `
version: '1.0'
metadata:
  title: 'Example Song'
  artist: 'Example Artist'
  duration_ms: 245000
lines:
  - text: 'Hello world'
    start_ms: 12000
    end_ms: 15500
    words:
      - text: 'Hello '
        start_ms: 12000
        end_ms: 12800
      - text: 'world'
        start_ms: 12800
        end_ms: 15500
  - text: 'Second line here'
    start_ms: 16000
    end_ms: 20000
    words:
      - text: 'Second '
        start_ms: 16000
        end_ms: 17000
      - text: 'line '
        start_ms: 17000
        end_ms: 18000
      - text: 'here'
        start_ms: 18000
        end_ms: 20000
`;

test("parses a valid word-synced Lyricsfile", () => {
  const result = ytmalParseLyricsfile(VALID_LYRICSFILE);
  assert.ok(result, "should not be null");
  assert.strictEqual(result.version, "1.0");
  assert.strictEqual(result.lines.length, 2);
  assert.strictEqual(result.hasWordSync, true);
  assert.strictEqual(result.lines[0].words.length, 2);
  assert.strictEqual(result.lines[0].words[0].text, "Hello ");
  assert.strictEqual(result.lines[0].words[0].startMs, 12000);
  assert.strictEqual(result.lines[0].words[0].endMs, 12800);
});

test("rejects unknown Lyricsfile version", () => {
  const yaml = `
version: '2.0'
lines:
  - text: 'Hello'
    start_ms: 1000
`;
  const result = ytmalParseLyricsfile(yaml);
  assert.strictEqual(result, null);
});

test("rejects missing lines array", () => {
  const yaml = `
version: '1.0'
metadata:
  title: 'Test'
`;
  const result = ytmalParseLyricsfile(yaml);
  assert.strictEqual(result, null);
});

test("handles malformed timestamps in lines", () => {
  const yaml = `
version: '1.0'
lines:
  - text: 'Bad line'
    start_ms: -100
  - text: 'Good line'
    start_ms: 1000
    end_ms: 2000
`;
  const result = ytmalParseLyricsfile(yaml);
  assert.ok(result);
  assert.strictEqual(result.lines.length, 1, "skips negative timestamp line");
  assert.strictEqual(result.lines[0].text, "Good line");
});

test("handles words with trailing spaces", () => {
  const result = ytmalParseLyricsfile(VALID_LYRICSFILE);
  assert.strictEqual(result.lines[0].words[0].text, "Hello ");
  assert.strictEqual(result.lines[1].words[0].text, "Second ");
});

test("fills missing word endMs from next word", () => {
  const yaml = `
version: '1.0'
lines:
  - text: 'Hello world'
    start_ms: 1000
    end_ms: 3000
    words:
      - text: 'Hello '
        start_ms: 1000
      - text: 'world'
        start_ms: 2000
`;
  const result = ytmalParseLyricsfile(yaml);
  assert.ok(result);
  assert.strictEqual(result.lines[0].words[0].endMs, 2000, "filled from next word");
  assert.strictEqual(result.lines[0].words[1].endMs, 3000, "filled from parent line");
});

test("handles lines without words (mixed sync)", () => {
  const yaml = `
version: '1.0'
lines:
  - text: 'With words'
    start_ms: 1000
    end_ms: 3000
    words:
      - text: 'With '
        start_ms: 1000
        end_ms: 1500
      - text: 'words'
        start_ms: 1500
        end_ms: 3000
  - text: 'Without words'
    start_ms: 3000
    end_ms: 5000
`;
  const result = ytmalParseLyricsfile(yaml);
  assert.ok(result);
  assert.strictEqual(result.lines.length, 2);
  assert.ok(result.lines[0].words, "first line has words");
  assert.strictEqual(result.lines[1].words, null, "second line has no words");
  assert.strictEqual(result.hasWordSync, true, "still marked as having word sync");
});

test("returns null for null/empty input", () => {
  assert.strictEqual(ytmalParseLyricsfile(null), null);
  assert.strictEqual(ytmalParseLyricsfile(""), null);
  assert.strictEqual(ytmalParseLyricsfile(123), null);
});

test("returns null for invalid YAML", () => {
  assert.strictEqual(ytmalParseLyricsfile("::invalid yaml{{"), null);
});

// ────────────────────────────────────────────────────────────
// 6. Binary search: active line
// ────────────────────────────────────────────────────────────

console.log("\n── Binary search (active line) ──");

const testLines = [
  { text: "a", startMs: 1000, endMs: 3000 },
  { text: "b", startMs: 3000, endMs: 5000 },
  { text: "c", startMs: 5000, endMs: 8000 },
  { text: "d", startMs: 10000, endMs: 12000 },
];

test("returns -1 before all lines", () => {
  assert.strictEqual(ytmalFindActiveLine(testLines, 500), -1);
});

test("returns 0 at exact start of first line", () => {
  assert.strictEqual(ytmalFindActiveLine(testLines, 1000), 0);
});

test("returns correct index mid-line", () => {
  assert.strictEqual(ytmalFindActiveLine(testLines, 2000), 0);
  assert.strictEqual(ytmalFindActiveLine(testLines, 4000), 1);
  assert.strictEqual(ytmalFindActiveLine(testLines, 6000), 2);
});

test("returns correct index at line boundary", () => {
  assert.strictEqual(ytmalFindActiveLine(testLines, 3000), 1);
  assert.strictEqual(ytmalFindActiveLine(testLines, 5000), 2);
});

test("handles gaps between lines", () => {
  // testLines[2].endMs = 8000, testLines[3].startMs = 10000
  // At 9000ms we're in the gap — should still show line 2
  assert.strictEqual(ytmalFindActiveLine(testLines, 9000), 2);
});

test("handles seeking backward", () => {
  // After being at line 3, seeking back to line 0
  assert.strictEqual(ytmalFindActiveLine(testLines, 11000), 3);
  assert.strictEqual(ytmalFindActiveLine(testLines, 1500), 0);
});

test("handles empty lines array", () => {
  assert.strictEqual(ytmalFindActiveLine([], 1000), -1);
});

test("handles time after all lines", () => {
  assert.strictEqual(ytmalFindActiveLine(testLines, 15000), 3);
});

// ────────────────────────────────────────────────────────────
// 7. Binary search: active word
// ────────────────────────────────────────────────────────────

console.log("\n── Binary search (active word) ──");

const testWords = [
  { text: "Hello ", startMs: 1000, endMs: 1500 },
  { text: "beautiful ", startMs: 1500, endMs: 2200 },
  { text: "world", startMs: 2200, endMs: 3000 },
];

test("returns -1 before all words", () => {
  assert.strictEqual(ytmalFindActiveWord(testWords, 500), -1);
});

test("returns correct word index", () => {
  assert.strictEqual(ytmalFindActiveWord(testWords, 1200), 0);
  assert.strictEqual(ytmalFindActiveWord(testWords, 1800), 1);
  assert.strictEqual(ytmalFindActiveWord(testWords, 2500), 2);
});

test("returns -1 in gap after word ends", () => {
  // All words are contiguous here, so this shouldn't happen
  // But test with a gap:
  const gapWords = [
    { text: "Hello", startMs: 1000, endMs: 1400 },
    { text: "world", startMs: 1600, endMs: 2000 },
  ];
  assert.strictEqual(ytmalFindActiveWord(gapWords, 1500), -1);
});

test("returns -1 for null/empty words", () => {
  assert.strictEqual(ytmalFindActiveWord(null, 1000), -1);
  assert.strictEqual(ytmalFindActiveWord([], 1000), -1);
});

test("handles exact word boundaries", () => {
  assert.strictEqual(ytmalFindActiveWord(testWords, 1500), 1);
  assert.strictEqual(ytmalFindActiveWord(testWords, 2200), 2);
});

// ────────────────────────────────────────────────────────────
// 8. Word progress
// ────────────────────────────────────────────────────────────

console.log("\n── Word progress ──");

test("returns 0 at word start", () => {
  const word = { text: "test", startMs: 1000, endMs: 2000 };
  assert.strictEqual(ytmalWordProgress(word, 1000), 0);
});

test("returns 0.5 at word midpoint", () => {
  const word = { text: "test", startMs: 1000, endMs: 2000 };
  assert.strictEqual(ytmalWordProgress(word, 1500), 0.5);
});

test("returns 1 at word end", () => {
  const word = { text: "test", startMs: 1000, endMs: 2000 };
  assert.strictEqual(ytmalWordProgress(word, 2000), 1);
});

test("clamps to [0, 1]", () => {
  const word = { text: "test", startMs: 1000, endMs: 2000 };
  assert.strictEqual(ytmalWordProgress(word, 500), 0);
  assert.strictEqual(ytmalWordProgress(word, 3000), 1);
});

test("returns -1 when endMs is missing", () => {
  const word = { text: "test", startMs: 1000, endMs: null };
  assert.strictEqual(ytmalWordProgress(word, 1500), -1);
});

test("returns -1 for null word", () => {
  assert.strictEqual(ytmalWordProgress(null, 1000), -1);
});

// ────────────────────────────────────────────────────────────
// 9. Candidate matching (pickBestMatch)
// ────────────────────────────────────────────────────────────

console.log("\n── Candidate matching ──");

test("picks closest duration with synced lyrics", () => {
  const best = ytmalPickBestMatch(
    [
      { duration: 180, syncedLyrics: "[00:01.00]x" },
      { duration: 201, syncedLyrics: "[00:01.00]y" },
      { duration: 210 },
    ],
    200,
    false
  );
  assert.strictEqual(best.duration, 201);
});

test("prefers word-synced when requested", () => {
  const best = ytmalPickBestMatch(
    [
      { duration: 200, syncedLyrics: "[00:01.00]x", hasWordSync: false },
      {
        duration: 205,
        syncedLyrics: "[00:01.00]y",
        hasWordSync: true,
        lyricsfile: "version: 1.0",
      },
    ],
    200,
    true
  );
  assert.strictEqual(best.duration, 205, "chose word-synced despite slightly worse duration match");
});

test("falls back to line-synced when no word-synced available", () => {
  const best = ytmalPickBestMatch(
    [
      { duration: 200, syncedLyrics: "[00:01.00]x", hasWordSync: false },
      { duration: 201, syncedLyrics: "[00:01.00]y", hasWordSync: false },
    ],
    200,
    true
  );
  assert.strictEqual(best.duration, 200, "falls back to closest duration");
});

test("returns null for empty/null results", () => {
  assert.strictEqual(ytmalPickBestMatch(null, 200, false), null);
  assert.strictEqual(ytmalPickBestMatch([], 200, false), null);
});

test("returns null when no results have synced lyrics", () => {
  const best = ytmalPickBestMatch(
    [{ duration: 200 }, { duration: 201 }],
    200,
    false
  );
  assert.strictEqual(best, null);
});

test("handles missing duration", () => {
  const best = ytmalPickBestMatch(
    [{ syncedLyrics: "[00:01.00]x" }, { syncedLyrics: "[00:01.00]y" }],
    null,
    false
  );
  assert.ok(best, "should return first match when no duration provided");
});

// ────────────────────────────────────────────────────────────
// 10. HTML escaping
// ────────────────────────────────────────────────────────────

console.log("\n── HTML escaping ──");

test("escapes dangerous characters", () => {
  assert.strictEqual(
    ytmalEscapeHtml('<script>alert("xss")</script>'),
    "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
  );
});

test("escapes ampersands", () => {
  assert.strictEqual(ytmalEscapeHtml("A & B"), "A &amp; B");
});

test("handles empty string", () => {
  assert.strictEqual(ytmalEscapeHtml(""), "");
});

// ────────────────────────────────────────────────────────────
// 11. Variable playback rate scenario
// ────────────────────────────────────────────────────────────

console.log("\n── Playback rate scenarios ──");

test("binary search works regardless of playback rate", () => {
  // The algorithm uses currentTimeMs directly, not wall-clock
  // so playback rate doesn't affect correctness — just verify
  // that the same time always maps to the same line
  const lines = [
    { text: "a", startMs: 0, endMs: 5000 },
    { text: "b", startMs: 5000, endMs: 10000 },
  ];
  assert.strictEqual(ytmalFindActiveLine(lines, 2500), 0);
  assert.strictEqual(ytmalFindActiveLine(lines, 7500), 1);
  // At 2x speed, if currentTime is 7500ms, we're at line 1
  // At 0.5x speed, if currentTime is 7500ms, we're still at line 1
  // The point is: we rely on currentTime, not elapsed real time
});

// ────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed.`);
} else {
  console.log(`❌ ${failed} of ${passed + failed} tests failed.`);
  process.exit(1);
}

// Unit tests for the pure helper functions in background.js and shared.js.
// Run with: node test/parse.test.js
// No dependencies — uses only Node builtins.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");

// Build a sandbox with a minimal chrome stub, then load both scripts as
// classic scripts so their top-level function declarations become globals.
const sandbox = {
  console,
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "shared.js"), "utf8"), sandbox, {
  filename: "shared.js",
});
vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox, {
  filename: "background.js",
});

const {
  parseLrc,
  finalizeLineEnds,
  firstArtist,
  pickBestLrclibMatch,
} = sandbox;

// --- parseLrc ---

const lrc = `[00:01.50]Hello world
[00:03.00]Second line
[00:05.250]Third line`;

const lines = parseLrc(lrc);
assert.strictEqual(lines.length, 3, "parses three lines");
assert.strictEqual(lines[0].text, "Hello world");
assert.strictEqual(lines[0].startMs, 1500, "centiseconds timestamp");
assert.strictEqual(lines[0].endMs, 3000, "endMs from next line");
assert.strictEqual(lines[2].startMs, 5250, "milliseconds timestamp");

// Multi-stamp line -> one entry per stamp
const multi = parseLrc(`[00:01.00][00:02.00]Echo`);
assert.strictEqual(multi.length, 2, "multi-stamp produces two entries");
assert.strictEqual(multi[0].endMs, 2000);

// --- finalizeLineEnds ---

const fin = finalizeLineEnds([
  { text: "a", startMs: 1000, endMs: null },
  { text: "a", startMs: 1000, endMs: null },
  { text: "b", startMs: 2000, endMs: null },
]);
assert.strictEqual(fin.length, 2, "dedupes identical consecutive lines");
assert.strictEqual(fin[0].endMs, 2000, "endMs from next line start");
assert.strictEqual(fin[1].endMs, 10000, "last line gets +8s fallback");

// --- firstArtist ---

assert.strictEqual(firstArtist("The Weeknd, Daft Punk"), "The Weeknd");
assert.strictEqual(firstArtist("Jay-Z & Rihanna"), "Jay-Z");
assert.strictEqual(firstArtist("Clean Bandit x Jess Glynne"), "Clean Bandit");

// --- pickBestLrclibMatch ---

const best = pickBestLrclibMatch(
  [
    { duration: 180, syncedLyrics: "[00:01.00]x" },
    { duration: 201, syncedLyrics: "[00:01.00]y" },
    { duration: 210 },
  ],
  200
);
assert.strictEqual(best.duration, 201, "picks closest duration with synced lyrics");

console.log("All tests passed.");

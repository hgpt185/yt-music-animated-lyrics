# YouTube Music Animated Lyrics — Implementation Plan

## 1. Objective

Build a Chromium browser extension for **YouTube Music** that displays lyrics in an extension-controlled panel and highlights the currently sung word in time with the song.

The MVP should use existing word timestamps whenever available. It must **not claim word-level sync when the source only provides line-level timestamps**.

### Success criteria

- Detect the currently playing track and its playback position on `music.youtube.com`.
- Retrieve lyrics from LRCLIB without repeatedly querying the same track.
- Use per-word timestamps for karaoke-style highlighting when they exist.
- Stay synchronized during pause, resume, seeking, track changes, and playback-rate changes.
- Fall back gracefully when a track has only line-synced lyrics or no lyrics.
- Keep the UI visually isolated from YouTube Music's CSS and avoid breaking the player.

## 2. Product decisions

### MVP experience

- Inject a small floating **Lyrics** toggle into the YouTube Music page.
- Clicking it opens/closes an extension-owned lyrics panel.
- Render lyrics inside a Shadow DOM root so the site's CSS is less likely to interfere.
- Highlight the active word; visually distinguish past, active, and upcoming words. A smooth fill effect within the active word is optional after basic word switching is reliable.
- Include loading, no lyrics found, line-sync-only, error, and retry states.
- Make the panel closable and allow a small set of preferences such as font size, theme, and highlight color.

### Explicit non-goals for the first version

- Do not download, record, or analyze the actual audio stream.
- Do not run speech recognition or forced alignment locally in the MVP.
- Do not promise word-by-word highlighting for every song.
- Do not rewrite or depend on YouTube Music's internal application state. Treat its DOM as an unstable integration surface.
- Do not create a backend server until one is justified by a later feature.

## 3. Proposed stack

- **Target:** Chromium Manifest V3 extension (test in Chrome first; check other Chromium browsers separately).
- **Language:** TypeScript.
- **Build:** Vite with an extension-aware build setup (for example, CRXJS) or an equivalent MV3 multi-entry build.
- **UI:** React is optional. A small TypeScript UI is enough for the MVP; if React is used, bundle it locally.
- **Lyricsfile parsing:** `yaml` package, bundled with the extension.
- **Tests:** Vitest for pure functions; browser/manual test checklist for YouTube Music integration.
- **Persistence:** `chrome.storage.local` for cached responses and preferences.

Do not load scripts or executable code remotely. Bundle all runtime code with the extension.

## 4. Architecture

```text
YouTube Music page
  └─ Content script
      ├─ Track metadata adapter ── reads title / artist / album / video duration
      ├─ Player clock ──────────── reads HTMLMediaElement.currentTime
      ├─ Lyrics state controller ─ loading / word-sync / line-sync / unavailable
      ├─ Lyrics renderer ───────── isolated Shadow DOM panel
      └─ Message passing
           └─ MV3 service worker
               ├─ cache lookup
               ├─ LRCLIB /api/get
               ├─ optional /api/search fallback
               └─ rate-limit / timeout / error handling
```

### Responsibilities

**Content script**
- Runs only on `https://music.youtube.com/*`.
- Finds the active `<video>` element and extracts visible track metadata from the player UI.
- Detects track changes and page navigation in YouTube Music's single-page app.
- Requests lyric lookup through `chrome.runtime.sendMessage`.
- Reads current playback time and renders the active word/line.
- Owns the UI and never trusts lyrics text as HTML.

**Service worker**
- Owns cross-origin LRCLIB requests and response caching.
- Exposes a narrow message such as `LOOKUP_LYRICS`; validate every incoming message.
- Uses a timeout with `AbortController`, respects `Retry-After` on HTTP 429, and does not retry aggressively.
- Returns structured results/errors rather than raw thrown exceptions.

**Shared modules**
- Types and runtime validation for LRCLIB records and Lyricsfile YAML.
- Metadata normalization and result matching.
- Active-line and active-word timing functions.
- LRC parser used only if a fallback response requires it.

## 5. Suggested project layout

```text
src/
  background/
    service-worker.ts
    lrclib-client.ts
    lyrics-cache.ts
  content/
    index.ts
    track-observer.ts
    metadata-adapter.ts
    player-clock.ts
    lyrics-controller.ts
    ui/
      mount.ts
      LyricsPanel.tsx        # if using React; otherwise LyricsPanel.ts
      lyrics-panel.css
  shared/
    types.ts
    lyricsfile.ts
    parse-lrc.ts
    normalize-track.ts
    timing.ts
  popup/
    index.html
    popup.ts
    popup.css
  tests/
    lyricsfile.test.ts
    timing.test.ts
    normalize-track.test.ts
manifest.json
vite.config.ts
package.json
README.md
```

Keep the metadata selectors in one adapter. If YouTube Music changes its DOM, this should be the only module that needs selector updates.

## 6. Manifest and permissions

Start with the narrowest permissions that support the feature:

- `content_scripts.matches`: `https://music.youtube.com/*`
- `host_permissions`: `https://lrclib.net/*`
- `permissions`: `storage`
- MV3 background service worker for API access and caching.

Example shape (adapt to the chosen build tool's output paths):

```json
{
  "manifest_version": 3,
  "name": "YT Music Animated Lyrics",
  "version": "0.1.0",
  "description": "Word-synced animated lyrics for YouTube Music when timing data is available.",
  "permissions": ["storage"],
  "host_permissions": ["https://lrclib.net/*"],
  "background": {
    "service_worker": "assets/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://music.youtube.com/*"],
      "js": ["assets/content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_title": "YT Music Animated Lyrics"
  }
}
```

The compiled filenames vary by bundler, so this is a manifest outline rather than a guaranteed drop-in file. Avoid broad permissions like `<all_urls>`.

## 7. Track detection and metadata

YouTube Music is a single-page application, and its DOM is not a stable public API. Implement a resilient metadata adapter with multiple selectors and graceful failure.

1. Locate the active media element (typically a `video` element used by the player).
2. Read `video.duration`; require it to be finite and greater than zero before doing a signature lookup.
3. Extract title and primary artist from the player bar using a small list of fallback selectors. Use visible DOM text, not an undocumented page JavaScript object.
4. Extract album if available; album may be absent.
5. Normalize whitespace and Unicode for comparison but preserve the original strings for the API request.
6. Build a track identity key from normalized title, artist, album, and rounded duration.
7. Use a debounced `MutationObserver` for metadata changes, plus media events such as `loadedmetadata` and `durationchange`. Never trigger an API request for every mutation.
8. On a new track identity, increment a request generation ID. Ignore old responses that arrive after the user has moved to another song.

If title/artist cannot be read reliably, show a retry/error state rather than querying with guessed metadata. Add a small debug mode during development to display the extracted metadata.

## 8. LRCLIB lookup strategy

Official documentation: https://lrclib.net/docs

LRCLIB is publicly accessible without an API key and is CORS-enabled. Its API is experimental and may change. The record includes `hasWordSync`, `syncedLyrics`, `plainLyrics`, and `lyricsfile`. Word-level timestamps are in Lyricsfile's `lines[].words` structure.

### Lookup flow

1. Check local cache using the normalized track identity key.
2. Query `GET https://lrclib.net/api/get` with:
   - `track_name` (required)
   - `artist_name` (required)
   - `album_name` (include when available)
   - `duration` in seconds (include when available; round the media duration to the nearest second)
3. Check the returned metadata against the active track before accepting the result. LRCLIB documents duration matching with approximately ±2 seconds for exact-signature lookups.
4. If not found or the result is a poor match, optionally call `GET /api/search` with `track_name` and `artist_name` (or `q` if metadata extraction is incomplete). Search can return multiple candidate versions.
5. Rank candidates using title, artist, album, and duration similarity. Prefer a high-confidence match with `hasWordSync: true`, but **never pick a clearly different version just because it has word-sync data**. If confidence is weak, show line-sync/no-match fallback.
6. If `hasWordSync === true`, parse and validate `lyricsfile`. Do not rely on `syncedLyrics` for word timings; it is line-synced LRC text.
7. If there are several requests in sequence, serialize them and add a short delay between requests. Respect HTTP 429 and its `Retry-After` header; do not continue retrying during a rate limit.
8. Send an identifying client header supported by LRCLIB, such as `X-User-Agent` or `Lrclib-Client`, with the extension name, version, and project URL if available.

### Cache policy

- Cache successful lyric records locally for several days (initial default: 7 days).
- Cache no-result responses briefly (initial default: 6 hours) to avoid retrying a missing record every time the user plays the same track.
- Cache key includes normalized title, artist, album, and rounded duration.
- Keep cache size bounded; remove expired entries first.
- Never fetch repeatedly while the same track is playing.

## 9. Parse and validate Lyricsfile

Reference format: https://github.com/tranxuanthang/lyricsfile

Lyricsfile 1.0 is a draft format; keep parsing behind one module and handle unknown versions safely.

Expected word-synced shape:

```yaml
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
```

Validation rules:

- Require a known supported `version` (`"1.0"` for the current draft) and a `lines` array to display synchronized lines.
- Check that timestamps are finite non-negative numbers and `end_ms >= start_ms` when an end exists.
- Sort only if necessary, and log a validation warning in development; don't silently hide malformed timing data.
- When `words` exists and has entries, use it for word sync. Verify the line's word text roughly reconstructs the line text; trailing spaces in a word's `text` may be intentional.
- Word/line `end_ms` may be missing. For rendering only, infer a temporary end from the next word/line start, then the parent line's end when available. Do not write inferred values back to the record.
- If some lines have word arrays and others don't, word-highlight the supported lines and use line-level highlighting for unsupported lines.
- Reject unknown schema versions rather than assuming they are compatible with version 1.0.
- Use safe YAML parsing; render all lyric text using text nodes/text content, never `innerHTML`.

## 10. Playback synchronization

**Source of truth:** the active media element's `currentTime * 1000`. Do not use wall-clock timers to estimate where the song is.

Listen for `play`, `pause`, `seeking`, `seeked`, `timeupdate`, `ratechange`, `loadedmetadata`, `durationchange`, and `ended`. Re-acquire the media element if YouTube Music replaces it.

### Active-word algorithm

- Store lines/words sorted by start timestamp.
- Use binary search to find the last word whose `start_ms <= currentTimeMs`.
- Treat a word as active only while `currentTimeMs < effectiveEndMs`; otherwise return no active word or select another overlapping word only if the data explicitly represents overlap.
- Convert seconds to milliseconds once at the player boundary; keep all internal timestamps in milliseconds.
- On each update, compare the computed active word ID with the previous one and update the DOM only when the active word changes.
- While playing, use `requestAnimationFrame` for responsive updates, but do no expensive full-tree render on every frame. Stop the loop while paused or the panel is hidden; use media events to resynchronize immediately after pause/seek.
- Seeking backward must move the highlight backward immediately. Track changes must clear the old highlight and cancel/ignore old requests.
- Avoid relying on a global “current line ends when next line begins” assumption; timing data can contain gaps, missing end times, or overlapping lines.

### Animation

**MVP:** apply an active class to the current word, with CSS transitions for color/background/opacity. Keep inactive words legible and preserve whitespace and punctuation.

**Optional enhancement:** animate a left-to-right fill within the active word using `(currentTimeMs - start_ms) / (end_ms - start_ms)`, clamped to `[0, 1]`. Make sure timing is based on the visible word rather than trailing separator spaces. For words without valid end times, use a simple active-word state without progress fill.

## 11. Fallback behavior

Choose the best available display mode in this order:

1. **Word-synced:** valid Lyricsfile with `lines[].words`; highlight the spoken word.
2. **Line-synced:** valid line timestamps from Lyricsfile or `syncedLyrics`; highlight the current line and show a clear “line sync” status.
3. **Unsynced:** show plain lyrics without pretending they're synchronized, if policy and the data source permit display.
4. **No match:** show “No lyrics found for this track” with a retry control.
5. **API/rate-limit failure:** preserve a cached result if available; otherwise show a friendly error and avoid rapid automatic retries.

If the API returns `hasWordSync: false`, do not attempt to derive word timing by evenly distributing the line's duration among its words. That approximation will be visibly wrong on many songs.

## 12. UI and accessibility

- Use a Shadow DOM host element to isolate extension UI styles.
- Use semantic buttons with accessible labels, keyboard focus states, and adequate contrast.
- Keep panel size responsive and avoid covering core playback controls.
- Add a “Word sync” or “Line sync” indicator so users know what they are seeing.
- Add controls for close/open, retry, font size, theme, and optionally highlight color.
- Respect reduced-motion preferences; users should be able to disable transitions.
- Use `textContent`/framework text rendering for all API-provided strings.
- Add an error-details mode in development, but keep end-user errors readable.

## 13. Error handling and privacy

- Handle missing metadata, unavailable video element, 404, malformed JSON/YAML, unsupported Lyricsfile version, network failure, timeout, 429, and 5xx.
- Abort or ignore stale work when the track changes.
- Store only lyric lookup/cache data and user settings required by the extension. Do not collect browsing history or transmit analytics in the MVP.
- Do not introduce a server-side proxy just to work around normal API calls. If a server is added later for forced alignment, document what audio/transcripts are uploaded and obtain appropriate user consent.
- Before publishing, review LRCLIB terms and applicable lyric-display/redistribution rights. A public API and free access do **not** automatically grant all rights needed to redistribute copyrighted lyrics.

## 14. Testing plan

### Unit tests

- Parses a valid word-synced Lyricsfile.
- Rejects an unknown version and malformed timestamps.
- Handles words with trailing spaces and punctuation.
- Finds the correct word just before, at, and just after a timestamp boundary.
- Handles gaps and missing end timestamps.
- Handles seeking backward and variable playback rate.
- Normalizes metadata without merging genuinely different tracks.
- Selects the correct candidate among live, remastered, clean, and album versions.

### Manual browser tests

- Track with word-synced lyrics.
- Track with line-synced lyrics only.
- Track with plain lyrics only.
- Instrumental/no lyrics.
- Same title by different artists.
- Track with missing album metadata.
- Pause/resume, seek forward/backward, replay, next/previous track.
- Change playback speed.
- Navigate between pages inside YouTube Music without reloading the tab.
- Long song session to check CPU use, memory leaks, and duplicate observers.
- API offline, LRCLIB 404, 429, and delayed response.
- UI works at narrow and wide window sizes and remains readable in dark/light themes.

### Acceptance criteria

- A supported word-synced track highlights the correct word using player time, not an independent timer.
- Pause freezes the highlight; seek updates it immediately; resume continues accurately.
- A track change never shows the previous track's lyrics after the new lookup completes.
- The same track does not cause repeated network requests during playback.
- Line-sync-only and missing data are clearly labeled; the extension never falsely claims word sync.
- No console errors during normal playback, and no repeated observers or animation loops accumulate across track changes.

## 15. Implementation milestones

### Milestone 1 — Extension shell
- Create TypeScript/Vite MV3 project.
- Add narrow manifest permissions and content-script entry point.
- Load unpacked extension in Chrome and verify it runs only on YouTube Music.
- Add a simple floating toggle and Shadow DOM panel.

### Milestone 2 — Player and metadata adapter
- Detect the active media element.
- Extract title, artist, album, duration.
- Detect SPA track changes and rebuild the track identity.
- Add a development-only metadata debug display.

### Milestone 3 — LRCLIB client
- Implement service-worker message handler, exact lookup, search fallback, timeout, cache, and 429 handling.
- Add response types and candidate matching.
- Test on known word-synced and line-only tracks.

### Milestone 4 — Lyricsfile parsing and renderer
- Add YAML parse/validation and the line-sync fallback.
- Render lyrics as safe text nodes.
- Implement active line/word highlighting with binary search.

### Milestone 5 — Playback polish
- Handle pause, seeking, rate changes, player replacement, and SPA navigation.
- Optimize rendering so only changed word/line states update.
- Add UI states, retry, accessibility, and preferences.

### Milestone 6 — QA and release preparation
- Run all unit and manual tests.
- Test across a representative set of tracks and clearly document word-sync coverage limitations.
- Review extension privacy disclosures, LRCLIB requirements, and lyric licensing.
- Prepare store screenshots, concise permissions rationale, and a user-facing README.

## 16. Technical references

- LRCLIB API documentation: https://lrclib.net/docs
- Lyricsfile format and example schema: https://github.com/tranxuanthang/lyricsfile
- Chrome extension content scripts: https://developer.chrome.com/docs/extensions/mv3/content_scripts/
- Chrome extension permissions: https://developer.chrome.com/docs/extensions/mv3/declare_permissions/
- Chrome extension architecture and message passing: https://developer.chrome.com/docs/extensions/mv3/architecture-overview/

## Final engineering principle

**Use the media player's actual time as the clock, use word timestamps as the source of truth, and clearly downgrade the UI when those timestamps are unavailable.** This is the core of reliable karaoke-style synchronization.

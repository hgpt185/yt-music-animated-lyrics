# Animated Lyrics for YouTube Music

Animated word-synced lyrics on music.youtube.com, with smooth scrolling, soft word glow and line transitions. Real word timings are preferred when available; recordings with only line timings use line sync. No word timings are manufactured.

## Use

Play a song and open YouTube Music's Lyrics tab. Hover a lyric line to make its text slightly whiter, then click to seek to that moment. Alt-click a word to seek its cue. The sync-mode button in the extension popup switches between word and line display and remembers your choice. Manual scrolling pauses following; use Resume lyrics or wait six seconds to follow again. The popup offers enable/disable and the sync-mode preference. Temporary provider failures are retried automatically.

Word coverage varies by recording and provider availability. An unavailable word mode is clearly labeled. Pause, seeking, playback speed and song changes follow the player clock. Reduced-motion settings are respected.

## Install locally

Requires Chrome 120 or later. Open chrome://extensions, enable Developer mode, choose Load unpacked and select the folder that directly contains manifest.json. Refresh YouTube Music after installing or reloading. The installed Chrome PWA also works; other standalone desktop clients do not load Chrome extensions.

## Files and release outputs

Everything for this project is inside this repository:

- Source code, tests, vendor licenses and development tools: repository root.
- Chrome-ready files: `dist/CHROME-LOAD-THIS-FOLDER/`.
- Store-upload ZIP, listing guide, privacy page and listing images: `dist/release/`.
- Final screenshots from the earlier website task: `dist/coballow/`.

The previous Codex outputs path is a compatibility symlink to dist, so the existing Chrome registration and earlier file links continue to resolve. Generated outputs are ignored by Git.

## Release package

```sh
python3 tools/package-extension.py --output dist/release
```

This creates one store-upload ZIP and a matching unpacked runtime directory. It uses an explicit allowlist: no tests, development tools, demos, provider-response dumps or build caches enter the package. manifest.json is always at the ZIP root. See docs/chrome-web-store/LISTING.md for listing text, permission justifications, screenshots and submission steps. Publish privacy.html at a public HTTPS URL before submitting for review.

## Development

```sh
node --test test/*.test.js
```

No build is required to load the source extension. Optional vendor rebuilds: node tools/build-renderer.mjs and node tools/build-parsers.mjs (Node 22+ and npm). The parser lockfile remains in vendor for reproducibility.

- player-metadata.js runs in YouTube Music's MAIN world and publishes bounded metadata snapshots. content.js runs isolated and rejects a different video's metadata.
- providers.js tries independent word providers in parallel, validates identity and duration, parses real TTML/QRC/enhanced-LRC cues and prefers word sync.
- background.js manages provider selection, LRCLIB/YouTube fallbacks, bounded retries and persistent caching keyed by video and metadata.
- shared.js holds parsers, matching and the renderer adapter. Changing display mode preserves the original word cues.
- content.js/content.css implement the panel, media clock, seeking, accessibility and display preference.
- popup.html/popup.js provide settings and user-controlled local diagnostics.

## Privacy and services

Current song metadata is sent over HTTPS to Better Lyrics public TTML/QQ, Binimum, lrc.red, Unison and LRCLIB as needed. YouTube Music's own lyrics endpoint is the final fallback. Requests omit credentials. Preferences, caches and the latest diagnostic report stay in local extension storage; lookup records are not automatically shared with the developer. See privacy.html for the full data flow and retention details.

The extension uses no borrowed private provider credentials. Public Better Lyrics cache misses can require access unavailable to this extension; independent services are tried before falling back to line sync. No service can guarantee word cues for every recording.

## Third-party software

Braccato core 1.16.10 (MIT), Braccato parsers 0.4.0 and their XML dependencies are bundled locally, along with YAML (ISC). See THIRD_PARTY_NOTICES.md and vendor/*.LICENSE.txt. Provider responses are parsed as lyric data; no remote code is executed.

Project: https://github.com/hgpt185/yt-music-animated-lyrics

This independently developed extension is not affiliated with or endorsed by Google, YouTube, Spotify or Better Lyrics.

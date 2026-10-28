# Chrome Web Store release — 2.1.6

Upload `animated-lyrics-2.1.6-chrome-web-store.zip`. Size: 412,183 bytes. SHA-256: `543083ac684b35b7af89eae73ef3e876893eb5d1b484bf60553574f6ca139748`.

## Changes

Hover now brightens only the lyric text, fading from 38% to 72% white over 160ms. The line background stays fully transparent; hover/click background boxes have been removed. Word highlight overlays remain untouched, and reduced motion disables the fade. The line/word sync control remains only in the extension popup, next to enable/disable settings. The on-screen mode button, Retry word sync, Lookup details and Copy report controls have been removed. Popup preferences update open lyric panels immediately through chrome.storage and persist across songs and reloads. Automatic retries still recover from transient provider failures. Hover highlighting, click-to-seek, real word timing and line fallback remain available. The privacy and listing text and store screenshots match this interface.

## Verified

- 65 Node entries passed (including a parser file with 56 assertions). Syntax, git diff --check and UI detector passed.
- The upload ZIP was extracted into a fresh folder and loaded in Chrome/155.0.8059.84. The actual popup changed an open fixture lyric panel to line mode; reloading retained that preference; Enter on the popup button restored word mode. No on-screen mode control or diagnostic controls remained. The 330px popup fit without overflow and was visually inspected.
- The hover transition, pointer cursor, click-to-seek, reduced motion and privacy page still passed. No page exceptions occurred. Browser testing uses original illustrative lyric cues and the actual bundled metadata bridge and renderer, not an automated signed-in YouTube Music session.
- Root MV3 manifest, description length, all runtime references and third-party licenses checked. The runtime-only package omits tests, tools, demos, debug dumps and build lockfiles.
- Refreshed store screenshots show the updated panel without its former mode button. Icon and promotional images remain in assets/.

## Submission

Use LISTING.md for store copy, permissions and review instructions. Publish the provided privacy.html at a stable public HTTPS URL before submitting for review. Upload only the ZIP. This work has not uploaded or published the extension; approval is determined by Google.

The existing dist/CHROME-LOAD-THIS-FOLDER path was updated in place. Reload the extension and refresh YouTube Music to activate 2.1.6. Old upload ZIPs and generated verification scratch files were removed.

Release files are consolidated under /home/nikhargupta/yt-music-animated-lyrics/dist. The former Codex outputs directory is a symlink to this directory, preserving the existing Chrome load path without duplicates.

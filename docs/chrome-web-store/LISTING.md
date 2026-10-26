# Chrome Web Store submission — 2.1.6

## Upload

Upload animated-lyrics-2.1.6-chrome-web-store.zip directly in the Chrome Web Store Developer Dashboard. Do not upload the entire release folder. manifest.json is at the ZIP root. The unpacked directory contains the same runtime files for local verification. Rebuild with python3 tools/package-extension.py --output dist/release.

The package is prepared locally; no store upload, publication, account registration or privacy-page hosting has been performed. Store approval is determined by Google.

## Listing text

Name: Animated Lyrics for YouTube Music

Summary: Animated word-synced lyrics for YouTube Music, with line-sync mode, smooth scrolling, and click-to-seek.

Detailed description:

Bring synchronized lyrics to the Lyrics tab on music.youtube.com.

• Follow real word timings with soft highlights, subtle glow and smooth line transitions.
• Switch between word and line sync using the button in the extension popup. Your choice is remembered.
• Hover over a line to make its text slightly whiter, then click to jump to that moment. Alt-click a timed word to seek its cue.
• Scroll freely and resume automatic following when you are ready.
• Keep lyrics aligned while pausing, seeking or changing playback speed.
• Enable or disable the extension from its popup; temporary source failures are retried automatically.

Word timing depends on the recording and available lyric providers. Songs without word timings use line sync; the extension does not invent word cues. No account or audio upload is required.

To retrieve lyrics, current song metadata is sent to independent lyric services. Preferences, cached lyrics and the latest lookup report are stored locally. Provider operators may retain their normal server logs. Read the linked privacy policy for the complete data flow and retention details.

Requires Chrome 120 or later. After installing, refresh YouTube Music, play a song and open its Lyrics tab. This independent extension is not affiliated with or endorsed by Google or YouTube.

Language: English. Suggested category: Entertainment.
Support / project URL: https://github.com/hgpt185/yt-music-animated-lyrics/issues

## Single purpose

Display synchronized, interactive lyrics for the song currently playing on music.youtube.com, including word/line display selection and click-to-seek.

## Permission justifications

storage: Save the enable and display-mode preferences, cache matched lyrics to reduce repeated provider requests, and keep the latest local lookup diagnostic report.

https://music.youtube.com/*: Read the current song and playback state, render the lyric panel, seek when the user clicks a lyric, and request YouTube Music's own timed lyrics when external sources have no usable result. A small MAIN-world script reads the page-owned player metadata API; rendering and lyric-provider requests remain isolated.

https://api.betterlyrics.org/*: Retrieve real TTML and QQ/QRC word timing using current song metadata.
https://lyrics-api.binimum.org/*: Find matching lyric catalog entries by title and artist.
https://lrc.red/*: Retrieve validated ISRC lyric documents and use a direct catalog fallback.
https://unison.boidu.dev/*: Retrieve matching community-contributed lyrics by video ID or song metadata.
https://lrclib.net/*: Retrieve matched timed lyrics when word providers are unavailable.

Remote code: No. All JavaScript, lyric parsers and the renderer ship in the ZIP. Remote TTML, QRC, LRC and JSON responses are parsed as data; they are not executed. Development-only download/build scripts are excluded from the ZIP.

## Privacy fields

Publish the included privacy.html at a stable public HTTPS URL you control, then paste that URL into the Privacy Policy field. A local extension URL cannot serve as the store listing's public policy URL. The same policy is available inside the installed extension via its popup.

Data handling includes current YouTube Music website content (song metadata and lyrics), the current video identifier/page reference, and local preferences/lookup diagnostics. Disclose Website content and the narrowly scoped Web history/current-video identifier under the dashboard's applicable definitions; do not select “no data handled.” The extension does not track browsing on other sites. It does not collect authentication, personal communications, payment, health or location data. Network services inherently receive request IP addresses/headers; their retention is controlled by those operators.

Confirm the dashboard's Limited Use certifications only after verifying that the submitted release and any future changes still match these disclosures. No data is sold, used for unrelated advertising, or used to determine creditworthiness. There is no developer-operated telemetry endpoint.

## Images and reviewer steps

Upload assets/icon128.png as the icon, assets/promo-440x280.png as the small promotional tile, and the 1280×800 screenshot images. The screenshots run the actual bundled extension UI with original illustrative lyrics and a clearly labeled preview player; they do not claim provider coverage for a real song.

Reviewer instructions: Open music.youtube.com and play a song. Open Lyrics. Word timing will be selected if public providers have usable cues; otherwise line sync is expected. Use the popup button to switch display mode. Hover a line to see its text brighten slightly with a pointer cursor, then click to seek. Temporary provider failures are retried automatically; the popup contains no retry or diagnostic controls. No extension-specific account or paid access is required.

Before submission: publish the public privacy URL, verify the support URL, choose your distribution regions and complete the developer account's required fields. Then upload the package and listing assets and submit for Google's review.

Official references checked 21 October 2026:
- https://developer.chrome.com/docs/webstore/prepare
- https://developer.chrome.com/docs/webstore/images
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

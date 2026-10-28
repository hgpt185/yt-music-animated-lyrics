# Braccato renderer

Pinned package: @braccato/core 1.16.10 (MIT).

Upstream: https://github.com/better-lyrics/braccato
Used by: https://github.com/better-lyrics/better-lyrics

Archive integrity: `sha512-CXZennEbsPmnklbtr9b5/3HAG3ydoZWsBdEuP8AH1MfM/zpYmOkHrF5noVmOOX8vGr1ZOJgy4NKXjzEXCwAcmw==`

The JavaScript engine is bundled without modification. Its CSS is included in the bundle, with :root changed to :host for our isolated lyrics panel and local CSS imports inlined. The extension's layout overrides live in content.js. No remote scripts or runtime package downloads are used.

Rebuild with Node 22+ and npm: `node tools/build-renderer.mjs`. No build is needed to load the extension unpacked.

See braccato.LICENSE.txt for the upstream license.

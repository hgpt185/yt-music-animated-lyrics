// ============================================================
// Animated Lyrics for YouTube Music — Content Script
// Shadow DOM lyrics panel with word-level sync, media event
// handling, accessibility, and smooth fill animations.
// ============================================================

(() => {
  const LYRICS_PAGE = "MUSIC_PAGE_TYPE_TRACK_LYRICS";
  const ROOT_ID = "ytmal-root";
  const SHADOW_HOST_ID = "ytmal-shadow-host";
  const USER_SCROLL_RESUME_MS = 6000;
  const METADATA_SETTLE_MS = 250;
  const SYNC_CHECK_INTERVAL = 20; // ~3 rAF ticks per song-change check

  // ── State ───────────────────────────────────────────────────

  const state = {
    videoId: null,
    trackKey: null,
    trackMeta: null,
    playerMetadata: null,
    loadTimer: 0,
    retryTimer: 0,
    retryAttempts: 0,
    requestId: 0,
    lines: [],
    syncMode: "none",      // Effective display mode.
    availableSyncMode: "none",
    preferredSyncMode: "word",
    activeLineIdx: -1,
    userScrolling: false,
    userScrollTimer: 0,
    raf: 0,
    frame: 0,
    mounted: false,
    enabled: true,
    progressPct: -1,
    shadowRoot: null,
    renderer: null,
  };

  const cache = new Map();
  let videoEl = null;
  let mediaListenersAttached = false;

  // Page-owned player methods are invisible in Chrome's ISOLATED world.
  // The MAIN-world bridge sends a small JSON snapshot; never executable code.
  document.addEventListener?.('ytmal:player-metadata', event => {
    if (typeof event.detail !== 'string' || event.detail.length > 5000) return;
    try {
      const meta = JSON.parse(event.detail);
      if (!/^[\w-]{11}$/.test(meta.videoId) || typeof meta.title !== 'string' ||
          typeof meta.artist !== 'string' || meta.title.length > 1000 || meta.artist.length > 1000 ||
          !Number.isFinite(meta.duration) || meta.duration < 0) return;
      state.playerMetadata = meta;
    } catch { /* Ignore malformed page messages. */ }
  });

  // ── Enable/disable toggle ─────────────────────────────────

  chrome.storage.local.get(["enabled", "preferredSyncMode"], (result) => {
    state.enabled = result.enabled !== false;
    state.preferredSyncMode = result.preferredSyncMode === 'line' ? 'line' : 'word';
    refreshSyncMode();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ('preferredSyncMode' in changes) {
      const mode = changes.preferredSyncMode.newValue === 'line' ? 'line' : 'word';
      if (mode !== state.preferredSyncMode) {
        state.preferredSyncMode = mode;
        refreshSyncMode();
      }
    }
    if (!("enabled" in changes)) return;
    const enabled = changes.enabled.newValue !== false;
    const wasEnabled = state.enabled;
    state.enabled = enabled;
    if (wasEnabled === enabled) return;
    if (!enabled) {
      window.clearTimeout(state.retryTimer);
      unmount();
    } else if (state.trackKey) {
      scheduleWordRetry(cache.get(state.trackKey), getNowPlaying(), state.requestId, state.trackKey);
    }
  });

  // ── Boot ──────────────────────────────────────────────────

  waitForApp().then(start);

  function start() {
    observePlayer();
    tick();
    document.addEventListener("yt-navigate-finish", syncSong, true);
    document.addEventListener("visibilitychange", () => {
      state.renderer?.noteVisibilityChange();
      if (!document.hidden && state.mounted) updateActiveLine(true);
    });
  }

  function waitForApp() {
    return new Promise((resolve) => {
      if (document.querySelector("ytmusic-app")) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector("ytmusic-app")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  // ── Player observation ────────────────────────────────────

  function observePlayer() {
    const observer = new MutationObserver(() => {
      mountIfNeeded();
      syncSong();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["page-type", "title", "video-id"],
    });
    mountIfNeeded();
    syncSong();
  }

  // ── Media element event handling ──────────────────────────

  function attachMediaListeners() {
    const video = getVideo();
    if (!video || mediaListenersAttached) return;

    const events = [
      "play", "pause", "seeking", "seeked", "timeupdate",
      "ratechange", "loadedmetadata", "durationchange", "ended",
    ];

    for (const evt of events) {
      video.addEventListener(evt, onMediaEvent, { passive: true });
    }
    mediaListenersAttached = true;
  }

  function detachMediaListeners() {
    if (!videoEl || !mediaListenersAttached) return;
    const events = [
      "play", "pause", "seeking", "seeked", "timeupdate",
      "ratechange", "loadedmetadata", "durationchange", "ended",
    ];
    for (const evt of events) {
      videoEl.removeEventListener(evt, onMediaEvent);
    }
    mediaListenersAttached = false;
  }

  function onMediaEvent(event) {
    switch (event.type) {
      case "loadedmetadata":
      case "durationchange":
        syncSong();
        break;
      case "seeking":
      case "seeked":
        // Immediate resync on seek
        state.activeLineIdx = -1;
        if (state.mounted) updateActiveLine(true);
        break;
      case "ratechange":
        // Playback speed changed — no special action needed,
        // tick() reads currentTime directly
        break;
      case "play":
        // Resume rAF loop if needed
        break;
      case "pause":
      case "ended":
        // Update position on pause so highlight freezes correctly
        if (state.mounted) updateActiveLine(false);
        break;
    }
  }

  // ── Mount / unmount ───────────────────────────────────────

  function lyricsTab() {
    return document.querySelector("#tab-renderer");
  }

  function isLyricsTabOpen() {
    return lyricsTab()?.getAttribute("page-type") === LYRICS_PAGE;
  }

  function unmount() {
    state.renderer?.destroy();
    state.renderer = null;
    window.clearTimeout(state.userScrollTimer);
    state.userScrolling = false;
    document.getElementById(SHADOW_HOST_ID)?.remove();
    state.shadowRoot = null;
    state.mounted = false;
    state.activeLineIdx = -1;
    lyricsTab()?.classList.remove("ytmal-active");
    document
      .querySelector("ytmusic-player-page")
      ?.classList.remove("ytmal-lyrics-open");
  }

  function mountIfNeeded() {
    if (!state.enabled) {
      if (state.mounted) unmount();
      return;
    }
    const tab = lyricsTab();
    if (!tab || !isLyricsTabOpen()) {
      if (state.mounted) unmount();
      return;
    }
    if (state.mounted && document.getElementById(SHADOW_HOST_ID)?.parentElement === tab) return;
    if (state.mounted) unmount();

    tab.classList.add("ytmal-active");
    document
      .querySelector("ytmusic-player-page")
      ?.classList.add("ytmal-lyrics-open");
    state.mounted = true;

    const { host, shadow } = createShadowPanel();
    state.shadowRoot = shadow;
    tab.appendChild(host);
    const scroller = shadow.querySelector("[data-ytmal-lines]");
    const followButton = shadow.querySelector("[data-ytmal-follow]");
    state.renderer = YtmalRenderer.createLyricsRenderer({
      document,
      window,
      mount: scroller,
      host: {
        isViewVisible: () => state.enabled && state.mounted && !document.hidden && isLyricsTabOpen(),
        getScrollElement: () => scroller,
        isLoaderActive: () => state.lines.length === 0,
        syncAdState: () => document.querySelector("#movie_player")?.classList.contains("ad-showing") || false,
        seek: seekToTime,
        setResumeAffordanceVisible: visible => {
          // Scrollbar drags also reach the renderer, without wheel/touch events.
          // Keep every manual scroll on the extension's six-second resume timer.
          if (visible) markUserScrolling();
          else followButton.hidden = true;
        },
        log: (...args) => console.debug("[YTMAL renderer]", ...args),
      },
    });

    attachMediaListeners();
    paintCurrentLyrics();
  }

  // ── Shadow DOM panel ──────────────────────────────────────

  function createShadowPanel() {
    const host = document.createElement("div");
    host.id = SHADOW_HOST_ID;
    host.style.cssText =
      "position:absolute;inset:0;z-index:3;pointer-events:auto;";

    const shadow = host.attachShadow({ mode: "open" });

    // Inject styles into shadow
    const style = document.createElement("style");
    style.textContent = YtmalRenderer.styles + getShadowStyles();
    shadow.appendChild(style);

    // Root container
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Animated lyrics");
    root.className = "ytmal-root";

    // Progress bar
    const progressWrap = document.createElement("div");
    progressWrap.className = "ytmal-progress";
    progressWrap.setAttribute("role", "progressbar");
    progressWrap.setAttribute("aria-label", "Song progress");

    const progressFill = document.createElement("div");
    progressFill.className = "ytmal-progress-fill";
    progressFill.dataset.ytmalProgressFill = "";
    progressWrap.appendChild(progressFill);
    root.appendChild(progressWrap);

    // Sync mode indicator
    const syncIndicator = document.createElement("div");
    syncIndicator.className = "ytmal-sync-indicator";
    syncIndicator.dataset.ytmalSyncIndicator = "";
    syncIndicator.setAttribute("aria-live", "polite");
    root.appendChild(syncIndicator);

    // Lines container
    const scroller = document.createElement("div");
    scroller.className = "ytmal-lines";
    scroller.dataset.ytmalLines = "";
    scroller.setAttribute("role", "group");
    scroller.setAttribute("aria-label", "Lyrics lines");
    scroller.tabIndex = 0;

    // User scroll detection
    scroller.addEventListener("wheel", markUserScrolling, { passive: true });
    scroller.addEventListener("touchmove", markUserScrolling, {
      passive: true,
    });

    // Braccato handles line clicks and Alt-clicking a word to seek its cue.
    scroller.addEventListener("scroll", () => state.renderer?.noteUserScroll(), { passive: true });
    scroller.addEventListener("pointerdown", event => {
      if (event.target === scroller) markUserScrolling();
    });

    // Keyboard navigation
    scroller.addEventListener("keydown", handleKeyNav);

    root.appendChild(scroller);

    const followButton = document.createElement("button");
    followButton.type = "button";
    followButton.className = "ytmal-follow";
    followButton.dataset.ytmalFollow = "";
    followButton.textContent = "Resume lyrics";
    followButton.hidden = true;
    followButton.addEventListener("click", resumeFollowing);
    root.appendChild(followButton);
    shadow.appendChild(root);

    return { host, shadow };
  }

  // ── Keyboard navigation ───────────────────────────────────

  function handleKeyNav(event) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      markUserScrolling();
    }
    const scroller = state.shadowRoot?.querySelector("[data-ytmal-lines]");
    if (!scroller) return;

    const lines = [...scroller.querySelectorAll("[data-line-index]")];
    if (!lines.length) return;

    let focusedIdx = lines.findIndex(
      (el) => el === state.shadowRoot.activeElement
    );

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusedIdx = Math.min(focusedIdx + 1, lines.length - 1);
        lines[focusedIdx]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        focusedIdx = Math.max(focusedIdx - 1, 0);
        lines[focusedIdx]?.focus();
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (focusedIdx >= 0) seekToLine(focusedIdx);
        break;
      case "Home":
        event.preventDefault();
        lines[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        lines[lines.length - 1]?.focus();
        break;
    }
  }

  // ── User scroll handling ──────────────────────────────────

  function markUserScrolling() {
    state.userScrolling = true;
    window.clearTimeout(state.userScrollTimer);
    const followButton = state.shadowRoot?.querySelector("[data-ytmal-follow]");
    if (followButton) followButton.hidden = false;
    state.userScrollTimer = window.setTimeout(resumeFollowing, USER_SCROLL_RESUME_MS);
  }

  function resumeFollowing() {
    state.userScrolling = false;
    window.clearTimeout(state.userScrollTimer);
    state.renderer?.resumeAutoscroll();
    const followButton = state.shadowRoot?.querySelector("[data-ytmal-follow]");
    if (followButton) followButton.hidden = true;
    updateActiveLine(true);
  }

  // ── Song sync ─────────────────────────────────────────────

  function syncSong() {
    const meta = getNowPlaying();
    const trackKey = meta.videoId ? ytmalTrackKey(meta) : null;
    if (trackKey === state.trackKey) return;

    // Check if video element changed
    const currentVideo = document.querySelector("video");
    if (currentVideo !== videoEl) {
      detachMediaListeners();
      videoEl = currentVideo;
      attachMediaListeners();
    }

    window.clearTimeout(state.loadTimer);
    window.clearTimeout(state.retryTimer);
    state.retryAttempts = 0;
    window.clearTimeout(state.userScrollTimer);
    state.userScrolling = false;
    // Invalidate old requests as soon as identity changes, before debouncing.
    const requestId = ++state.requestId;
    state.videoId = meta.videoId || null;
    state.trackKey = trackKey;
    if (meta.title && meta.artist) state.trackMeta = meta;
    state.activeLineIdx = -1;
    state.lines = [];
    state.syncMode = "none";
    state.availableSyncMode = "none";
    state.progressPct = -1;
    updateSyncIndicator();
    renderStatus("Loading synced lyrics…");
    if (!trackKey) return;

    // URL, player-bar text, and media duration often update in separate turns.
    // Only query a metadata snapshot that has settled and is still current.
    state.loadTimer = window.setTimeout(() => {
      if (requestId !== state.requestId) return;
      if (ytmalTrackKey(getNowPlaying()) !== trackKey) {
        syncSong();
        return;
      }
      loadLyrics(meta, requestId, trackKey);
    }, METADATA_SETTLE_MS);
  }

  async function loadLyrics(meta, requestId, trackKey, refresh = false) {
    // Cache by the whole snapshot so a provisional title can't poison a video.
    const cached = cache.get(trackKey);
    if (cached && !refresh) {
      applyLyrics(cached, requestId);
      scheduleWordRetry(cached, meta, requestId, trackKey);
      return;
    }

    if (!refresh) renderStatus("Loading synced lyrics…");

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "YTMAL_GET_LYRICS",
        payload: meta,
        refresh,
      });
    } catch (error) {
      result = {
        ok: false,
        error: error?.message || String(error),
        syncMode: "none",
        lines: [],
      };
    }

    if (requestId !== state.requestId) return; // stale
    if (ytmalTrackKey(getNowPlaying()) !== trackKey) {
      syncSong();
      return;
    }
    // Keep already displayed lyrics while a retry is temporarily unavailable.
    const previous = cache.get(trackKey);
    const keepPrevious = refresh && previous?.ok && (!result?.ok || (previous.syncMode === 'word' && result.syncMode !== 'word'));
    const selected = keepPrevious ? previous : result;
    cache.set(trackKey, selected);
    applyLyrics(selected, requestId);
    scheduleWordRetry(selected, meta, requestId, trackKey);
  }

  function scheduleWordRetry(result, meta, requestId, trackKey) {
    window.clearTimeout(state.retryTimer);
    if (result?.syncMode === 'word') return;
    const delay = [15000, 45000, 120000][Math.min(state.retryAttempts++, 2)];
    state.retryTimer = window.setTimeout(() => {
      if (requestId !== state.requestId || trackKey !== state.trackKey || !state.enabled) return;
      loadLyrics(getNowPlaying(), requestId, trackKey, true);
    }, delay);
  }

  function applyLyrics(result, requestId) {
    if (requestId !== state.requestId) return;
    if (ytmalTrackKey(getNowPlaying()) !== state.trackKey) {
      syncSong();
      return;
    }
    if (!result?.ok || !result.lines?.length) {
      state.lines = [];
      state.syncMode = "none";
      state.availableSyncMode = "none";
      updateSyncIndicator();
      renderEmpty(
        result?.error ||
          "No timed lyrics were found for this song."
      );
      return;
    }
    state.lines = result.lines;
    state.availableSyncMode = result.syncMode || "line";
    refreshSyncMode();
  }

  function refreshSyncMode() {
    state.syncMode = state.lines.length
      ? (state.availableSyncMode === 'word' && state.preferredSyncMode === 'word' ? 'word' : 'line')
      : 'none';
    renderLines();
    updateSyncIndicator();
    if (state.lines.length) updateActiveLine(true);
  }

  function paintCurrentLyrics() {
    if (!state.shadowRoot) return;
    if (state.lines.length) {
      renderLines();
      updateSyncIndicator();
      updateActiveLine(true);
      return;
    }
    if (state.trackKey && cache.has(state.trackKey)) {
      applyLyrics(cache.get(state.trackKey), state.requestId);
    }
  }

  // ── Rendering (textContent / DOM nodes only) ──────────────

  function renderStatus(message) {
    state.renderer?.clear();
    if (!state.shadowRoot) return;
    const scroller = state.shadowRoot.querySelector("[data-ytmal-lines]");
    if (!scroller) return;
    scroller.textContent = "";
    const div = document.createElement("div");
    div.className = "ytmal-status";
    div.textContent = message;
    scroller.appendChild(div);
  }

  function renderEmpty(message) {
    state.renderer?.clear();
    if (!state.shadowRoot) return;
    const scroller = state.shadowRoot.querySelector("[data-ytmal-lines]");
    if (!scroller) return;
    scroller.textContent = "";
    const div = document.createElement("div");
    div.className = "ytmal-empty";
    div.textContent = message;
    scroller.appendChild(div);
  }

  function updateSyncIndicator() {
    if (!state.shadowRoot) return;
    const indicator = state.shadowRoot.querySelector(
      "[data-ytmal-sync-indicator]"
    );
    if (!indicator) return;

    const labels = {
      word: "Word sync",
      line: "Line sync",
      none: "",
    };
    indicator.textContent = labels[state.syncMode] || "";
    indicator.className = `ytmal-sync-indicator ${state.syncMode !== "none" ? "visible" : ""}`;

  }

  function renderLines() {
    if (!state.renderer) return;
    state.activeLineIdx = -1;
    state.renderer.setLyrics(ytmalRendererLyrics(state.lines, state.syncMode));
    state.renderer.lines.forEach((line, index) => {
      const element = line.lyricElement;
      element.dataset.lineIndex = String(index);
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", `Line ${index + 1}: ${state.lines[index].text}`);
      element.tabIndex = -1;
    });
  }

  // ── Tick loop ─────────────────────────────────────────────

  function tick() {
    state.frame += 1;

    // Periodic song-change check
    if (state.frame % SYNC_CHECK_INTERVAL === 0) {
      // Metadata can finish loading after the video ID has already changed.
      syncSong();

      // Re-acquire video element if it was replaced
      const currentVideo = document.querySelector("video");
      if (currentVideo !== videoEl) {
        detachMediaListeners();
        videoEl = currentVideo;
        attachMediaListeners();
      }
    }

    if (!document.hidden && state.enabled && isLyricsTabOpen()) {
      if (!state.mounted) mountIfNeeded();
      if (state.mounted) {
        const video = getVideo();
        // Only update during playback to avoid CPU waste while paused
        if (video && !video.paused) {
          updateActiveLine(false);
        }
      }
    }

    state.raf = requestAnimationFrame(tick);
  }

  // ── Active line/word update ───────────────────────────────

  function updateActiveLine(forceScroll) {
    if (!state.lines.length || !state.shadowRoot || !state.renderer) return;
    const video = getVideo();
    const timeMs = getCurrentTimeMs();
    const lineIndex = ytmalFindActiveLine(state.lines, timeMs);
    if (lineIndex !== state.activeLineIdx) {
      state.activeLineIdx = lineIndex;
      state.renderer.lines.forEach((line, index) => {
        if (index === lineIndex) line.lyricElement.setAttribute("aria-current", "true");
        else line.lyricElement.removeAttribute("aria-current");
      });
    }
    if (forceScroll) state.renderer.resumeAutoscroll();
    // Braccato owns word/letter masks, glow, line scaling and interruptible scroll.
    // Drive all of it from the media clock, including paused seeks and rate changes.
    state.renderer.tick(timeMs / 1000, {
      eventCreationTime: Date.now(),
      isPlaying: !!video && !video.paused && !video.ended,
      playbackRate: video?.playbackRate || 1,
      smoothScroll: !forceScroll,
      passiveScrollEnabled: false,
    });
    updateProgress(timeMs);
  }

  function updateProgress(timeMs) {
    if (!state.shadowRoot) return;
    const fill = state.shadowRoot.querySelector("[data-ytmal-progress-fill]");
    if (!fill) return;
    const durationMs = (getVideo()?.duration || 0) * 1000;
    const ratio = durationMs > 0 ? Math.min(timeMs / durationMs, 1) : 0;
    const pct = Math.round(ratio * 200); // 0.5% steps
    if (pct === state.progressPct) return;
    state.progressPct = pct;
    fill.style.width = `${(pct / 2).toFixed(1)}%`;
  }

  // ── Seek to line ──────────────────────────────────────────

  function seekToLine(index) {
    const line = state.lines[index];
    if (!line) return;
    seekToTime(line.startMs / 1000);
  }

  function seekToTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const player = document.querySelector("#movie_player");
    if (player && typeof player.seekTo === "function") {
      player.seekTo(seconds, true);
    } else {
      const video = getVideo();
      if (video) video.currentTime = seconds;
    }
    const video = getVideo();
    video?.play?.()?.catch?.(() => {});
    state.userScrolling = false;
    window.clearTimeout(state.userScrollTimer);
    state.renderer?.resumeAutoscroll();
    state.activeLineIdx = -1;
    updateActiveLine(true);
  }

  // ── Player helpers ────────────────────────────────────────

  function getVideo() {
    if (!videoEl || !videoEl.isConnected) {
      videoEl = document.querySelector("video");
    }
    return videoEl;
  }

  function getNowPlaying() {
    if (document.dispatchEvent) document.dispatchEvent(new CustomEvent('ytmal:request-player-metadata'));
    const urlVideoId = new URLSearchParams(location.search).get('v') || '';
    const snapshot = state.playerMetadata;
    // Ignore a previous video's snapshot as soon as the URL changes.
    const bridge = snapshot && (!urlVideoId || snapshot.videoId === urlVideoId) ? snapshot : null;
    const player = document.querySelector("#movie_player");
    let data = {};
    try { data = player?.getVideoData?.() || {}; } catch { /* Isolated or unready player. */ }
    if (!data.video_id && bridge) data = {video_id:bridge.videoId, title:bridge.title, author:bridge.artist};
    const bar = document.querySelector("ytmusic-player-bar");
    const titleNode = bar?.querySelector(".title");
    const barTitle = titleNode?.textContent?.trim() || "";
    const titleLink = titleNode?.closest?.("a[href*='watch']") ||
      titleNode?.querySelector?.("a[href*='watch']");
    const barVideoId = titleLink
      ? new URL(titleLink.href, location.href).searchParams.get("v") : "";
    const videoId = data.video_id ||
      new URLSearchParams(location.search).get("v") || barVideoId || "";
    const byline = bar?.querySelector(".byline")?.textContent?.trim() || "";
    const [artistPart, albumPart] = byline.split("•").map((part) => part.trim());
    const video = getVideo();

    // Don't combine a new player ID with the old player bar's artist/album.
    const barMatches = (!barVideoId || barVideoId === videoId) &&
      (!data.title || ytmalMatchText(barTitle) === ytmalMatchText(data.title));
    const meta = {
      videoId,
      title: (barMatches ? barTitle : "") || data.title || "",
      artist: ((barMatches ? artistPart : "") || data.author || "").replace(/\s+/g, " ").trim(),
      album: (barMatches ? albumPart || "" : "").replace(/\s+/g, " ").trim(),
      duration: bridge?.duration || (Number.isFinite(video?.duration) ? video.duration : 0),
      metadataSource: bridge ? "player-bridge" : data.video_id ? "player-api" : barMatches && barTitle ? "player-bar" : "missing",
    };

    // In an isolated content-script world getVideoData may be unavailable.
    // During navigation the URL can advance before the bar text. Use only the
    // video-specific YouTube fallback until that stale metadata is replaced.
    const previous = state.trackMeta;
    if (!data.video_id && !barVideoId && previous && videoId !== previous.videoId &&
        ytmalNormalize(meta.title) === ytmalNormalize(previous.title) &&
        ytmalNormalize(meta.artist) === ytmalNormalize(previous.artist)) {
      meta.title = "";
      meta.artist = "";
      meta.album = "";
      meta.duration = 0;
    }
    return meta;
  }

  function getCurrentTimeMs() {
    return (getVideo()?.currentTime || 0) * 1000;
  }

  // ── Shadow DOM styles ─────────────────────────────────────

  function getShadowStyles() {
    return `
      :host {
        all: initial;
        display: block;
        position: absolute;
        inset: 0;
        z-index: 3;
        color-scheme: dark;
      }

      .ytmal-root {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        color: #fff;
        font-family: "YouTube Sans", "Roboto", "Noto Sans", sans-serif;
        background: transparent;
      }

      /* ── Progress bar ────────────────────────────── */

      .ytmal-progress {
        flex: 0 0 auto;
        height: 2px;
        margin: 0 28px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 2px;
        overflow: hidden;
      }

      .ytmal-progress-fill {
        height: 100%;
        width: 0%;
        border-radius: 2px;
        background: linear-gradient(90deg, rgba(255, 255, 255, 0.45), #ffffff);
        transition: width 250ms linear;
      }

      /* ── Sync indicator ──────────────────────────── */

      .ytmal-sync-indicator {
        flex: 0 0 auto;
        padding: 6px 28px 0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.4);
        opacity: 0;
        transition: opacity 300ms ease;
      }

      .ytmal-sync-indicator.visible {
        opacity: 1;
      }

      /* Braccato's published Better Lyrics styles are prepended above. */
      :host {
        --blyrics-font-family: "YouTube Sans", "Roboto", "Noto Sans", sans-serif;
        --blyrics-font-size: clamp(22px, 1.9vw, 28px);
        --blyrics-font-weight: 700;
        --blyrics-line-height: 1.4;
        --blyrics-padding: 16px;
        --blyrics-lyric-active-color: #fff;
        --blyrics-lyric-inactive-color: rgba(255, 255, 255, 0.38);
        --blyrics-glow-color: rgba(255, 255, 255, 0.5);
        --blyrics-target-scroll-pos-ratio: 0.37;
      }

      .ytmal-lines {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 0 22px;
        scroll-padding: 16px 0 28px;
        overscroll-behavior: contain;
        outline: none;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
        mask-image: linear-gradient(to bottom, transparent, #000 16px, #000 calc(100% - 28px), transparent);
      }

      .ytmal-lines:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.5);
        outline-offset: -3px;
      }

      .ytmal-lines::-webkit-scrollbar { width: 6px; }
      .ytmal-lines::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.18);
        border-radius: 8px;
      }

      .blyrics--line {
        cursor: pointer;
      }
      .blyrics--word:not(.blyrics-word-highlight) {
        transition: color 160ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      @media (hover: hover) and (pointer: fine) {
        .blyrics--line:hover {
          --blyrics-lyric-inactive-color: rgba(255, 255, 255, 0.72);
        }
      }
      .blyrics--line:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.7);
        outline-offset: 2px;
        border-radius: 3px;
      }

      .ytmal-follow {
        position: absolute;
        right: 24px;
        bottom: 18px;
        padding: 9px 14px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 20px;
        background: #242424;
        color: #fff;
        font: 600 13px "Roboto", sans-serif;
        cursor: pointer;
        z-index: 2;
      }
      .ytmal-follow[hidden] { display: none; }
      .ytmal-follow:hover { background: #353535; }
      .ytmal-follow:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
      ::selection { color: #fff; background: rgba(255, 255, 255, 0.25); }

      /* ── Empty / status states ───────────────────── */

      .ytmal-empty,
      .ytmal-status {
        padding: 48px 28px;
        color: rgba(255, 255, 255, 0.55);
        font-size: 16px;
        line-height: 1.5;
      }

      .ytmal-status {
        color: rgba(255, 255, 255, 0.4);
        font-size: 14px;
      }

      @media (prefers-reduced-motion: reduce) {
        :host {
          --blyrics-animate-line-scale: 0;
          --blyrics-animate-word-wobble: 0;
          --blyrics-animate-instrumental: 0;
          --blyrics-animate-scroll: 0;
          --blyrics-scale: 1;
          --blyrics-active-scale: 1;
        }
        .ytmal-progress-fill, .blyrics--word:not(.blyrics-word-highlight) { transition: none; }
      }
    `;
  }
})();

(() => {
  const LYRICS_PAGE = "MUSIC_PAGE_TYPE_TRACK_LYRICS";
  const ROOT_ID = "ytmal-root";
  const USER_SCROLL_RESUME_MS = 6000;
  const SYNC_CHECK_INTERVAL = 20; // frames between song-change checks (~3x per second)

  const state = {
    videoId: null,
    requestId: 0,
    lines: [],
    activeIndex: -1,
    userScrolling: false,
    userScrollTimer: 0,
    raf: 0,
    frame: 0,
    mounted: false,
    enabled: true,
    progressPct: -1,
  };

  const cache = new Map();
  let videoEl = null;

  // Enable/disable toggle (popup -> chrome.storage -> content script).
  chrome.storage.local.get("enabled", (result) => {
    state.enabled = result.enabled !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("enabled" in changes)) return;
    const enabled = changes.enabled.newValue !== false;
    const wasEnabled = state.enabled;
    state.enabled = enabled;
    if (wasEnabled === enabled) return;
    if (!enabled) unmount();
  });

  waitForApp().then(start);

  function unmount() {
    document.getElementById(ROOT_ID)?.remove();
    state.mounted = false;
    state.activeIndex = -1;
    state.progressPct = -1;
    lyricsTab()?.classList.remove("ytmal-active");
    document.querySelector("ytmusic-player-page")?.classList.remove("ytmal-lyrics-open");
  }

  function start() {
    observePlayer();
    tick();
    document.addEventListener("yt-navigate-finish", syncSong, true);
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
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

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

  function lyricsTab() {
    return document.querySelector("#tab-renderer");
  }

  function isLyricsTabOpen() {
    return lyricsTab()?.getAttribute("page-type") === LYRICS_PAGE;
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
    if (state.mounted) return;
    tab.classList.add("ytmal-active");
    document.querySelector("ytmusic-player-page")?.classList.add("ytmal-lyrics-open");
    state.mounted = true;
    tab.appendChild(createRoot());
    paintCurrentLyrics();
  }

  function paintCurrentLyrics() {
    if (!document.getElementById(ROOT_ID)) return;
    if (state.lines.length) {
      renderLines();
      updateActiveLine(true);
      return;
    }
    if (state.videoId && cache.has(state.videoId)) {
      applyLyrics(cache.get(state.videoId), state.requestId);
    }
  }

  function createRoot() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "ytmal-root";
    root.innerHTML = `
      <div class="ytmal-progress" data-ytmal-progress>
        <div class="ytmal-progress-fill" data-ytmal-progress-fill></div>
      </div>
      <div class="ytmal-lines" data-ytmal-lines></div>
    `;
    const scroller = root.querySelector("[data-ytmal-lines]");
    scroller.addEventListener("wheel", markUserScrolling, { passive: true });
    scroller.addEventListener("touchmove", markUserScrolling, { passive: true });
    scroller.addEventListener("pointerdown", (event) => {
      const button = event.target.closest("[data-line-index]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      seekToLine(Number(button.dataset.lineIndex));
    });
    return root;
  }

  function markUserScrolling() {
    state.userScrolling = true;
    window.clearTimeout(state.userScrollTimer);
    state.userScrollTimer = window.setTimeout(() => {
      state.userScrolling = false;
      scrollActiveIntoView(true);
    }, USER_SCROLL_RESUME_MS);
  }

  function syncSong() {
    const meta = getNowPlaying();
    if (!meta.videoId || meta.videoId === state.videoId) return;
    state.videoId = meta.videoId;
    state.activeIndex = -1;
    state.progressPct = -1;
    state.lines = [];
    loadLyrics(meta);
  }

  async function loadLyrics(meta) {
    const requestId = ++state.requestId;

    const cached = cache.get(meta.videoId);
    if (cached) {
      applyLyrics(cached, requestId);
      return;
    }

    renderStatus("Loading synced lyrics…");
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "YTMAL_GET_LYRICS",
        payload: meta,
      });
    } catch (error) {
      result = { ok: false, error: error?.message || String(error), lines: [] };
    }

    if (requestId !== state.requestId) return;
    cache.set(meta.videoId, result);
    applyLyrics(result, requestId);
  }

  function applyLyrics(result, requestId) {
    if (requestId !== state.requestId) return;
    if (!result?.ok || !result.lines?.length) {
      state.lines = [];
      renderEmpty(
        result?.error ||
          "No timed lyrics were found for this song. YouTube Music only has unsynced text here."
      );
      return;
    }
    state.lines = result.lines;
    renderLines();
    updateActiveLine(true);
  }

  function renderStatus() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.querySelector("[data-ytmal-lines]").innerHTML = "";
  }

  function renderEmpty(message) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.querySelector("[data-ytmal-lines]").innerHTML =
      `<div class="ytmal-empty">${ytmalEscapeHtml(message)}</div>`;
  }

  function renderLines() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const scroller = root.querySelector("[data-ytmal-lines]");
    scroller.innerHTML = state.lines
      .map(
        (line, index) =>
          `<button type="button" class="ytmal-line" data-line-index="${index}">${ytmalEscapeHtml(
            line.text
          )}</button>`
      )
      .join("");
    scroller.scrollTop = 0;
  }

  function tick() {
    state.frame += 1;
    if (state.frame % SYNC_CHECK_INTERVAL === 0) {
      const playingId = getNowPlaying().videoId;
      if (playingId && playingId !== state.videoId) syncSong();
    }
    if (state.enabled && isLyricsTabOpen()) {
      if (!state.mounted) mountIfNeeded();
      if (state.mounted) updateActiveLine(false);
    }
    state.raf = requestAnimationFrame(tick);
  }

  function updateActiveLine(forceScroll) {
    if (!state.lines.length) return;
    const timeMs = getCurrentTimeMs();
    const index = findActiveIndex(timeMs);
    const lineChanged = index !== state.activeIndex;
    state.activeIndex = index;

    if (lineChanged) {
      const buttons = document.querySelectorAll("#ytmal-root [data-line-index]");
      buttons.forEach((button, i) => {
        button.classList.toggle("is-active", i === index);
        button.classList.toggle("is-passed", i < index);
        if (i === index) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      });
    }

    updateProgress(timeMs);

    if (!state.userScrolling || forceScroll) {
      scrollActiveIntoView(!forceScroll);
    }
  }

  function updateProgress(timeMs) {
    const fill = document.querySelector("#ytmal-root [data-ytmal-progress-fill]");
    if (!fill) return;
    const durationMs = (getVideo()?.duration || 0) * 1000;
    const ratio = durationMs > 0 ? Math.min(timeMs / durationMs, 1) : 0;
    const pct = Math.round(ratio * 200); // 0.5% steps
    if (pct === state.progressPct) return;
    state.progressPct = pct;
    fill.style.width = `${(pct / 2).toFixed(1)}%`;
  }

  function findActiveIndex(timeMs) {
    let active = 0;
    for (let i = 0; i < state.lines.length; i += 1) {
      if (state.lines[i].startMs <= timeMs) active = i;
      else break;
    }
    return active;
  }

  function scrollActiveIntoView(smooth) {
    const active = document.querySelector("#ytmal-root .ytmal-line.is-active");
    const scroller = document.querySelector("#ytmal-root [data-ytmal-lines]");
    if (!active || !scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const lineRect = active.getBoundingClientRect();
    const offset =
      lineRect.top -
      scrollerRect.top -
      scrollerRect.height / 2 +
      lineRect.height / 2;
    scroller.scrollTo({
      top: scroller.scrollTop + offset,
      behavior: smooth ? "smooth" : "instant",
    });
  }

  function seekToLine(index) {
    const line = state.lines[index];
    if (!line) return;
    const seconds = line.startMs / 1000;
    const player = document.querySelector("#movie_player");
    if (player && typeof player.seekTo === "function") {
      player.seekTo(seconds, true);
    } else {
      const video = getVideo();
      if (video) video.currentTime = seconds;
    }
    const video = getVideo();
    video?.play?.();
    state.userScrolling = false;
    state.activeIndex = -1;
    updateActiveLine(true);
  }

  function getVideo() {
    if (!videoEl || !videoEl.isConnected) {
      videoEl = document.querySelector("video");
    }
    return videoEl;
  }

  function getNowPlaying() {
    const player = document.querySelector("#movie_player");
    const data = player?.getVideoData?.() || {};
    const bar = document.querySelector("ytmusic-player-bar");
    const title =
      data.title ||
      bar?.querySelector(".title")?.textContent?.trim() ||
      document.querySelector("ytmusic-player-bar .title")?.textContent?.trim() ||
      "";
    const byline = bar?.querySelector(".byline")?.textContent?.trim() || "";
    const [artistPart, albumPart] = byline.split("•").map((part) => part.trim());
    const video = getVideo();
    return {
      videoId:
        data.video_id ||
        new URLSearchParams(location.search).get("v") ||
        "",
      title,
      artist: (data.author || artistPart || "").replace(/\s+/g, " ").trim(),
      album: (albumPart || "").replace(/\s+/g, " ").trim(),
      duration: Number.isFinite(video?.duration) ? video.duration : 0,
    };
  }

  function getCurrentTimeMs() {
    return (getVideo()?.currentTime || 0) * 1000;
  }
})();

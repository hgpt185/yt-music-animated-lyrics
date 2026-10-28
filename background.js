// ============================================================
// Animated Lyrics for YouTube Music — Service Worker (Background)
// Manages word providers + LRCLIB + YouTube InnerTube lookup with
// persistent caching, rate-limit handling, and timeouts.
// ============================================================

// Load shared utilities and YAML parser into service worker scope
importScripts("vendor/yaml.min.js", "vendor/parsers.min.js", "shared.js", "providers.js");

const INNERTUBE_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const YTMUSIC_ORIGIN = "https://music.youtube.com";
const EXT_VERSION = "2.1.6";
const LRCLIB_CLIENT = `Animated-Lyrics-for-YouTube-Music/${EXT_VERSION} (https://github.com/hgpt185/yt-music-animated-lyrics)`;

// ── Cache constants ─────────────────────────────────────────
const CACHE_KEY_PREFIX = "ytmal_cache_";
// Older entries were selected before the real word-provider pipeline existed.
const CACHE_LOOKUP_VERSION = 5;
const CACHE_TTL_FOUND_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days
const CACHE_TTL_LINE_MS = 15 * 60 * 1000; // Retry for richer sources soon.
const CACHE_TTL_NOT_FOUND_MS = 6 * 60 * 60 * 1000;       // 6 hours
const CACHE_MAX_ENTRIES = 500;

// ── Rate limit state ────────────────────────────────────────
let rateLimitedUntil = 0;   // epoch ms
let pendingRequest = null;  // serialization lock

// ── Message handler ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "YTMAL_GET_LYRICS") return;
  handleLyricsRequest(message.payload, message.refresh === true)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        source: null,
        syncMode: "none",
        lines: [],
        error: error?.message || String(error),
      });
    });
  return true;
});

// ── Main lookup orchestrator ────────────────────────────────

async function handleLyricsRequest(payload, refresh = false) {
  // Include video identity: incomplete or identical metadata must not share
  // a YouTube fallback (or a negative result) between different videos.
  const cacheKey = ytmalTrackKey(payload);

  // 1. Check persistent cache
  const cached = !refresh && await getCachedResult(cacheKey);
  if (cached) { await recordLookup(payload, cached, true); return cached; }

  // 2. Serialize requests — don't hammer the API
  while (pendingRequest) {
    await pendingRequest;
  }

  // Double-check cache after waiting
  const cachedAfterWait = !refresh && await getCachedResult(cacheKey);
  if (cachedAfterWait) { await recordLookup(payload, cachedAfterWait, true); return cachedAfterWait; }

  let resolve;
  pendingRequest = new Promise((r) => { resolve = r; });

  try {
    const result = await fetchLyrics(payload);
    await setCachedResult(cacheKey, result);
    await recordLookup(payload, result, false);
    return result;
  } finally {
    pendingRequest = null;
    resolve();
  }
}

async function recordLookup(payload, result, cached) {
  try {
    await chrome.storage.local.set({ytmal_last_lookup: {
      version: EXT_VERSION, checkedAt: new Date().toISOString(), track: payload,
      source: result?.source, syncMode: result?.syncMode, cached,
      wordCues: result?.lines?.reduce((sum, line) => sum + (line.words?.length || 0), 0),
      providerAttempts: result?.providerAttempts || [],
    }});
  } catch (error) { console.warn('[YTMAL] Diagnostics unavailable:', error?.message); }
}

async function fetchLyrics(payload) {
  const diagnostics = {};
  const withDiagnostics = result => ({...result, providerAttempts: diagnostics.providerAttempts || []});
  // Try real TTML/QRC/community word sources before any line fallback.
  const external = await fetchWordProviderLyrics(payload, diagnostics);
  if (external?.syncMode === "word") return withDiagnostics(external);

  const lrclibResult = await fetchLrclibLyrics(payload);
  if (lrclibResult?.ok) return withDiagnostics(lrclibResult);
  if (external?.ok) return withDiagnostics(external);

  // YouTube InnerTube as fallback — only line-level
  const ytResult = await fetchYouTubeTimedLyrics(payload.videoId);
  if (ytResult?.ok) return withDiagnostics(ytResult);

  return {
    ok: false,
    source: null,
    syncMode: "none",
    lines: [],
    error: "No synced lyrics found",
    providerAttempts: diagnostics.providerAttempts || [],
  };
}

// ── LRCLIB client ───────────────────────────────────────────

async function fetchLrclibLyrics({ title, artist, album, duration }) {
  if (!title || !artist) return null;

  // Exact signature lookup
  const params = new URLSearchParams({
    track_name: title,
    artist_name: ytmalFirstArtist(artist),
  });
  if (album) params.set("album_name", album);
  if (duration) params.set("duration", String(Math.round(duration)));

  const track = { title, artist, album, duration };
  const record = await lrclibJson(`/api/get?${params.toString()}`);
  const exactResult = ytmalIsMatchingTrack(record, track)
    ? parseLrclibRecord(record, track) : null;
  if (exactResult?.syncMode === "word") return exactResult;

  // Keep an exact line match as a fallback, but search for real word timestamps
  // before accepting it. A line-only exact response must not end the lookup.
  let lineFallback = exactResult;
  const searchParams = new URLSearchParams({
    track_name: title,
    artist_name: ytmalFirstArtist(artist),
  });
  const searchResults = await lrclibJson(
    `/api/search?${searchParams.toString()}`
  );

  for (const candidate of ytmalRankMatches(searchResults, duration, true)) {
    if (!ytmalIsMatchingTrack(candidate, track)) continue;
    const result = parseLrclibRecord(candidate, track);
    if (result?.syncMode === "word") return result;
    // Invalid or mislabeled word-sync data must not hide another valid match.
    if (!lineFallback && result) lineFallback = result;
  }

  return lineFallback;
}

function parseLrclibRecord(record, track) {
  // Trust validated word cues rather than the provider's hasWordSync flag alone.
  if (record?.lyricsfile) {
    const parsed = ytmalParseLyricsfile(record.lyricsfile);
    const metadata = parsed?.metadata || {};
    const fileMatches = !track || ytmalIsMatchingTrack({
      trackName: metadata.title || record.trackName || record.title || record.name,
      artistName: metadata.artist || record.artistName || record.artist,
      duration: metadata.duration_ms != null ? Number(metadata.duration_ms) / 1000 : record.duration,
    }, track);
    if (parsed?.lines.length && fileMatches) {
      return {
        ok: true,
        source: "lrclib",
        syncMode: parsed.hasWordSync ? "word" : "line",
        lines: parsed.lines,
      };
    }
  }

  if (record?.syncedLyrics) {
    const lines = ytmalParseLrc(record.syncedLyrics);
    if (lines.length) {
      return { ok: true, source: "lrclib", syncMode: "line", lines };
    }
  }
  return null;
}

async function lrclibJson(path) {
  // Respect rate limit
  if (Date.now() < rateLimitedUntil) {
    const waitSec = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    console.warn(`[YTMAL] LRCLIB rate limited, ${waitSec}s remaining`);
    return null;
  }

  // Add a short inter-request delay
  await new Promise((r) => setTimeout(r, 200));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(`https://lrclib.net${path}`, {
      headers: {
        "Lrclib-Client": LRCLIB_CLIENT,
      },
      signal: controller.signal,
      credentials: "omit",
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : 60 * 1000; // default 60s
      rateLimitedUntil = Date.now() + waitMs;
      console.warn(`[YTMAL] LRCLIB 429 — waiting ${waitMs / 1000}s`);
      return null;
    }

    if (response.status === 404) return null;
    if (!response.ok) return null;

    return response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      console.warn("[YTMAL] LRCLIB request timed out");
    } else {
      console.warn("[YTMAL] LRCLIB fetch error:", error?.message);
    }
    return null;
  }
}

// ── YouTube InnerTube (fallback) ────────────────────────────

async function fetchYouTubeTimedLyrics(videoId) {
  if (!videoId) return null;

  try {
    const browseId = await getLyricsBrowseId(videoId);
    if (!browseId) return null;

    const browse = await innertube("browse", {
      browseId,
      context: {
        client: {
          clientName: "ANDROID_MUSIC",
          clientVersion: "7.27.52",
          hl: "en",
        },
      },
    });

    const timed =
      browse?.contents?.elementRenderer?.newElement?.type?.componentType?.model
        ?.timedLyricsModel?.lyricsData?.timedLyricsData;

    const lines = parseTimedLyricsData(timed);
    if (!lines.length) return null;
    return { ok: true, source: "youtube", syncMode: "line", lines };
  } catch (error) {
    console.warn("[YTMAL] YouTube lyrics fetch failed:", error?.message);
    return null;
  }
}

async function getLyricsBrowseId(videoId) {
  const data = await innertube("next", {
    videoId,
    isAudioOnly: true,
    context: {
      client: {
        clientName: "WEB_REMIX",
        clientVersion: "1.20240101.01.00",
        hl: "en",
      },
    },
  });

  const tabs =
    data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
      ?.watchNextTabbedResultsRenderer?.tabs || [];

  for (const tab of tabs) {
    const endpoint = tab?.tabRenderer?.endpoint?.browseEndpoint;
    const pageType =
      endpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
    if (pageType === "MUSIC_PAGE_TYPE_TRACK_LYRICS") {
      return endpoint.browseId || null;
    }
  }
  return null;
}

function parseTimedLyricsData(entries) {
  if (!Array.isArray(entries)) return [];
  const lines = [];
  for (const entry of entries) {
    const text = String(entry?.lyricLine || "").trim();
    const start = Number(entry?.cueRange?.startTimeMilliseconds);
    if (!text || !Number.isFinite(start)) continue;
    const endRaw = Number(entry?.cueRange?.endTimeMilliseconds);
    lines.push({
      text,
      startMs: start,
      endMs: Number.isFinite(endRaw) ? endRaw : null,
    });
  }
  return ytmalFinalizeLineEnds(lines);
}

async function innertube(endpoint, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      `${YTMUSIC_ORIGIN}/youtubei/v1/${endpoint}?alt=json&key=${INNERTUBE_KEY}`,
      {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Origin: YTMUSIC_ORIGIN,
          "X-Goog-Visitor-Id": "",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`YouTube ${endpoint} failed (${response.status})`);
    }
    return response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ── Persistent cache (chrome.storage.local) ─────────────────

async function getCachedResult(cacheKey) {
  const storageKey = CACHE_KEY_PREFIX + cacheKey;
  try {
    const data = await chrome.storage.local.get(storageKey);
    const entry = data[storageKey];
    if (!entry || typeof entry !== "object") return null;
    if (entry.lookupVersion !== CACHE_LOOKUP_VERSION) return null;

    const age = Date.now() - (entry.timestamp || 0);
    const ttl = entry.found ? (entry.result?.syncMode === "word" ? CACHE_TTL_FOUND_MS : CACHE_TTL_LINE_MS) : CACHE_TTL_NOT_FOUND_MS;

    if (age > ttl) {
      // Expired — clean up asynchronously
      chrome.storage.local.remove(storageKey);
      return null;
    }

    return entry.result;
  } catch (e) {
    console.warn("[YTMAL] Cache read error:", e?.message);
    return null;
  }
}

async function setCachedResult(cacheKey, result) {
  if (result?.cacheAllowed === false) return;
  const storageKey = CACHE_KEY_PREFIX + cacheKey;
  try {
    // Evict old entries if cache is too large
    await evictCacheIfNeeded();

    await chrome.storage.local.set({
      [storageKey]: {
        lookupVersion: CACHE_LOOKUP_VERSION,
        timestamp: Date.now(),
        found: result?.ok === true,
        result,
      },
    });
  } catch (e) {
    console.warn("[YTMAL] Cache write error:", e?.message);
  }
}

async function evictCacheIfNeeded() {
  try {
    const all = await chrome.storage.local.get(null);
    const cacheEntries = [];

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(CACHE_KEY_PREFIX)) continue;
      cacheEntries.push({
        key,
        timestamp: value?.timestamp || 0,
        found: value?.found || false,
        syncMode: value?.result?.syncMode,
      });
    }

    if (cacheEntries.length < CACHE_MAX_ENTRIES) return;

    // Remove expired first
    const now = Date.now();
    const expired = cacheEntries.filter((e) => {
      const ttl = e.found ? (e.syncMode === "word" ? CACHE_TTL_FOUND_MS : CACHE_TTL_LINE_MS) : CACHE_TTL_NOT_FOUND_MS;
      return now - e.timestamp > ttl;
    });

    if (expired.length > 0) {
      await chrome.storage.local.remove(expired.map((e) => e.key));
      return;
    }

    // If still over limit, remove oldest 20%
    cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = cacheEntries
      .slice(0, Math.ceil(cacheEntries.length * 0.2))
      .map((e) => e.key);
    await chrome.storage.local.remove(toRemove);
  } catch (e) {
    console.warn("[YTMAL] Cache eviction error:", e?.message);
  }
}

const INNERTUBE_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const YTMUSIC_ORIGIN = "https://music.youtube.com";

const lyricsCache = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "YTMAL_GET_LYRICS") return;
  fetchLyrics(message.payload)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        source: null,
        lines: [],
        error: error?.message || String(error),
      });
    });
  return true;
});

async function fetchLyrics(payload) {
  const cacheKey = [
    payload.videoId,
    payload.title,
    payload.artist,
    payload.duration,
  ].join("|");
  if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);

  const result =
    (await fetchYouTubeTimedLyrics(payload.videoId)) ||
    (await fetchLrclibLyrics(payload));

  const wrapped = result || {
    ok: false,
    source: null,
    lines: [],
    error: "No synced lyrics found",
  };
  lyricsCache.set(cacheKey, wrapped);
  return wrapped;
}

async function fetchYouTubeTimedLyrics(videoId) {
  if (!videoId) return null;
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
  return { ok: true, source: "youtube", lines };
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
  return finalizeLineEnds(lines);
}

async function fetchLrclibLyrics({ title, artist, album, duration }) {
  if (!title || !artist) return null;

  const params = new URLSearchParams({
    track_name: title,
    artist_name: firstArtist(artist),
  });
  if (album) params.set("album_name", album);
  if (duration) params.set("duration", String(Math.round(duration)));

  let record = await lrclibJson(`/api/get?${params.toString()}`);
  if (!record?.syncedLyrics) {
    const search = await lrclibJson(
      `/api/search?${new URLSearchParams({
        track_name: title,
        artist_name: firstArtist(artist),
      }).toString()}`
    );
    record = pickBestLrclibMatch(search, duration);
  }

  const lines = parseLrc(record?.syncedLyrics || "");
  if (!lines.length) return null;
  return { ok: true, source: "lrclib", lines };
}

function pickBestLrclibMatch(results, duration) {
  if (!Array.isArray(results) || !results.length) return null;
  const withSync = results.filter((item) => item?.syncedLyrics);
  if (!withSync.length) return null;
  if (!duration) return withSync[0];
  return withSync
    .slice()
    .sort(
      (a, b) =>
        Math.abs((a.duration || 0) - duration) -
        Math.abs((b.duration || 0) - duration)
    )[0];
}

function parseLrc(lrc) {
  if (!lrc) return [];
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] || "0";
      const ms =
        minutes * 60000 +
        seconds * 1000 +
        Number(fraction.padEnd(3, "0").slice(0, 3));
      lines.push({ text, startMs: ms, endMs: null });
    }
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  return finalizeLineEnds(lines);
}

function finalizeLineEnds(lines) {
  const cleaned = lines
    .filter((line) => line.text && line.text !== "♪")
    .sort((a, b) => a.startMs - b.startMs)
    .filter(
      (line, i, arr) =>
        !(i > 0 && line.text === arr[i - 1].text && line.startMs === arr[i - 1].startMs)
    );
  for (let i = 0; i < cleaned.length; i += 1) {
    const next = cleaned[i + 1];
    if (next) cleaned[i].endMs = next.startMs;
    else if (cleaned[i].endMs == null) cleaned[i].endMs = cleaned[i].startMs + 8000;
  }
  return cleaned;
}

function firstArtist(artist) {
  return String(artist)
    .split(/\s*(?:,|&| and | x |\u2022)\s*/i)[0]
    .trim();
}

async function innertube(endpoint, body) {
  const response = await fetch(
    `${YTMUSIC_ORIGIN}/youtubei/v1/${endpoint}?alt=json&key=${INNERTUBE_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: YTMUSIC_ORIGIN,
        "X-Goog-Visitor-Id": "",
      },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(`YouTube ${endpoint} failed (${response.status})`);
  }
  return response.json();
}

async function lrclibJson(path) {
  const response = await fetch(`https://lrclib.net${path}`, {
    headers: {
      "User-Agent": "Animated-Lyrics-for-YouTube-Music/1.0.0",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  return response.json();
}

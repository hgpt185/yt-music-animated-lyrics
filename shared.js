// ============================================================
// Shared pure helpers for Animated Lyrics for YouTube Music.
// Loaded before content.js as a classic script so these become
// global functions.  YAML global is available from vendor/yaml.min.js.
// ============================================================

// ── Text safety ─────────────────────────────────────────────

function ytmalEscapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── Metadata normalization ──────────────────────────────────

/**
 * Normalize a metadata string for comparison.
 * Lowercases, collapses whitespace, strips diacritics.
 */
function ytmalNormalize(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a cache key from track metadata.
 * Used for both in-memory and chrome.storage caching.
 */
function ytmalCacheKey(title, artist, album, duration) {
  const t = ytmalNormalize(title);
  const a = ytmalNormalize(artist);
  const al = ytmalNormalize(album || "");
  const d = Number.isFinite(duration) ? Math.round(duration) : 0;
  return `${t}|${a}|${al}|${d}`;
}

/** A lyric cache belongs to one video and one complete metadata snapshot. */
function ytmalTrackKey({ videoId, title, artist, album, duration }) {
  return JSON.stringify([
    String(videoId || ""),
    ytmalNormalize(title),
    ytmalNormalize(artist),
    ytmalNormalize(album),
    Number.isFinite(duration) ? Math.round(duration) : 0,
  ]);
}

/** Ignore video presentation labels, while retaining live/remix/version names. */
function ytmalMatchText(value) {
  const normalized = ytmalNormalize(value)
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (match, round, square) => {
      const label = (round || square).trim();
      return /^(?:official(?: music)? (?:video|audio|lyrics?(?: video)?)|lyrics?(?: video)?|music video|visuali[sz]er|hd|4k)$/u.test(label) ? " " : match;
    })
    .replace(/\s+-\s+(?:official(?: music)? (?:video|audio)|lyrics?(?: video)?|visuali[sz]er)$/u, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Symbol-only song/artist names must not all collapse to the same identity.
  return normalized || ytmalNormalize(value);
}

/** Reject unrelated songs/versions before applying word-sync preference. */
function ytmalIsMatchingTrack(record, track) {
  if (!record || !track?.title || !track?.artist) return false;
  const title = record.trackName || record.title || record.name;
  const artist = record.artistName || record.artist;
  if (!title || !artist || ytmalMatchText(title) !== ytmalMatchText(track.title)) return false;

  const artistName = (value) => String(value).replace(/\s+-\s+Topic$/i, "");
  const primaryArtist = (value) => ytmalMatchText(
    artistName(value).split(/,\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0]
  );
  // Do not split band names on '&', 'and', or 'x' when checking identity.
  if (primaryArtist(artist) !== primaryArtist(track.artist)) return false;

  const recordDuration = Number(record.duration);
  if (Number.isFinite(track.duration) && track.duration > 0 &&
      Number.isFinite(recordDuration) && recordDuration > 0) {
    const tolerance = Math.max(5, Math.min(10, track.duration * 0.025));
    if (Math.abs(recordDuration - track.duration) > tolerance) return false;
  }
  return true;
}

/**
 * Extract the first / primary artist from a multi-artist string.
 */
function ytmalFirstArtist(artist) {
  return String(artist)
    .split(/\s*(?:,|&| and | x |\u2022)\s*/i)[0]
    .trim();
}

// ── LRC Parser ──────────────────────────────────────────────

/**
 * Parse standard LRC format into line objects.
 * Returns [{text, startMs, endMs}] sorted by startMs.
 */
function ytmalParseLrc(lrc) {
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
  return ytmalFinalizeLineEnds(lines);
}

/**
 * Deduplicate, sort, and fill in missing endMs values.
 */
function ytmalFinalizeLineEnds(lines) {
  const cleaned = lines
    .filter((line) => line.text && line.text !== "♪")
    .sort((a, b) => a.startMs - b.startMs)
    .filter(
      (line, i, arr) =>
        !(
          i > 0 &&
          line.text === arr[i - 1].text &&
          line.startMs === arr[i - 1].startMs
        )
    );
  for (let i = 0; i < cleaned.length; i += 1) {
    const next = cleaned[i + 1];
    if (next) cleaned[i].endMs = next.startMs;
    else if (cleaned[i].endMs == null)
      cleaned[i].endMs = cleaned[i].startMs + 8000;
  }
  return cleaned;
}

// ── Lyricsfile (YAML) parser ────────────────────────────────

/**
 * Parse and validate a Lyricsfile YAML string.
 * Returns { version, metadata, lines } where lines have optional words arrays.
 *
 * Shape:
 * {
 *   version: '1.0',
 *   metadata: { title, artist, duration_ms },
 *   lines: [
 *     {
 *       text: 'Hello world',
 *       startMs: 12000,
 *       endMs: 15500,
 *       words: [
 *         { text: 'Hello ', startMs: 12000, endMs: 12800 },
 *         { text: 'world',  startMs: 12800, endMs: 15500 }
 *       ]
 *     }
 *   ]
 * }
 *
 * Returns null if parsing fails or the version is unsupported.
 */
function ytmalParseLyricsfile(yamlString) {
  if (!yamlString || typeof yamlString !== "string") return null;

  let doc;
  try {
    // YAML global from vendor/yaml.min.js
    doc = YAML.parse(yamlString);
  } catch (e) {
    console.warn("[YTMAL] Lyricsfile YAML parse error:", e?.message);
    return null;
  }

  if (!doc || typeof doc !== "object") return null;

  // Version check — only support 1.0
  const version = String(doc.version || "").trim();
  if (version !== "1.0") {
    console.warn("[YTMAL] Unsupported Lyricsfile version:", version);
    return null;
  }

  if (!Array.isArray(doc.lines) || doc.lines.length === 0) return null;

  const lines = [];
  let hasAnyWordSync = false;

  for (const rawLine of doc.lines) {
    if (!rawLine || typeof rawLine !== "object") continue;

    const text = String(rawLine.text || "").trim();
    if (!text) continue;

    const startMs = Number(rawLine.start_ms);
    if (!Number.isFinite(startMs) || startMs < 0) continue;

    const rawEnd = Number(rawLine.end_ms);
    const endMs = Number.isFinite(rawEnd) && rawEnd >= startMs ? rawEnd : null;

    const line = { text, startMs, endMs, words: null };

    // Parse words if present
    if (Array.isArray(rawLine.words) && rawLine.words.length > 0) {
      const words = [];
      for (const rawWord of rawLine.words) {
        if (!rawWord || typeof rawWord !== "object") continue;
        const wText = String(rawWord.text || "");
        if (!wText) continue;

        const wStart = Number(rawWord.start_ms);
        if (!Number.isFinite(wStart) || wStart < 0) continue;

        const wEndRaw = Number(rawWord.end_ms);
        const wEnd =
          Number.isFinite(wEndRaw) && wEndRaw >= wStart ? wEndRaw : null;

        words.push({ text: wText, startMs: wStart, endMs: wEnd });
      }

      if (words.length > 0) {
        // Fill in missing word endMs from next word / parent line
        for (let i = 0; i < words.length; i++) {
          if (words[i].endMs == null) {
            if (i + 1 < words.length) {
              words[i].endMs = words[i + 1].startMs;
            } else if (endMs != null) {
              words[i].endMs = endMs;
            }
            // else leave null — rendering will handle it
          }
        }
        line.words = words;
        hasAnyWordSync = true;
      }
    }

    lines.push(line);
  }

  if (lines.length === 0) return null;

  // Fill in missing line endMs from next line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endMs == null && i + 1 < lines.length) {
      lines[i].endMs = lines[i + 1].startMs;
    }
    // Last line: if no endMs, leave it null for renderer to decide
  }

  return {
    version,
    metadata: doc.metadata || {},
    lines,
    hasWordSync: hasAnyWordSync,
  };
}

// ── Binary search for active line/word ──────────────────────

/**
 * Find the index of the active line at the given time (ms).
 * Returns the index of the last line whose startMs <= timeMs.
 * Returns -1 if timeMs is before all lines.
 */
function ytmalFindActiveLine(lines, timeMs) {
  if (!lines.length) return -1;
  if (timeMs < lines[0].startMs) return -1;

  let lo = 0;
  let hi = lines.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startMs <= timeMs) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const idx = hi;

  // Check if we've passed beyond the line's effective end
  const line = lines[idx];
  if (line.endMs != null && timeMs >= line.endMs) {
    // We're in a gap — check if next line hasn't started yet
    if (idx + 1 < lines.length && timeMs < lines[idx + 1].startMs) {
      return idx; // Still show the last line during gaps
    }
  }

  return idx;
}

/**
 * Find the index of the active word within a line at the given time (ms).
 * Returns -1 if no word is active.
 */
function ytmalFindActiveWord(words, timeMs) {
  if (!words || !words.length) return -1;
  if (timeMs < words[0].startMs) return -1;

  let lo = 0;
  let hi = words.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid].startMs <= timeMs) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const idx = hi;
  const word = words[idx];

  // Only active if we haven't passed the word's end
  if (word.endMs != null && timeMs >= word.endMs) {
    return -1; // In a gap between words
  }

  return idx;
}

/**
 * Compute the fill progress for the active word (0 to 1).
 * Returns -1 if progress can't be computed.
 */
function ytmalWordProgress(word, timeMs) {
  if (!word || word.endMs == null || word.startMs == null) return -1;
  const duration = word.endMs - word.startMs;
  if (duration <= 0) return 1;
  const progress = (timeMs - word.startMs) / duration;
  return Math.max(0, Math.min(1, progress));
}

// ── LRCLIB candidate matching ───────────────────────────────

/**
 * Rank LRCLIB search results, using word-sync metadata as a priority hint.
 * The lookup validates Lyricsfile contents before selecting a sync mode.
 * A Lyricsfile is eligible even when no separate syncedLyrics LRC exists.
 */
function ytmalRankMatches(results, duration, preferWordSync = true) {
  if (!Array.isArray(results)) return [];

  return results
    .filter((item) => item && (item.syncedLyrics || item.lyricsfile))
    .sort((a, b) => {
      if (preferWordSync) {
        const aWord = Boolean(a.hasWordSync && a.lyricsfile);
        const bWord = Boolean(b.hasWordSync && b.lyricsfile);
        if (aWord !== bWord) return aWord ? -1 : 1;
      }
      if (!duration) return 0;
      return Math.abs((a.duration || 0) - duration) -
        Math.abs((b.duration || 0) - duration);
    });
}

/** Pick the highest-ranked candidate, preferring word sync by default. */
function ytmalPickBestMatch(results, duration, preferWordSync = true) {
  return ytmalRankMatches(results, duration, preferWordSync)[0] || null;
}

// ── Braccato renderer adapter ───────────────────────────────

/** Preserve genuine cues; line-only sources never acquire made-up word times. */
function ytmalRendererLyrics(lines, syncMode) {
  return lines.map((line, index) => {
    if (syncMode === "word" && line.rendererLyric) return line.rendererLyric;
    const finalWordEnd = line.words?.at(-1)?.endMs;
    const endMs = line.endMs ?? lines[index + 1]?.startMs ?? finalWordEnd ?? line.startMs;
    const lyric = {
      words: line.text,
      startTimeMs: line.startMs,
      durationMs: Math.max(0, endMs - line.startMs),
    };
    if (syncMode !== "word" || !line.words?.length) return lyric;

    // Some files omit separator spaces from their word tokens. Recover the
    // exact separators from the line text without changing any word's timing.
    let cursor = 0;
    const positions = line.words.map(word => {
      const text = word.text.trim();
      const start = text ? line.text.indexOf(text, cursor) : -1;
      if (start >= 0) cursor = start + text.length;
      return start;
    });
    const aligned = positions.every((start, i) => start >= 0 && (i === 0 || start > positions[i - 1]));
    lyric.parts = line.words.map((word, i) => ({
      words: aligned
        ? line.text.slice(i === 0 ? 0 : positions[i], positions[i + 1] ?? line.text.length)
        : word.text,
      startTimeMs: word.startMs,
      // A missing end is a zero-duration cue, not an estimated sung duration.
      durationMs: word.endMs == null ? 0 : Math.max(0, word.endMs - word.startMs),
    }));
    return lyric;
  });
}

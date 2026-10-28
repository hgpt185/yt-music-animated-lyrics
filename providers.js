// Public word-timed sources used by Better Lyrics. No borrowed keys or tokens.
// The parser is bundled locally, so this also runs inside an MV3 service worker.
const YTMAL_PROVIDER_TIMEOUT_MS = 6000;
const YTMAL_PROVIDER_MAX_BYTES = 2 * 1024 * 1024;
const ytmalProviderCooldowns = new Map();
const ytmalProviderTraces = new WeakMap();

async function ytmalProviderRequest(url, signal, asText = false) {
  const parsedURL = new URL(url);
  const origin = parsedURL.origin;
  const trace = ytmalProviderTraces.get(signal);
  const attempt = { endpoint: origin + parsedURL.pathname, outcome: 'pending' };
  trace?.push(attempt);
  const started = Date.now();
  if (signal?.aborted || Date.now() < (ytmalProviderCooldowns.get(origin) || 0)) {
    attempt.outcome = signal?.aborted ? 'cancelled' : 'rate-limit cooldown';
    return null;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, YTMAL_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    attempt.status = response.status;
    if (response.status === 429) {
      const value = response.headers.get('Retry-After');
      const seconds = Number(value);
      const until = value && !Number.isFinite(seconds) ? Date.parse(value) : Date.now() + (value ? seconds : 60) * 1000;
      attempt.outcome = 'rate limited';
      ytmalProviderCooldowns.set(origin, Math.max(Date.now() + 1000, until || Date.now() + 60000));
      return null;
    }
    // Public Better Lyrics cache misses may require a key. Fall through normally.
    if (!response.ok) { attempt.outcome = `HTTP ${response.status}`; return null; }
    const length = Number(response.headers.get('Content-Length'));
    if (length > YTMAL_PROVIDER_MAX_BYTES) { attempt.outcome = 'response too large'; return null; }
    const text = await response.text();
    if (text.length > YTMAL_PROVIDER_MAX_BYTES) { attempt.outcome = 'response too large'; return null; }
    attempt.outcome = 'received';
    return asText ? text : JSON.parse(text);
  } catch (error) {
    attempt.outcome = controller.signal.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') : 'network or invalid response';
    if (!controller.signal.aborted) console.debug?.('[YTMAL] Provider unavailable:', origin, error?.message);
    return null;
  } finally {
    attempt.elapsedMs = Date.now() - started;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function ytmalProviderMatches(record, track) {
  const candidate = {
    trackName: record.trackName || record.track_name || record.song || record.title,
    artistName: record.artistName || record.artist_name || record.artist,
    duration: record.duration,
  };
  if (ytmalIsMatchingTrack(candidate, track)) return true;
  // Catalogs delimit collaborations with commas; YouTube often uses '&'.
  // Require the complete same artist list before normalizing the delimiter.
  const members = value => String(value || '').split(/\s*(?:,|&|\band\b)\s*/i).map(ytmalMatchText);
  const theirs = members(candidate.artistName), ours = members(track.artist);
  const artistsAgree = theirs.length > 1 && theirs.length === ours.length && theirs.every((name, i) => name === ours[i]);
  if (artistsAgree) candidate.artistName = track.artist;
  // A soundtrack subtitle can be supplied by the album instead of the title.
  // Never discard recording/version qualifiers such as live, remix or acoustic.
  const stripAlbumSubtitle = (title, album) => String(title || '').replace(/\(([^)]*)\)/g, (whole, subtitle) => {
    if (/\b(live|remix|mix|mixed|acoustic|demo|draft|edit|version|cover|instrumental|remaster|slowed|sped)\b/i.test(subtitle)) return whole;
    const normalized = ytmalMatchText(subtitle);
    return normalized && ytmalMatchText(album).includes(normalized) ? '' : whole;
  });
  candidate.trackName = stripAlbumSubtitle(candidate.trackName, track.album);
  const normalizedTrack = { ...track, title: stripAlbumSubtitle(track.title, record.albumName || record.album_name || record.album) };
  return ytmalIsMatchingTrack(candidate, normalizedTrack);
}

function ytmalParseProviderText(text, format, track, source) {
  if (typeof text !== 'string' || !text.trim() || text.length > YTMAL_PROVIDER_MAX_BYTES) return null;
  // External entities/DTDs are unnecessary in lyrics and must not be expanded.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) return null;
  try {
    const durationMs = Number.isFinite(track.duration) && track.duration > 0 ? track.duration * 1000 : undefined;
    let lyrics;
    if (format === 'ttml') lyrics = YtmalParsers.parseTTMLContent(text, { songDurationMs: durationMs }).lyrics;
    else if (format === 'lrc') lyrics = YtmalParsers.parseLRC(text, durationMs || 0);
    else if (format === 'qrc') {
      // Validate supplied QRC title/artist tags before dropping credit lines.
      const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const title = text.match(/\[ti:([^\]]+)\]/i)?.[1];
      const artist = text.match(/\[ar:([^\]]+)\]/i)?.[1];
      if ((title || artist) && !ytmalProviderMatches({ title: decode(title || track.title), artist: decode(artist || track.artist), duration: track.duration }, track)) return null;
      lyrics = YtmalParsers.parseQRC(text, durationMs || 0, { title: track.title, artist: track.artist });
    } else return null;
    const lines = [];
    for (const lyric of lyrics || []) {
      if (lyric.isInstrumental || !lyric.words?.trim()) continue;
      if (!Number.isFinite(lyric.startTimeMs) || lyric.startTimeMs < 0 || !Number.isFinite(lyric.durationMs) || lyric.durationMs < 0) return null;
      const endMs = lyric.startTimeMs + lyric.durationMs;
      if (durationMs && endMs > durationMs + 15000) return null;
      const parts = (lyric.parts || []).filter(part => !part.isBackground && part.words?.trim());
      if (parts.some(part => !Number.isFinite(part.startTimeMs) || part.startTimeMs < 0 || !Number.isFinite(part.durationMs) || part.durationMs < 0)) return null;
      lines.push({
        text: lyric.words.trim(), startMs: lyric.startTimeMs, endMs,
        words: parts.length ? parts.map(part => ({ text: part.words, startMs: part.startTimeMs, endMs: part.startTimeMs + part.durationMs })) : null,
        // Preserve the original rich structure, including syllables/agents/backgrounds.
        rendererLyric: lyric,
      });
    }
    if (!lines.length) return null;
    lines.sort((a,b) => a.startMs - b.startMs);
    const hasWords = lines.some(line => line.words?.some(word => word.endMs > word.startMs));
    return { ok: true, source, syncMode: hasWords ? 'word' : 'line', lines };
  } catch (error) {
    console.debug?.('[YTMAL] Invalid provider lyrics:', source, error?.message);
    return null;
  }
}

async function ytmalFetchBetterLyrics(track, signal, qqOnly = false) {
  if (!track.title || !track.artist) return null;
  const params = new URLSearchParams({ s: track.title, a: track.artist, al: track.album || '', d: String(Math.round(track.duration || 0)) });
  let lineFallback = null;
  for (const [path, format, source] of [qqOnly ? ['qq/getLyrics','qrc','qq'] : ['getLyrics','ttml','betterlyrics']]) {
    if (signal.aborted) return null;
    const data = await ytmalProviderRequest(`https://api.betterlyrics.org/${path}?${params}`, signal);
    if (Number.isFinite(data?.score) && data.score < .85) continue;
    const result = ytmalParseProviderText(data?.ttml || data?.lyrics, format, track, source);
    if (result?.syncMode === 'word') return result;
    lineFallback ||= result;
  }
  return lineFallback;
}

async function ytmalFetchBinimum(track, signal) {
  if (!track.title || !track.artist) return null;
  const params = new URLSearchParams({ q: `${track.title} ${track.artist}` });
  const data = await ytmalProviderRequest(`https://lyrics-api.binimum.org/?${params}`, signal);
  if (!Array.isArray(data?.results)) return null;
  const candidates = data.results.filter(record => ytmalProviderMatches(record, track)).sort((a,b) => {
    const wordRank = Number(b.timing_type === 'word' || b.timing_type === 'syllable') - Number(a.timing_type === 'word' || a.timing_type === 'syllable');
    return wordRank || Math.abs(Number(a.duration) - track.duration) - Math.abs(Number(b.duration) - track.duration);
  });
  let lineFallback = null;
  for (const candidate of candidates.slice(0, 3)) {
    if (signal.aborted) return null;
    const isrc = candidate.isrc || candidate.id;
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc || '')) continue;
    // Build a fixed allowed URL; never follow an arbitrary URL from provider data.
    const text = await ytmalProviderRequest(`https://lrc.red/s/${isrc}.ttml`, signal, true);
    const result = ytmalParseProviderText(text, 'ttml', track, 'binimum');
    if (result?.syncMode === 'word') return result;
    lineFallback ||= result;
  }
  return lineFallback;
}

// Direct access to the same ISRC catalog backing BiniLyrics. This stays
// independent so an outage in the catalog gateway cannot remove its word data.
async function ytmalFetchLrcRed(track, signal) {
  if (!track.title || !track.artist) return null;
  const params = new URLSearchParams({ track: track.title, artist: track.artist });
  if (track.album) params.set('album', track.album);
  if (track.duration) params.set('duration', String(Math.round(track.duration)));
  const data = await ytmalProviderRequest(`https://lrc.red/match.json?${params}`, signal);
  if (!Array.isArray(data?.hits)) return null;
  let lineFallback = null;
  for (const candidate of data.hits.filter(record => ytmalProviderMatches(record, track)).slice(0, 3)) {
    if (signal.aborted) return null;
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(candidate.isrc || '')) continue;
    const song = await ytmalProviderRequest(`https://lrc.red/s/${candidate.isrc}.song.json`, signal);
    if (!song || !ytmalProviderMatches(song, track)) continue;
    const result = ytmalParseProviderText(song.source, 'ttml', track, 'lrc-red');
    if (result?.syncMode === 'word') return result;
    lineFallback ||= result;
  }
  return lineFallback;
}

async function ytmalFetchUnison(track, signal) {
  if (!track.videoId && (!track.title || !track.artist)) return null;
  const params = new URLSearchParams();
  if (track.videoId) params.set('v', track.videoId);
  if (track.title) params.set('song', track.title);
  if (track.artist) params.set('artist', track.artist);
  if (track.duration) params.set('duration', String(Math.round(track.duration)));
  let data = await ytmalProviderRequest(`https://unison.boidu.dev/lyrics?${params}`, signal);
  let candidates = data?.success && data.data ? [data.data] : [];
  // Trust actual parsed cues, not a contributor's syncType label.
  const direct = candidates[0];
  const directResult = direct && ytmalProviderMatches(direct, track)
    ? ytmalParseProviderText(direct.lyrics, direct.format, track, 'unison') : null;
  if (directResult?.syncMode === 'word') { directResult.cacheAllowed = false; return directResult; }
  // Search by complete metadata when the video entry has no usable word cues.
  {
    if (track.title && track.artist && !signal.aborted) {
      const query = new URLSearchParams({ song: track.title, artist: track.artist, limit: '5' });
      data = await ytmalProviderRequest(`https://unison.boidu.dev/lyrics/search?${query}`, signal);
      if (data?.success && Array.isArray(data.data)) candidates.push(...data.data);
    }
  }
  candidates.sort((a,b) => Number(b.syncType === 'richsync') - Number(a.syncType === 'richsync'));
  let lineFallback = null;
  for (const candidate of candidates) {
    if (!ytmalProviderMatches(candidate, track)) continue;
    const result = ytmalParseProviderText(candidate.lyrics, candidate.format, track, 'unison');
    if (!result) continue;
    result.cacheAllowed = false; // Match Better Lyrics' community-source cache policy.
    if (result.syncMode === 'word') return result;
    lineFallback ||= result;
  }
  return lineFallback;
}

async function fetchWordProviderLyrics(track, diagnostics = {}) {
  const controller = new AbortController();
  const attempts = [];
  ytmalProviderTraces.set(controller.signal, attempts);
  // Independent services run together. A valid word result wins immediately;
  // a fast line result cannot hide a slower word result from another provider.
  const providers = [ytmalFetchBetterLyrics, (track, signal) => ytmalFetchBetterLyrics(track, signal, true), ytmalFetchBinimum, ytmalFetchUnison, ytmalFetchLrcRed];
  return new Promise(resolve => {
    let remaining = providers.length, settled = false, lineFallback = null;
    const finish = result => {
      diagnostics.providerAttempts = attempts.map(attempt => ({...attempt, outcome: attempt.outcome === 'pending' ? (result?.syncMode === 'word' ? 'cancelled after word match' : 'deadline exceeded') : attempt.outcome}));
      resolve(result);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true; controller.abort(); finish(lineFallback);
    }, 8000);
    for (const provider of providers) {
      Promise.resolve().then(() => provider(track, controller.signal)).catch(() => null).then(result => {
        if (settled) return;
        if (result?.syncMode === 'word') {
          settled = true; clearTimeout(deadline); controller.abort(); finish(result); return;
        }
        lineFallback ||= result;
        if (--remaining === 0) { settled = true; clearTimeout(deadline); finish(lineFallback); }
      });
    }
  });
}

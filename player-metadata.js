// Runs in YouTube Music's MAIN world. Only publish bounded song metadata;
// extension APIs, provider requests, lyric rendering and media ticks stay isolated.
(() => {
  const read = (player, method) => {
    try { return typeof player?.[method] === 'function' ? player[method]() : null; }
    catch { return null; }
  };
  const text = value => typeof value === 'string' ? value.trim().slice(0, 1000) : '';
  document.addEventListener('ytmal:request-player-metadata', () => {
    const player = document.querySelector('#movie_player');
    const data = read(player, 'getVideoData') || {};
    const details = read(player, 'getPlayerResponse')?.videoDetails || {};
    const videoId = text(data.video_id || details.videoId);
    if (!/^[\w-]{11}$/.test(videoId)) return;
    // Never merge details belonging to a different video during navigation.
    const matchingDetails = details.videoId === videoId ? details : {};
    const duration = Number(matchingDetails.lengthSeconds) || Number(read(player, 'getDuration')) || 0;
    document.dispatchEvent(new CustomEvent('ytmal:player-metadata', {detail: JSON.stringify({
      videoId,
      title: text(data.title || matchingDetails.title),
      artist: text(data.author || matchingDetails.author),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    })}));
  });
})();

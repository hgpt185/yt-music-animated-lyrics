// Shared pure helpers for Animated Lyrics for YouTube Music.
// Loaded before content.js as a classic script, so these become global functions.

function ytmalEscapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

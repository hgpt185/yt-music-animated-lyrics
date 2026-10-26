const checkbox = document.getElementById('enabled');
const modeButton = document.getElementById('sync-mode-toggle');
const modeStatus = document.getElementById('sync-mode-status');
let preferredMode = 'word';

document.getElementById('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
function paintMode() {
  modeStatus.textContent = preferredMode === 'word' ? 'Word sync preferred' : 'Line sync selected';
  modeButton.textContent = `Switch to ${preferredMode === 'word' ? 'line' : 'word'} sync`;
}
chrome.storage.local.get(['enabled', 'preferredSyncMode'], result => {
  checkbox.checked = result.enabled !== false;
  preferredMode = result.preferredSyncMode === 'line' ? 'line' : 'word';
  paintMode();
});
checkbox.addEventListener('change', () => {
  chrome.storage.local.set({enabled: checkbox.checked});
});
modeButton.addEventListener('click', async () => {
  const previous = preferredMode;
  preferredMode = preferredMode === 'word' ? 'line' : 'word';
  paintMode();
  try { await chrome.storage.local.set({preferredSyncMode: preferredMode}); }
  catch {
    preferredMode = previous;
    paintMode();
    modeStatus.textContent = 'Could not save your choice. Try again.';
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('preferredSyncMode' in changes) {
    preferredMode = changes.preferredSyncMode.newValue === 'line' ? 'line' : 'word';
    paintMode();
  }
  if ('enabled' in changes) checkbox.checked = changes.enabled.newValue !== false;
});

// background.js — service worker for persisting shots to chrome.storage.local
// Shots auto-save here on every hit. Data persists across reloads and restarts.
// Use the CSV button in the overlay or options page to export as a file.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'save-shot') {
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const shots = savedShots || [];
      shots.push(msg.row);
      chrome.storage.local.set({ savedShots: shots }, () => {
        sendResponse({ count: shots.length });
      });
    });
    return true;
  }
});

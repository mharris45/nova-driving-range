const scriptUrlInput = document.getElementById('scriptUrl');
const saveBtn        = document.getElementById('saveBtn');
const statusEl       = document.getElementById('status');

// Load saved URL on open
chrome.storage.sync.get(['scriptUrl'], (result) => {
  if (result.scriptUrl) scriptUrlInput.value = result.scriptUrl;
});

saveBtn.addEventListener('click', () => {
  const url = scriptUrlInput.value.trim();
  chrome.storage.sync.set({ scriptUrl: url }, () => {
    statusEl.classList.add('visible');
    setTimeout(() => statusEl.classList.remove('visible'), 2500);
  });
});

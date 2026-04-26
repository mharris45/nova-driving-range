const downloadBtn  = document.getElementById('downloadBtn');
const clearBtn     = document.getElementById('clearBtn');
const shotCountEl  = document.getElementById('shot-count');
const statusEl     = document.getElementById('status');

const CSV_HEADERS = ['Club','Timestamp','BallSpeed','vLaunchAngle','hLaunchAngle','CarryDist','TotalDist','OfflineDist','PeakHeight','HangTime','TotalSpin','Backspin','Sidespin','SpinAxis','ClubSpeed','SmashFactor','DescentAngle','DistEfficiency','ShotName','ShotRank'];

function showStatus(msg, color) {
  statusEl.textContent = msg;
  statusEl.style.color = color || '#52b788';
  statusEl.classList.add('visible');
  setTimeout(() => statusEl.classList.remove('visible'), 3000);
}

// Load shot count
chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
  shotCountEl.textContent = (savedShots || []).length;
});

// Download CSV
downloadBtn.addEventListener('click', () => {
  chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
    const shots = savedShots || [];
    if (shots.length === 0) {
      showStatus('No saved shots', '#f85149');
      return;
    }
    const csvRows = [CSV_HEADERS.join(',')];
    for (const s of shots) {
      csvRows.push([
        s.club, s.timestamp, s.ballSpeed, s.vLaunchAngle, s.hLaunchAngle,
        s.carryDist, s.totalDist, s.offlineDist, s.peakHeight, s.hangTime,
        s.totalSpin, s.backspin, s.sidespin, s.spinAxis, s.clubSpeed,
        s.smashFactor, s.descentAngle, s.distEfficiency,
        `"${(s.shotName||'').replace(/"/g,'""')}"`, s.shotRank,
      ].join(','));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'nova-shots.csv';
    a.click();
    URL.revokeObjectURL(url);
    showStatus(`Downloaded ${shots.length} shots`);
  });
});

// Clear all data
clearBtn.addEventListener('click', () => {
  if (!confirm('Delete all saved shot data? This cannot be undone.')) return;
  chrome.storage.local.set({ savedShots: [] }, () => {
    shotCountEl.textContent = '0';
    showStatus('All data cleared');
  });
});

// ── AI coaching settings ─────────────────────────────────────────────
const aiEnabledEl  = document.getElementById('aiEnabled');
const aiEndpointEl = document.getElementById('aiEndpoint');
const aiKeyEl      = document.getElementById('aiKey');
const aiModelEl    = document.getElementById('aiModel');
const aiSaveBtn    = document.getElementById('aiSaveBtn');
const aiTestBtn    = document.getElementById('aiTestBtn');
const aiStatusEl   = document.getElementById('aiStatus');

function showAiStatus(msg, color) {
  aiStatusEl.textContent = msg;
  aiStatusEl.style.color = color || '#52b788';
  aiStatusEl.classList.add('visible');
  setTimeout(() => aiStatusEl.classList.remove('visible'), 4000);
}

chrome.storage.local.get(['aiEnabled','aiEndpoint','aiKey','aiModel'], (s) => {
  aiEnabledEl.checked  = !!s.aiEnabled;
  aiEndpointEl.value   = s.aiEndpoint || '';
  aiKeyEl.value        = s.aiKey || '';
  aiModelEl.value      = s.aiModel || '';
});

aiSaveBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    aiEnabled:  aiEnabledEl.checked,
    aiEndpoint: aiEndpointEl.value.trim(),
    aiKey:      aiKeyEl.value.trim(),
    aiModel:    aiModelEl.value.trim(),
  }, () => showAiStatus('✓ Settings saved'));
});

aiTestBtn.addEventListener('click', () => {
  const endpoint = aiEndpointEl.value.trim();
  const key      = aiKeyEl.value.trim();
  const model    = aiModelEl.value.trim();
  if (!endpoint || !key) {
    showAiStatus('⚠ Endpoint and API key required', '#f85149');
    return;
  }
  showAiStatus('Testing…', '#8b949e');
  chrome.runtime.sendMessage({
    type: 'analyze-shot',
    overrides: { endpoint, key, model },
    testMessage: 'Reply with the single word: pong',
  }, (resp) => {
    if (resp?.ok) {
      showAiStatus('✓ ' + (resp.text || '').slice(0, 80));
    } else {
      showAiStatus('✗ ' + (resp?.error || 'unknown error'), '#f85149');
    }
  });
});

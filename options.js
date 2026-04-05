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

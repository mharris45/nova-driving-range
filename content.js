// content.js — runs in the extension's isolated world
// Handles UI, Chrome storage, and communicates with scene.js via postMessage

(function () {
  if (document.getElementById('gsv-overlay')) return;

  // ── Club list (Driver – SW, no putter) ──────────────────────────────────
  const clubs = [
    'Driver','3W','5W','7W',
    '2i','3i','4i','5i','6i','7i','8i','9i',
    'PW','GW','SW',
  ];
  let selectedClub = clubs[0];

  // ── Shot data (empty until live data or loaded from storage) ─────────
  const shot = {
    ballSpeed:0, vLaunchAngle:0, hLaunchAngle:0,
    totalSpin:0, spinAxis:0, backspin:0, sidespin:0,
    carryDist:0, totalDist:0, offlineDist:0,
    peakHeight:0, hangTime:0, descentAngle:0,
    clubSpeed:0, smashFactor:0, distEfficiency:0,
    shotName:'', shotRank:'', shotColor:'',
  };

  let lastShotSig = ''; // dedup: skip if Firestore replays the same shot on reload

  // ── Ring Attack mode state ─────────────────────────────────────────────
  let ringModeActive = false;
  let ringScore = 0;
  let ringShots = 0;
  let ringHighScore = 0;
  const RING_MAX_SHOTS = 10;

  function shotHasData() {
    return shot.ballSpeed > 0;
  }

  // Load last saved shot for the selected club into the shot object
  function loadLastShot(callback) {
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const clubShots = (savedShots || []).filter(s => s.club === selectedClub);
      if (clubShots.length > 0) {
        const last = clubShots[clubShots.length - 1];
        const keys = ['ballSpeed','vLaunchAngle','hLaunchAngle','totalSpin','spinAxis',
          'backspin','sidespin','carryDist','totalDist','offlineDist','peakHeight',
          'hangTime','descentAngle','clubSpeed','smashFactor','distEfficiency',
          'shotName','shotRank'];
        for (const k of keys) {
          if (last[k] !== undefined) shot[k] = last[k];
        }
        shot.shotColor = '';
        // Set dedup signature so Firestore replay of this same shot won't re-save
        lastShotSig = `${shot.ballSpeed}|${shot.vLaunchAngle}|${shot.carryDist}|${shot.totalSpin}`;
      } else {
        // No saved shots for this club — reset to empty
        Object.keys(shot).forEach(k => shot[k] = typeof shot[k] === 'string' ? '' : 0);
        lastShotSig = '';
      }
      if (callback) callback();
    });
  }

  // ── Ball flight calculator ─────────────────────────────────────────────
  // Simplified trajectory model from ball speed, launch angle, and spin.
  // Uses basic physics with drag and Magnus lift approximations.
  function calcFlightFromRaw(ballSpeedMph, vLaunchDeg, hLaunchDeg, spinRpm, spinAxisDeg) {
    const g = 32.174;                         // ft/s²
    const dt = 0.01;                          // time step (s)
    const ballSpeedFps = ballSpeedMph * 1.467; // mph → ft/s
    const vRad = vLaunchDeg * Math.PI / 180;
    const hRad = hLaunchDeg * Math.PI / 180;

    // Initial velocity components
    let vx = ballSpeedFps * Math.cos(vRad) * Math.sin(hRad); // lateral
    let vy = ballSpeedFps * Math.sin(vRad);                   // vertical
    let vz = ballSpeedFps * Math.cos(vRad) * Math.cos(hRad); // downrange

    let x = 0, y = 0, z = 0;
    let peakY = 0, time = 0;

    // Drag coefficient scaled for golf ball
    const Cd = 0.22;
    const rho = 0.0023769;   // air density slugs/ft³
    const A = 0.00304;       // ball cross-section ft²
    const m = 0.1012;        // ball mass slugs (~1.62 oz)
    const dragK = 0.5 * Cd * rho * A / m;

    // Magnus lift from backspin (simplified)
    const spinRad = spinRpm * 2 * Math.PI / 60;
    const liftK = 0.00002 * spinRad; // tuned coefficient

    while (y >= 0 || time < 0.1) {
      const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (speed < 1) break;
      if (time > 15) break; // safety cap

      // Drag opposes velocity
      const drag = dragK * speed;
      const ax = -drag * vx;
      const ay = -drag * vy - g + liftK * speed; // lift opposes gravity
      const az = -drag * vz;

      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      time += dt;

      if (y > peakY) peakY = y;
      if (y < 0 && time > 0.5) break;
    }

    // Convert ft → yards
    const carryZ = Math.max(0, z / 3);
    const carryX = x / 3;
    const peakYds = peakY / 3;

    // Descent angle from final velocity
    const finalSpeed = Math.sqrt(vz*vz + vy*vy);
    const descentDeg = finalSpeed > 0 ? Math.abs(Math.atan2(-vy, vz)) * 180 / Math.PI : 45;

    // Roll estimate — steeper descent and more spin = less roll
    const rollFactor = Math.max(0.05, 0.25 - (descentDeg / 300) - (spinRpm / 50000));
    const rollDist = carryZ * rollFactor;

    return {
      carryDist:    Math.round(carryZ * 10) / 10,
      totalDist:    Math.round((carryZ + rollDist) * 10) / 10,
      offlineDist:  Math.round(carryX * 10) / 10,
      peakHeight:   Math.round(peakYds * 10) / 10,
      hangTime:     Math.round(time * 10) / 10,
      descentAngle: Math.round(descentDeg * 10) / 10,
    };
  }

  function updateShotFromFirestore(fields) {
    const dv = (f) => f?.doubleValue || 0;
    const rawBallSpeed = dv(fields.ball_speed);
    const rawVLA       = dv(fields.vertical_launch_angle);
    const rawHLA       = -dv(fields.horizontal_launch_angle);
    const rawSpin      = dv(fields.spin);
    const rawBackspin  = dv(fields.backspin);
    const rawSidespin  = dv(fields.sidespin);
    const rawSpinAxis  = dv(fields.spin_axis);

    if (rawBallSpeed < 1) return false;

    const ballSpeedMph = rawBallSpeed * 2.23694;

    // Raw sensor data
    shot.vLaunchAngle = Math.round(rawVLA * 10) / 10;
    shot.hLaunchAngle = Math.round(rawHLA * 10) / 10;
    shot.totalSpin    = Math.round(rawSpin);
    shot.backspin     = Math.round(rawBackspin);
    shot.sidespin     = Math.round(rawSidespin);
    shot.spinAxis     = Math.round(rawSpinAxis * 10) / 10;

    // Use open_golf_coach data when available (pre-calculated, accurate)
    const coach = fields.open_golf_coach?.mapValue?.fields;
    const us = coach?.us_customary_units?.mapValue?.fields;

    if (us) {
      shot.ballSpeed      = Math.round(dv(us.ball_speed_mph) * 10) / 10;
      shot.clubSpeed      = Math.round(dv(us.club_speed_mph) * 10) / 10;
      shot.smashFactor    = Math.round(dv(coach.smash_factor) * 100) / 100;
      shot.carryDist      = Math.round(dv(us.carry_distance_yards) * 10) / 10;
      shot.totalDist      = Math.round(dv(us.total_distance_yards) * 10) / 10;
      shot.offlineDist    = -Math.round(dv(us.offline_distance_yards) * 10) / 10;
      shot.peakHeight     = Math.round(dv(us.peak_height_yards) * 10) / 10;
      shot.hangTime       = Math.round(dv(coach.hang_time_seconds) * 10) / 10;
      shot.descentAngle   = Math.round(dv(coach.descent_angle_degrees) * 10) / 10;
      shot.distEfficiency = Math.round(dv(coach.distance_efficiency_percent));
      shot.shotName       = coach.shot_name?.stringValue || '';
      shot.shotRank       = coach.shot_rank?.stringValue || '';
      shot.shotColor      = coach.shot_color_rgb?.stringValue || '';
    } else {
      // Fallback: calculate from raw sensor data
      shot.ballSpeed = Math.round(ballSpeedMph * 10) / 10;
      const calc = calcFlightFromRaw(ballSpeedMph, rawVLA, rawHLA, rawSpin, rawSpinAxis);
      // offlineDist sign is already correct since rawHLA was negated at source
      Object.assign(shot, calc);
      shot.smashFactor    = 0;
      shot.clubSpeed      = 0;
      shot.distEfficiency = shot.carryDist > 0
        ? Math.round(shot.carryDist / shot.ballSpeed * 100) / 100
        : 0;
      shot.shotName = '';
      shot.shotRank = '';
      shot.shotColor = '';
    }

    return true;
  }

  // ── Listen for Firestore shot data from interceptor.js (MAIN world) ─────
  // interceptor.js patches XHR in the main world and relays shot documents here.
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'gsv-firestore-shot') {
      const fields = e.data.fields;
      const valid = fields.valid_launch?.booleanValue !== false;
      if (valid && updateShotFromFirestore(fields)) {
        console.log('[GSV] New shot:', shot.ballSpeed, 'mph,', shot.carryDist, 'yds carry');

        if (ringModeActive) {
          // Ring mode: count shot, skip save, update HUD
          ringShots++;
          renderRingHUD();
          if (overlay.style.display === 'flex') {
            window.postMessage({ type:'gsv-update', shot }, '*');
          }
          // Check game over after last shot's animation (delay for flight)
          if (ringShots >= RING_MAX_SHOTS) {
            const hangTime = Math.max(shot.hangTime || 3, 2);
            setTimeout(() => {
              if (ringModeActive) endRingMode();
            }, (hangTime + 5) * 1000);
          }
        } else {
          autoSaveShot(() => {
            refreshClubAverages(() => renderStats());
          });
          if (overlay.style.display === 'flex') {
            window.postMessage({ type:'gsv-update', shot }, '*');
          }
        }
      }
    }
    // Ring hit message from scene.js
    if (e.data?.type === 'gsv-ring-hit') {
      ringScore += e.data.points;
      renderRingHUD();
      // Flash the score element
      const scoreEl = document.getElementById('gsv-ring-score');
      if (scoreEl) {
        scoreEl.style.transform = 'scale(1.4)';
        scoreEl.style.transition = 'transform 0.15s ease-out';
        setTimeout(() => {
          scoreEl.style.transform = 'scale(1)';
          scoreEl.style.transition = 'transform 0.3s ease-in';
        }, 150);
      }
    }
  });

  // ── Launch button ──────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'gsv-launcher';
  btn.innerHTML = '⛳';
  Object.assign(btn.style, {
    position:'fixed', bottom:'24px', right:'24px', zIndex:'2147483646',
    width:'54px', height:'54px', borderRadius:'50%',
    background:'linear-gradient(135deg,#1a472a,#2d6a4f)',
    border:'2px solid #52b788', color:'#fff', fontSize:'24px',
    cursor:'pointer', boxShadow:'0 4px 24px rgba(0,0,0,.6)',
    transition:'transform .2s', display:'flex',
    alignItems:'center', justifyContent:'center',
  });
  btn.onmouseenter = () => btn.style.transform = 'scale(1.12)';
  btn.onmouseleave = () => btn.style.transform = 'scale(1)';
  document.body.appendChild(btn);

  // ── Overlay ────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'gsv-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;background:#080e14;
    display:none;flex-direction:column;
    font-family:'Segoe UI',system-ui,sans-serif;
  `;
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:10px 20px;background:#0d1117;border-bottom:1px solid #21262d;
      flex-shrink:0;height:48px;box-sizing:border-box;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">⛳</span>
        <span style="color:#52b788;font-weight:700;font-size:14px;letter-spacing:1px;">SHOT REPLAY</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="gsv-club-select" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;outline:none;">
          ${clubs.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <button id="gsv-ring-btn" style="background:#1a2a3a;border:1px solid #ffd700;color:#ffd700;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">💍 RING ATTACK</button>
        <button id="gsv-replay-btn" style="background:#1e3a2f;border:1px solid #52b788;color:#52b788;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">▶ REPLAY</button>
        <button id="gsv-birdseye-btn" style="background:#1a2a3a;border:1px solid #f0c040;color:#f0c040;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">🦅 BIRDS EYE</button>
        <button id="gsv-table-btn"   style="background:#1a2a3a;border:1px solid #8b949e;color:#8b949e;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">📋 TABLE</button>
        <button id="gsv-csv-btn"    style="background:#1a2a3a;border:1px solid #da8ee7;color:#da8ee7;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">📥 CSV</button>
        <button id="gsv-report-btn" style="background:#1a2a3a;border:1px solid #4da6ff;color:#4da6ff;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">📊 REPORT</button>
        <span id="gsv-save-status"  style="font-size:11px;color:#52b788;min-width:80px;"></span>
        <button id="gsv-close-btn"  style="background:none;border:none;color:#6e7681;font-size:22px;cursor:pointer;padding:0 4px;">✕</button>
      </div>
    </div>

    <div id="gsv-canvas-wrap" style="flex:1;position:relative;overflow:hidden;min-height:0;"></div>

    <div id="gsv-table-panel" style="display:none;flex:1;overflow-y:auto;background:#0d1117;padding:10px 20px;min-height:0;">
    </div>

    <div id="gsv-statsbar" style="display:flex;flex-wrap:wrap;gap:6px;padding:10px 20px;
      background:#0d1117;border-top:1px solid #21262d;flex-shrink:0;"></div>

  `;
  document.body.appendChild(overlay);

  // ── Stats bar ──────────────────────────────────────────────────────────
  const statDefs = [
    ['Ball Speed','ballSpeed','mph'],['Club Speed','clubSpeed','mph'],
    ['Smash Factor','smashFactor',''],['Carry','carryDist','yds'],
    ['Total','totalDist','yds'],['Offline','offlineDist','yds'],
    ['Peak Ht','peakHeight','yds'],['Hang Time','hangTime','s'],
    ['Launch ↕','vLaunchAngle','°'],['Launch ↔','hLaunchAngle','°'],
    ['Spin','totalSpin','rpm'],['Backspin','backspin','rpm'],
    ['Sidespin','sidespin','rpm'],['Spin Axis','spinAxis','°'],
    ['Descent','descentAngle','°'],['Efficiency','distEfficiency','%'],
  ];

  // ── Club averages for stat comparison ──────────────────────────────────
  let clubAvgs = {}; // key → average value for selectedClub

  function refreshClubAverages(callback) {
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const shots = (savedShots || []).filter(s => s.club === selectedClub);
      clubAvgs = {};
      if (shots.length > 0) {
        const numericKeys = statDefs.map(([,k]) => k);
        for (const k of numericKeys) {
          const vals = shots.map(s => s[k]).filter(v => typeof v === 'number' && v !== 0);
          if (vals.length > 0) {
            clubAvgs[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
          }
        }
      }
      if (callback) callback();
    });
  }

  function renderStats() {
    const rankColors = { S:'#ffd700', A:'#52b788', B:'#388bfd', C:'#8b949e', D:'#6e4d30' };
    const rankCol = rankColors[shot.shotRank] || '#52b788';

    // Shot name + rank badge
    const badge = (shot.shotName || shot.shotRank) ? `
      <div style="background:#161b22;border:1px solid ${rankCol};border-radius:8px;
        padding:6px 14px;text-align:center;min-width:100px;">
        <div style="color:${rankCol};font-size:14px;font-weight:700;">${shot.shotName || '—'}${shot.shotRank ? ' <span style="font-size:16px;font-weight:900;">' + shot.shotRank + '</span>' : ''}</div>
        <div style="color:#6e7681;font-size:9px;margin-top:2px;text-transform:uppercase;letter-spacing:.5px;">Shot Type</div>
      </div>` : '';

    const cards = statDefs
      .filter(([,k]) => shot[k] !== 0 && shot[k] !== '')
      .map(([l,k,u]) => {
        const val = shot[k];
        const avg = clubAvgs[k];
        let arrow = '', arrowColor = '#8b949e';
        if (avg != null) {
          const diff = val - avg;
          const threshold = Math.abs(avg) * 0.005; // ~0.5% dead zone
          if (diff > threshold)      { arrow = '▲'; arrowColor = '#52b788'; }
          else if (diff < -threshold) { arrow = '▼'; arrowColor = '#f85149'; }
          else                        { arrow = '—'; arrowColor = '#e6edf3'; }
        }
        const avgLine = avg != null ? `<div style="color:#6e7681;font-size:9px;margin-top:1px;">avg ${Math.round(avg*10)/10}${u}</div>` : '';
        return `
      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;
        padding:6px 14px;text-align:center;min-width:80px;">
        <div style="font-size:14px;font-weight:700;">
          <span style="color:${arrowColor};">${arrow}</span>
          <span style="color:#52b788;">${val}${u}</span>
        </div>
        ${avgLine}
        <div style="color:#6e7681;font-size:9px;margin-top:2px;text-transform:uppercase;
          letter-spacing:.5px;">${l}</div>
      </div>`;
      }).join('');

    overlay.querySelector('#gsv-statsbar').innerHTML = badge + cards;
  }

  loadLastShot(() => refreshClubAverages(() => renderStats()));

  // ── Club selector ───────────────────────────────────────────────────────
  overlay.querySelector('#gsv-club-select').addEventListener('change', (e) => {
    selectedClub = e.target.value;
    renderLandingDots();
    loadLastShot(() => refreshClubAverages(() => renderStats()));
  });

  // ── Auto-save shot to CSV via background worker ───────────────────────

  function autoSaveShot(callback) {
    // Fingerprint the shot by its key metrics — if identical, it's a replay
    const sig = `${shot.ballSpeed}|${shot.vLaunchAngle}|${shot.carryDist}|${shot.totalSpin}`;
    if (sig === lastShotSig) {
      if (callback) callback();
      return;
    }
    lastShotSig = sig;

    const st = overlay.querySelector('#gsv-save-status');
    const row = {
      club: selectedClub,
      timestamp: new Date().toISOString(),
      ballSpeed: shot.ballSpeed,
      vLaunchAngle: shot.vLaunchAngle,
      hLaunchAngle: shot.hLaunchAngle,
      carryDist: shot.carryDist,
      totalDist: shot.totalDist,
      offlineDist: shot.offlineDist,
      peakHeight: shot.peakHeight,
      hangTime: shot.hangTime,
      totalSpin: shot.totalSpin,
      backspin: shot.backspin,
      sidespin: shot.sidespin,
      spinAxis: shot.spinAxis,
      clubSpeed: shot.clubSpeed,
      smashFactor: shot.smashFactor,
      descentAngle: shot.descentAngle,
      distEfficiency: shot.distEfficiency,
      shotName: shot.shotName,
      shotRank: shot.shotRank,
    };
    chrome.runtime.sendMessage({ type: 'save-shot', row }, (resp) => {
      if (resp?.count) {
        st.style.color = '#52b788'; st.textContent = `✓ Saved (${resp.count})`;
        setTimeout(() => st.textContent = '', 3000);
      }
      renderLandingDots();
      if (callback) callback();
    });
  }

  // ── Landing dots — show last 100 carry points for selected club ────────
  function renderLandingDots() {
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const shots = (savedShots || []).filter(s => s.club === selectedClub);
      const recent = shots.slice(-100).map(s => ({
        carryDist: s.carryDist,
        offlineDist: s.offlineDist,
      }));
      window.postMessage({ type: 'gsv-landing-dots', dots: recent }, '*');
    });
  }

  // ── Export CSV ─────────────────────────────────────────────────────────
  const CSV_HEADERS = ['Club','Timestamp','BallSpeed','vLaunchAngle','hLaunchAngle','CarryDist','TotalDist','OfflineDist','PeakHeight','HangTime','TotalSpin','Backspin','Sidespin','SpinAxis','ClubSpeed','SmashFactor','DescentAngle','DistEfficiency','ShotName','ShotRank'];

  overlay.querySelector('#gsv-csv-btn').addEventListener('click', () => {
    const st = overlay.querySelector('#gsv-save-status');
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const shots = savedShots || [];
      if (shots.length === 0) {
        st.style.color = '#f85149'; st.textContent = '⚠ No saved shots';
        setTimeout(() => st.textContent = '', 3000);
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
      st.style.color = '#52b788'; st.textContent = `✓ Exported ${shots.length} shots`;
      setTimeout(() => st.textContent = '', 3000);
    });
  });

  overlay.querySelector('#gsv-report-btn').addEventListener('click', () => {
    const club = overlay.querySelector('#gsv-club-select').value;
    const url = chrome.runtime.getURL('report.html') + '?club=' + encodeURIComponent(club);
    window.open(url, '_blank');
  });

  // ── Shot table ─────────────────────────────────────────────────────────
  let tableOpen = false;
  const tablePanel = overlay.querySelector('#gsv-table-panel');
  const canvasWrap = overlay.querySelector('#gsv-canvas-wrap');
  const tableBtn = overlay.querySelector('#gsv-table-btn');

  function renderTable() {
    chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
      const shots = savedShots || [];
      if (shots.length === 0) {
        tablePanel.innerHTML = '<div style="color:#6e7681;text-align:center;padding:40px;">No saved shots</div>';
        return;
      }
      const thStyle = 'padding:6px 10px;text-align:left;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #21262d;position:sticky;top:0;background:#0d1117;';
      const tdStyle = 'padding:5px 10px;font-size:12px;color:#e6edf3;border-bottom:1px solid #161b22;';
      let html = `<table style="width:100%;border-collapse:collapse;font-family:'Segoe UI',system-ui,sans-serif;">
        <thead><tr>
          <th style="${thStyle}"></th>
          <th style="${thStyle}">Club</th>
          <th style="${thStyle}">Time</th>
          <th style="${thStyle}">Ball Spd</th>
          <th style="${thStyle}">Carry</th>
          <th style="${thStyle}">Total</th>
          <th style="${thStyle}">Offline</th>
          <th style="${thStyle}">Peak</th>
          <th style="${thStyle}">Spin</th>
          <th style="${thStyle}">Launch</th>
          <th style="${thStyle}">Shot</th>
        </tr></thead><tbody>`;
      // Show newest first
      for (let i = shots.length - 1; i >= 0; i--) {
        const s = shots[i];
        const time = s.timestamp ? new Date(s.timestamp).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
        html += `<tr>
          <td style="${tdStyle}"><button data-del-idx="${i}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px;padding:0 4px;">✕</button></td>
          <td style="${tdStyle}font-weight:700;color:#52b788;">${s.club||'—'}</td>
          <td style="${tdStyle}color:#6e7681;">${time}</td>
          <td style="${tdStyle}">${s.ballSpeed||0} mph</td>
          <td style="${tdStyle}font-weight:700;">${s.carryDist||0} yds</td>
          <td style="${tdStyle}">${s.totalDist||0} yds</td>
          <td style="${tdStyle}">${s.offlineDist||0} yds</td>
          <td style="${tdStyle}">${s.peakHeight||0} yds</td>
          <td style="${tdStyle}">${s.totalSpin||0} rpm</td>
          <td style="${tdStyle}">${s.vLaunchAngle||0}°</td>
          <td style="${tdStyle}color:#8b949e;">${s.shotName||'—'} ${s.shotRank||''}</td>
        </tr>`;
      }
      html += '</tbody></table>';
      tablePanel.innerHTML = html;

      // Wire up delete buttons
      tablePanel.querySelectorAll('button[data-del-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.delIdx);
          chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
            const shots = savedShots || [];
            shots.splice(idx, 1);
            chrome.storage.local.set({ savedShots: shots }, () => {
              renderTable();
              renderLandingDots();
              loadLastShot(() => refreshClubAverages(() => renderStats()));
            });
          });
        });
      });
    });
  }

  tableBtn.addEventListener('click', () => {
    tableOpen = !tableOpen;
    if (tableOpen) {
      tableBtn.style.background = '#2a2a3a';
      tableBtn.textContent = '📋 CLOSE';
      canvasWrap.style.display = 'none';
      tablePanel.style.display = 'block';
      renderTable();
    } else {
      tableBtn.style.background = '#1a2a3a';
      tableBtn.textContent = '📋 TABLE';
      tablePanel.style.display = 'none';
      canvasWrap.style.display = 'block';
    }
  });

  // ── Replay button ──────────────────────────────────────────────────────
  overlay.querySelector('#gsv-replay-btn').addEventListener('click', () => {
    if (shotHasData()) {
      window.postMessage({ type: 'gsv-update', shot }, '*');
    }
  });

  // ── Birds eye button ──────────────────────────────────────────────────
  let birdsEyeActive = false;
  const birdsEyeBtn = overlay.querySelector('#gsv-birdseye-btn');
  birdsEyeBtn.addEventListener('click', () => {
    birdsEyeActive = !birdsEyeActive;
    if (birdsEyeActive) {
      birdsEyeBtn.style.background = '#3a2a00';
      birdsEyeBtn.textContent = '🦅 NORMAL';
    } else {
      birdsEyeBtn.style.background = '#1a2a3a';
      birdsEyeBtn.textContent = '🦅 BIRDS EYE';
    }
    window.postMessage({ type: 'gsv-birdseye', active: birdsEyeActive }, '*');
  });

  // ── Ring Attack mode ────────────────────────────────────────────────────
  const ringBtn = overlay.querySelector('#gsv-ring-btn');
  const clubSelect = overlay.querySelector('#gsv-club-select');
  let ringMinDist = 25, ringMaxDist = 100;

  function renderRingHUD() {
    const remaining = RING_MAX_SHOTS - ringShots;
    overlay.querySelector('#gsv-statsbar').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:32px;width:100%;padding:4px 0;">
        <div style="text-align:center;">
          <div style="color:#ffd700;font-size:28px;font-weight:900;text-shadow:0 0 16px rgba(255,215,0,.4);" id="gsv-ring-score">${ringScore}</div>
          <div style="color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Score</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#e6edf3;font-size:20px;font-weight:700;">${Math.max(0, remaining)}</div>
          <div style="color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;">Shots Left</div>
        </div>
        <div style="text-align:center;">
          <div style="color:#ffa500;font-size:16px;font-weight:700;">${ringHighScore}</div>
          <div style="color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;">High Score</div>
        </div>
      </div>`;
  }

  function renderRingSettings() {
    const sliderTrack = 'background:#21262d;border:none;border-radius:4px;height:6px;outline:none;-webkit-appearance:none;appearance:none;width:100%;';
    overlay.querySelector('#gsv-statsbar').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;padding:10px 0;">
        <div style="color:#ffd700;font-size:18px;font-weight:800;letter-spacing:1px;">RING ATTACK SETTINGS</div>
        <div style="display:flex;gap:40px;align-items:flex-start;">
          <div style="text-align:center;min-width:160px;">
            <div style="color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Min Distance</div>
            <input type="range" id="gsv-ring-min" min="10" max="180" value="${ringMinDist}" step="5"
              style="${sliderTrack}cursor:pointer;accent-color:#ffd700;">
            <div style="color:#e6edf3;font-size:16px;font-weight:700;margin-top:4px;" id="gsv-ring-min-val">${ringMinDist} yds</div>
          </div>
          <div style="text-align:center;min-width:160px;">
            <div style="color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Max Distance</div>
            <input type="range" id="gsv-ring-max" min="10" max="180" value="${ringMaxDist}" step="5"
              style="${sliderTrack}cursor:pointer;accent-color:#ffd700;">
            <div style="color:#e6edf3;font-size:16px;font-weight:700;margin-top:4px;" id="gsv-ring-max-val">${ringMaxDist} yds</div>
          </div>
        </div>
        <button id="gsv-ring-go" style="background:linear-gradient(135deg,#b8860b,#ffd700);border:none;color:#000;
          border-radius:8px;padding:8px 32px;cursor:pointer;font-size:14px;font-weight:800;letter-spacing:1px;
          margin-top:4px;transition:transform .15s;">START GAME</button>
      </div>`;

    const minSlider = document.getElementById('gsv-ring-min');
    const maxSlider = document.getElementById('gsv-ring-max');
    const minVal = document.getElementById('gsv-ring-min-val');
    const maxVal = document.getElementById('gsv-ring-max-val');

    minSlider.addEventListener('input', () => {
      ringMinDist = parseInt(minSlider.value);
      if (ringMinDist > ringMaxDist - 10) { ringMaxDist = ringMinDist + 10; maxSlider.value = ringMaxDist; maxVal.textContent = ringMaxDist + ' yds'; }
      minVal.textContent = ringMinDist + ' yds';
    });
    maxSlider.addEventListener('input', () => {
      ringMaxDist = parseInt(maxSlider.value);
      if (ringMaxDist < ringMinDist + 10) { ringMinDist = ringMaxDist - 10; minSlider.value = ringMinDist; minVal.textContent = ringMinDist + ' yds'; }
      maxVal.textContent = ringMaxDist + ' yds';
    });

    document.getElementById('gsv-ring-go').addEventListener('click', () => {
      ringScore = 0;
      ringShots = 0;
      renderRingHUD();
      window.postMessage({ type: 'gsv-ring-start', minDist: ringMinDist, maxDist: ringMaxDist }, '*');
    });
  }

  function endRingMode() {
    // Save high score if beaten
    if (ringScore > ringHighScore) {
      ringHighScore = ringScore;
      chrome.storage.local.set({ ringHighScore });
    }
    ringModeActive = false;
    ringBtn.textContent = '💍 RING ATTACK';
    ringBtn.style.background = '#1a2a3a';
    clubSelect.style.display = '';
    window.postMessage({ type: 'gsv-ring-end' }, '*');
    refreshClubAverages(() => renderStats());
  }

  ringBtn.addEventListener('click', () => {
    if (!ringModeActive) {
      ringModeActive = true;
      ringBtn.textContent = '💍 END GAME';
      ringBtn.style.background = '#3a2a00';
      clubSelect.style.display = 'none';
      // Load high score then show settings
      chrome.storage.local.get(['ringHighScore'], (data) => {
        ringHighScore = data.ringHighScore || 0;
        renderRingSettings();
      });
    } else {
      endRingMode();
    }
  });

  // ── Close button ───────────────────────────────────────────────────────
  overlay.querySelector('#gsv-close-btn').addEventListener('click', () => {
    overlay.style.display = 'none';
    if (ringModeActive) endRingMode();
  });

  // ── Inject Three.js then scene.js into the MAIN world ──────────────────
  let sceneReady = false;

  function injectScripts() {
    if (sceneReady) {
      // Already loaded — only send shot data if we have real data
      if (shotHasData()) window.postMessage({ type: 'gsv-init', shot }, '*');
      return;
    }
    // Guard against invalidated extension context (e.g. after reload)
    if (!chrome.runtime?.id) {
      alert('Nova Driving Range: extension was updated or reloaded.\nPlease refresh this page.');
      return;
    }
    const threeScript = document.createElement('script');
    threeScript.src = chrome.runtime.getURL('three.min.js');
    threeScript.onload = () => {
      // Load sounds.js, then scene.js
      const soundsScript = document.createElement('script');
      soundsScript.src = chrome.runtime.getURL('sounds.js');
      soundsScript.dataset.ringSound  = chrome.runtime.getURL('sonic.wav');
      soundsScript.dataset.driver     = chrome.runtime.getURL('driver.mp3');
      soundsScript.dataset.irons      = chrome.runtime.getURL('irons.mp3');
      soundsScript.dataset.background = chrome.runtime.getURL('background.mp3');
      soundsScript.dataset.wind       = chrome.runtime.getURL('wind.mp3');
      soundsScript.onload = () => {
        const sceneScript = document.createElement('script');
        sceneScript.src = chrome.runtime.getURL('scene.js');
        sceneScript.dataset.fontUrl = chrome.runtime.getURL('fonts/LexendDeca-Bold.ttf');
        document.head.appendChild(sceneScript);
      };
      document.head.appendChild(soundsScript);
    };
    document.head.appendChild(threeScript);
  }

  // scene.js posts 'gsv-ready' when it has initialised
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'gsv-ready') {
      sceneReady = true;
      // Only send shot data if we have a real shot loaded
      if (shotHasData()) window.postMessage({ type: 'gsv-init', shot }, '*');
      renderLandingDots();
    }
  });

  // ── Open overlay ───────────────────────────────────────────────────────
  btn.addEventListener('click', () => {
    overlay.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(injectScripts));
    if (sceneReady) renderLandingDots();
  });

})();

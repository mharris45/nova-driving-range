// content.js — runs in the extension's isolated world
// Handles UI, Chrome storage, and communicates with scene.js via postMessage

(function () {
  if (document.getElementById('gsv-overlay')) return;

  // ── Shot data (defaults until live data arrives) ────────────────────────
  const shot = {
    ballSpeed:0, vLaunchAngle:0, hLaunchAngle:0,
    totalSpin:0, spinAxis:0, backspin:0, sidespin:0,
    carryDist:0, totalDist:0, offlineDist:0,
    peakHeight:0, hangTime:0, descentAngle:0,
    clubSpeed:0, smashFactor:0, distEfficiency:0,
  };

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
    const rawHLA       = dv(fields.horizontal_launch_angle);
    const rawSpin      = dv(fields.spin);
    const rawBackspin  = dv(fields.backspin);
    const rawSidespin  = dv(fields.sidespin);
    const rawSpinAxis  = dv(fields.spin_axis);

    if (rawBallSpeed < 1) return false; // skip invalid/empty shots

    // Ball speed from Firestore is in m/s — convert to mph for display and calc
    const ballSpeedMph = rawBallSpeed * 2.23694;

    // Raw data
    shot.ballSpeed    = Math.round(ballSpeedMph * 10) / 10;
    shot.vLaunchAngle = Math.round(rawVLA * 10) / 10;
    shot.hLaunchAngle = Math.round(rawHLA * 10) / 10;
    shot.totalSpin    = Math.round(rawSpin);
    shot.backspin     = Math.round(rawBackspin);
    shot.sidespin     = Math.round(rawSidespin);
    shot.spinAxis     = Math.round(rawSpinAxis * 10) / 10;

    // Calculated data (using mph)
    const calc = calcFlightFromRaw(ballSpeedMph, rawVLA, rawHLA, rawSpin, rawSpinAxis);
    // Negate offline to correct left/right orientation in the scene
    calc.offlineDist = -calc.offlineDist;
    Object.assign(shot, calc);

    // Derived
    shot.smashFactor    = 0;
    shot.clubSpeed      = 0;
    shot.distEfficiency = shot.carryDist > 0
      ? Math.round(shot.carryDist / shot.ballSpeed * 100) / 100
      : 0;

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
        renderStats();
        renderEditBar();
        // Only send to scene if overlay is already open — don't auto-open
        if (overlay.style.display === 'flex') {
          window.postMessage({ type:'gsv-update', shot }, '*');
        }
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
        <button id="gsv-replay-btn" style="background:#1e3a2f;border:1px solid #52b788;color:#52b788;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">▶ REPLAY</button>
        <button id="gsv-save-btn"   style="background:#1a2a3a;border:1px solid #388bfd;color:#388bfd;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;">💾 SAVE</button>
        <span id="gsv-save-status"  style="font-size:11px;color:#52b788;min-width:80px;"></span>
        <button id="gsv-close-btn"  style="background:none;border:none;color:#6e7681;font-size:22px;cursor:pointer;padding:0 4px;">✕</button>
      </div>
    </div>

    <div id="gsv-canvas-wrap" style="flex:1;position:relative;overflow:hidden;min-height:0;"></div>

    <div id="gsv-statsbar" style="display:flex;flex-wrap:wrap;gap:6px;padding:10px 20px;
      background:#0d1117;border-top:1px solid #21262d;flex-shrink:0;"></div>

    <div id="gsv-editbar" style="display:none;flex-wrap:wrap;gap:6px;
      padding:10px 20px 14px;background:#0a0f15;border-top:1px solid #21262d;flex-shrink:0;"></div>

    <div style="text-align:center;padding:5px;background:#0d1117;
      border-top:1px solid #161b22;flex-shrink:0;">
      <button id="gsv-edit-toggle" style="background:none;border:none;
        color:#6e7681;font-size:11px;cursor:pointer;letter-spacing:.5px;">▲ EDIT SHOT DATA</button>
    </div>
  `;
  document.body.appendChild(overlay);

  // ── Stats bar ──────────────────────────────────────────────────────────
  const statDefs = [
    ['Ball Speed','ballSpeed','mph'],['Carry','carryDist','yds'],
    ['Total','totalDist','yds'],['Launch ↕','vLaunchAngle','°'],
    ['Launch ↔','hLaunchAngle','°'],['Peak Ht','peakHeight','yds'],
    ['Hang Time','hangTime','s'],['Spin','totalSpin','rpm'],
    ['Backspin','backspin','rpm'],['Sidespin','sidespin','rpm'],
    ['Spin Axis','spinAxis','°'],['Descent','descentAngle','°'],
    ['Offline','offlineDist','yds'],
  ];

  function renderStats() {
    overlay.querySelector('#gsv-statsbar').innerHTML = statDefs.map(([l,k,u]) => `
      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;
        padding:6px 14px;text-align:center;min-width:80px;">
        <div style="color:#52b788;font-size:14px;font-weight:700;">${shot[k]}${u}</div>
        <div style="color:#6e7681;font-size:9px;margin-top:2px;text-transform:uppercase;
          letter-spacing:.5px;">${l}</div>
      </div>`).join('');
  }

  // ── Edit bar ───────────────────────────────────────────────────────────
  const editDefs = [
    ['Carry (yds)','carryDist'],['Total (yds)','totalDist'],
    ['Ball Speed (mph)','ballSpeed'],['Peak Ht (yds)','peakHeight'],
    ['V-Launch (°)','vLaunchAngle'],['Hang Time (s)','hangTime'],
    ['Club Speed (mph)','clubSpeed'],['Total Spin (rpm)','totalSpin'],
    ['Offline (yds)','offlineDist'],['H-Launch (°)','hLaunchAngle'],
  ];

  function renderEditBar() {
    overlay.querySelector('#gsv-editbar').innerHTML = editDefs.map(([l,k]) => `
      <div style="display:flex;flex-direction:column;min-width:110px;">
        <span style="color:#6e7681;font-size:9px;text-transform:uppercase;
          letter-spacing:.5px;margin-bottom:3px;">${l}</span>
        <input data-key="${k}" type="number" step="0.1" value="${shot[k]}"
          style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;
          border-radius:6px;padding:4px 8px;font-size:12px;outline:none;width:100%;"/>
      </div>`).join('');
    overlay.querySelectorAll('#gsv-editbar input').forEach(inp => {
      inp.addEventListener('change', () => {
        shot[inp.dataset.key] = parseFloat(inp.value) || 0;
        renderStats();
        window.postMessage({ type:'gsv-update', shot }, '*');
      });
    });
  }

  renderStats();
  renderEditBar();

  // ── Edit toggle ────────────────────────────────────────────────────────
  let editOpen = false;
  overlay.querySelector('#gsv-edit-toggle').addEventListener('click', () => {
    editOpen = !editOpen;
    overlay.querySelector('#gsv-editbar').style.display = editOpen ? 'flex' : 'none';
    overlay.querySelector('#gsv-edit-toggle').textContent =
      editOpen ? '▼ EDIT SHOT DATA' : '▲ EDIT SHOT DATA';
  });

  // ── Save to Google Sheet ───────────────────────────────────────────────
  overlay.querySelector('#gsv-save-btn').addEventListener('click', () => {
    chrome.storage.sync.get(['scriptUrl'], ({ scriptUrl }) => {
      const st = overlay.querySelector('#gsv-save-status');
      if (!scriptUrl) {
        st.style.color = '#f85149';
        st.textContent = '⚠ No URL in Options';
        setTimeout(() => st.textContent = '', 3000);
        return;
      }
      st.style.color = '#8b949e'; st.textContent = 'Saving…';
      fetch(scriptUrl, {
        method: 'POST', body: JSON.stringify(shot), mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
      })
      .then(() => { st.style.color='#52b788'; st.textContent='✓ Saved!'; setTimeout(()=>st.textContent='',3000); })
      .catch(() => { st.style.color='#f85149'; st.textContent='✗ Failed'; setTimeout(()=>st.textContent='',3000); });
    });
  });

  // ── Replay button ──────────────────────────────────────────────────────
  overlay.querySelector('#gsv-replay-btn').addEventListener('click', () => {
    window.postMessage({ type: 'gsv-replay' }, '*');
  });

  // ── Close button ───────────────────────────────────────────────────────
  overlay.querySelector('#gsv-close-btn').addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  // ── Inject Three.js then scene.js into the MAIN world ──────────────────
  let sceneReady = false;

  function injectScripts() {
    if (sceneReady) {
      // Already loaded — just send current shot data
      window.postMessage({ type: 'gsv-init', shot }, '*');
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
      const sceneScript = document.createElement('script');
      sceneScript.src = chrome.runtime.getURL('scene.js');
      document.head.appendChild(sceneScript);
    };
    document.head.appendChild(threeScript);
  }

  // scene.js posts 'gsv-ready' when it has initialised
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'gsv-ready') {
      sceneReady = true;
      window.postMessage({ type: 'gsv-init', shot }, '*');
    }
  });

  // ── Open overlay ───────────────────────────────────────────────────────
  btn.addEventListener('click', () => {
    overlay.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(injectScripts));
  });

})();

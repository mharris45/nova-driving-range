// report.js — Club Report dashboard
// Reads savedShots from chrome.storage.local and renders per-club analytics.

(function () {
  const clubSelect  = document.getElementById('club-select');
  const shotCountEl = document.getElementById('shot-count');
  const emptyEl     = document.getElementById('empty');
  const contentEl   = document.getElementById('content');
  const dashboardEl = document.getElementById('dashboard');
  const qualityEl   = document.getElementById('quality-bars');

  let allShots = [];

  // ── Close button ────────────────────────────────────────────────────────
  document.getElementById('close-btn').addEventListener('click', () => {
    window.close();
  });

  // ── Bootstrap ───────────────────────────────────────────────────────────
  chrome.storage.local.get(['savedShots'], ({ savedShots }) => {
    allShots = savedShots || [];
    if (allShots.length === 0) {
      emptyEl.style.display = '';
      contentEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    contentEl.style.display = '';
    populateClubs();
    render();
  });

  function populateClubs() {
    const clubs = [...new Set(allShots.map(s => s.club || 'Unknown'))];
    // Add "All Clubs" option first
    clubSelect.innerHTML = '<option value="__all__">All Clubs</option>' +
      clubs.map(c => `<option value="${c}">${c}</option>`).join('');

    // If URL has ?club=XXX, pre-select it
    const params = new URLSearchParams(location.search);
    const pre = params.get('club');
    if (pre && clubs.includes(pre)) clubSelect.value = pre;

    clubSelect.addEventListener('change', render);
  }

  // ── Render everything ───────────────────────────────────────────────────
  function render() {
    const club = clubSelect.value;
    const isAll = club === '__all__';
    const shots = isAll
      ? allShots
      : allShots.filter(s => (s.club || 'Unknown') === club);

    const allPanel = document.getElementById('all-clubs-panel');
    const singlePanel = document.getElementById('single-club-panel');

    shotCountEl.textContent = `${shots.length} shot${shots.length !== 1 ? 's' : ''}`;
    if (shots.length === 0) {
      dashboardEl.innerHTML = '';
      qualityEl.innerHTML = '';
      allPanel.style.display = 'none';
      singlePanel.style.display = '';
      return;
    }

    if (isAll) {
      allPanel.style.display = '';
      singlePanel.style.display = '';
      renderAllClubs(allShots);
    } else {
      allPanel.style.display = 'none';
      singlePanel.style.display = '';
    }

    renderStats(shots);
    renderQuality(shots);
    renderDispersion(shots);
    renderHistogram(shots);
    renderSpeedChart('ballspeed-canvas', 'Ball Speed', 'mph', shots.map(s => s.ballSpeed || 0).filter(v => v > 0));
    renderSpeedChart('clubspeed-canvas', 'Club Speed', 'mph', shots.map(s => s.clubSpeed || 0).filter(v => v > 0));
    const classified = classifyShots(shots);
    renderSwingPath(shots, classified);
    renderPathDistance(shots, classified);
  }

  // ── Stat cards ──────────────────────────────────────────────────────────
  function avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function renderStats(shots) {
    const carries = shots.map(s => s.carryDist || 0).filter(v => v > 0);
    const totals  = shots.map(s => s.totalDist || 0).filter(v => v > 0);
    const speeds  = shots.map(s => s.ballSpeed || 0).filter(v => v > 0);
    const smash   = shots.map(s => s.smashFactor || 0).filter(v => v > 0);
    const peaks   = shots.map(s => s.peakHeight || 0).filter(v => v > 0);
    const spins   = shots.map(s => s.totalSpin || 0).filter(v => v > 0);
    const offline = shots.map(s => s.offlineDist || 0);
    const descent = shots.map(s => s.descentAngle || 0).filter(v => v > 0);

    const avgCarry = avg(carries);
    const avgTotal = avg(totals);
    const minCarry = carries.length ? Math.min(...carries) : 0;
    const maxCarry = carries.length ? Math.max(...carries) : 0;

    const stats = [
      { label: 'Avg Carry',    value: avgCarry.toFixed(1),         unit: 'yds', sub: `${minCarry.toFixed(0)}–${maxCarry.toFixed(0)} range` },
      { label: 'Avg Total',    value: avgTotal.toFixed(1),         unit: 'yds' },
      { label: 'Ball Speed',   value: avg(speeds).toFixed(1),      unit: 'mph' },
      { label: 'Smash Factor', value: avg(smash).toFixed(2),       unit: '' },
      { label: 'Peak Height',  value: avg(peaks).toFixed(1),       unit: 'yds' },
      { label: 'Total Spin',   value: Math.round(avg(spins)).toLocaleString(), unit: 'rpm' },
      { label: 'Avg Offline',  value: avg(offline).toFixed(1),     unit: 'yds', sub: offlineLabel(avg(offline)) },
      { label: 'Descent Angle',value: avg(descent).toFixed(1),     unit: '°' },
    ];

    dashboardEl.innerHTML = stats.map(s => `
      <div class="stat-card">
        <div class="label">${s.label}</div>
        <div class="value">${s.value}<span class="unit">${s.unit}</span></div>
        ${s.sub ? `<div class="sub">${s.sub}</div>` : ''}
      </div>
    `).join('');
  }

  function offlineLabel(v) {
    if (Math.abs(v) < 0.5) return 'Center';
    return v > 0 ? 'Right tendency' : 'Left tendency';
  }

  // ── Shot quality breakdown ──────────────────────────────────────────────
  function renderQuality(shots) {
    // Group by shotName or shotRank
    const counts = {};
    let labeled = 0;
    for (const s of shots) {
      const name = s.shotName || s.shotRank || '';
      if (!name) continue;
      labeled++;
      counts[name] = (counts[name] || 0) + 1;
    }

    if (labeled === 0) {
      qualityEl.innerHTML = '<div style="font-size:12px;color:#8b949e;">No shot quality data available</div>';
      return;
    }

    const colors = {
      'A+': '#52b788', 'A': '#52b788',
      'B+': '#4da6ff', 'B': '#4da6ff',
      'C+': '#f0c040', 'C': '#f0c040',
      'D': '#f85149', 'F': '#f85149',
    };

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    qualityEl.innerHTML = sorted.map(([name, count]) => {
      const pct = (count / labeled * 100).toFixed(0);
      const color = colors[name] || rankColor(name);
      return `
        <div class="quality-row">
          <span class="q-label">${name}</span>
          <div class="q-bar-bg"><div class="q-bar" style="width:${pct}%;background:${color};"></div></div>
          <span class="q-pct">${pct}%</span>
        </div>`;
    }).join('');
  }

  function rankColor(name) {
    const n = name.toLowerCase();
    if (n.includes('straight') || n.includes('push draw')) return '#52b788';
    if (n.includes('draw'))  return '#4da6ff';
    if (n.includes('fade'))  return '#f0c040';
    if (n.includes('hook') || n.includes('slice')) return '#f85149';
    return '#8b949e';
  }

  // ── Dispersion scatter plot ─────────────────────────────────────────────
  function renderDispersion(shots) {
    const canvas = document.getElementById('dispersion-canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientWidth; // square
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const carries = shots.map(s => s.carryDist || 0);
    const offlines = shots.map(s => s.offlineDist || 0);

    if (carries.length === 0) return;

    const avgCarry = avg(carries);
    const maxOff = Math.max(30, Math.max(...offlines.map(Math.abs)) * 1.3);
    const carryRange = Math.max(40, (Math.max(...carries) - Math.min(...carries)) * 1.3);
    const carryCenter = avgCarry;

    const pad = 50;
    const pw = w - pad * 2;
    const ph = h - pad * 2;

    function toX(off) { return pad + pw / 2 + (off / maxOff) * (pw / 2); }
    function toY(carry) { return pad + ph - ((carry - carryCenter + carryRange / 2) / carryRange) * ph; }

    // Grid lines
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;

    // Vertical center line
    ctx.beginPath();
    ctx.moveTo(toX(0), pad);
    ctx.lineTo(toX(0), h - pad);
    ctx.stroke();

    // Horizontal avg carry line
    ctx.beginPath();
    ctx.moveTo(pad, toY(avgCarry));
    ctx.lineTo(w - pad, toY(avgCarry));
    ctx.stroke();

    // Yard markers on offline axis
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    const offStep = maxOff > 60 ? 20 : maxOff > 30 ? 10 : 5;
    for (let v = -Math.floor(maxOff / offStep) * offStep; v <= maxOff; v += offStep) {
      const x = toX(v);
      if (x < pad || x > w - pad) continue;
      ctx.fillText(`${v > 0 ? '+' : ''}${v}`, x, h - pad + 16);
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, h - pad);
      ctx.strokeStyle = '#21262d';
      ctx.stroke();
    }
    ctx.fillText('← Left     Offline (yds)     Right →', w / 2, h - 8);

    // Carry axis labels
    ctx.textAlign = 'right';
    const carryStep = carryRange > 80 ? 20 : carryRange > 40 ? 10 : 5;
    const carryMin = carryCenter - carryRange / 2;
    const carryMax = carryCenter + carryRange / 2;
    for (let v = Math.ceil(carryMin / carryStep) * carryStep; v <= carryMax; v += carryStep) {
      const y = toY(v);
      if (y < pad || y > h - pad) continue;
      ctx.fillText(`${v.toFixed(0)}`, pad - 6, y + 4);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.strokeStyle = '#21262d';
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Carry (yds)', 0, 0);
    ctx.restore();

    // Plot dots — oldest first, newest on top
    for (let i = 0; i < shots.length; i++) {
      const carry = shots[i].carryDist || 0;
      const off = shots[i].offlineDist || 0;
      const age = shots.length > 1 ? i / (shots.length - 1) : 1;
      const alpha = 0.25 + age * 0.65;
      const x = toX(off);
      const y = toY(carry);

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor(shots[i], alpha);
      ctx.fill();
    }

    // Average marker
    const avgOff = avg(offlines);
    ctx.beginPath();
    ctx.arc(toX(avgOff), toY(avgCarry), 8, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,140,0,0.3)';
    ctx.fill();
  }

  function dotColor(shot, alpha) {
    const name = (shot.shotName || '').toLowerCase();
    if (name.includes('straight')) return `rgba(82,183,136,${alpha})`;
    if (name.includes('draw'))     return `rgba(77,166,255,${alpha})`;
    if (name.includes('fade'))     return `rgba(240,192,64,${alpha})`;
    if (name.includes('hook'))     return `rgba(248,81,73,${alpha})`;
    if (name.includes('slice'))    return `rgba(248,81,73,${alpha})`;
    if (shot.shotColor) {
      return `rgba(${hexToRgb(shot.shotColor)},${alpha})`;
    }
    return `rgba(77,166,255,${alpha})`;
  }

  function hexToRgb(hex) {
    const m = hex.replace('#', '').match(/.{2}/g);
    if (!m) return '77,166,255';
    return m.map(h => parseInt(h, 16)).join(',');
  }

  // ── Offline distribution histogram ──────────────────────────────────────
  function renderHistogram(shots) {
    const canvas = document.getElementById('histogram-canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 320;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const offlines = shots.map(s => s.offlineDist || 0);
    if (offlines.length < 2) return;

    const mean = avg(offlines);
    const stdDev = Math.sqrt(avg(offlines.map(v => (v - mean) ** 2)));
    const maxAbs = Math.max(30, Math.max(...offlines.map(Math.abs)) * 1.2);

    // Build histogram bins
    const binCount = 21;
    const binWidth = (maxAbs * 2) / binCount;
    const bins = new Array(binCount).fill(0);
    for (const v of offlines) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v + maxAbs) / binWidth)));
      bins[idx]++;
    }
    const maxBin = Math.max(...bins, 1);

    const pad = { top: 20, right: 20, bottom: 40, left: 20 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    // Draw bars
    const barW = pw / binCount;
    for (let i = 0; i < binCount; i++) {
      const barH = (bins[i] / maxBin) * ph;
      const x = pad.left + i * barW;
      const y = pad.top + ph - barH;
      ctx.fillStyle = 'rgba(77,166,255,0.5)';
      ctx.fillRect(x + 1, y, barW - 2, barH);
    }

    // Draw normal curve overlay
    if (stdDev > 0.1) {
      ctx.beginPath();
      ctx.strokeStyle = '#52b788';
      ctx.lineWidth = 2;
      const peakPdf = 1 / (stdDev * Math.sqrt(2 * Math.PI));
      for (let px = 0; px <= pw; px++) {
        const val = -maxAbs + (px / pw) * maxAbs * 2;
        const pdf = Math.exp(-0.5 * ((val - mean) / stdDev) ** 2) / (stdDev * Math.sqrt(2 * Math.PI));
        const y = pad.top + ph - (pdf / peakPdf) * ph * 0.9;
        if (px === 0) ctx.moveTo(pad.left + px, y);
        else ctx.lineTo(pad.left + px, y);
      }
      ctx.stroke();
    }

    // Center line
    const centerX = pad.left + ((mean + maxAbs) / (maxAbs * 2)) * pw;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(centerX, pad.top);
    ctx.lineTo(centerX, pad.top + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // X axis labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    const step = maxAbs > 60 ? 20 : maxAbs > 30 ? 10 : 5;
    for (let v = -Math.floor(maxAbs / step) * step; v <= maxAbs; v += step) {
      const x = pad.left + ((v + maxAbs) / (maxAbs * 2)) * pw;
      ctx.fillText(`${v > 0 ? '+' : ''}${v}`, x, h - pad.bottom + 16);
    }
    ctx.fillText('← Left     Offline (yds)     Right →', w / 2, h - 4);

    // Stats label
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.fillText(`μ = ${mean.toFixed(1)}   σ = ${stdDev.toFixed(1)}`, pad.left + 4, pad.top + 14);
  }

  // ── Shared swing path classification ──────────────────────────────────
  // Inferred from the curve between launch direction (hLaunchAngle) and
  // landing point (offlineDist).  If the ball curves L→R it's a fade/slice
  // pattern (out-to-in path); R→L is draw/hook (in-to-out path).
  // Sidespin sign is used as confirmation when available.
  function classifyShots(shots) {
    const classified = [];
    for (const s of shots) {
      const hla = s.hLaunchAngle || 0;
      const off = s.offlineDist || 0;
      const carry = s.carryDist || 0;
      if (carry < 10) continue;

      const straightLanding = carry * Math.tan((hla * Math.PI) / 180);
      const curve = off - straightLanding;
      const ss = s.sidespin || 0;
      const threshold = 1.0;

      let type;
      if (Math.abs(curve) < threshold && Math.abs(ss) < 200) {
        type = 'straight';
      } else if (curve > 0 || (Math.abs(curve) < threshold && ss > 200)) {
        type = 'oti';
      } else {
        type = 'ito';
      }

      classified.push({ type, curve, hla, off, carry, shot: s });
    }
    return classified;
  }

  // ── Swing path tendency ─────────────────────────────────────────────────
  function renderSwingPath(shots, classified) {
    const summaryEl = document.getElementById('path-summary');
    const canvas    = document.getElementById('path-canvas');

    if (classified.length < 3) {
      summaryEl.innerHTML = '<span style="color:#8b949e;">Need at least 3 shots for swing path analysis</span>';
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const oti = classified.filter(s => s.type === 'oti');
    const ito = classified.filter(s => s.type === 'ito');
    const str = classified.filter(s => s.type === 'straight');
    const total = classified.length;

    const otiPct = ((oti.length / total) * 100).toFixed(0);
    const itoPct = ((ito.length / total) * 100).toFixed(0);
    const strPct = ((str.length / total) * 100).toFixed(0);

    // Determine dominant pattern
    let dominant, dominantDesc;
    if (oti.length > ito.length && oti.length > str.length) {
      dominant = 'Out-to-In';
      dominantDesc = 'Your club tends to cut across the ball from outside the target line. This produces fades and slices — the ball curves left to right.';
    } else if (ito.length > oti.length && ito.length > str.length) {
      dominant = 'In-to-Out';
      dominantDesc = 'Your club tends to swing from inside the target line outward. This produces draws and hooks — the ball curves right to left.';
    } else {
      dominant = 'Neutral';
      dominantDesc = 'Your swing path is fairly balanced with no strong out-to-in or in-to-out tendency.';
    }

    const avgCurve = avg(classified.map(s => s.curve));
    const curveDir = Math.abs(avgCurve) < 0.5 ? 'straight' : avgCurve > 0 ? 'right (fade)' : 'left (draw)';

    summaryEl.innerHTML = `
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;">
        <div>
          <span style="color:#8b949e;">Dominant path:</span>
          <strong style="color:${dominant === 'Out-to-In' ? '#f0c040' : dominant === 'In-to-Out' ? '#4da6ff' : '#52b788'};font-size:16px;margin-left:6px;">${dominant}</strong>
        </div>
        <div style="color:#8b949e;font-size:12px;max-width:480px;">${dominantDesc}</div>
      </div>
      <div style="margin-top:8px;color:#8b949e;font-size:12px;">
        Avg curve: <strong style="color:#e6edf3;">${Math.abs(avgCurve).toFixed(1)} yds ${curveDir}</strong>
      </div>
    `;

    // ── Draw the path chart: 3 horizontal bars ──────────────────────────
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 280;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const pad = { top: 30, right: 30, bottom: 20, left: 120 };
    const pw = w - pad.left - pad.right;
    const barData = [
      { label: 'In-to-Out (Draw)',  count: ito.length, pct: itoPct, color: '#4da6ff' },
      { label: 'Straight',          count: str.length, pct: strPct, color: '#52b788' },
      { label: 'Out-to-In (Fade)',  count: oti.length, pct: otiPct, color: '#f0c040' },
    ];

    const barH = 36;
    const gap = 24;
    const totalH = barData.length * barH + (barData.length - 1) * gap;
    const startY = pad.top + (h - pad.top - pad.bottom - totalH) / 2;

    for (let i = 0; i < barData.length; i++) {
      const d = barData[i];
      const y = startY + i * (barH + gap);
      const barW = total > 0 ? (d.count / total) * pw : 0;

      // Label
      ctx.fillStyle = '#e6edf3';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(d.label, pad.left - 12, y + barH / 2 + 5);

      // Bar background
      ctx.fillStyle = '#21262d';
      ctx.beginPath();
      ctx.roundRect(pad.left, y, pw, barH, 6);
      ctx.fill();

      // Bar fill
      if (barW > 0) {
        ctx.fillStyle = d.color;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.roundRect(pad.left, y, Math.max(barW, 8), barH, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Count + percentage
      ctx.fillStyle = '#e6edf3';
      ctx.font = 'bold 13px system-ui';
      ctx.textAlign = 'left';
      const text = `${d.count}  (${d.pct}%)`;
      const textX = pad.left + barW + 10;
      ctx.fillText(text, textX > w - pad.right - 60 ? pad.left + 8 : textX, y + barH / 2 + 5);
    }

    // Shot-by-shot timeline along bottom
    const tlY = startY + totalH + gap;
    const tlH = 8;
    const dotW = Math.min(12, (pw - 4) / classified.length);
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('Recent shots →', pad.left, tlY - 4);

    for (let i = 0; i < classified.length; i++) {
      const s = classified[i];
      ctx.fillStyle = s.type === 'oti' ? '#f0c040' : s.type === 'ito' ? '#4da6ff' : '#52b788';
      ctx.globalAlpha = 0.8;
      ctx.fillRect(pad.left + i * dotW, tlY, Math.max(dotW - 1, 2), tlH);
    }
    ctx.globalAlpha = 1;
  }

  // ── Speed distribution + trendline chart ────────────────────────────────
  function renderSpeedChart(canvasId, title, unit, values) {
    const canvas = document.getElementById(canvasId);
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 300;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    if (values.length < 2) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(`No ${title.toLowerCase()} data`, w / 2, h / 2);
      return;
    }

    const mean = avg(values);
    const stdDev = Math.sqrt(avg(values.map(v => (v - mean) ** 2)));
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const rangeV = Math.max(maxV - minV, 5);
    const lo = minV - rangeV * 0.15;
    const hi = maxV + rangeV * 0.15;

    const pad = { top: 30, right: 20, bottom: 50, left: 44 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    // ── Histogram ──
    const binCount = Math.min(25, Math.max(9, Math.round(values.length / 2)));
    const binWidth = (hi - lo) / binCount;
    const bins = new Array(binCount).fill(0);
    for (const v of values) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / binWidth)));
      bins[idx]++;
    }
    const maxBin = Math.max(...bins, 1);

    const barW = pw / binCount;
    for (let i = 0; i < binCount; i++) {
      const barH = (bins[i] / maxBin) * ph;
      const x = pad.left + i * barW;
      const y = pad.top + ph - barH;
      ctx.fillStyle = 'rgba(77,166,255,0.4)';
      ctx.fillRect(x + 1, y, barW - 2, barH);
    }

    // ── Normal curve ──
    if (stdDev > 0.1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(77,166,255,0.8)';
      ctx.lineWidth = 2;
      const peakPdf = 1 / (stdDev * Math.sqrt(2 * Math.PI));
      for (let px = 0; px <= pw; px++) {
        const val = lo + (px / pw) * (hi - lo);
        const pdf = Math.exp(-0.5 * ((val - mean) / stdDev) ** 2) / (stdDev * Math.sqrt(2 * Math.PI));
        const y = pad.top + ph - (pdf / peakPdf) * ph * 0.85;
        if (px === 0) ctx.moveTo(pad.left + px, y);
        else ctx.lineTo(pad.left + px, y);
      }
      ctx.stroke();
    }

    // ── Rolling average trendline (overlaid as small line chart) ──
    // Drawn in the top portion of the chart
    const trendH = ph * 0.35;
    const trendY0 = pad.top + 4;
    const windowSize = Math.max(3, Math.round(values.length / 8));
    const rolling = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - windowSize + 1);
      const slice = values.slice(start, i + 1);
      rolling.push(avg(slice));
    }
    const trendMin = Math.min(...rolling);
    const trendMax = Math.max(...rolling);
    const trendRange = Math.max(trendMax - trendMin, 0.5);

    ctx.beginPath();
    ctx.strokeStyle = '#52b788';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    for (let i = 0; i < rolling.length; i++) {
      const x = pad.left + (i / (rolling.length - 1)) * pw;
      const y = trendY0 + trendH - ((rolling[i] - trendMin) / trendRange) * trendH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Trendline labels
    ctx.fillStyle = '#52b788';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(`${rolling[rolling.length - 1].toFixed(1)} ${unit}`, pad.left + pw + 3 - 56, trendY0 + 10);
    ctx.fillStyle = '#8b949e';
    ctx.fillText('trend →', pad.left + 2, trendY0 + 10);

    // ── Mean line ──
    const meanX = pad.left + ((mean - lo) / (hi - lo)) * pw;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(meanX, pad.top);
    ctx.lineTo(meanX, pad.top + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── X axis labels ──
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    const step = rangeV > 40 ? 10 : rangeV > 20 ? 5 : rangeV > 8 ? 2 : 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const x = pad.left + ((v - lo) / (hi - lo)) * pw;
      ctx.fillText(v.toFixed(0), x, h - pad.bottom + 16);
    }
    ctx.fillText(`${title} (${unit})`, w / 2, h - 6);

    // ── Stats ──
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.fillText(`μ = ${mean.toFixed(1)}   σ = ${stdDev.toFixed(1)}   range: ${minV.toFixed(1)}–${maxV.toFixed(1)}`, pad.left + 4, h - pad.bottom - 6);
  }

  // ── All Clubs distance map ───────────────────────────────────────────────
  const CLUB_PALETTE = [
    '#4da6ff', '#52b788', '#f0c040', '#da8ee7', '#ff6b6b',
    '#45d9c8', '#ff9f43', '#a29bfe', '#fd79a8', '#6c5ce7',
    '#00cec9', '#e17055', '#74b9ff', '#55efc4', '#ffeaa7',
  ];

  function renderAllClubs(shots) {
    const canvas = document.getElementById('allclubs-canvas');
    const legendEl = document.getElementById('allclubs-legend');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 600;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    // Group shots by club
    const clubMap = {};
    for (const s of shots) {
      const c = s.club || 'Unknown';
      if (!clubMap[c]) clubMap[c] = [];
      clubMap[c].push(s);
    }
    const clubNames = Object.keys(clubMap).sort((a, b) => {
      // Sort by avg carry descending so longest club is first
      const avgA = avg(clubMap[a].map(s => s.carryDist || 0));
      const avgB = avg(clubMap[b].map(s => s.carryDist || 0));
      return avgB - avgA;
    });

    // Assign colors
    const clubColor = {};
    clubNames.forEach((c, i) => clubColor[c] = CLUB_PALETTE[i % CLUB_PALETTE.length]);

    // Chart area
    const pad = { top: 20, right: 30, bottom: 50, left: 50 };
    const pw = w - pad.left - pad.right;
    const ph = h - pad.top - pad.bottom;

    // Fixed axes: Y = 0–400 yds, X = spread
    const yMin = 0, yMax = 400;
    const allOff = shots.map(s => s.offlineDist || 0);
    const maxOff = Math.max(40, Math.max(...allOff.map(Math.abs)) * 1.2);

    function toX(off) { return pad.left + pw / 2 + (off / maxOff) * (pw / 2); }
    function toY(carry) { return pad.top + ph - ((carry - yMin) / (yMax - yMin)) * ph; }

    // ── Grid ──
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;

    // Y-axis grid + labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    for (let v = 0; v <= 400; v += 50) {
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(`${v}`, pad.left - 8, y + 4);
    }
    ctx.save();
    ctx.translate(14, pad.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Carry Distance (yds)', 0, 0);
    ctx.restore();

    // X-axis grid + labels
    ctx.textAlign = 'center';
    const offStep = maxOff > 80 ? 20 : maxOff > 40 ? 10 : 5;
    for (let v = -Math.floor(maxOff / offStep) * offStep; v <= maxOff; v += offStep) {
      const x = toX(v);
      if (x < pad.left || x > w - pad.right) continue;
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + ph);
      ctx.strokeStyle = '#21262d';
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(`${v > 0 ? '+' : ''}${v}`, x, h - pad.bottom + 16);
    }
    ctx.fillText('← Left     Offline (yds)     Right →', w / 2, h - 8);

    // Center line
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(toX(0), pad.top);
    ctx.lineTo(toX(0), pad.top + ph);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Plot individual shots (faded dots) ──
    for (const club of clubNames) {
      const color = clubColor[club];
      for (const s of clubMap[club]) {
        const carry = s.carryDist || 0;
        const off = s.offlineDist || 0;
        if (carry < 5) continue;
        const x = toX(off);
        const y = toY(carry);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ── Average bubbles per club (sized by shot count) ──
    const maxCount = Math.max(...clubNames.map(c => clubMap[c].length));
    const minR = 10, maxR = 36;

    for (const club of clubNames) {
      const clubShots = clubMap[club];
      const carries = clubShots.map(s => s.carryDist || 0).filter(v => v > 0);
      const offlines = clubShots.map(s => s.offlineDist || 0);
      if (carries.length === 0) continue;

      const ac = avg(carries);
      const ao = avg(offlines);
      const r = minR + ((clubShots.length / maxCount) * (maxR - minR));
      const x = toX(ao);
      const y = toY(ac);

      // Bubble fill
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = clubColor[club];
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Bubble stroke
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = clubColor[club];
      ctx.lineWidth = 2;
      ctx.stroke();

      // Club label
      ctx.fillStyle = '#e6edf3';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(club, x, y - r - 5);

      // Distance label inside bubble
      ctx.fillStyle = '#e6edf3';
      ctx.font = 'bold 12px system-ui';
      ctx.fillText(`${ac.toFixed(0)}`, x, y + 1);
      ctx.font = '9px system-ui';
      ctx.fillStyle = '#8b949e';
      ctx.fillText('yds', x, y + 12);
    }

    // ── Legend ──
    legendEl.innerHTML = clubNames.map(club => {
      const n = clubMap[club].length;
      const ac = avg(clubMap[club].map(s => s.carryDist || 0).filter(v => v > 0));
      return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${clubColor[club]};display:inline-block;"></span>
        <strong style="color:#e6edf3;">${club}</strong>
        <span style="color:#8b949e;">${ac.toFixed(0)} yds avg · ${n} shots</span>
      </span>`;
    }).join('');
  }

  // ── Distance by swing path ──────────────────────────────────────────────
  function renderPathDistance(shots, classified) {
    const canvas = document.getElementById('pathdist-canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 260;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    if (classified.length < 3) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Need at least 3 shots for path distance comparison', w / 2, h / 2);
      return;
    }

    const groups = [
      { key: 'ito', label: 'In-to-Out (Draw)',  color: '#4da6ff' },
      { key: 'straight', label: 'Straight',      color: '#52b788' },
      { key: 'oti', label: 'Out-to-In (Fade)',   color: '#f0c040' },
    ];

    // Compute stats per group
    for (const g of groups) {
      const members = classified.filter(c => c.type === g.key);
      g.count = members.length;
      g.avgCarry = members.length ? avg(members.map(m => m.carry)) : 0;
      g.avgTotal = members.length ? avg(members.map(m => m.shot.totalDist || m.carry)) : 0;
      g.avgOffline = members.length ? avg(members.map(m => Math.abs(m.off))) : 0;
    }

    const maxDist = Math.max(...groups.map(g => Math.max(g.avgCarry, g.avgTotal)), 1);

    const pad = { top: 40, right: 30, bottom: 40, left: 140 };
    const pw = w - pad.left - pad.right;
    const barH = 22;
    const groupGap = 36;
    const barGap = 4;

    // Header
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('Avg Carry', pad.left, pad.top - 22);
    ctx.fillText('Avg Total', pad.left + 120, pad.top - 22);
    ctx.fillText('Avg |Offline|', pad.left + 240, pad.top - 22);
    ctx.fillText('Shots', pad.left + 370, pad.top - 22);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const topY = pad.top + i * (barH * 2 + barGap + groupGap);

      // Group label
      ctx.fillStyle = '#e6edf3';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(g.label, pad.left - 14, topY + barH / 2 + 5);

      if (g.count === 0) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '12px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText('No shots', pad.left + 4, topY + barH / 2 + 5);
        continue;
      }

      // Carry bar
      const carryW = (g.avgCarry / maxDist) * pw;
      ctx.fillStyle = '#21262d';
      ctx.beginPath();
      ctx.roundRect(pad.left, topY, pw, barH, 4);
      ctx.fill();
      ctx.fillStyle = g.color;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.roundRect(pad.left, topY, Math.max(carryW, 4), barH, 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Carry label
      ctx.fillStyle = '#e6edf3';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(`${g.avgCarry.toFixed(1)} yds carry`, pad.left + carryW + 8, topY + barH / 2 + 4);

      // Total bar
      const totalY = topY + barH + barGap;
      const totalW = (g.avgTotal / maxDist) * pw;
      ctx.fillStyle = '#21262d';
      ctx.beginPath();
      ctx.roundRect(pad.left, totalY, pw, barH, 4);
      ctx.fill();
      ctx.fillStyle = g.color;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.roundRect(pad.left, totalY, Math.max(totalW, 4), barH, 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Total + offline + count label
      ctx.fillStyle = '#8b949e';
      ctx.font = '11px system-ui';
      ctx.fillText(`${g.avgTotal.toFixed(1)} yds total  ·  ${g.avgOffline.toFixed(1)} yds offline  ·  ${g.count} shot${g.count !== 1 ? 's' : ''}`, pad.left + totalW + 8, totalY + barH / 2 + 4);
    }
  }
})();

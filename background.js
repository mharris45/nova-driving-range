// background.js — service worker for persisting shots to chrome.storage.local
// Shots auto-save here on every hit. Data persists across reloads and restarts.
// Use the CSV button in the overlay or options page to export as a file.
//
// Also relays shot-analysis requests to the user-configured DigitalOcean
// GenAI endpoint (Agents or Serverless Inference, OpenAI-compatible).

const SYSTEM_PROMPT = `You are a concise PGA-level golf coach reviewing launch-monitor data.
You receive (1) the most recent shot and (2) the previous up-to-20 shots with the same club.
Respond in 2–4 sentences, plain text, no preamble, no markdown:
- summarize the latest shot (ball flight + quality),
- call out any pattern or recurring issue you see across the recent shots,
- give one specific, actionable focus for the next swing.
Use only the metrics provided — do not invent numbers or infer data that isn't there.`;

function fmtShotLine(s, idx) {
  const tag = idx === 0 ? 'NOW' : `-${idx}`;
  const parts = [
    `${tag}`,
    `bs=${s.ballSpeed}`,
    `cs=${s.clubSpeed}`,
    `smash=${s.smashFactor}`,
    `carry=${s.carryDist}`,
    `total=${s.totalDist}`,
    `off=${s.offlineDist}`,
    `vLA=${s.vLaunchAngle}`,
    `hLA=${s.hLaunchAngle}`,
    `spin=${s.totalSpin}`,
    `back=${s.backspin}`,
    `side=${s.sidespin}`,
    `axis=${s.spinAxis}`,
    `peak=${s.peakHeight}`,
    `hang=${s.hangTime}`,
    `desc=${s.descentAngle}`,
  ];
  if (s.shotName || s.shotRank) parts.push(`type=${(s.shotName || '').trim()}${s.shotRank ? '/' + s.shotRank : ''}`);
  return parts.join(' ');
}

function buildShotPrompt({ shot, recentShots, recentAvgs }) {
  const lines = [];
  lines.push(`Club: ${shot.club}`);
  lines.push('');
  lines.push('Latest shot:');
  lines.push(fmtShotLine(shot, 0));

  if (Array.isArray(recentShots) && recentShots.length) {
    lines.push('');
    lines.push(`Previous ${recentShots.length} shots (newest first):`);
    recentShots.forEach((s, i) => lines.push(fmtShotLine(s, i + 1)));
  }

  if (recentAvgs && Object.keys(recentAvgs).length) {
    lines.push('');
    const avgStr = Object.entries(recentAvgs)
      .map(([k, v]) => `${k}=${Math.round(v * 10) / 10}`)
      .join(', ');
    lines.push(`Averages across the recent ${shot.club} shots: ${avgStr}`);
  }

  lines.push('');
  lines.push('Key: bs=ball speed mph, cs=club speed mph, smash=smash factor, carry/total/off=yards (off + right / − left), vLA/hLA=vertical/horizontal launch°, spin/back/side=rpm, axis=spin axis°, peak=yds, hang=s, desc=descent°.');
  return lines.join('\n');
}

async function callCoach({ endpoint, key, model, userText }) {
  const body = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userText },
    ],
    max_tokens: 320,
    temperature: 0.6,
    stream: false,
  };
  if (model) body.model = model;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200) || resp.statusText}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? '';
  return text.trim();
}

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

  if (msg.type === 'analyze-shot') {
    chrome.storage.local.get(['aiEnabled','aiEndpoint','aiKey','aiModel'], async (cfg) => {
      const o = msg.overrides || {};
      const endpoint = o.endpoint ?? cfg.aiEndpoint;
      const key      = o.key      ?? cfg.aiKey;
      const model    = o.model    ?? cfg.aiModel;

      if (!endpoint || !key) {
        sendResponse({ ok: false, error: 'AI endpoint or API key not set' });
        return;
      }
      // Skip if disabled, unless caller is the test button (sends overrides).
      if (!o.endpoint && !cfg.aiEnabled) {
        sendResponse({ ok: false, error: 'AI coaching disabled' });
        return;
      }

      const userText = msg.testMessage
        ? msg.testMessage
        : buildShotPrompt({
            shot: msg.shot || {},
            recentShots: msg.recentShots || [],
            recentAvgs: msg.recentAvgs,
          });

      try {
        const text = await callCoach({ endpoint, key, model, userText });
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    });
    return true; // async
  }
});

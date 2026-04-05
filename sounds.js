// sounds.js — reusable sound manager for the MAIN world
// Inject before scene.js; pass audio URLs via dataset attributes on the script tag.

(function () {
  if (window.__gsvSoundsLoaded) return;
  window.__gsvSoundsLoaded = true;

  const el = document.currentScript;
  const soundUrls = {
    ring:       el?.dataset?.ringSound   || '',
    driver:     el?.dataset?.driver      || '',
    irons:      el?.dataset?.irons       || '',
    background: el?.dataset?.background  || '',
    wind:       el?.dataset?.wind        || '',
  };

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffers = {};
  const loops = {};  // active looping sources keyed by name

  // Preload all sounds
  Object.entries(soundUrls).forEach(([name, url]) => {
    if (!url) return;
    fetch(url)
      .then(r => r.arrayBuffer())
      .then(ab => ctx.decodeAudioData(ab))
      .then(buf => { buffers[name] = buf; })
      .catch(err => console.warn('[GSV Sound] Failed to load', name, err));
  });

  window.__gsvSounds = {
    // Play a sound once
    play(name) {
      if (ctx.state === 'suspended') ctx.resume();
      const buf = buffers[name];
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    },

    // Start a looping sound (for ambient background/wind)
    loop(name, volume) {
      if (ctx.state === 'suspended') ctx.resume();
      if (loops[name]) return; // already looping
      const buf = buffers[name];
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = volume != null ? volume : 1;
      src.connect(gain).connect(ctx.destination);
      src.start();
      loops[name] = { src, gain };
    },

    // Stop a looping sound
    stopLoop(name) {
      const l = loops[name];
      if (!l) return;
      l.src.stop();
      delete loops[name];
    },

    // Set volume on a running loop
    setLoopVolume(name, volume) {
      const l = loops[name];
      if (l) l.gain.gain.value = volume;
    },
  };
})();

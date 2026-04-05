// scene.js — injected into the MAIN world, THREE is available here

(function () {
  if (window.__gsvSceneLoaded) return;
  window.__gsvSceneLoaded = true;

  let renderer, scene, camera, ball, shadowDisk, trailGeo, trailPos;
  let traj = [], animIdx = 0, running = false;
  let trailLine = null, trailMat = null;

  // Load Lexend Deca font bundled with the extension
  const _fontUrl = document.currentScript?.dataset?.fontUrl;
  const fontReady = _fontUrl
    ? new FontFace('Lexend Deca', `url(${_fontUrl})`).load().then(f => { document.fonts.add(f); return f; })
    : Promise.resolve(null);
  const FLIGHT_FRAMES = 200; // frames for the flight portion
  let shot = {};

  // ── Listen for messages from content.js ─────────────────────────────
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.type) return;

    if (d.type === 'gsv-init') {
      shot = d.shot;
      if (!renderer) initScene();
      else { traj = buildTraj(); replay(); }
    }
    if (d.type === 'gsv-update') {
      shot = d.shot;
      traj = buildTraj();
      replay();
    }
    if (d.type === 'gsv-replay') {
      replay();
    }
  });

  // ── Tell content.js we're ready ──────────────────────────────────────
  window.postMessage({ type: 'gsv-ready' }, '*');

  // ── Trajectory with bounce & rollout ──────────────────────────────────
  // We generate points at a fixed "time" rate so that the animation plays
  // proportionally — flight, bounce, and roll each get duration-appropriate
  // numbers of points.
  function buildTraj() {
    const { carryDist, peakHeight, offlineDist, totalDist, descentAngle } = shot;
    const carry  = carryDist || 0;
    const peak   = peakHeight || 0;
    const offline = offlineDist || 0;
    const total  = totalDist || carry;
    const roll   = total - carry;
    const pts    = [];

    // Phase 1: flight (parabolic arc)
    // More points = smoother. 200 points for the flight portion.
    const FLIGHT = 200;
    for (let i = 0; i <= FLIGHT; i++) {
      const t = i / FLIGHT;
      pts.push([
        t * offline,
        4 * peak * t * (1 - t),
        t * carry,
      ]);
    }

    const onFairway = Math.abs(offline) < 25;

    // Descent angle drives bounce behavior
    const descent = descentAngle || 40;
    // Steeper descent = higher first bounce, less forward travel
    const firstBounceHt = peak * (onFairway ? 0.06 : 0.10) * Math.min(descent / 40, 1.5);
    const bounceForwardFactor = Math.max(0.1, 1.0 - descent / 80);

    // Bounce parameters
    const bounces = onFairway
      ? [{ htScale: 1.0, fwd: 0.22 }, { htScale: 0.35, fwd: 0.10 }, { htScale: 0.12, fwd: 0.04 }, { htScale: 0.04, fwd: 0.015 }]
      : [{ htScale: 1.0, fwd: 0.15 }, { htScale: 0.25, fwd: 0.06 }, { htScale: 0.06, fwd: 0.02 }];

    // Phase 2: bounces — each gets enough points to feel natural
    let curZ = carry;
    let curX = offline;
    let usedBounceDist = 0;
    const PTS_PER_BOUNCE = 40; // enough points for smooth mini-arcs

    for (const b of bounces) {
      const bh = firstBounceHt * b.htScale;
      const fwd = roll * b.fwd * bounceForwardFactor;
      usedBounceDist += fwd;
      if (bh < 0.01 && fwd < 0.05) break; // too small to see
      for (let i = 1; i <= PTS_PER_BOUNCE; i++) {
        const t = i / PTS_PER_BOUNCE;
        pts.push([curX, Math.max(0, 4 * bh * t * (1 - t)), curZ + t * fwd]);
      }
      curZ += fwd;
    }

    // Phase 3: ground roll (long, gradual deceleration)
    const rollRemaining = Math.max(0, roll - usedBounceDist);
    const ROLL_PTS = onFairway ? 120 : 60;
    for (let i = 1; i <= ROLL_PTS; i++) {
      const t = i / ROLL_PTS;
      // Quartic ease-out for very gradual stop
      const ease = 1 - Math.pow(1 - t, 4);
      pts.push([curX, 0, curZ + ease * rollRemaining]);
    }

    return pts;
  }

  const TEE_POS = [0, 0.4, 0]; // ball resting on tee

  function replay() {
    animIdx = 0; animProgress = 0; lastFrameTime = 0;
    running = true;
    if (trailLine) { scene.remove(trailLine); trailLine = null; }
    if (ball) { ball.position.set(TEE_POS[0], TEE_POS[1], TEE_POS[2]); }
    if (camera) { camera.position.set(0, 3, -4); }
  }

  // ── Build scene ───────────────────────────────────────────────────────
  function initScene() {
    const wrap = document.getElementById('gsv-canvas-wrap');
    if (!wrap) return;

    const W = wrap.clientWidth  || window.innerWidth;
    const H = wrap.clientHeight || window.innerHeight - 200;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    Object.assign(renderer.domElement.style, {
      position:'absolute', top:'0', left:'0', width:'100%', height:'100%', display:'block'
    });
    wrap.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    // ── Procedural sky shader (summer day with clouds) ──────────────────
    const skyGeo = new THREE.SphereGeometry(500, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vWorldDir;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          float a = hash(i); float b = hash(i+vec2(1,0));
          float c = hash(i+vec2(0,1)); float d = hash(i+vec2(1,1));
          vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          mat2 rot = mat2(0.8,0.6,-0.6,0.8);
          for (int i = 0; i < 6; i++) { v += a*noise(p); p = rot*p*2.0; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float y = dir.y;

          // Sky gradient — warm blue to pale horizon
          vec3 zenith  = vec3(0.25, 0.55, 0.95);
          vec3 horizon = vec3(0.65, 0.82, 0.96);
          vec3 sky = mix(horizon, zenith, smoothstep(0.0, 0.5, max(y, 0.0)));

          // Sun glow
          vec3 sunDir = normalize(vec3(0.3, 0.45, 0.5));
          float sunDot = max(dot(dir, sunDir), 0.0);
          sky += vec3(1.0, 0.95, 0.8) * pow(sunDot, 256.0) * 2.0;   // sun disk
          sky += vec3(1.0, 0.9, 0.7) * pow(sunDot, 8.0) * 0.3;      // glow halo

          // Clouds — two FBM layers at different scales
          if (y > 0.0) {
            vec2 uv = dir.xz / (y + 0.1) * 3.0;
            float c1 = fbm(uv * 0.8 + vec2(1.3, 2.7));
            float c2 = fbm(uv * 1.6 + vec2(5.1, 3.2));
            float cloud = smoothstep(0.42, 0.72, c1);
            cloud += smoothstep(0.48, 0.78, c2) * 0.5;
            cloud = clamp(cloud, 0.0, 1.0);

            // Cloud color — bright white with subtle grey underside
            vec3 cloudCol = mix(vec3(0.85, 0.87, 0.9), vec3(1.0, 1.0, 1.0), c2);
            sky = mix(sky, cloudCol, cloud * smoothstep(0.0, 0.15, y));
          }

          // Below horizon — fade to a grass-tinted colour
          if (y < 0.0) {
            vec3 groundCol = vec3(0.12, 0.28, 0.12);
            sky = mix(horizon, groundCol, smoothstep(0.0, -0.15, y));
          }

          gl_FragColor = vec4(sky, 1.0);
        }
      `
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    scene.add(skyMesh);

    // Fog matches horizon colour for seamless blending
    scene.background = new THREE.Color(0xa6d1f5);
    scene.fog = new THREE.FogExp2(0xa6d1f5, 0.003);

    camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 600);
    camera.position.set(0, 3, -4);
    camera.lookAt(0, 1, 25);

    window.addEventListener('resize', () => {
      const nW = wrap.clientWidth  || window.innerWidth;
      const nH = wrap.clientHeight || window.innerHeight - 200;
      if (!nW || !nH) return;
      renderer.setSize(nW, nH);
      camera.aspect = nW / nH;
      camera.updateProjectionMatrix();
    });

    // Lights
    scene.add(new THREE.AmbientLight(0x88aacc, 1.2));
    const sun = new THREE.DirectionalLight(0xffe8b0, 2.2);
    sun.position.set(20, 50, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left=-80; sun.shadow.camera.right=80;
    sun.shadow.camera.top=40;   sun.shadow.camera.bottom=-20;
    sun.shadow.camera.near=1;   sun.shadow.camera.far=300;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x4466aa, 0.7);
    fill.position.set(-15, 12, -10);
    scene.add(fill);

    // ── Grass shaders ─────────────────────────────────────────────────────
    const grassVert = `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vUv  = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;

    // Shared noise library — gradient noise + FBM + Voronoi
    const noiseFuncs = `
      vec2 hash2v(vec2 p) {
        p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
      }
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      // Gradient noise (smoother than value noise)
      float gnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
        return mix(mix(dot(hash2v(i+vec2(0,0)),f-vec2(0,0)),
                       dot(hash2v(i+vec2(1,0)),f-vec2(1,0)),u.x),
                   mix(dot(hash2v(i+vec2(0,1)),f-vec2(0,1)),
                       dot(hash2v(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        mat2 rot = mat2(0.8,0.6,-0.6,0.8);
        for (int i = 0; i < 6; i++) { v += a * gnoise(p); p = rot * p * 2.0; a *= 0.5; }
        return v;
      }
      // Voronoi — returns (cell dist, cell random)
      vec2 voronoi(vec2 p) {
        vec2 n = floor(p); vec2 f = fract(p);
        float md = 8.0; float mr = 0.0;
        for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++) {
          vec2 g = vec2(float(i),float(j));
          vec2 o = vec2(hash(n+g), hash(n+g+vec2(31.3,17.7)));
          vec2 r = g + o - f;
          float d = dot(r,r);
          if (d < md) { md = d; mr = hash(n+g+vec2(5.1,3.3)); }
        }
        return vec2(sqrt(md), mr);
      }
    `;

    // Sunlight direction for fake diffuse
    const sunDir = `vec3 sunDir = normalize(vec3(0.4, 1.0, 0.6));`;

    // Rough: wild, uncut grass with clumps and bare patches
    const roughFrag = `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      ` + noiseFuncs + `
      void main() {
        vec2 p = vWorldPos.xz;
        ` + sunDir + `

        // Large terrain undulation
        float terrain = fbm(p * 0.025) * 0.5 + 0.5;
        // Clump pattern via voronoi
        vec2 vor = voronoi(p * 0.3);
        float clump = smoothstep(0.1, 0.5, vor.x);
        // Medium variation
        float med = fbm(p * 0.12 + 5.0) * 0.5 + 0.5;
        // Fine blade-level detail — elongated in random directions per clump
        float angle = vor.y * 6.28;
        vec2 rotP = vec2(cos(angle)*p.x - sin(angle)*p.y, sin(angle)*p.x + cos(angle)*p.y);
        float blades = gnoise(vec2(rotP.x * 25.0, rotP.y * 4.0)) * 0.5 + 0.5;
        // Micro grain
        float micro = gnoise(p * 40.0) * 0.5 + 0.5;

        // Color palette — wider range for rough
        vec3 darkGreen  = vec3(0.04, 0.14, 0.03);
        vec3 midGreen   = vec3(0.09, 0.24, 0.07);
        vec3 limeGreen  = vec3(0.18, 0.38, 0.12);
        vec3 olive       = vec3(0.15, 0.22, 0.06);
        vec3 dryPatch   = vec3(0.20, 0.22, 0.10);
        vec3 bareEarth  = vec3(0.14, 0.12, 0.08);

        // Base from terrain — smoother blending
        vec3 col = mix(darkGreen, midGreen, terrain);
        // Clump color variation — gentle
        col = mix(col, limeGreen, smoothstep(0.35, 0.65, vor.y) * 0.3);
        col = mix(col, olive, (1.0 - clump) * 0.2);
        // Dry patches — subtle, only occasional
        float dryMask = smoothstep(0.3, 0.4, terrain) * smoothstep(0.55, 0.4, med);
        col = mix(col, dryPatch, dryMask * 0.25);
        col = mix(col, bareEarth, smoothstep(0.85, 1.0, vor.x) * 0.15);

        // Blade and micro detail — reduced contrast
        col *= 0.92 + 0.16 * blades;
        col += (micro - 0.5) * 0.015;

        // Fake diffuse lighting
        float ndl = max(dot(vWorldNormal, sunDir), 0.0) * 0.3 + 0.7;
        col *= ndl;

        // Distance fade
        float dist = length(vWorldPos.xz);
        col *= 1.0 - smoothstep(80.0, 300.0, dist) * 0.2;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    // Fairway: tight-mown, striped, lush
    const fairwayFrag = `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      ` + noiseFuncs + `
      void main() {
        vec2 p = vWorldPos.xz;
        ` + sunDir + `

        float n    = fbm(p * 0.08);
        float fine = gnoise(p * 15.0) * 0.5 + 0.5;
        float micro = gnoise(p * 35.0) * 0.5 + 0.5;

        // Mowing stripes — alternating bands along z with slight curve
        float wobble = gnoise(vec2(p.x * 0.15, p.y * 0.02)) * 0.6;
        float stripe = sin((p.y + wobble) * 0.785) * 0.5 + 0.5;
        stripe = smoothstep(0.3, 0.7, stripe);

        // Cross-hatch mowing pattern (subtle diamond)
        float cross = sin((p.y + p.x * 0.08) * 1.5) * 0.5 + 0.5;
        cross = smoothstep(0.4, 0.6, cross);
        stripe = mix(stripe, cross, 0.15);

        vec3 light = vec3(0.18, 0.54, 0.22);
        vec3 dark  = vec3(0.12, 0.40, 0.15);
        vec3 col   = mix(dark, light, stripe);

        // Subtle variation
        col *= 0.92 + 0.16 * (n * 0.5 + 0.5);
        col *= 0.95 + 0.1 * fine;
        col += (micro - 0.5) * 0.012;

        // Fake diffuse
        float ndl = max(dot(vWorldNormal, sunDir), 0.0) * 0.25 + 0.75;
        col *= ndl;

        // Distance fade
        float dist = abs(vWorldPos.z);
        col *= 1.0 - smoothstep(80.0, 300.0, dist) * 0.15;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    // Tee box: very tight-cut, almost putting-green quality with faint stripe
    const teeboxFrag = `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      ` + noiseFuncs + `
      void main() {
        vec2 p = vWorldPos.xz;
        ` + sunDir + `

        float fine = gnoise(p * 20.0) * 0.5 + 0.5;
        float micro = gnoise(p * 50.0) * 0.5 + 0.5;

        // Very subtle mow stripe
        float stripe = sin(p.y * 1.2) * 0.5 + 0.5;
        stripe = smoothstep(0.4, 0.6, stripe);

        vec3 light = vec3(0.16, 0.50, 0.20);
        vec3 dark  = vec3(0.12, 0.42, 0.16);
        vec3 col   = mix(dark, light, stripe);

        col *= 0.94 + 0.12 * fine;
        col += (micro - 0.5) * 0.01;

        float ndl = max(dot(vWorldNormal, sunDir), 0.0) * 0.2 + 0.8;
        col *= ndl;

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    const roughMat   = new THREE.ShaderMaterial({ vertexShader: grassVert, fragmentShader: roughFrag });
    const fairwayMat = new THREE.ShaderMaterial({ vertexShader: grassVert, fragmentShader: fairwayFrag });
    const teeboxMat  = new THREE.ShaderMaterial({ vertexShader: grassVert, fragmentShader: teeboxFrag });

    // Ground (rough)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 600, 1, 1), roughMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 200);
    ground.receiveShadow = true;
    scene.add(ground);

    // Fairway
    const fairway = new THREE.Mesh(new THREE.PlaneGeometry(50, 600, 1, 1), fairwayMat);
    fairway.rotation.x = -Math.PI / 2;
    fairway.position.set(0, 0.01, 200);
    scene.add(fairway);

    // Tee box — raised grass pad
    const teeBox = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 5), teeboxMat);
    teeBox.position.set(0, 0.05, 0);
    teeBox.receiveShadow = true;
    scene.add(teeBox);

    // Tee box border — complete closed rectangle using lines
    const tbHW = 2.5, tbHD = 2.5, tbY = 0.11;
    const borderPts = [
      new THREE.Vector3(-tbHW, tbY, -tbHD),
      new THREE.Vector3( tbHW, tbY, -tbHD),
      new THREE.Vector3( tbHW, tbY,  tbHD),
      new THREE.Vector3(-tbHW, tbY,  tbHD),
      new THREE.Vector3(-tbHW, tbY, -tbHD),
    ];
    const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
    scene.add(new THREE.Line(borderGeo, new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.5 })));

    // Tee markers — two small rounded markers at front corners (like real course markers)
    [[-1.6, 2.0], [1.6, 2.0]].forEach(([mx, mz]) => {
      // Rounded body — capsule shape (sphere on top of short cylinder)
      const mBase = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.1, 0.16, 12),
        new THREE.MeshPhongMaterial({ color: 0xcc2222, specular: 0x663333, shininess: 40 })
      );
      mBase.position.set(mx, 0.18, mz);
      mBase.castShadow = true;
      scene.add(mBase);
      const mTop = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 8),
        new THREE.MeshPhongMaterial({ color: 0xdd3333, specular: 0x884444, shininess: 60 })
      );
      mTop.position.set(mx, 0.28, mz);
      scene.add(mTop);
    });

    // Golf tee — thin tapered peg
    const teeGeom = new THREE.CylinderGeometry(0.01, 0.03, 0.2, 8);
    const teePeg = new THREE.Mesh(teeGeom, new THREE.MeshLambertMaterial({ color: 0xeeddaa }));
    teePeg.position.set(0, 0.2, 0);
    scene.add(teePeg);
    // Tee cup (tiny concave dish at top)
    const teeCup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.01, 0.04, 12),
      new THREE.MeshLambertMaterial({ color: 0xeeddaa })
    );
    teeCup.position.set(0, 0.31, 0);
    scene.add(teeCup);

    // ── Yardage markers — football-field style painted numbers & lines ─────
    const paintY = 0.02; // just above ground

    // Canvas-based text renderer using Lexend Deca font
    function makeTextTexture(text) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const fontSize = 128;
      canvas.width = 256;
      canvas.height = 128;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `700 ${fontSize}px "Lexend Deca", sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.scale(-1, 1);
      ctx.fillText(text, -canvas.width / 2, canvas.height / 2);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }

    // Place a standing text sprite (Fringe-style) facing the camera/tee
    function paintNumber(cx, cz, num, scale) {
      const s = scale || 1;
      const tex = makeTextTexture(String(num));
      const aspect = 2; // canvas is 256×128
      const h = 2.4 * s;
      const w = h * aspect;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(cx, h / 2 + 0.1, cz);
      scene.add(m);
    }

    // Helper: paint a half-circle arc on the ground as a mesh strip (for reliable thickness)
    function paintArc(radius, segs, thickness, mat) {
      const halfT = thickness / 2;
      const verts = [];
      const idx = [];
      for (let i = 0; i <= segs; i++) {
        const a = -Math.PI / 2 + (i / segs) * Math.PI;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        verts.push(sin * (radius - halfT), paintY, cos * (radius - halfT));
        verts.push(sin * (radius + halfT), paintY, cos * (radius + halfT));
        if (i < segs) {
          const b = i * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(idx);
      return new THREE.Mesh(geo, mat || new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide
      }));
    }

    // Paint arcs immediately (no font needed)
    const arcThickness = 0.5; // 2× base thickness
    [50, 100, 150, 200, 250].forEach(yds => {
      const arc = paintArc(yds, 64, arcThickness);
      scene.add(arc);
    });
    const minorArcMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
    for (let y = 10; y <= 280; y += 10) {
      if (y % 50 === 0) continue;
      const arc = paintArc(y, 48, arcThickness, minorArcMat);
      scene.add(arc);
    }

    // Paint numbers once Lexend Deca font is loaded
    fontReady.then(() => {
      [50, 100, 150, 200, 250].forEach(yds => {
        paintNumber(-6.5, yds, yds, 1.2);
        paintNumber( 6.5, yds, yds, 1.2);
      });
    });


    // Ball — golf ball is ~1.68 inches diameter ≈ 0.14 units
    ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 24, 24),
      new THREE.MeshPhongMaterial({ color:0xfcfcfc, specular:0xbbbbbb, shininess:120, emissive:0x111111 })
    );
    ball.castShadow = true;
    ball.position.set(0, 0.4, 0); // start on the tee
    scene.add(ball);

    // Shadow disk
    shadowDisk = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 16),
      new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.5 })
    );
    shadowDisk.rotation.x = -Math.PI / 2;
    shadowDisk.position.y = 0.02;
    scene.add(shadowDisk);

    // Trail material (reused each rebuild)
    trailMat = new THREE.LineBasicMaterial({ color: 0x52b788 });

    traj = buildTraj();
    // Don't auto-replay on launch — just set ball on tee and start render loop
    ball.position.set(TEE_POS[0], TEE_POS[1], TEE_POS[2]);
    running = false;
    animate();
  }

  // ── Render loop ───────────────────────────────────────────────────────
  const _ct = new THREE.Vector3();
  const _lk = new THREE.Vector3();
  const camHome = new THREE.Vector3(0, 3, -4);
  let lastFrameTime = 0;
  let animProgress = 0; // 0..1 through the trajectory

  function animate(now) {
    requestAnimationFrame(animate);
    if (!running || !traj.length) { lastFrameTime = 0; renderer.render(scene, camera); return; }

    if (!lastFrameTime) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // Pacing: flight portion plays in real hang-time, ground portion gets its own time
    const hangTime = Math.max(shot.hangTime || 3, 2);
    const groundTime = 4.0; // seconds for bounce + roll
    const flightFrac = FLIGHT_FRAMES / traj.length; // what fraction of points is flight
    const totalDuration = hangTime / flightFrac; // scale so flight takes hangTime seconds
    // But cap ground portion so it doesn't rush
    const minDuration = hangTime + groundTime;
    const duration = Math.max(totalDuration, minDuration);

    animProgress = Math.min(animProgress + dt / duration, 1.0);
    animIdx = Math.min(Math.floor(animProgress * (traj.length - 1)), traj.length - 1);
    const [px, py, pz] = traj[animIdx];

    ball.position.set(px, py, pz);
    ball.rotation.x += animIdx <= FLIGHT_FRAMES ? 0.25 : 0.08;

    const hf = Math.max(0.08, 1 - py / Math.max(shot.peakHeight || 1, 0.1));
    shadowDisk.position.x = px;
    shadowDisk.position.z = pz;
    shadowDisk.scale.setScalar(hf);
    shadowDisk.material.opacity = 0.5 * hf;

    // Rebuild trail line from trajectory points visited so far
    if (animIdx > 1) {
      if (trailLine) scene.remove(trailLine);
      const pts = [];
      // Sample every few points to keep it efficient, but always include key points
      const step = Math.max(1, Math.floor(animIdx / 400));
      for (let i = 0; i <= animIdx; i += step) {
        const p = traj[i];
        pts.push(new THREE.Vector3(p[0], p[1], p[2]));
      }
      // Always include the current point
      const last = traj[animIdx];
      pts.push(new THREE.Vector3(last[0], last[1], last[2]));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      trailLine = new THREE.Line(geo, trailMat);
      scene.add(trailLine);
    }

    _ct.set(px * 0.1, Math.max(4, 4 + py * 0.3), Math.max(-4, pz - 16));
    camera.position.lerp(_ct, 0.04);
    _lk.set(px, py * 0.3, pz + 10);
    camera.lookAt(_lk);

    if (animIdx >= traj.length - 1) {
      running = false;
      const t0 = performance.now(), dur = 1800, from = camera.position.clone();
      function easeHome(now) {
        const p = Math.min((now - t0) / dur, 1);
        const e = p < .5 ? 2*p*p : -1+(4-2*p)*p;
        camera.position.lerpVectors(from, camHome, e);
        camera.lookAt(0, 1, 25);
        if (p < 1) requestAnimationFrame(easeHome);
      }
      setTimeout(() => {
        requestAnimationFrame(easeHome);
        setTimeout(() => { ball.position.set(TEE_POS[0], TEE_POS[1], TEE_POS[2]); }, 2000);
      }, 1200);
    }

    renderer.render(scene, camera);
  }

})();

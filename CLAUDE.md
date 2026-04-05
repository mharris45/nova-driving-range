# CLAUDE.md — Nova Driving Range

## What This Is

A Chrome Extension (Manifest V3) that overlays a 3D driving range on the OpenLaunch launch monitor dashboard. It intercepts live Firestore shot data, renders ball flight in Three.js, tracks shots per club, and exports to CSV.

## Architecture

**Multi-world Chrome Extension** with message-passing between isolated contexts:

```
interceptor.js (MAIN world, document_start)
  → Patches fetch() + XHR to intercept Firestore Listen streams
  → Posts shot fields to content.js via window.postMessage

content.js (isolated world, document_idle)
  → Manages all UI (overlay, stats bar, table, club selector)
  → Saves shots to chrome.storage.local via background.js
  → Injects Three.js + scene.js into MAIN world on demand

scene.js (MAIN world, dynamically injected)
  → Full Three.js 3D scene (sky, grass, yardage markers)
  → Ball flight animation with physics-based trajectory
  → Landing dot dispersion display + birds-eye camera

background.js (service worker)
  → Persists shots to chrome.storage.local
```

All cross-context communication uses `window.postMessage` with type-prefixed messages (`gsv-*`).

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `manifest.json` | 42 | Extension config, permissions, content script declarations |
| `interceptor.js` | 101 | Firestore stream interception (fetch + XHR patching) |
| `content.js` | 592 | UI, storage, data flow, physics calculator |
| `scene.js` | ~1232 | Three.js scene, shaders, animation, camera |
| `background.js` | 17 | Shot persistence service worker |
| `options.html/js` | 167/56 | Settings page (view count, export CSV, clear data) |
| `three.min.js` | — | Bundled Three.js library |

## Conventions & Patterns

- **No build system** — vanilla JS, no bundler, no npm. Files are loaded directly.
- **Message types** — all postMessage types prefixed with `gsv-` (e.g., `gsv-firestore-shot`, `gsv-update`, `gsv-ready`, `gsv-init`, `gsv-landing-dots`, `gsv-birdseye`).
- **Shot deduplication** — signature string `ballSpeed|vLaunchAngle|carryDist|totalSpin` prevents re-saving on Firestore replay.
- **Non-blocking interception** — `response.body.tee()` creates two independent streams; app gets one, extension reads the other.
- **Lazy loading** — Three.js and scene.js only injected when user opens the overlay.
- **All inline styles** — no external CSS files; styles are set directly in JS via `style.cssText` or `Object.assign(el.style, {...})`.
- **IIFE wrapping** — every JS file wrapped in an immediately-invoked function to avoid global scope pollution.

## Data Flow

1. User hits shot on launch monitor
2. OpenLaunch dashboard receives Firestore update
3. `interceptor.js` tees the fetch response, parses the chunk for `ball_speed` fields
4. Posts `gsv-firestore-shot` message with raw Firestore fields
5. `content.js` receives message, extracts metrics (prefers OpenGolf Coach calculated values when available, falls back to physics calc)
6. Auto-saves to `chrome.storage.local` via `background.js`
7. If overlay is open, sends `gsv-update` to `scene.js` for 3D animation

## Physics

- `calcFlightFromRaw()` in content.js — drag + Magnus lift time-stepping simulation
- `buildTraj()` in scene.js — 400-point trajectory (200 flight + 200 bounce/roll)
- Flight uses real hang-time for duration; ground phase is a fixed 4-second animation

## Grass Rendering

Three-layer system in scene.js:
1. Shader-based ground plane with multi-octave Perlin FBM (fairway, rough, tee zones)
2. 200K instanced grass blades via `InstancedMesh` (single draw call)
3. Per-blade wind sway in vertex shader

## Common Tasks

**Adding a new shot metric**: Add to the `shot` object in content.js, extract from Firestore fields in `updateShotFromFirestore()`, add to `statDefs` array for stats bar display, include in `autoSaveShot()` row and `CSV_HEADERS`.

**Adding a new UI button**: Add HTML in the overlay template string in content.js, wire up event listener below.

**Modifying 3D scene**: Edit scene.js. Key functions: `initScene()`, `buildTraj()`, `animate()`, grass/sky shader code.

## Gotchas

- Extension runs only on `https://dashboard.openlaunch.io/*`
- `chrome.runtime.id` check guards against invalidated extension context after reload
- The `offlineDist` sign is negated from Firestore values (convention: positive = right)
- Scene.js reads font URL from `document.currentScript.dataset.fontUrl` set during injection

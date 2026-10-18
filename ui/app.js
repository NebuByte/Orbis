'use strict';
// Orbis - neural file explorer + launcher (full screen or windowed; EXIT closes it completely).
// One search box: every query is matched on names AND on meaning (descriptive search on the
// Intel NPU, semantic\orbis_sem.py). Whichever fits better leads; the other follows below it.
// The map is a flat plexus of your folders that folds into a turning globe when idle; names appear only along lit
// paths and under the mouse. Recently changed folders glow; idle, the map drifts on its own.
// Rust commands: status, base_graph, search, describe, describe_warm, reindex_docs, details,
//   open_item, reveal_item, vscode_item, rebuild, apps_search, apps_top, launch_app, sys_stats,
//   set_kiosk, set_theme, quit_app, system_profile, install_engine, update_settings, start_saver, exit_saver
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = n => Number(n).toLocaleString('en-US');
const fmt = b => b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + ' GB'
  : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' KB' : b + ' B';
const day = s => s ? new Date(s * 1000).toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const K = { FILE: 0, DIR: 1, LINK: 2, DRIVE: 3, ROOT: 4, TOOL: 5 };
const NONE = 4294967295;
const KIND_LABEL = { 0: 'File', 1: 'Folder', 2: 'Link / junction', 3: 'Drive', 4: 'This PC', 5: 'Tooling folder (contents not indexed)' };
const extOf = (name, kind) => kind === K.FILE ? (name.includes('.') ? name.split('.').pop().toUpperCase().slice(0, 4) : 'FILE')
  : kind === K.LINK ? 'LINK' : kind === K.DRIVE ? 'DRV' : kind === K.TOOL ? 'PKG' : 'DIR';
const initials = name => (name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => [...w][0]).join('') || '?').toUpperCase();
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hash = (i, s) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };

// ---------------------------------------------------------------- themes
// heat = the warm glow of recently changed folders; file types get hue-shifted shades of acc
const THEMES = {
  ice:      { label: 'Ice',       bg: '#020b1c', bg2: '#0b2d5c', grid: '#0a1c37', web: '169,216,255', acc: '#8fd3ff', lit: '#f4fbff', ink: '#d7e9fb', dim: '#55769a', panel: 'rgba(5,20,44,.86)', line: '#1b3f68', heat: '#ffc46b' },
  stark:    { label: 'Stark',     bg: '#0b0603', bg2: '#4a2408', grid: '#21140a', web: '255,205,150', acc: '#ffb04a', lit: '#fff4e2', ink: '#f3e3cf', dim: '#8d6a48', panel: 'rgba(24,13,5,.86)', line: '#4a2e14', heat: '#ff5a36' },
  matrix:   { label: 'Matrix',    bg: '#010e09', bg2: '#06402a', grid: '#08231a', web: '150,245,205', acc: '#3ef0a5', lit: '#eafff6', ink: '#d2f3e5', dim: '#4c8a70', panel: 'rgba(3,24,16,.86)', line: '#134a35', heat: '#e2ff5c' },
  alert:    { label: 'Red alert', bg: '#100207', bg2: '#4d0a1f', grid: '#260a14', web: '255,170,190', acc: '#ff5470', lit: '#fff0f3', ink: '#f6dbe1', dim: '#97566a', panel: 'rgba(28,5,12,.86)', line: '#521a2b', heat: '#ffcf5c' },
  nebula:   { label: 'Nebula',    bg: '#07041a', bg2: '#2c1666', grid: '#170f36', web: '205,184,255', acc: '#a982ff', lit: '#f6f1ff', ink: '#e2d9ff', dim: '#6d62a0', panel: 'rgba(15,9,40,.86)', line: '#33266a', heat: '#ff7ad9' },
  graphite: { label: 'Graphite',  bg: '#0a0b0d', bg2: '#262a31', grid: '#16181c', web: '210,215,222', acc: '#e6e9ee', lit: '#ffffff', ink: '#e2e5e9', dim: '#6c717b', panel: 'rgba(20,22,26,.88)', line: '#33373f', heat: '#ffb86b' },
  solar:    { label: 'Solar',     bg: '#06121a', bg2: '#0d3b4a', grid: '#0b222c', web: '160,230,230', acc: '#ffd25a', lit: '#fffbe8', ink: '#dcefee', dim: '#5b8a90', panel: 'rgba(6,26,34,.88)', line: '#1d4652', heat: '#ff7b3a' },
  // light but easy on the eyes: an overcast grey-blue, no pure white anywhere
  daylight: { label: 'Daylight',  bg: '#bcc5d1', bg2: '#c9d1dc', grid: '#b0bac6', web: '28,54,90', acc: '#1a58b8', lit: '#0a2142', ink: '#18283c', dim: '#4c5c71', panel: 'rgba(200,209,220,.95)', line: '#9aa7b8', heat: '#b84f00', light: true },
};
let themeKey = 'ice', theme = THEMES.ice, sprites = null, tints = {};
const rgbOf = hex => { const v = parseInt(hex.slice(1), 16); return `${v >> 16},${v >> 8 & 255},${v & 255}`; };
// rotate a colour's hue (and give grey themes a little colour) - the file-type shades
function hueShift(hex, deg) {
  let [r, g, b] = rgbOf(hex).split(',').map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + deg + 360) % 360; s = Math.max(s, .35);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
const TYPE_SHIFT = { doc: 0, code: 60, media: -70, archive: 140, app: 200, other: 0 };
const TYPE_EXT = {
  doc: 'pdf doc docx xls xlsx xlsm csv ppt pptx txt md rtf odt ods odp epub',
  code: 'js mjs ts tsx jsx py rs go java c h cpp hpp cs php rb swift kt html htm css scss json xml yml yaml toml sql sh ps1 bat cmd ipynb vue dart lua',
  media: 'jpg jpeg png gif webp bmp svg psd ai heic tif tiff mp4 mkv mov avi webm mp3 wav flac m4a ogg',
  archive: 'zip rar 7z tar gz bz2 xz iso bak',
  app: 'exe msi apk appx msix dll lnk',
};
const EXT_TYPE = {};
for (const [t, list] of Object.entries(TYPE_EXT)) list.split(' ').forEach(e => EXT_TYPE[e] = t);
const typeOf = (name, kind) => kind !== undefined && kind !== K.FILE && kind !== K.LINK ? 'other' : EXT_TYPE[(name.split('.').pop() || '').toLowerCase()] || 'other';
const tintOf = h => tints[typeOf(h.name, h.kind)] || theme.acc;
function glowSprite(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${rgb},.9)`); gr.addColorStop(.25, `rgba(${rgb},.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c;
}
function applyTheme(key, save) {
  themeKey = THEMES[key] ? key : 'ice'; theme = THEMES[themeKey];
  const st = document.documentElement.style;
  for (const v of ['bg', 'bg2', 'grid', 'acc', 'lit', 'ink', 'dim', 'panel', 'line', 'heat']) st.setProperty('--' + v, theme[v]);
  document.documentElement.classList.toggle('light', !!theme.light);
  tints = Object.fromEntries(Object.entries(TYPE_SHIFT).map(([t, d]) => [t, d ? hueShift(theme.acc, d) : theme.acc]));
  sprites = { acc: glowSprite(rgbOf(theme.acc)), lit: glowSprite(rgbOf(theme.lit)), heat: glowSprite(rgbOf(theme.heat)),
    type: Object.fromEntries(Object.entries(tints).map(([t, c]) => [t, glowSprite(rgbOf(c))])) };
  litVer++; renderSwatches(); drawBackdrop();
  if (typeof ensureIcons === 'function' && dockApps.length) ensureIcons([...dockApps, ...apps]).then(() => { renderDock(); if (hasQuery()) renderResults(); });
  if (st && save) invoke('set_theme', { theme: themeKey }).catch(() => {});
  if (typeof renderResults === 'function' && hasQuery()) renderResults();
}
function renderSwatches() {
  $('swatches').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button type="button" class="sw" data-theme="${k}" aria-pressed="${k === themeKey}"><i style="background:radial-gradient(circle at 50% 50%,${t.acc} 0 34%,${t.bg} 36%)"></i>${esc(t.label)}</button>`).join('');
}
$('swatches').addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (b) applyTheme(b.dataset.theme, true); });

// ---------------------------------------------------------------- graph store
// Every folder has two places. Flat (dx, dy): the 2D map you work with - results always show here.
// Globe (gx, gy, gz): nested shells around the core that the map folds into when you leave it idle;
// each shell turns against its neighbours. cam.fold (0 = flat, 1 = globe) blends between the two.
const G = new Map();
let ROOT = null, webFlat = [], webGlobe = [];
const RADII = [0, 170, 360, 560, 740, 900, 1040, 1170, 1290, 1400];
const R = d => d < RADII.length ? RADII[d] : RADII[RADII.length - 1] + (d - RADII.length + 1) * 110;
const SHELL = [0, 120, 270, 390, 480, 540], HN = 512;
const shellR = d => d < SHELL.length ? SHELL[d] : 540 + 60 * (1 - Math.exp(-(d - 5) / 3));
let globeR = 560;                    // the outer shell actually used (far-side dimming)
function diskPos(n) {
  let r = R(n.depth), a = n.ang;
  if (n.depth >= 2) { r += (hash(n.id, 1) - .5) * (R(n.depth) - R(n.depth - 1)) * .8; a += (hash(n.id, 2) - .5) * .05; }
  return [Math.cos(a) * r, Math.sin(a) * r];
}
// Hilbert curve: position along the curve -> cell of a square; contiguous runs stay compact patches
function d2xy(n, d) {
  let x = 0, y = 0;
  for (let s = 1, t = d; s < n; s *= 2, t >>= 2) {
    const rx = (t >> 1) & 1, ry = (t ^ rx) & 1;
    if (!ry) { if (rx) { x = s - 1 - x; y = s - 1 - y; } const k = x; x = y; y = k; }
    x += s * rx; y += s * ry;
  }
  return [x, y];
}
// a folder's slice of the tree (its angle) -> a Hilbert cell -> a point on an equal-area sphere,
// so every folder's subfolders form one patch around it, on the shell for its depth
function globePos(n) {
  if (n.depth === 0) return [0, 0, 0];
  const t = Math.min(.999999, Math.max(0, (n.ang + Math.PI) / (Math.PI * 2)));
  const [hx, hy] = d2xy(HN, Math.floor(t * HN * HN));
  let u = (hx + .5) / HN, v = (hy + .5) / HN;
  if (n.depth >= 2) { u += (hash(n.id, 3) - .5) * .02; v += (hash(n.id, 4) - .5) * .02; }
  v = Math.min(.985, Math.max(.015, v));
  const y = 2 * v - 1, ring = Math.sqrt(1 - y * y), lon = u * Math.PI * 2;
  const r = shellR(n.depth) * (n.depth >= 2 ? 1 + (hash(n.id, 1) - .5) * .12 : 1);
  return [ring * Math.cos(lon) * r, y * r, ring * Math.sin(lon) * r];
}
function addNode(g, base) {
  let n = G.get(g.id);
  if (n) { if (base) n.base = true; return n; }
  n = { ...g, base: !!base, px: 0, py: 0, pk: 1, pz: 0 };
  const [dx, dy] = diskPos(n), [gx, gy, gz] = globePos(n);
  Object.assign(n, { dx, dy, gx, gy, gz, x: dx, y: dy });      // x/y: the flat map (fitting, panning)
  G.set(g.id, n);
  return n;
}
const radius = n => { const f = Math.hypot(n.dx, n.dy); return f + (Math.hypot(n.gx, n.gy, n.gz) - f) * cam.fold; };
function dropExtras(keep) {
  const k = new Set(); keep.forEach(h => h.chain.forEach(n => k.add(n)));
  for (const [id, n] of G) if (!n.base && !k.has(n)) G.delete(id);
}
const parentOf = n => n.parent === NONE ? null : G.get(n.parent);
function chainOf(n) { const a = []; let c = n; while (c) { a.unshift(c); c = parentOf(c); } return a; }
function pathOf(chain) {
  const c = chain.filter(x => x.kind !== K.ROOT);
  if (!c.length) return 'This PC';
  return c[0].name + '\\' + c.slice(1).map(x => x.name).join('\\');
}
// nearest neighbours: flat ones for the 2D map; on the globe only within the same shell, so each
// shell stays a rigid web while the shells turn against each other
function knn(nodes, pos, C, sameShell, n1, n2) {
  const cell = new Map(), key = (x, y, z) => (x * 4001 + y) * 4001 + z, P = new Map(nodes.map(n => [n, pos(n)]));
  const cellOf = p => [Math.floor(p[0] / C), Math.floor(p[1] / C), Math.floor(p[2] / C)];
  for (const n of nodes) { const c = cellOf(P.get(n)), k = key(...c); let l = cell.get(k); if (!l) cell.set(k, l = []); l.push(n); }
  const seen = new Set(), out = [];
  for (const n of nodes) {
    const p = P.get(n), [cx, cy, cz] = cellOf(p), near = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      const list = cell.get(key(cx + i, cy + j, cz + l)); if (!list) continue;
      for (const m of list) {
        if (m === n || (sameShell && m.depth !== n.depth)) continue;
        const q = P.get(m), d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]); if (d < C) near.push([d, m]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [d, m] of near.slice(0, 3)) {
      const k = n.id < m.id ? n.id * 4294967296 + m.id : m.id * 4294967296 + n.id;
      if (seen.has(k)) continue; seen.add(k); out.push([n, m, d < n1 ? 2 : d < n2 ? 1 : 0]);
    }
  }
  return out;
}
function buildWeb() {
  const nodes = [...G.values()].filter(n => n.base && n.kind !== K.ROOT);
  webFlat = knn(nodes, n => [n.dx, n.dy, 0], 130, false, 42, 85);
  webGlobe = knn(nodes, n => [n.gx, n.gy, n.gz], 120, true, 34, 70);
  globeR = Math.max(200, ...nodes.map(n => Math.hypot(n.gx, n.gy, n.gz))) * 1.06;
}
// folders with recent changes glow warm: under a day strong, a week medium, a month faint.
// Program Files and friends change with every update, so they never count.
const SYSTEM_TOP = /^(program files( \(x86\))?|programdata|windows|\$recycle\.bin|system volume information|wsl|docker|msocache|intel|amd|nvidia|perflogs|recovery)$/i;
let hot = [];
function computeHeat() {
  const now = Date.now() / 1000;
  hot = [];
  for (const n of G.values()) {
    if (!n.base || n.depth < 2 || !n.recent || n.recent > now + 86400) continue;
    let top = n; while (top && top.depth > 2) top = parentOf(top);
    if (top && SYSTEM_TOP.test(top.name)) continue;
    const age = now - n.recent;
    const h = age < 86400 ? 1 : age < 7 * 86400 ? .55 : age < 30 * 86400 ? .25 : 0;
    if (h) hot.push({ n, h, ph: hash(n.id, 9) * 6.28 });
  }
  hot.sort((a, b) => b.h - a.h || b.n.recent - a.n.recent);
  hot = hot.slice(0, 20);   // a hint of where you've been working, not a rash over the globe
}
const ago = t => { const s = Date.now() / 1000 - t; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} MIN AGO` : s < 86400 ? `${Math.round(s / 3600)} H AGO` : s < 86400 * 60 ? `${Math.round(s / 86400)} DAYS AGO` : day(t).toUpperCase(); };

// ---------------------------------------------------------------- canvas, camera, projection
const fx = $('fx'), g = fx.getContext('2d');
let W = 0, H = 0, DPR = 1, litVer = 0;
const view = { x: 0, y: 0, s: .5, to: null };
// the idle globe (radians): fold blends flat -> globe, spin turns the shells against each other,
// yaw turns the whole globe, pitch nods it. FOCAL: perspective distance in world units.
const cam = { fold: 0, spin: 0, yaw: 0, pitch: .3 }, FOCAL = 2600;
let C = null;
// shell d turns by yaw + spin, alternating direction from shell to shell, deeper ones a little faster
const shellYaw = d => cam.yaw + cam.spin * (d % 2 ? 1 : -1) * (.6 + .25 * d);
const persp = z => FOCAL / Math.max(FOCAL * .25, FOCAL - z);
function camFrame() { C = { cp: Math.cos(cam.pitch), sp: Math.sin(cam.pitch), f: cam.fold, ox: -view.x * view.s, oy: -view.y * view.s }; }
// a node -> screen. Flat: just the 2D view. Folding: blend toward its turned, tilted globe position,
// with perspective about the core. (The WebGL shader does exactly the same.)
function project(n) {
  let x = n.dx, y = n.dy, z = 0;
  if (C.f > 0) {
    const a = shellYaw(Math.min(n.depth, 7)), ca = Math.cos(a), sa = Math.sin(a);
    const gx = n.gx * ca + n.gz * sa, gz0 = -n.gx * sa + n.gz * ca;
    const gy = n.gy * C.cp - gz0 * C.sp, gz = n.gy * C.sp + gz0 * C.cp;
    x += (gx - x) * C.f; y += (gy - y) * C.f; z = gz * C.f;
  }
  const k = persp(z), s = view.s;
  n.px = W / 2 + (x * k - view.x) * s; n.py = H / 2 + (y * k - view.y) * s; n.pk = k; n.pz = z;
}
// on the globe the far side is dimmer; on the flat map everything is 1
const facing = n => 1 - C.f * .7 * (1 - Math.max(0, Math.min(1, n.pz / globeR * .5 + .5)));
// the core always faces you
function corePlane() { g.setTransform(DPR, 0, 0, DPR, (W / 2 + C.ox) * DPR, (H / 2 + C.oy) * DPR); }
const flat = () => g.setTransform(DPR, 0, 0, DPR, 0, 0);
function region() {
  const res = !$('results').hidden;
  return { l: W > 1050 ? 210 : 20, r: W - (res ? 394 : 30), t: 74, b: H - 54 };
}
function fitTo(pts, pad = 40) {
  if (!pts.length) return;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const r = region(); const rw = Math.max(200, r.r - r.l - pad * 2), rh = Math.max(200, r.b - r.t - pad * 2);
  const s = Math.min(1.5, Math.max(.08, Math.min(rw / Math.max(1, maxx - minx), rh / Math.max(1, maxy - miny))));
  const cx = (r.l + r.r) / 2, cy = (r.t + r.b) / 2;
  view.to = { x: (minx + maxx) / 2 - (cx - W / 2) / s, y: (miny + maxy) / 2 - (cy - H / 2) / s, s };
}
const fitAll = () => fitTo([...G.values()].filter(n => n.base && n.depth <= 3));
// the globe fills nearly the whole height, in the middle of the screen (a little smaller as the
// screen saver, to leave the clock and the gauges their own columns)
function globeView() {
  const side = saverOn ? Math.max(300, Math.min(480, W * .25)) : 210, cy = H / 2 + (saverOn ? 0 : 10);
  const s = Math.min(1.6, Math.min(W - 2 * side, H - (saverOn ? 70 : 30)) / (2 * globeR * .92));
  return { x: 0, y: -(cy - H / 2) / s, s };   // x 0: the core sits in the middle of the screen
}
function fitGlobe() { view.to = globeView(); }
function resize() {
  DPR = Math.min(1.5, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
  fx.width = Math.round(W * DPR); fx.height = Math.round(H * DPR);
  // the web of lines is drawn at normal (CSS) resolution and scaled up by the screen: 2.25x fewer pixels
  // (and anti-aliasing samples) for the GPU each frame; the core, glows and labels stay sharp on fx
  glc.width = Math.round(W * GL_DPR); glc.height = Math.round(H * GL_DPR);
  drawBackdrop();
}
// the backdrop: a starfield thickest along a diagonal band, with soft nebula clouds in the theme's
// colours. Drawn once per theme and screen size, so it costs nothing per frame.
const bgc = $('bg');
function drawBackdrop() {
  if (!sprites || !W) return;
  const dpr = Math.min(1.5, devicePixelRatio || 1), b = bgc.getContext('2d'), light = !!theme.light;
  bgc.width = Math.round(W * dpr); bgc.height = Math.round(H * dpr);
  b.setTransform(dpr, 0, 0, dpr, 0, 0); b.clearRect(0, 0, W, H);
  let seed = 20261017; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const ang = -.42, ca = Math.cos(ang), sa = Math.sin(ang), cx = W / 2, cy = H / 2, len = Math.hypot(W, H);
  b.globalCompositeOperation = light ? 'multiply' : 'screen';
  for (let i = 0; i < 8; i++) {
    const t = (rnd() - .5) * .95, x = cx + ca * t * len + (rnd() - .5) * W * .1, y = cy + sa * t * len + (rnd() - .5) * H * .22;
    const r = Math.max(W, H) * (.1 + rnd() * .2), col = i % 4 === 3 ? rgbOf(theme.heat) : i % 2 ? theme.web : rgbOf(theme.acc);
    const al = light ? .07 : .045 + rnd() * .045, gr = b.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},${al})`); gr.addColorStop(.45, `rgba(${col},${al * .45})`); gr.addColorStop(1, `rgba(${col},0)`);
    b.fillStyle = gr; b.fillRect(x - r, y - r, r * 2, r * 2);
  }
  b.globalCompositeOperation = 'source-over';
  const n = Math.round(W * H / 2100), lit = rgbOf(theme.lit);
  for (let i = 0; i < n; i++) {
    let x = rnd() * W, y = rnd() * H;
    if (rnd() < .45) { const t = (rnd() - .5) * 1.1, off = (rnd() + rnd() + rnd() - 1.5) * H * .17; x = cx + ca * t * len - sa * off; y = cy + sa * t * len + ca * off; }
    const big = rnd() < .03, r = big ? .9 + rnd() * .8 : .35 + rnd() * .55, al = (big ? .55 + rnd() * .4 : .1 + rnd() * .42) * (light ? .45 : 1);
    b.fillStyle = `rgba(${rnd() < .7 ? theme.web : lit},${al})`;
    b.beginPath(); b.arc(x, y, r, 0, 6.3); b.fill();
    if (big && !light) { b.globalAlpha = .3; b.drawImage(sprites.lit, x - 7, y - 7, 14, 14); b.globalAlpha = 1; }
  }
}
addEventListener('resize', () => { resize(); if (drift.on) fitGlobe(); else if (!searching() && !sel) fitAll(); else refit(); });

// ---------------------------------------------------------------- search state
const LINES = 6;                 // how many results get a lit path at once
// measured on this PC's 24.7k documents: real matches score .86-.89, nonsense queries top out near .82
const SEM_MIN = .83;             // meaning matches below this cosine score are noise
const pct = s => Math.round(Math.max(0, Math.min(1, (s - .80) / (.88 - .80))) * 100);
let nameHits = [], semHits = [], apps = [], total = 0, nameMs = 0, semMs = 0;
const setting = (k, d) => (st && st.settings && st.settings[k] !== undefined ? st.settings[k] : d);
// lite: no glows or landmarks - chosen in settings, or forced when the PC has no WebGL
const lite = () => setting('visuals', 'full') === 'lite' || !GLP || !caps.full;
let lead = 'name', semOn = false, semState = 'off', semLastUse = 0, moreSecond = false, saverOn = false;
let sel = null, selInfo = null, hl = null, hover = null, cursor = 0, rows = [];
let seq = 0, deb, semDeb;
const hasQuery = () => !!$('q').value.trim();

// ---------------------------------------------------------------- the smart search box
//   = 1250*12                                   a calculator
//   > restart                                   a fixed list of Windows commands
//   type:pdf  changed:week  in:Projects  big:500mb  filters, alone or with words
let pq = { mode: 'search', text: '', filters: null, chips: [] };
const searching = () => hasQuery() && pq.mode === 'search';
const TYPE_GROUPS = {
  image: 'jpg jpeg png gif webp bmp svg heic tif tiff psd', photo: 'jpg jpeg png heic webp', video: 'mp4 mkv mov avi webm wmv',
  audio: 'mp3 wav flac m4a ogg aac', doc: TYPE_EXT.doc, docs: TYPE_EXT.doc, code: TYPE_EXT.code, archive: TYPE_EXT.archive, app: 'exe msi apk appx msix',
};
function parseQuery(raw) {
  const t = raw.trim();
  if (t.startsWith('=')) return { mode: 'calc', text: t.slice(1).trim(), filters: null, chips: [] };
  if (t.startsWith('>')) return { mode: 'cmd', text: t.slice(1).trim().toLowerCase(), filters: null, chips: [] };
  const f = { exts: [], folders_only: false, since: 0, within: '', min_size: 0 }, words = [], chips = [];
  for (const w of t.split(/\s+/).filter(Boolean)) {
    const m = /^(type|changed|in|big):(.*)$/i.exec(w);
    if (!m) { words.push(w); continue; }
    const k = m[1].toLowerCase(), v = m[2].toLowerCase();
    if (k === 'type' && v) {
      if (/^(folder|folders|dir)$/.test(v)) f.folders_only = true;
      else f.exts.push(...(TYPE_GROUPS[v] || v).split(/[ ,]+/).filter(Boolean).map(x => x.replace(/^\./, '')));
      chips.push('type ' + v);
    } else if (k === 'changed') {
      const now = Date.now() / 1000, D = 86400, sod = new Date(); sod.setHours(0, 0, 0, 0);
      const n = /^(\d+)([hdwmy])$/.exec(v), unit = { h: 3600, d: D, w: 7 * D, m: 30 * D, y: 365 * D };
      f.since = Math.floor(v === 'today' ? sod / 1000 : v === 'yesterday' ? sod / 1000 - D : v === 'month' ? now - 30 * D
        : v === 'year' ? now - 365 * D : n ? now - n[1] * unit[n[2]] : now - 7 * D);
      chips.push('changed ' + (v || 'week'));
    } else if (k === 'in' && v) { f.within = v; chips.push('in ' + v); }
    else if (k === 'big') {
      const n = /^(\d+(?:\.\d+)?)(kb|mb|gb)?$/.exec(v);
      f.min_size = n ? Math.round(n[1] * { kb: 1e3, mb: 1e6, gb: 1e9 }[n[2] || 'mb']) : 1e8;
      chips.push('over ' + fmt(f.min_size));
    }
  }
  const any = f.exts.length || f.folders_only || f.since || f.within || f.min_size;
  return { mode: 'search', text: words.join(' '), filters: any ? f : null, chips };
}
// meaning results follow the same filters, checked on what each result carries
function semPasses(h, f) {
  if (!f) return true;
  const ext = (h.name.split('.').pop() || '').toLowerCase();
  return !f.folders_only && (!f.exts.length || f.exts.includes(ext)) && (!f.since || h.mtime >= f.since)
    && (!f.min_size || h.size >= f.min_size) && (!f.within || (h.path || '').toLowerCase().includes(f.within));
}
// a small, safe calculator: + - * / ^ %, brackets, sqrt sin cos tan (degrees) log ln abs round, pi, e
function calc(expr) {
  const src = expr.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '').toLowerCase();
  let i = 0;
  const eat = c => src[i] === c ? (i++, true) : false, rad = x => x * Math.PI / 180;
  const FN = { sqrt: Math.sqrt, sin: x => Math.sin(rad(x)), cos: x => Math.cos(rad(x)), tan: x => Math.tan(rad(x)), log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round };
  const atom = () => {
    if (eat('(')) { const v = sum(); if (!eat(')')) throw 0; return v; }
    if (eat('-')) return -atom();
    if (eat('+')) return atom();
    const w = /^[a-z]+/.exec(src.slice(i));
    if (w) {
      i += w[0].length;
      if (w[0] === 'pi') return Math.PI;
      if (w[0] === 'e') return Math.E;
      if (!FN[w[0]] || !eat('(')) throw 0;
      const v = sum(); if (!eat(')')) throw 0; return FN[w[0]](v);
    }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i)); if (!m) throw 0;
    i += m[0].length; return parseFloat(m[0]);
  };
  const power = () => { let v = atom(); while (eat('%')) v /= 100; if (eat('^')) v = Math.pow(v, power()); return v; };
  const prod = () => { let v = power(); for (;;) { if (eat('*')) v *= power(); else if (eat('/')) v /= power(); else return v; } };
  const sum = () => { let v = prod(); for (;;) { if (eat('+')) v += prod(); else if (eat('-')) v -= prod(); else return v; } };
  const v = sum(); if (i !== src.length || !isFinite(v)) throw 0; return v;
}
const calcText = v => Math.abs(v) >= 1e15 || (v && Math.abs(v) < 1e-6) ? v.toExponential(6) : (+v.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 10 });
// "> command": the same fixed list Rust accepts, plus theme switching
const COMMANDS = [
  ['settings', 'Settings'], ['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['display', 'Display'], ['sound', 'Sound'],
  ['updates', 'Windows Update'], ['apps', 'Installed apps'], ['storage', 'Storage'], ['power', 'Power & sleep'],
  ['taskmgr', 'Task Manager'], ['control', 'Control Panel'], ['terminal', 'Terminal'], ['recycle', 'Recycle Bin'],
  ['downloads', 'Downloads'], ['documents', 'Documents'], ['reindex', 'Re-scan drives'], ['reclaim', 'Reclaim space'], ['lock', 'Lock the PC'],
  ['sleep', 'Sleep', 1], ['restart', 'Restart', 1], ['shutdown', 'Shut down', 1], ['signout', 'Sign out', 1],
  ...Object.keys(THEMES).map(k => ['theme ' + k, 'Theme: ' + THEMES[k].label]),
].map(([key, label, confirm]) => ({ key, label, confirm: !!confirm }));
let wsCmds = [];   // "> ws <name>" opens a workspace (rebuilt from the saved ones)
async function loadWsCmds() {
  try { const o = await invoke('workspaces'); wsCmds = [{ key: 'workspaces', label: 'Workspaces…', confirm: false }, ...o.saved.map(w => ({ key: 'ws ' + w.name.toLowerCase(), label: 'Workspace: ' + w.name, confirm: false, ws: w.name }))]; } catch { /* none yet */ }
}
function matchCommands(t) {
  const ALL = [...wsCmds, ...COMMANDS];
  if (!t) return ALL;
  return ALL.map(c => { const l = c.label.toLowerCase(); return { c, s: c.key.startsWith(t) || l.startsWith(t) ? 2 : c.key.includes(t) || l.includes(t) ? 1 : 0 }; })
    .filter(x => x.s).sort((a, b) => b.s - a.s).map(x => x.c);
}
let armed = null;   // a command waiting for its second Enter (sleep, restart, shut down, sign out)
async function runCmd(c) {
  if (c.key === 'reclaim') { openReclaim(); return true; }
  if (c.key === 'workspaces') { openWs(); return true; }
  if (c.ws) { try { const n = await invoke('open_workspace', { name: c.ws }); toast(`Opened ${c.ws} · ${n} item${n === 1 ? '' : 's'}`); } catch (e) { toast(String(e)); } return true; }
  if (c.key.startsWith('theme ')) { applyTheme(c.key.slice(6), true); toast(c.label); return true; }
  if (c.confirm && armed !== c.key) { armed = c.key; renderResults(); return false; }
  armed = null;
  try { await invoke('run_command', { name: c.key }); toast(c.label); } catch (e) { toast(String(e)); }
  return true;
}
// Enter (or a click on an app, command or sum) does the thing, then the search clears and the globe returns
async function actOn(h) {
  if (h.calc != null) copyCalc(h.calc);
  else if (h.cmd) { if (!await runCmd(h.cmd)) return; }
  else if (h.app) launch(h.app);
  else act('open_item', h);
  resetAll();
}
function copyCalc(v) { navigator.clipboard.writeText(String(+v.toPrecision(12))).then(() => toast('Copied ' + calcText(v))); }
function runQuery(raw) {
  pq = parseQuery(raw); armed = null;
  if (pq.mode !== 'search' || (!pq.text && !pq.filters)) {          // calculator, commands, or a filter still being typed
    seq++; clearTimeout(semDeb);
    nameHits = []; semHits = []; apps = []; total = 0; sel = null; selHit = null; selInfo = null; hl = null; cursor = 0;
    dropExtras([]); decideLead(); renderAll(); litVer++;
    return;
  }
  runSearch(pq.text, pq.filters);
}

function makeNameHit(h) {
  const chain = h.chain.map(g => addNode(g, false)), node = chain[chain.length - 1];
  return { src: 'name', node, chain, name: node.name, kind: h.kind, size: h.size, mtime: h.mtime, tooling: h.tooling, noisy: h.noisy, folder: chain.length > 1 ? chain[chain.length - 2] : null };
}
// the same folder or file in several places (agent worktrees, backups, copies) becomes one result
// with its other places tucked under it: same name, same kind, same size (files) or item count (folders)
function collapseDupes(list) {
  const seen = new Map(), out = [];
  for (const h of list) {
    const isFile = h.kind === K.FILE || h.kind === K.LINK;
    const key = h.name.toLowerCase() + '|' + h.kind + '|' + (isFile ? h.size : h.node.count), first = seen.get(key);
    if (first) first.dupes.push(h); else { h.dupes = []; seen.set(key, h); out.push(h); }
  }
  return out;
}
// a path you can read at a glance: where it starts (drive, project) and where it ends
function shortPath(p) {
  const parts = p.split('\\').filter(Boolean);
  return (parts.length <= 4 ? parts : [...parts.slice(0, 3), '…', parts[parts.length - 1]]).join(' › ');
}
// another place of the same item: show where its path leaves the main one's (e.g. the worktree folder)
function diffPath(p, ref) {
  const a = p.split('\\').filter(Boolean), b = ref.split('\\').filter(Boolean);
  let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  if (i >= a.length) return shortPath(p);
  const mid = a.slice(Math.max(1, i - 1), i + 2), endAt = Math.max(1, i - 1) + mid.length;
  return [a[0], i > 2 ? '…' : null, ...mid, endAt < a.length - 1 ? '…' : null, endAt < a.length ? a[a.length - 1] : null].filter(Boolean).join(' › ');
}
let openDupes = new Set(), openFolders = new Set();
function makeSemHit(h) {
  const chain = h.chain.map(g => addNode(g, false)), node = chain.length ? chain[chain.length - 1] : null;
  return { src: 'sem', node, chain, name: node ? node.name : h.path.split('\\').pop(), path: h.path, kind: K.FILE, size: h.size, mtime: h.mtime, score: h.score, pct: pct(h.score), snip: h.snip, noisy: h.noisy, folder: chain.length > 1 ? chain[chain.length - 2] : null };
}
// lit lines: name results take turns across folders so one busy folder cannot use them all
function numberName() {
  const fid = h => h.folder ? h.folder.id : -1, order = [];
  nameHits.forEach(h => { if (!order.includes(fid(h))) order.push(fid(h)); });
  nameHits.sort((x, y) => order.indexOf(fid(x)) - order.indexOf(fid(y)));
  const groups = order.map(f => nameHits.filter(h => fid(h) === f));
  nameHits.forEach(h => h.k = 99);
  let k = 0;
  for (let r = 0; k < LINES && groups.some(g => g[r]); r++) for (const g of groups) { if (k >= LINES) break; if (g[r]) g[r].k = k++; }
}
function numberSem() { let k = 0; semHits.forEach(h => h.k = h.node && k < LINES ? k++ : 99); }

// names lead when the words actually appear in names; a sentence that matches no name is a description
function decideLead() {
  const words = pq.text.split(/\s+/).filter(Boolean).length;
  if (!semHits.length) lead = 'name';
  else if (!nameHits.length) lead = 'sem';
  else lead = words >= 4 && semHits[0].pct >= 50 ? 'sem' : 'name';
  const tag = $('mode');
  tag.hidden = !searching() || (!nameHits.length && !semHits.length);
  tag.textContent = lead === 'sem' ? 'BY MEANING' : 'BY NAME';
}
const leadList = () => lead === 'sem' ? semHits : nameHits;
const secondList = () => lead === 'sem' ? nameHits : semHits;

async function runSearch(q, filters = null) {
  const my = ++seq;
  let r, a;
  try { [r, a] = await Promise.all([invoke('search', { q, limit: 300, filters }), q && !filters ? invoke('apps_search', { q }) : Promise.resolve([])]); }
  catch (e) { toast(String(e)); return; }
  if (my !== seq) return;                       // a newer keystroke already won
  dropExtras(semHits);
  apps = a; total = r.total; nameMs = r.ms;
  if (apps.length) ensureIcons(apps).then(() => { if (my === seq) renderResults(); });
  nameHits = collapseDupes(r.hits.map(makeNameHit)); numberName();
  openDupes = new Set(); openFolders = new Set();
  sel = null; selInfo = null; hl = null; cursor = 0; moreSecond = false;
  decideLead(); renderAll(); showLit();
  clearTimeout(semDeb);
  if (semOn && q.trim().length >= 3) semDeb = setTimeout(() => runDescribe(q, my, filters), 260);
}
async function runDescribe(q, my, filters = null) {
  setSem('busy');
  let r;
  try { r = await invoke('describe', { q, k: 30 }); }
  catch (e) { setSem('off'); if (my === seq) toast(String(e)); return; }
  semLastUse = Date.now(); setSem('ready');
  if (my !== seq) return;
  semMs = r.ms;
  dropExtras(nameHits);
  // the same file saved in several places (WeChat keeps copies) shows once, with a copy count;
  // identical content gives an identical score, so name + score finds the copies
  const seen = new Map();
  semHits = [];
  const ranked = r.hits.filter(x => x.score >= SEM_MIN).map(makeSemHit).filter(h => semPasses(h, filters)).sort((a, b) => (b.score - (b.noisy ? .02 : 0)) - (a.score - (a.noisy ? .02 : 0)));
  for (const h of ranked) {
    const k = h.name.toLowerCase() + '|' + h.score.toFixed(4), first = seen.get(k);
    if (first) first.copies++; else { h.copies = 0; seen.set(k, h); semHits.push(h); }
  }
  numberSem();
  if (isQuestion(q) && semHits.length) askDocs(q, my); else ans = null;
  const before = lead; decideLead();
  renderAll();
  if (before !== lead || lead === 'sem') showLit();
}
// Ask your documents: when the search reads like a question, the best documents are read in full and
// the passage that answers it is shown on top, the question's words highlighted.
let ans = null, ansSeq = 0;
const isQuestion = q => /[?\u061f]\s*$/.test(q) || /^(what|when|where|who|which|how|why|is|are|does|do|can|ما|ماذا|متى|أين|اين|من|كم|كيف|لماذا|هل)\s/i.test(q.trim());
async function askDocs(q, my) {
  const top = semHits.filter(h => h.path).slice(0, 2).map(h => h.path);
  if (!top.length) return;
  ans = { q, busy: true, list: [] }; renderResults();
  let r; try { r = await invoke('answer', { q, paths: top }); } catch (e) { ans = null; renderResults(); return; }
  if (my !== seq) return;
  ans = { q, busy: false, list: r }; renderResults();
}
function markWords(text, q) {
  const words = q.toLowerCase().split(/[\s,.?\u061f]+/).filter(w => w.length > 2 && !/^(what|when|where|which|does|the|and|for|with|from|that|this|ما|متى|كيف|هل)$/.test(w));
  let h = esc(text);
  for (const w of words) h = h.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  return h;
}
function answerCard() {
  if (!ans || pq.text !== ans.q) return '';
  if (ans.busy) return '<div class="ans"><i>ANSWER</i><p class="dim">Reading the best documents…</p></div>';
  const a = ans.list[0]; if (!a) return '';
  return `<div class="ans" data-ans="0"><i>ANSWER · ${pct(a.score)}% match</i><p dir="auto">${markWords(a.passage, ans.q)}</p>
    <small dir="auto">${esc(a.path.split('\\').pop())} · <a href="#" data-ansopen="0">open</a> · <a href="#" data-ansshow="0">show in folder</a></small></div>`;
}
$('rlist').addEventListener('click', e => {
  const o = e.target.closest('[data-ansopen],[data-ansshow]'); if (!o || !ans) return;
  e.preventDefault(); e.stopPropagation();
  const a = ans.list[0]; act(o.dataset.ansopen != null ? 'open_item' : 'reveal_item', { path: a.path });
}, true);
function warmSem() {
  if (!semOn || semState !== 'off') return;
  setSem('busy');
  invoke('describe_warm').then(() => { semLastUse = Date.now(); setSem('ready'); }).catch(() => setSem('off'));
}
function setSem(s) { semState = s; renderNpu(); }

function litHits() {
  if (sel) return [selHit || { node: sel, chain: chainOf(sel), name: sel.name }];
  if (hl && hl.node) return [hl];
  return leadList().filter(h => h.node && h.k < LINES).sort((a, b) => a.k - b.k);
}
let selHit = null;
function showLit() { litVer++; const l = litHits(); if (l.length) fitTo(l.flatMap(h => h.chain), 40, l.map(h => h.node)); else if (!hasQuery()) fitAll(); }
function refit() { const l = litHits(); if (l.length) fitTo(l.flatMap(h => h.chain), 40, l.map(h => h.node)); }
function select(h) {
  selHit = h; sel = h.node; selInfo = null; litVer++;
  renderAll();                                   // first: the panel decides how much map is free
  if (sel) { const c = chainOf(sel); fitTo(c.length > 2 ? c.slice(1) : c, 40, [sel]); loadDetails(sel); }
}
function unselect() { sel = null; selHit = null; selInfo = null; litVer++; renderAll(); refit(); }
async function loadDetails(n) {
  try { const d = await invoke('details', { id: n.id }); if (sel === n) { selInfo = d; renderDetail(); } }
  catch (e) { toast(String(e)); }
}
function resetAll() {
  if (qlOn) closeQuick();
  clearTimeout(deb); clearTimeout(semDeb); seq++; $('q').value = ''; $('clr').hidden = true;
  nameHits = []; semHits = []; apps = []; total = 0; sel = null; selHit = null; selInfo = null; hl = null; cursor = 0;
  dropExtras([]); decideLead(); renderAll(); litVer++; fitAll();
}
const target = h => h.node ? { id: h.node.id } : { path: h.path };
async function act(cmd, h) { try { await invoke(cmd, target(h)); } catch (e) { toast(String(e)); } }
async function launch(a) {
  try { await invoke('launch_app', { id: a.id, name: a.name }); toast(`Launching ${a.name}`); loadDock(); }
  catch (e) { toast(String(e)); }
}

// ---------------------------------------------------------------- results panel
function renderAll() {
  const q = hasQuery();
  document.body.classList.toggle('idle', !q && !sel);
  $('results').hidden = !q && !sel && !ttMode;
  renderResults(); renderDetail();
}
// one result: type (in its colour) | name | readable path | size, date, places, copy tag.
// A bar on the left marks the results that have a lit line on the map. sub = another place of a dupe.
function nameRow(h, i, sub) {
  const where = pathOf(h.chain.slice(0, -1));   // sub: the main result's folder path, to compare against
  const cls = `row${h.k < LINES && !sub ? ' lit' : ''}${sel && h.node === sel ? ' on' : ''}${cursor === i ? ' cur' : ''}${sub ? ' sub' : ''}`;
  if (sub) return `<div class="${cls}" data-r="${i}"><span class="k"></span><span class="p2" title="${esc(where)}">${esc(diffPath(where, sub))}</span>${h.noisy ? '<span class="m"><span class="tag">copy / build</span></span>' : ''}</div>`;
  const meta = h.kind === K.FILE ? `${fmt(h.size)} · ${day(h.mtime)}` : h.kind === K.LINK ? 'link' : `${num(h.node.count)} items · ${fmt(h.size)}`;
  const places = h.dupes && h.dupes.length ? `<button type="button" class="chip" data-dupes="${i}" aria-expanded="${openDupes.has(h)}">${h.dupes.length + 1} places</button>` : '';
  return `<div class="${cls}" data-r="${i}">
    <span class="k t" style="color:${tintOf(h)}">${esc(extOf(h.name, h.kind))}</span>
    <span class="n" dir="auto">${esc(h.name)}</span>
    <span class="p2" title="${esc(where)}">${esc(shortPath(where))}</span>
    <span class="m">${meta}${places}${h.noisy ? '<span class="tag">copy / build</span>' : ''}${h.tooling ? '<span class="tag">tooling</span>' : ''}</span></div>`;
}
function semRow(h, i) {
  const where = h.chain.length ? pathOf(h.chain.slice(0, -1)) : h.path.slice(0, h.path.lastIndexOf('\\'));
  return `<div class="row${selHit === h ? ' on' : ''}${cursor === i ? ' cur' : ''}" data-r="${i}">
    <span class="k" style="color:${tintOf(h)}">${h.pct}<small>%</small></span>
    <span class="n" dir="auto">${esc(h.name)}</span>
    ${h.snip ? `<span class="s" dir="auto">${esc(h.snip)}</span>` : ''}
    <span class="p2" title="${esc(where)}">${esc(shortPath(where))}</span>
    ${h.copies || h.noisy ? `<span class="m">${h.copies ? `+${h.copies} identical cop${h.copies > 1 ? 'ies' : 'y'} elsewhere` : ''}${h.noisy ? '<span class="tag">copy / build</span>' : ''}</span>` : ''}</div>`;
}
function renderResults() {
  const q = $('q').value.trim();
  rows = [];
  if (!q && ttMode && !sel) { renderTravel(); return; }
  if (!q) { $('rh').textContent = sel ? 'SELECTED' : 'RESULTS'; $('rmeta').textContent = ''; $('rlist').innerHTML = ''; return; }
  if (pq.mode === 'calc') {
    let v = null; try { v = calc(pq.text); } catch { /* not a full sum yet */ }
    $('rh').textContent = 'CALCULATOR'; $('rmeta').textContent = '';
    rows = v == null ? [] : [{ calc: v }];
    $('rlist').innerHTML = v == null ? '<div class="empty">Type a sum: 1250*12 · (3+4)^2 · 15% * 200 · sqrt(2) · pi*2</div>'
      : `<div class="row calc cur" data-r="0"><span class="k t">=</span><span class="n big">${calcText(v)}</span><span class="m">Enter copies it</span></div>`;
    return;
  }
  if (pq.mode === 'cmd') {
    const list = matchCommands(pq.text);
    $('rh').textContent = 'COMMANDS'; $('rmeta').textContent = '';
    rows = list.map(c => ({ cmd: c })); if (cursor >= rows.length) cursor = 0;
    $('rlist').innerHTML = list.length ? list.map((c, i) => `<div class="row cmd${cursor === i ? ' cur' : ''}${armed === c.key ? ' armed' : ''}" data-r="${i}">
      <span class="k t">›</span><span class="n">${esc(c.label)}</span><span class="m">${armed === c.key ? 'Press Enter again to confirm' : esc('> ' + c.key)}</span></div>`).join('')
      : '<div class="empty">No such command.</div>';
    return;
  }
  const L = leadList(), S2 = secondList();
  $('rh').textContent = lead === 'sem' ? 'BY MEANING' : 'BY NAME';
  $('rmeta').textContent = lead === 'sem' ? `${semMs.toFixed(0)} ms on NPU` : `${num(total)} · ${nameMs.toFixed(0)} ms`;
  let html = (pq.chips.length ? `<div class="fchips">${pq.chips.map(c => `<span>${esc(c)}</span>`).join('')}</div>` : '') + answerCard();
  const add = (h, fn) => { const i = rows.length; rows.push(h); return fn(h, i); };
  if (apps.length) { html += '<div class="sec"><span>APPS</span></div>'; apps.forEach(a => { html += add({ app: a }, (x, i) => `<div class="row app${cursor === i ? ' cur' : ''}" data-r="${i}"><span class="k">${iconHtml(a)}</span><span class="n" dir="auto">${esc(a.name)}${a.pinned ? '<i class="pin"></i>' : ''}</span></div>`); }); }
  const rowFn = h => h.src === 'sem' ? semRow : nameRow;
  if (L.length) {
    if (apps.length) html += `<div class="sec"><span>${lead === 'sem' ? 'DOCUMENTS' : 'FILES &amp; FOLDERS'}</span></div>`;
    if (lead === 'sem') L.slice(0, 150).forEach(h => { html += add(h, rowFn(h)); });
    else {
      // name results come grouped by folder: a busy folder shows 3, then "+N more in <folder>"
      const fid = h => h.folder ? h.folder.id : -1;
      let shown = 0;
      for (let i = 0; i < L.length && shown < 150;) {
        let j = i; while (j < L.length && fid(L[j]) === fid(L[i])) j++;
        const group = L.slice(i, j), open = group.length <= 4 || openFolders.has(fid(L[i]));
        for (const h of open ? group : group.slice(0, 3)) {
          html += add(h, nameRow); shown++;
          if (openDupes.has(h)) { const ref = pathOf(h.chain.slice(0, -1)); h.dupes.forEach(d => { html += add(d, (x, k) => nameRow(x, k, ref)); }); }
        }
        if (!open) html += `<button type="button" class="more" data-folder="${fid(L[i])}">+${group.length - 3} more in ${esc(group[0].folder ? group[0].folder.name : 'this folder')}</button>`;
        i = j;
      }
      if (L.length > shown) html += `<div class="empty">Top ${shown} of ${num(total)}. Add a word to narrow it down.</div>`;
    }
  }
  if (S2.length) {
    const shown = moreSecond ? S2.slice(0, 60) : S2.slice(0, 4);
    html += `<div class="sec"><span>${lead === 'sem' ? `ALSO BY NAME · ${num(total)}` : 'ALSO BY MEANING'}</span>${S2.length > 4 ? `<button type="button" data-more>${moreSecond ? 'LESS' : 'MORE'}</button>` : ''}</div>`;
    shown.forEach(h => { html += add(h, rowFn(h)); });
  }
  if (!rows.length) html += semState === 'busy' ? '<div class="empty">Reading meaning…</div>' : '<div class="empty">Nothing found. Try fewer words, or describe what is inside the file.</div>';
  $('rlist').innerHTML = html;
  const cur = $('rlist').querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  if (qlOn && rows[cursor] !== qlFor) { if (canQuick(rows[cursor])) openQuick(rows[cursor]); else closeQuick(); }
}
// drag a result out of Orbis (into Explorer, an email, WhatsApp...): press, move a few pixels, drop
let dragOut = null, dragged = false;
$('rlist').addEventListener('pointerdown', e => {
  const r = e.target.closest('[data-r]'), h = r && rows[+r.dataset.r];
  dragOut = e.button === 0 && h && (h.node || h.path) && h.kind !== K.ROOT && h.kind !== K.DRIVE ? { x: e.clientX, y: e.clientY, h } : null;
  dragged = false;
});
$('rlist').addEventListener('pointermove', e => {
  if (!dragOut || !(e.buttons & 1) || Math.hypot(e.clientX - dragOut.x, e.clientY - dragOut.y) < 8) return;
  const h = dragOut.h; dragOut = null; dragged = true;
  invoke('drag_out', { paths: [hitPath(h)] }).catch(err => toast(String(err)));
});
addEventListener('pointerup', () => { dragOut = null; });
$('rlist').addEventListener('click', e => {
  if (dragged) { dragged = false; return; }   // that was a drag, not a click
  if (e.target.closest('[data-more]')) { moreSecond = !moreSecond; renderResults(); return; }
  const dp = e.target.closest('[data-dupes]');
  if (dp) { const h = rows[+dp.dataset.dupes]; if (openDupes.has(h)) openDupes.delete(h); else openDupes.add(h); renderResults(); return; }
  const mf = e.target.closest('[data-folder]');
  if (mf) { openFolders.add(+mf.dataset.folder); renderResults(); return; }
  const r = e.target.closest('[data-r]'); if (!r) return;
  const h = rows[+r.dataset.r]; cursor = +r.dataset.r;
  if (h.calc != null || h.cmd || h.app) actOn(h); else select(h);   // a file or folder: show its details
});
// right-click an app (here or in the list on the left) to pin or unpin it
$('rlist').addEventListener('contextmenu', e => { const r = e.target.closest('[data-r]'), h = r && rows[+r.dataset.r]; if (h && h.app) { e.preventDefault(); togglePin(h.app); } });
$('rlist').addEventListener('dblclick', e => { const r = e.target.closest('[data-r]'); const h = r && rows[+r.dataset.r]; if (h && (h.node || h.path)) act('open_item', h); });
$('rlist').addEventListener('mouseover', e => { const r = e.target.closest('[data-r]'); const h = r ? rows[+r.dataset.r] : null; const n = h && !h.app ? h : null; if (n !== hl) { hl = n; litVer++; } });
$('rlist').addEventListener('mouseleave', () => { if (hl) { hl = null; litVer++; } });

function renderDetail() {
  const el = $('detail');
  if (!selHit) { el.hidden = true; return; }
  el.hidden = false;
  const h = selHit, d = selInfo;
  const acts = isDir => `<div class="acts"><button class="pri" data-a="open_item">OPEN</button><button data-a="preview">PREVIEW</button><button data-a="ws" title="Add to a workspace">+ WORKSPACE</button><button data-a="reveal_item">FOLDER</button>${isDir ? '<button data-a="vscode_item">VS CODE</button>' : ''}<button data-a="copy">COPY</button></div>`;
  if (!h.node) {   // a document the map does not hold
    el.innerHTML = `<div class="nm" dir="auto">${esc(h.name)}</div><div class="pa" dir="auto">${esc(h.path)}</div>
      <dl><dt>SIZE</dt><dd>${fmt(h.size)}</dd><dt>CHANGED</dt><dd>${day(h.mtime)}</dd></dl>${acts(false)}`;
    return;
  }
  if (!d) { el.innerHTML = `<div class="nm" dir="auto">${esc(h.name)}</div><div class="pa">Loading…</div>`; return; }
  const isFile = d.kind === K.FILE || d.kind === K.LINK;
  const type = d.kind === K.DIR && d.is_repo ? 'Folder · Git repository' : KIND_LABEL[d.kind];
  const z = d.zone, src = z && (z.host || z.referrer);
  el.innerHTML = `<div class="nm" dir="auto">${esc(d.name)}</div><div class="pa" dir="auto">${esc(d.path)}</div>
    <dl><dt>TYPE</dt><dd>${type}</dd><dt>SIZE</dt><dd>${fmt(d.size)}${isFile ? '' : ` · ${num(d.count)} items`}</dd>
    <dt>CHANGED</dt><dd>${day(d.mtime)}</dd>
    ${d.came_from ? `<dt>CAME FROM</dt><dd dir="auto" title="${esc(d.came_from[1])}">${esc(d.came_from[0])}</dd>` : ''}
    ${isFile && src ? `<dt>DOWNLOADED</dt><dd>${esc(src)}</dd>` : ''}</dl>
    ${h.snip ? `<div class="pa" dir="auto" style="color:var(--ink);opacity:.8">${esc(h.snip)}</div>` : ''}${acts(!isFile)}<div class="wspick"></div>`;
}
$('detail').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || !selHit) return;
  if (b.dataset.a === 'preview') { openQuick(selHit); return; }
  if (b.dataset.a === 'ws') { addToWorkspace(selHit); return; }
  if (b.dataset.a === 'copy') { const p = selInfo ? selInfo.path : selHit.path; navigator.clipboard.writeText(p || '').then(() => toast('Path copied')); return; }
  act(b.dataset.a, selHit);
});

// ---------------------------------------------------------------- quick preview
// Space on a result (after moving to it with the arrows) shows it right here: pictures, PDFs, video
// and sound straight from disk, text and code, Word / Excel / PowerPoint, a folder's contents. While it
// is open the arrows flip through the results; Space or Esc closes it.
let qlOn = false, qlFor = null, listMode = false, qlSeq = 0;
const QL_IMG = 'jpg jpeg png gif webp bmp svg ico avif'.split(' '), QL_VID = 'mp4 webm mov m4v ogv'.split(' '), QL_AUD = 'mp3 wav ogg m4a flac aac opus'.split(' ');
const QL_OFFICE = 'docx xlsx xlsm pptx'.split(' ');
const QL_TEXT = ('txt md csv tsv log ini cfg conf json xml yml yaml toml sql html htm css scss js mjs cjs ts tsx jsx py rs go java kt c h cpp hpp cs php rb swift dart lua ' +
  'sh bat cmd ps1 psm1 vue svelte env gitignore editorconfig properties gradle csproj sln reg srt vtt').split(' ');
const hitPath = h => h.path || (h.chain ? pathOf(h.chain) : '');
const canQuick = h => !!h && !!(h.node || h.path) && h.kind !== K.ROOT && h.kind !== K.DRIVE;
function toggleQuick() { if (qlOn) closeQuick(); else openQuick(rows[cursor]); }
function closeQuick() { qlOn = false; qlFor = null; $('ql').hidden = true; $('qlb').innerHTML = ''; }
async function openQuick(h) {
  if (!canQuick(h)) return;
  if (qlOn && qlFor === h) return;
  qlOn = true; qlFor = h; const my = ++qlSeq;
  const path = hitPath(h), isDir = h.kind === K.DIR || h.kind === K.TOOL || h.kind === K.LINK;
  const ext = isDir ? '' : (h.name.split('.').pop() || '').toLowerCase(), src = window.__TAURI__.core.convertFileSrc(path);
  const meta = isDir ? `${h.node ? num(h.node.count) + ' items · ' : ''}${fmt(h.size)}` : `${fmt(h.size)} · ${day(h.mtime)}`;
  $('qlh').innerHTML = `<span class="k t" style="color:${tintOf(h)}">${esc(extOf(h.name, h.kind))}</span><div><b dir="auto">${esc(h.name)}</b><small dir="auto">${esc(path)} · ${meta}</small></div>
    <button type="button" data-ql="open_item">OPEN</button><button type="button" data-ql="reveal_item">FOLDER</button><button type="button" data-ql="close" aria-label="Close preview">×</button>`;
  const body = $('qlb'), put = html => { if (my === qlSeq) body.innerHTML = html; };
  $('ql').hidden = false;
  if (isDir && h.node) {
    put('<div class="qle">Loading…</div>');
    try {
      const items = await invoke('folder_items', { id: h.node.id });
      put(items.length ? `<div class="qlf">${items.map(c => { const f = c.kind === K.FILE; return `<div><span class="k t">${esc(extOf(c.name, c.kind))}</span><span dir="auto">${esc(c.name)}</span><small>${f ? fmt(c.size) : num(c.count) + ' items'}</small></div>`; }).join('')}</div>` : '<div class="qle">This folder is empty.</div>');
    } catch (e) { put(`<div class="qle">${esc(String(e))}</div>`); }
  } else if (QL_IMG.includes(ext)) put(`<img class="qli" src="${src}" alt="">`);
  else if (ext === 'pdf') put(`<iframe class="qlp" src="${src}#toolbar=0&view=FitH" title="PDF preview"></iframe>`);
  else if (QL_VID.includes(ext)) put(`<video class="qli" src="${src}" controls autoplay muted></video>`);
  else if (QL_AUD.includes(ext)) put(`<div class="qle"><audio src="${src}" controls autoplay></audio></div>`);
  else if (QL_OFFICE.includes(ext)) {
    put('<div class="qle">Reading…</div>');
    try {
      const o = await invoke('preview_office', { path });
      if (o.kind === 'sheet') put(`<div class="qls"><table>${o.rows.map(r => `<tr>${r.map(c => `<td dir="auto">${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      else if (o.kind === 'slides') put(`<div class="qld">${o.slides.map((s, i) => `<section><i>SLIDE ${i + 1}</i>${s.map(p => `<p dir="auto">${esc(p)}</p>`).join('')}</section>`).join('')}</div>`);
      else put(`<div class="qld">${o.paras.map(p => `<p dir="auto">${esc(p)}</p>`).join('') || '<p>No text in this document.</p>'}</div>`);
    } catch (e) { put(`<div class="qle">${esc(String(e))}</div>`); }
  } else if (QL_TEXT.includes(ext) || !ext.includes(' ') && h.size < 300000 && !/^(exe|dll|msi|zip|rar|7z|iso|bin|dat|db|sys|lnk|doc|xls|ppt|psd|ai|mkv|avi|heic|tif|tiff|raw)$/.test(ext)) {
    put('<div class="qle">Reading…</div>');
    try { const t = await invoke('preview_text', { path }); put(`<pre class="qlt" dir="auto">${esc(t.text)}</pre>${t.truncated ? '<div class="qle">Showing the first 300 KB.</div>' : ''}`); }
    catch (e) { put(`<div class="qle">No preview for this type.<br><small>Enter opens it.</small></div>`); }
  } else put(`<div class="qle"><span class="big t" style="color:${tintOf(h)}">${esc(extOf(h.name, h.kind))}</span>No preview for this type.<br><small>Enter opens it.</small></div>`);
}
$('qlh').addEventListener('click', e => {
  const b = e.target.closest('[data-ql]'); if (!b || !qlFor) return;
  if (b.dataset.ql === 'close') closeQuick(); else act(b.dataset.ql, qlFor);
});

let tt; function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2400); }

// ---------------------------------------------------------------- small widgets
// app icons in the theme's colours: each icon's light and shade are remapped onto three tones of the
// theme (deep, accent, bright), so every icon matches whichever theme is on and changes with it
const iconRaw = new Map(), iconThemed = new Map();
const rgbArr = hex => rgbOf(hex).split(',').map(Number);
const mixArr = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function themeIcon(id) {
  const key = themeKey + '|' + id, src = iconRaw.get(id);
  if (iconThemed.has(key) || !src) return Promise.resolve();
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 48;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 48, 48);
      const d = x.getImageData(0, 0, 48, 48), p = d.data, acc = rgbArr(theme.acc);
      const dark = theme.light ? rgbArr(theme.lit) : mixArr(rgbArr(theme.bg), acc, .45);
      const bright = theme.light ? mixArr(rgbArr(theme.bg), acc, .35) : rgbArr(theme.lit);
      for (let i = 0; i < p.length; i += 4) {
        if (!p[i + 3]) continue;
        const L = (p[i] * .299 + p[i + 1] * .587 + p[i + 2] * .114) / 255;
        const [a, b, t] = L < .5 ? [dark, acc, L * 2] : [acc, bright, (L - .5) * 2];
        p[i] = a[0] + (b[0] - a[0]) * t; p[i + 1] = a[1] + (b[1] - a[1]) * t; p[i + 2] = a[2] + (b[2] - a[2]) * t;
      }
      x.putImageData(d, 0, 0); iconThemed.set(key, c.toDataURL()); res();
    };
    img.onerror = () => res();
    img.src = src;
  });
}
async function ensureIcons(list) {
  const want = [...new Set(list.map(a => a.id))].filter(id => !iconRaw.has(id));
  if (want.length) {
    try { const got = await invoke('app_icons', { ids: want }); want.forEach(id => iconRaw.set(id, got[id] || '')); }
    catch { return; }
  }
  await Promise.all(list.map(a => themeIcon(a.id)));
}
const iconHtml = a => { const u = iconThemed.get(themeKey + '|' + a.id); return u ? `<img class="aicon" src="${u}" alt="">` : `<span class="badge">${esc(initials(a.name))}</span>`; };

// the five apps you use most (Windows' own record), on the left
let dockApps = [];
function renderDock() {
  const item = a => `<button type="button" data-dock="${dockApps.indexOf(a)}" title="${esc(a.name)} · right-click to ${a.pinned ? 'unpin' : 'pin'}">${iconHtml(a)}<span dir="auto">${esc(a.name)}</span>${a.pinned ? '<i class="pin"></i>' : ''}</button>`;
  const pins = dockApps.filter(a => a.pinned), most = dockApps.filter(a => !a.pinned);
  $('dock').innerHTML = (pins.length ? '<div class="lbl">PINNED</div>' + pins.map(item).join('') : '')
    + (most.length ? `<div class="lbl">${pins.length ? 'MOST USED' : 'APPS'}</div>` + most.map(item).join('') : '');
}
$('dock').onclick = e => { const d = e.target.closest('[data-dock]'); if (d) launch(dockApps[+d.dataset.dock]); };
$('dock').addEventListener('contextmenu', e => { const d = e.target.closest('[data-dock]'); if (!d) return; e.preventDefault(); togglePin(dockApps[+d.dataset.dock]); });
async function togglePin(a) {
  try { await invoke('pin_app', { id: a.id, on: !a.pinned }); toast(a.pinned ? `Unpinned ${a.name}` : `Pinned ${a.name}`); await loadDock(); if (hasQuery()) runQuery($('q').value); }
  catch (e) { toast(String(e)); }
}
addEventListener('contextmenu', e => e.preventDefault());   // no browser menu anywhere in Orbis
async function loadDock() {
  try { dockApps = await invoke('apps_top', { n: 5 }); } catch { return; }   // apps not read yet
  renderDock();
  ensureIcons(dockApps).then(renderDock);
}
listen('icons-ready', () => { iconRaw.clear(); iconThemed.clear(); loadDock(); if (apps.length) ensureIcons(apps).then(renderResults); });
let st = null;
// the dot by the clock: green while the search-by-meaning helper is loaded (it unloads itself after
// two idle minutes), blinking while it searches, amber while it reads documents, grey when asleep
function renderNpu() {
  const el = $('npu'), s = st && st.sem, dev = setting('sem_device', 'auto');
  el.hidden = !setting('semantic', false) || !s || !s.available;
  if (el.hidden) return;
  const indexing = s.live, where = { NPU: 'the NPU', GPU: 'the Intel GPU', CPU: 'the processor' }[dev] || 'this PC';
  el.innerHTML = '<i></i>' + ({ NPU: 'NPU', GPU: 'GPU', CPU: 'CPU' }[dev] || 'AI');
  el.className = 'npu ' + (semState === 'busy' ? 'busy' : semState === 'ready' ? 'ready' : indexing ? 'indexing' : '');
  el.title = indexing ? `Reading documents on ${where}: ${num(s.done)} of ${num(s.of)}` : semState === 'ready' ? `Search by meaning is loaded on ${where}`
    : !semOn ? 'Search by meaning: no documents read yet' : 'Search by meaning is asleep. It wakes when you type.';
}
const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
async function tickStats() {
  let s; try { s = await invoke('sys_stats'); } catch { return; }
  stats = s;
  cpuHist.push(s.cpu); if (cpuHist.length > 60) cpuHist.shift();
  if (saverOn) renderSaver();
  const docs = st && st.sem ? st.sem.files : 0;
  $('data').innerHTML = row('NODES', st ? num(st.items) : '—') + row('DOCS', docs ? num(docs) : '—') + row('APPS', st ? num(st.apps) : '—') + '<i></i>'
    + row('CPU', Math.round(s.cpu) + '%') + row('MEM', Math.round(s.mem_used / s.mem_total * 100) + '%')
    + s.drives.map(d => row(d.name, fmt(d.free) + ' free')).join('')
    + (s.battery != null ? row('PWR', s.battery + '%' + (s.charging ? ' AC' : '')) : '');
}
let cpuHist = [];
const hm = d => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`, ampm = d => d.getHours() < 12 ? 'AM' : 'PM';
function tickClock() {
  const d = new Date();
  $('clock').innerHTML = `${hm(d)}<small>${ampm(d)}</small>`;
  $('date').textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(/,/g, '');
  if (saverOn) {
    $('svT').innerHTML = `${hm(d)}<small><em>${ampm(d)}</em>${String(d.getSeconds()).padStart(2, '0')}</small>`;
    $('svD').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/,/g, '').replace(' ', ' · ');
  }
}
async function refreshStatus() {
  try { st = await invoke('status'); } catch { return st; }
  semOn = !!(setting('semantic', false) && st.sem && st.sem.available && st.sem.files > 0);
  renderPrefs();
  if (semState === 'ready' && !(st.sem && st.sem.helper) && Date.now() - semLastUse > 5000) semState = 'off';   // the helper unloaded itself
  renderNpu();
  $('pfiles').innerHTML = `<span>Files</span> ${num(st.items)}${st.building ? ' · re-scanning…' : ` · ${day(st.built_at)}`}`;
  const s = st.sem;
  $('auto').setAttribute('aria-pressed', String(!!st.autostart)); $('auto').textContent = 'Start with Windows: ' + (st.autostart ? 'ON' : 'OFF');
  const tq = setting('tray_start', false);
  $('ptray').setAttribute('aria-pressed', String(tq)); $('ptray').textContent = 'Start quietly in the tray: ' + (tq ? 'ON' : 'OFF');
  $('ptray').disabled = !st.autostart; $('ptray').title = st.autostart ? 'When Windows starts Orbis, it waits in the tray instead of opening full screen' : 'Turn on Start with Windows first';
  $('pdocs').innerHTML = !s || !s.available ? '<span>Documents</span> not installed'
    : s.live ? `<span>Documents</span> reading ${num(s.done)} / ${num(s.of)}` : `<span>Documents</span> ${num(s.files)} · ${s.built ? day(s.built) : 'never'}`;
  return st;
}
setInterval(() => { if (!document.hidden) tickClock(); }, 5000);
setInterval(() => { if (!document.hidden) tickStats(); }, 3000);
setInterval(() => { if (!document.hidden) refreshStatus(); }, 15000);

// ---------------------------------------------------------------- window, popover, keys
let kiosk = true;
function renderWin() { $('win').textContent = kiosk ? 'WINDOW' : 'FULL SCREEN'; document.body.classList.toggle('windowed', !kiosk); }
$('wmin').onclick = () => invoke('win_minimize');
$('wmax').onclick = () => invoke('win_toggle_maximize');
$('wclose').onclick = () => invoke('win_hide');
// the tray menu changed a setting (or Rust has something to say)
listen('prefs-changed', () => refreshStatus());
listen('toast', e => toast(String(e.payload)));
async function toggleKiosk() { kiosk = await invoke('set_kiosk', { on: !kiosk }); renderWin(); }
$('win').onclick = toggleKiosk;
$('exit').onclick = () => invoke('quit_app');
$('gear').onclick = e => { e.stopPropagation(); const p = $('pop'); p.hidden = !p.hidden; $('gear').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) refreshStatus(); };
document.addEventListener('pointerdown', e => { if (!$('pop').hidden && !e.target.closest('#pop,#gear')) { $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false'); } });
$('auto').onclick = async () => {
  try { const on = await invoke('set_autostart', { on: !(st && st.autostart) }); if (st) st.autostart = on; refreshStatus(); toast(on ? 'Orbis will open when Windows starts' : 'Orbis no longer opens with Windows'); }
  catch (e) { toast(String(e)); }
};
$('pop').addEventListener('click', async e => {
  const b = e.target.closest('[data-cmd]'); if (!b) return;
  try { await invoke(b.dataset.cmd); toast(b.dataset.cmd === 'rebuild' ? 'Re-scanning drives in the background' : 'Reading documents in the background'); setTimeout(refreshStatus, 1500); }
  catch (err) { toast(String(err)); }
});

$('q').addEventListener('input', e => {
  const v = e.target.value; $('clr').hidden = !v; clearTimeout(deb); listMode = false; if (qlOn) closeQuick(); if (ttMode && v.trim()) leaveTravel();
  if (!v.trim()) { resetAll(); return; }
  if (!/^\s*[=>]/.test(v)) warmSem();
  deb = setTimeout(() => runQuery(v), 110);
});
$('q').addEventListener('keydown', e => {
  const n = rows.length;
  const plain = h => !!(h.node || h.path);
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) listMode = true;
  if (e.key === ' ' && n && (listMode || qlOn) && canQuick(rows[cursor])) { e.preventDefault(); toggleQuick(); return; }
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); cursor = (cursor + 1) % n; armed = null; hl = plain(rows[cursor]) ? rows[cursor] : null; litVer++; renderResults(); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); cursor = (cursor - 1 + n) % n; armed = null; hl = plain(rows[cursor]) ? rows[cursor] : null; litVer++; renderResults(); }
  else if (e.key === 'Enter' && n) {
    e.preventDefault(); const h = rows[cursor]; if (h) actOn(h);
  }
});
$('clr').onclick = () => { resetAll(); $('q').focus(); };
// type anywhere: after a click on a button, an app or the map, letters, digits and symbols still go
// to the search box (and ↑ ↓ Enter still move through the results). Other text fields, the setup
// screen and the screen saver keep their keys.
addEventListener('keydown', e => {
  const q = $('q'), t = document.activeElement;
  if (saverOn || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || t === q || q.disabled || !$('wiz').hidden || !$('scope').hidden || !$('reclaim').hidden || !$('wsd').hidden) return;
  if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit)$/.test(t.type)))) return;
  if (e.key.length === 1 || e.key === 'Backspace') {
    e.preventDefault();
    if (!$('pop').hidden) { $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false'); }
    q.focus();
    q.value = e.key === 'Backspace' ? q.value.slice(0, -1) : q.value + e.key;
    q.setSelectionRange(q.value.length, q.value.length);
    q.dispatchEvent(new Event('input'));
  } else if (/^(ArrowDown|ArrowUp|Enter)$/.test(e.key) && (hasQuery() || ttMode) && !(e.key === 'Enter' && t && t.tagName === 'BUTTON')) {
    e.preventDefault(); q.focus(); q.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
  }
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && qlOn) { closeQuick(); return; }
  if (e.key === 'Escape' && ttMode && !sel) { leaveTravel(); return; }
  if (e.key === 'Escape') { if (!$('pop').hidden) $('pop').hidden = true; else if (sel && hasQuery()) unselect(); else if (hasQuery() || sel) resetAll(); }
  if (e.key === 'F11') { e.preventDefault(); toggleKiosk(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('q').focus(); $('q').select(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'q') { e.preventDefault(); invoke('quit_app'); }
});

// ---------------------------------------------------------------- pointer
let drag = null, lastInput = performance.now(), pickAt = null;
['pointermove', 'keydown', 'wheel', 'pointerdown'].forEach(ev => addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true }));
fx.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, yaw: cam.yaw, pitch: cam.pitch, m: 0 }; fx.setPointerCapture(e.pointerId); fx.classList.add('grab'); view.to = null; });
fx.addEventListener('pointermove', e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.m = Math.max(drag.m, Math.abs(dx) + Math.abs(dy));
    if (cam.fold > .5) { cam.yaw = drag.yaw - dx * .006; cam.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + dy * .006)); }   // spin the globe
    else { view.x = drag.vx - dx / view.s; view.y = drag.vy - dy / view.s; }                                                      // pan the map
    return;
  }
  pickAt = { x: e.clientX, y: e.clientY };
});
fx.addEventListener('pointerup', e => {
  fx.classList.remove('grab'); const moved = drag && drag.m > 5; drag = null; if (moved) return;
  const n = pick(e.clientX, e.clientY);
  if (n && n.kind !== K.ROOT) { const h = [...nameHits, ...semHits].find(x => x.node === n); select(h || { node: n, chain: chainOf(n), name: n.name, kind: n.kind }); return; }
  if (sel) { if (hasQuery()) unselect(); else resetAll(); }
});
fx.addEventListener('pointerleave', () => { hover = null; pickAt = null; });
fx.addEventListener('dblclick', e => { const n = pick(e.clientX, e.clientY); if (n && n.kind !== K.ROOT) act('open_item', { node: n }); });
fx.addEventListener('wheel', e => e.preventDefault(), { passive: false });   // no zooming: the view frames itself
function pick(mx, my) {
  let b = null, bd = 1e9;
  for (const n of G.values()) { const d = Math.hypot(n.px - mx, n.py - my); if (d < 10 && d < bd) { bd = d; b = n; } }
  return b;
}

// ---------------------------------------------------------------- the globe: always moving until you search
// With nothing searched or picked, the map is a globe that turns on its own - speeding up, slowing
// down, reversing at random - while its shells turn against each other and the globe nods. A search
// (or clicking a folder) unfolds it into the flat 2D map; clearing the search folds it back up.
const drift = { on: false, rate: 0, rateTo: 0, yawRate: 0, yawTo: 0, pitchTo: .3, next: 0 };
const pickRate = () => (Math.random() < .5 ? -1 : 1) * (.04 + Math.random() * .1);
function startDrift() {
  if (drift.on || reduce) return;
  Object.assign(drift, { on: true, rate: 0, rateTo: pickRate(), yawRate: 0, yawTo: pickRate() * .6, next: 0 });
  fitGlobe();
}
function stopDrift() {
  if (!drift.on) return;
  drift.on = false;
}
function stepCamera(dt) {
  const ease = r => 1 - Math.exp(-dt * r), toward = (v, to, max) => v + Math.sign(to - v) * Math.min(Math.abs(to - v), max);
  const target = drift.on ? 1 : 0;
  cam.fold += (target - cam.fold) * ease(drift.on ? 1.4 : 3.5);
  if (Math.abs(cam.fold - target) < 1e-3) cam.fold = target;
  if (!drift.on) return;
  drift.rate = toward(drift.rate, drift.rateTo, dt * .04); drift.yawRate = toward(drift.yawRate, drift.yawTo, dt * .03);
  cam.spin += drift.rate * dt; cam.yaw += drift.yawRate * dt;
  if (Math.random() < dt * .05) drift.rateTo = pickRate();
  if (Math.random() < dt * .04) drift.yawTo = pickRate() * .6;
  if (T > drift.next) { drift.pitchTo = -.2 + Math.random() * .8; drift.next = T + 7 + Math.random() * 8; }
  cam.pitch += (drift.pitchTo - cam.pitch) * ease(.35);
}

// ---------------------------------------------------------------- drawing helpers
const sub = h => h.src === 'sem' ? `MATCH ${h.pct}%` : h.folder && h.folder.kind !== K.ROOT ? `IN ${h.folder.name}`.toUpperCase().slice(0, 40) : '';
const clamp01 = v => Math.max(0, Math.min(1, v));
const easeOut = t => 1 - Math.pow(1 - clamp01(t), 3);
function textOut(t, x, y, fill) { g.lineWidth = 4; g.strokeStyle = theme.bg; g.strokeText(t, x, y); g.fillStyle = fill; g.fillText(t, x, y); }
function label(n, title, subline, subColor, placed, force, alpha = 1) {
  const r = region(), cxs = W / 2 + C.ox;
  const name = title.length > 40 ? title.slice(0, 39) + '…' : title;
  g.font = '500 12.5px "Cascadia Mono",Consolas,monospace'; g.letterSpacing = '0px'; const w1 = g.measureText(name).width;
  g.font = '600 9.5px Bahnschrift,"Segoe UI",sans-serif'; g.letterSpacing = '1.5px'; const w2 = subline ? g.measureText(subline).width : 0;
  const w = Math.max(w1, w2);
  let right = n.px >= cxs;
  if (right && n.px + 14 + w > r.r) right = false; else if (!right && n.px - 14 - w < r.l) right = true;
  const x = right ? n.px + 14 : n.px - 14 - w, box = { x, y: n.py - 17, w, h: subline ? 32 : 20 };
  if (!force && placed.some(b => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return;
  placed.push(box);
  g.globalAlpha = alpha; g.textAlign = right ? 'left' : 'right'; g.lineJoin = 'round'; const tx = right ? n.px + 14 : n.px - 14;
  g.font = '500 12.5px "Cascadia Mono",Consolas,monospace'; g.letterSpacing = '0px'; textOut(name, tx, n.py + (subline ? -2 : 4), theme.lit);
  if (subline) { g.font = '600 9.5px Bahnschrift,"Segoe UI",sans-serif'; g.letterSpacing = '1.5px'; textOut(subline, tx, n.py + 11, subColor || theme.acc); }
  g.textAlign = 'left'; g.letterSpacing = '0px'; g.globalAlpha = 1;
}

// ---------------------------------------------------------------- the frame
let last = performance.now(), T = 0, lastDraw = 0, running = false;
const onBattery = () => !!(stats && stats.battery != null && !stats.charging);
let introT0 = -99, grow = { t0: -99 }, litKey = '', litFromHover = false, stats = null;
// live activity: Windows reports every change on your drives; the folder it happened in pulses in
// the heat colour
let pathIndex = new Map(), pulses = [];
function buildPathIndex() { pathIndex = new Map(); for (const n of G.values()) if (n.base && n.kind !== K.ROOT) pathIndex.set(pathOf(chainOf(n)).toLowerCase(), n); }
listen('fs-activity', e => {
  if (document.hidden || !pathIndex.size) return;
  const now = Date.now() / 1000; let hit = 0;
  for (const dir of e.payload) {
    let p = dir.toLowerCase(), n = null;
    while (p.length > 2 && !(n = pathIndex.get(p))) { const k = p.lastIndexOf('\\'); if (k < 0) break; p = p.slice(0, k); }
    if (!n || n.lastPulse > T - .8) continue;
    n.recent = now; n.lastPulse = T; hit++;
    if (pulses.length < 40) pulses.push({ n, t0: T });
  }
  if (hit) computeHeat();
});
// landmarks: faint names for the drives, the biggest top folders and your biggest projects, on the
// near side of the globe
let landmarks = [];
function pickLandmarks() {
  const nodes = [...G.values()].filter(n => n.base), top = (list, k) => list.sort((a, b) => b.count - a.count).slice(0, k);
  landmarks = [
    ...nodes.filter(n => n.kind === K.DRIVE),
    ...top(nodes.filter(n => n.depth === 2 && !SYSTEM_TOP.test(n.name)), 6),
    ...top(nodes.filter(n => n.depth === 3 && !SYSTEM_TOP.test((parentOf(n) || {}).name || '')), 8),
  ];
}

// the core: soft light, three rings of data blocks turning at their own pace, ticks, and the drive arcs
const RINGS = [{ r: .5, n: 40, w: .085, sp: .06 }, { r: .68, n: 64, w: .06, sp: -.035 }, { r: .84, n: 90, w: .045, sp: .02 }]
  .map((q, ri) => ({ ...q, segs: Array.from({ length: q.n }, (_, k) => ({ a: k / q.n * Math.PI * 2, span: Math.PI * 2 / q.n * (.35 + hash(k, ri + 7) * .45), on: hash(k, ri + 3) > .22, lv: Math.floor(hash(k, ri + 11) * 3) })) }));
// the core: big on the flat map, a little smaller at the heart of the globe
const coreSize = () => { const disk = Math.max(60, Math.min(170, 125 * view.s)), globe = Math.max(70, Math.min(200, 120 * view.s)); return disk + (globe - disk) * cam.fold; };
// Once the core has assembled, each ring of data blocks (and the tick ring) is a picture drawn once
// per theme and only rotated each frame - a few image copies instead of ~170 arcs every frame.
const SPR_B = 200;
let coreSprites = null, coreSpritesKey = '';
function getCoreSprites() {
  const key = themeKey + '|' + DPR;
  if (coreSpritesKey === key) return coreSprites;
  const acc = rgbOf(theme.acc), b = SPR_B, size = Math.ceil(b * 2.4), px = Math.ceil(size * DPR);
  const mk = draw => { const c = document.createElement('canvas'); c.width = c.height = px; const x = c.getContext('2d'); x.setTransform(DPR, 0, 0, DPR, px / 2, px / 2); draw(x); return c; };
  const rings = RINGS.map(ring => mk(x => {
    x.lineWidth = b * ring.w; const rr = b * ring.r;
    for (const lv of [0, 1, 2]) {
      x.beginPath();
      for (const sg of ring.segs) { if (!sg.on || sg.lv !== lv) continue; x.moveTo(Math.cos(sg.a) * rr, Math.sin(sg.a) * rr); x.arc(0, 0, rr, sg.a, sg.a + sg.span); }
      x.strokeStyle = `rgba(${acc},${[.36, .58, .8][lv]})`; x.stroke();
    }
  }));
  const ticks = mk(x => {
    x.beginPath();
    for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2, r0 = b * .95, r1 = r0 + (i % 6 ? 4 : 9); x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); x.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); }
    x.strokeStyle = `rgba(${acc},.4)`; x.lineWidth = 1; x.stroke();
    x.setLineDash([2, 6]); x.beginPath(); x.arc(0, 0, b * 1.12, 0, 6.3); x.strokeStyle = `rgba(${acc},.3)`; x.stroke();
  });
  coreSprites = { rings, ticks, size }; coreSpritesKey = key;
  return coreSprites;
}
function drawCore(t, intro) {
  const b = coreSize(), acc = rgbOf(theme.acc), lit = rgbOf(theme.lit), tt = reduce ? 0 : t;
  corePlane();
  const fog = g.createRadialGradient(0, 0, 0, 0, 0, b * .45);
  fog.addColorStop(0, `rgba(${lit},${(theme.light ? .25 : .5) * easeOut(intro / .4)})`); fog.addColorStop(1, `rgba(${lit},0)`);
  g.fillStyle = fog; g.beginPath(); g.arc(0, 0, b * .45, 0, 6.3); g.fill();
  if (intro >= 1.1) {                                      // assembled: rotate the pictures
    const sp = getCoreSprites(), S = sp.size * b / SPR_B;
    RINGS.forEach((ring, i) => { g.save(); g.rotate(tt * ring.sp); g.drawImage(sp.rings[i], -S / 2, -S / 2, S, S); g.restore(); });
    g.save(); g.rotate(-tt * .01); g.drawImage(sp.ticks, -S / 2, -S / 2, S, S); g.restore();
  } else RINGS.forEach((ring, i) => {
    const e = easeOut((intro - .15 - i * .15) / .55); if (e <= 0) return;
    g.lineWidth = b * ring.w;
    const rr = b * ring.r * (.4 + .6 * e), turn = tt * ring.sp + (1 - e) * (i % 2 ? -1.2 : 1.2);
    for (const lv of [0, 1, 2]) {                       // three brightness levels, one path each
      g.beginPath();
      for (const sgm of ring.segs) {
        if (!sgm.on || sgm.lv !== lv) continue;
        const a = sgm.a + turn; g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); g.arc(0, 0, rr, a, a + sgm.span);
      }
      g.strokeStyle = `rgba(${acc},${[.36, .58, .8][lv] * e})`; g.stroke();
    }
  });
  const et = easeOut((intro - .55) / .5);
  if (et > 0 && intro < 1.1) {                             // the tick ring fading in during the startup
    g.beginPath();
    for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2 - tt * .01, r0 = b * .95, r1 = r0 + (i % 6 ? 4 : 9); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); }
    g.strokeStyle = `rgba(${acc},${.4 * et})`; g.lineWidth = 1; g.stroke();
    g.setLineDash([2, 6]); g.beginPath(); g.arc(0, 0, b * 1.12, 0, 6.3); g.strokeStyle = `rgba(${acc},${.3 * et})`; g.stroke(); g.setLineDash([]);
  }
  drawDriveArcs(b, easeOut((intro - .75) / .7));
  g.beginPath(); g.arc(0, 0, b * .2, 0, 6.3); g.strokeStyle = `rgba(${lit},${.85 * easeOut(intro / .3)})`; g.lineWidth = 1.2; g.stroke();
  flat();
  const c = { px: W / 2 + C.ox, py: H / 2 + C.oy };
  const flash = intro < .5 ? 1 + (1 - intro / .5) * 3 : 1;
  g.drawImage(sprites.lit, c.px - 16 * flash, c.py - 16 * flash, 32 * flash, 32 * flash);
  g.fillStyle = theme.lit; g.beginPath(); g.arc(c.px, c.py, 4.5, 0, 6.3); g.fill();
}
// C: across the top of the core, D: across the bottom; the bright part is how full each drive is
// where the drive labels around the core sit on screen (centre x/y, width), so other labels keep clear
function driveLabels() {
  if (!stats) return [];
  const drives = stats.drives.slice(0, 4), rr = coreSize() * 1.3 + 17, cx = W / 2 + C.ox, cy = H / 2 + C.oy;
  const centers = drives.length === 1 ? [-Math.PI / 2] : drives.map((_, i) => -Math.PI / 2 + i * Math.PI * 2 / drives.length);
  g.font = '600 9.5px Bahnschrift,"Segoe UI",sans-serif'; g.letterSpacing = '1.2px';
  const out = drives.map((d, i) => ({ x: cx + Math.cos(centers[i]) * rr, y: cy + Math.sin(centers[i]) * rr, w: g.measureText(`${d.name} 100%`).width + 16 }));
  g.letterSpacing = '0px';
  return out;
}
function drawDriveArcs(b, e) {
  if (!stats || e <= 0) return;
  const drives = stats.drives.slice(0, 4), span = Math.PI * .72, r = b * 1.3;
  const centers = drives.length === 1 ? [-Math.PI / 2] : drives.map((_, i) => -Math.PI / 2 + i * Math.PI * 2 / drives.length);
  drives.forEach((d, i) => {
    const used = 1 - d.free / d.total, a0 = centers[i] - span / 2, full = used > .9;
    g.lineWidth = 3; g.lineCap = 'butt';
    g.strokeStyle = `rgba(${rgbOf(theme.acc)},.14)`; g.beginPath(); g.arc(0, 0, r, a0, a0 + span * e); g.stroke();
    g.strokeStyle = full ? '#ff6b6b' : theme.acc; g.beginPath(); g.arc(0, 0, r, a0, a0 + span * used * e); g.stroke();
    // label just outside the middle of the arc, kept upright
    const lx = Math.cos(centers[i]) * (r + 17), ly = Math.sin(centers[i]) * (r + 17);
    g.save(); g.translate(lx, ly); const m = g.getTransform(); g.setTransform(DPR, 0, 0, DPR, m.e, m.f);
    g.globalAlpha = e; g.font = '600 9.5px Bahnschrift,"Segoe UI",sans-serif'; g.letterSpacing = '1.2px'; g.textAlign = 'center';
    const txt = `${d.name} ${Math.round(used * 100)}%`;
    g.lineWidth = 3; g.lineJoin = 'round'; g.strokeStyle = theme.bg; g.strokeText(txt, 0, 3);
    g.fillStyle = full ? '#ff8a8a' : theme.dim; g.fillText(txt, 0, 3);
    g.restore(); g.letterSpacing = '0px'; g.globalAlpha = 1;
  });
}

// ---------------------------------------------------------------- WebGL layer: the web and the dots
// A thousand-plus hairlines are nearly free for the GPU but costly for a 2D canvas, so the plexus is
// drawn with WebGL. Each vertex carries its flat and its globe place; the shader folds, turns the
// shells and applies perspective exactly like project(). The 2D canvas above keeps the core, glows,
// lit paths and labels. Without WebGL it all falls back to 2D.
const VS = `
attribute vec2 aDisk; attribute vec3 aGlobe; attribute vec3 aInfo;
uniform vec4 uCam; uniform vec4 uView; uniform vec4 uP; uniform float uDpr; uniform float uSet;
varying float vA;
void main() {
  float d = min(aInfo.x, 7.0);
  float a = uCam.z + uCam.y * (mod(d, 2.0) > .5 ? 1.0 : -1.0) * (.6 + .25 * d);
  float ca = cos(a), sa = sin(a), cp = cos(uCam.w), sp = sin(uCam.w);
  vec3 q0 = vec3(aGlobe.x * ca + aGlobe.z * sa, aGlobe.y, -aGlobe.x * sa + aGlobe.z * ca);
  vec3 gq = vec3(q0.x, q0.y * cp - q0.z * sp, q0.y * sp + q0.z * cp);
  float f = uCam.x;
  vec3 q = vec3(mix(aDisk, gq.xy, f), gq.z * f);
  float k = uP.y / max(uP.y * .25, uP.y - q.z), s = uP.x;
  vec2 p = vec2(uView.z * .5 + (q.x * k - uView.x) * s, uView.w * .5 + (q.y * k - uView.y) * s);
  gl_Position = vec4(p.x / uView.z * 2.0 - 1.0, 1.0 - p.y / uView.w * 2.0, 0.0, 1.0);
  gl_PointSize = aInfo.z * k * uDpr;
  float face = 1.0 - f * .7 * (1.0 - clamp(q.z / uP.z * .5 + .5, 0.0, 1.0));
  float r = mix(length(aDisk), length(aGlobe), f);
  float set = uSet < .5 ? 1.0 - f : (uSet < 1.5 ? f : 1.0);
  vA = aInfo.y * step(r, uP.w) * face * set;
}`;
const FS = `
precision mediump float;
uniform vec3 uColor; uniform float uFade; uniform float uRound;
varying float vA;
void main() {
  float a = vA * uFade;
  if (uRound > .5) { float d = length(gl_PointCoord - .5); if (d > .5) discard; a *= smoothstep(.5, .3, d); }
  gl_FragColor = vec4(uColor * a, a);
}`;
const glc = $('gl'), GL_DPR = 1;
let gl = null, GLP = null, glBufs = null, GL_SOFT = false;
function glInit() {
  try {
    gl = glc.getContext('webgl', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (!gl) return;
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    GLP = { pr, aDisk: gl.getAttribLocation(pr, 'aDisk'), aGlobe: gl.getAttribLocation(pr, 'aGlobe'), aInfo: gl.getAttribLocation(pr, 'aInfo'), u: {} };
    for (const u of ['uCam', 'uView', 'uP', 'uDpr', 'uSet', 'uColor', 'uFade', 'uRound']) GLP.u[u] = gl.getUniformLocation(pr, u);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    GL_SOFT = /swiftshader|basic render|llvmpipe|software/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
  } catch (e) { console.warn('WebGL off, drawing the web in 2D:', e); gl = null; GLP = null; }
}
// Wires are straight; only where they meet a node do they round off. At each end a wire turns
// smoothly into the line it continues across that node (its straightest neighbour), so a path through
// the web flows round its corners instead of meeting at a point. Works the same in 2D and 3D.
const vsub = (p, q) => p.map((v, i) => v - q[i]), vlen = p => Math.hypot(...p), vdot = (p, q) => p.reduce((s, v, i) => s + v * q[i], 0);
const vnorm = p => { const l = vlen(p) || 1; return p.map(v => v / l); };
const CORNER_MAX = .7;   // a rounded end turns at most ~40 degrees away from the straight line
function clampTan(t, u) {
  const d = vdot(t, u); if (d >= Math.cos(CORNER_MAX)) return t;
  const p = t.map((v, i) => v - u[i] * d), pl = vlen(p); if (pl < 1e-6) return u;
  return u.map((v, i) => v * Math.cos(CORNER_MAX) + p[i] / pl * Math.sin(CORNER_MAX));
}
// the direction a wire leaves node pa toward pb, rounded into the neighbour it continues from
function endTangent(pa, pb, others) {
  const u = vnorm(vsub(pb, pa)); let best = null, bd = -.1;            // corners sharper than ~95 degrees stay corners
  for (const x of others) { const w = vnorm(vsub(pa, x)), d = vdot(w, u); if (d > bd) { bd = d; best = w; } }
  return best ? clampTan(vnorm(best.map((v, i) => v + u[i])), u) : u;
}
// points of a wire pa -> pb: straight, except a short rounded end (length up to r) wherever it turns
function filletPath(pa, pb, ta, tb, r, n) {
  const u = vnorm(vsub(pb, pa)), f = Math.min(r, vlen(vsub(pb, pa)) * .3);
  const ea = pa.map((v, i) => v + u[i] * f), eb = pb.map((v, i) => v - u[i] * f);
  const cub = (p0, p1, p2, p3, t) => { const s = 1 - t; return p0.map((_, i) => s * s * s * p0[i] + 3 * s * s * t * p1[i] + 3 * s * t * t * p2[i] + t * t * t * p3[i]); };
  const out = [pa], bendA = vdot(ta, u) < .9995, bendB = vdot(tb, u) < .9995;
  if (bendA) { const c1 = pa.map((v, i) => v + ta[i] * f * .55), c2 = ea.map((v, i) => v - u[i] * f * .45); for (let k = 1; k <= n; k++) out.push(cub(pa, c1, c2, ea, k / n)); }
  if (bendB) { const c1 = eb.map((v, i) => v + u[i] * f * .45), c2 = pb.map((v, i) => v - tb[i] * f * .55); out.push(eb); for (let k = 1; k <= n; k++) out.push(cub(eb, c1, c2, pb, k / n)); }
  else out.push(pb);
  return out;
}
// static buffers, rebuilt when the map loads: flat x,y | globe x,y,z | depth, alpha, point size
function glBuild() {
  if (!GLP) return;
  const mk = arr => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); return { b, n: arr.length / 8 }; };
  const V = (n, al, size) => [n.dx, n.dy, n.gx, n.gy, n.gz, n.depth, al, size];
  const flatL = [], globeL = [], front = [], back = [];
  // who each node is wired to, on the flat map (web + spokes) and on the globe
  const spokes = [...G.values()].filter(n => n.base && n.depth <= 2 && parentOf(n)).map(n => [parentOf(n), n]);
  const adjOf = links => { const m = new Map(), add = (x, y) => { let l = m.get(x); if (!l) m.set(x, l = []); l.push(y); }; for (const [x, y] of links) { add(x, y); add(y, x); } return m; };
  const adjFlat = adjOf([...webFlat, ...spokes]), adjGlobe = adjOf(webGlobe);
  // one wire: straight, its ends rounded into the wires it continues (flat ones on the map, globe ones on the globe)
  const link = (out, a, c, al, onGlobe) => {
    const P = n => onGlobe ? [n.gx, n.gy, n.gz] : [n.dx, n.dy], adj = onGlobe ? adjGlobe : adjFlat;
    const pa = P(a), pb = P(c), u = vnorm(vsub(pb, pa)), L = vlen(vsub(pb, pa)) || 1;
    const ta = endTangent(pa, pb, (adj.get(a) || []).filter(x => x !== c).map(P));
    const tb = endTangent(pb, pa, (adj.get(c) || []).filter(x => x !== a).map(P)).map(v => -v);
    const pts = filletPath(pa, pb, ta, tb, 22, 4);
    const V = p => {
      const s = clamp01(vdot(vsub(p, pa), u) / L);   // the other place (flat or globe) just follows along the wire
      const f = onGlobe ? [a.dx + (c.dx - a.dx) * s, a.dy + (c.dy - a.dy) * s] : p;
      const q = onGlobe ? p : [a.gx + (c.gx - a.gx) * s, a.gy + (c.gy - a.gy) * s, a.gz + (c.gz - a.gz) * s];
      return [f[0], f[1], q[0], q[1], q[2], s < .5 ? a.depth : c.depth, al, 0];
    };
    for (let i = 1; i < pts.length; i++) out.push(...V(pts[i - 1]), ...V(pts[i]));
  };
  for (const [a, c, bk] of webFlat) link(flatL, a, c, [.09, .18, .32][bk], false);
  for (const [a, c, bk] of webGlobe) link(globeL, a, c, [.1, .2, .34][bk], true);
  for (const [p, n] of spokes) link(flatL, p, n, .13, false);
  for (const n of G.values()) {
    if (!n.base) continue;
    if (n.kind === K.ROOT) continue;
    if (n.depth <= 2) front.push(...V(n, .85, 6.2));
    else back.push(...V(n, n.depth === 3 ? .7 : .5, n.depth === 3 ? 4.2 : 3.6));
  }
  if (glBufs) Object.values(glBufs).forEach(x => gl.deleteBuffer(x.b));
  glBufs = { flatL: mk(flatL), globeL: mk(globeL), back: mk(back), front: mk(front) };
}
function glDraw(fade, revealR) {
  gl.viewport(0, 0, glc.width, glc.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  if (!glBufs) return;
  gl.useProgram(GLP.pr);
  const U = GLP.u;
  gl.uniform4f(U.uCam, cam.fold, cam.spin, cam.yaw, cam.pitch);
  gl.uniform4f(U.uView, view.x, view.y, W, H); gl.uniform4f(U.uP, view.s, FOCAL, globeR, revealR); gl.uniform1f(U.uDpr, GL_DPR);
  const webC = theme.web.split(',').map(v => v / 255), litC = rgbOf(theme.lit).split(',').map(v => v / 255);
  const draw = (buf, mode, set, color, f, round) => {
    if (!buf.n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.b);
    gl.enableVertexAttribArray(GLP.aDisk); gl.vertexAttribPointer(GLP.aDisk, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(GLP.aGlobe); gl.vertexAttribPointer(GLP.aGlobe, 3, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(GLP.aInfo); gl.vertexAttribPointer(GLP.aInfo, 3, gl.FLOAT, false, 32, 20);
    gl.uniform1f(U.uSet, set); gl.uniform3f(U.uColor, color[0], color[1], color[2]); gl.uniform1f(U.uFade, f); gl.uniform1f(U.uRound, round ? 1 : 0);
    gl.drawArrays(mode, 0, buf.n);
  };
  if (cam.fold < 1) draw(glBufs.flatL, gl.LINES, 0, webC, fade, false);
  if (cam.fold > 0) draw(glBufs.globeL, gl.LINES, 1, webC, fade, false);
  draw(glBufs.back, gl.POINTS, 2, webC, fade * .9 + .1, true);
  draw(glBufs.front, gl.POINTS, 2, litC, 1, true);
}

// Each frame books the next one ~12 ms later and then waits for the screen's next refresh, so a
// 240 Hz screen wakes Orbis ~60 times a second instead of 240 (asking every refresh and skipping
// most kept the page and the GPU process busy for nothing).
// A lit path through a chain's folders: straight hops that round off where they pass a folder, so
// the path flows through each folder instead of turning a sharp corner there. Sampled as CURVE_SEG
// evenly spaced points per hop (the paths grow out at an even speed), worked out once per chain per frame.
const CURVE_SEG = 12;
let curveCache = new Map(), curveFrame = -1;
function curve(c) {
  if (curveFrame !== T) { curveCache = new Map(); curveFrame = T; }
  let out = curveCache.get(c);
  if (out) return out;
  const P = c.map(n => [n.px, n.py]);
  // the direction the path runs through each folder (none at the ends, or at a hairpin turn)
  const tan = P.map((p, i) => {
    if (!i || i === P.length - 1) return null;
    const w = vnorm(vsub(p, P[i - 1])), u = vnorm(vsub(P[i + 1], p));
    return vdot(w, u) > -.1 ? vnorm(w.map((v, k) => v + u[k])) : null;
  });
  out = [P[0]];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1], u = vnorm(vsub(b, a));
    const dense = filletPath(a, b, tan[i] ? clampTan(tan[i], u) : u, tan[i + 1] ? clampTan(tan[i + 1], u) : u, 26, 8);
    const cum = [0]; for (let k = 1; k < dense.length; k++) cum.push(cum[k - 1] + vlen(vsub(dense[k], dense[k - 1])));
    const tot = cum[cum.length - 1]; let k = 1;
    for (let s = 1; s <= CURVE_SEG; s++) {
      const want = tot * s / CURVE_SEG; while (k < dense.length - 1 && cum[k] < want) k++;
      const f = (want - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1), p = dense[k - 1], q = dense[k];
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
    }
  }
  curveCache.set(c, out);
  return out;
}

function frame(now) {
  if (document.hidden) { running = false; return; }                   // minimised or covered: nothing at all
  setTimeout(() => requestAnimationFrame(frame), fpsTarget() === 30 ? 28 : 12);
  perfSample(now);
  lastDraw = now;
  const dt = Math.min(.1, (now - last) / 1000); last = now; T += dt;
  if (view.to) {
    const k = 1 - Math.pow(.012, Math.min(dt, .05));
    view.x += (view.to.x - view.x) * k; view.y += (view.to.y - view.y) * k; view.s += (view.to.s - view.s) * k;
    if (Math.abs(view.to.s - view.s) < .001 && Math.abs(view.to.x - view.x) < .3 && Math.abs(view.to.y - view.y) < .3) { view.x = view.to.x; view.y = view.to.y; view.s = view.to.s; view.to = null; }
  }
  if (!drift.on && G.size && !searching() && !sel) startDrift();
  else if (drift.on && (searching() || sel)) stopDrift();
  // while the globe turns, it stays framed in the middle - whatever framing a search left behind
  if (drift.on) { const t = globeView(), c = view.to || view; if (Math.abs(c.x - t.x) > .5 || Math.abs(c.y - t.y) > .5 || Math.abs(c.s - t.s) > 1e-3) view.to = t; }
  stepCamera(dt);
  camFrame();
  for (const n of G.values()) project(n);
  if (pickAt && !drag) { hover = pick(pickAt.x, pickAt.y); pickAt = null; }

  const intro = T - introT0;                                   // seconds since the map arrived
  const revealR = intro < 3 ? (intro - .45) * 900 : 1e9;       // the web spreads out from the core
  const lit = litHits();
  const key = lit.map(h => h.node.id).join(',');
  if (key !== litKey) {                                        // new results: the lines grow out
    if (!hl && !litFromHover && lit.length) grow = { t0: T };
    litFromHover = !!hl; litKey = key;
  }
  const fade = lit.length ? .5 : 1, light = theme.light;
  flat(); g.clearRect(0, 0, W, H);

  // web, spokes, dots - deeper ones smaller and dimmer (WebGL; 2D only as a fallback)
  const shown = n => intro >= 3 || radius(n) < revealR;
  if (GLP) glDraw(fade, intro >= 3 ? 1e9 : revealR);
  else {
    for (const b of [0, 1, 2]) {
      g.beginPath();
      for (const [a, c, bk] of (cam.fold < .5 ? webFlat : webGlobe)) { if (bk !== b || !shown(a) || !shown(c)) continue; g.moveTo(a.px, a.py); g.lineTo(c.px, c.py); }
      g.strokeStyle = `rgba(${theme.web},${[.09, .18, .32][b] * fade})`; g.lineWidth = .8; g.stroke();
    }
    g.beginPath();
    for (const n of G.values()) { if (!n.base || n.depth > 2 || !shown(n)) continue; const p = parentOf(n); if (p) { g.moveTo(p.px, p.py); g.lineTo(n.px, n.py); } }
    g.strokeStyle = `rgba(${theme.web},${.13 * fade})`; g.stroke();
    for (const [lo, hi, rr, al] of [[0, 2, 2.6, .85], [3, 3, 1.6, .7], [4, 99, 1.3, .5]]) {
      g.beginPath();
      for (const n of G.values()) {
        if (!n.base || n.kind === K.ROOT || n.depth < lo || n.depth > hi || !shown(n)) continue;
        const r = rr * n.pk; g.moveTo(n.px + r, n.py); g.arc(n.px, n.py, r, 0, 6.3);
      }
      g.fillStyle = lo === 0 ? theme.lit : `rgba(${theme.web},1)`; g.globalAlpha = al * (lo ? fade * .9 + .1 : .85); g.fill(); g.globalAlpha = 1;
    }
  }

  // activity glow: recently changed folders breathe in the heat colour
  g.globalCompositeOperation = light ? 'source-over' : 'lighter';
  if (!lite()) for (const q of hot) {
    if (!shown(q.n)) continue;
    const pulse = reduce ? .7 : .55 + .45 * Math.sin(T * 1.6 + q.ph), r = (7 + 10 * q.h) * q.n.pk;
    g.globalAlpha = (light ? .4 : .6) * q.h * pulse * (lit.length ? .5 : 1) * facing(q.n);
    g.drawImage(sprites.heat, q.n.px - r, q.n.py - r, r * 2, r * 2);
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';

  // live activity pulses
  pulses = pulses.filter(q => T - q.t0 < 1.6);
  for (const q of pulses) {
    const k = (T - q.t0) / 1.6;
    g.strokeStyle = theme.heat; g.globalAlpha = (1 - k) * .9 * facing(q.n); g.lineWidth = 1.5;
    g.beginPath(); g.arc(q.n.px, q.n.py, 6 + k * 26, 0, 6.3); g.stroke();
  }
  g.globalAlpha = 1;
  // landmarks on the near side of the globe
  if (cam.fold > .3 && !lit.length && !lite()) {
    const fa = (cam.fold - .3) / .7, placedL = driveLabels().map(d => ({ x: d.x - d.w / 2, y: d.y, w: d.w }));
    g.font = '600 10px Bahnschrift,"Segoe UI",sans-serif'; g.letterSpacing = '1.6px'; g.textBaseline = 'middle';
    for (const n of (ttMode ? ttMode.marks : landmarks)) {
      const v = facing(n); if (v < .72 || !shown(n) || Math.hypot(n.px - (W / 2 + C.ox), n.py - (H / 2 + C.oy)) < coreSize() * 1.45) continue;   // not over the core
      const t = (n.kind === K.DRIVE ? n.name + '\\' : n.name).toUpperCase() + (ttMode ? ` · ${num(ttMode.counts.get(n.id) || 0)}` : ''), w = g.measureText(t).width, x = n.px + 9, y = n.py;
      if (placedL.some(b => x < b.x + b.w && b.x < x + w && Math.abs(y - b.y) < 13)) continue;
      placedL.push({ x, y, w });
      g.globalAlpha = fa * (v - .72) / .28 * .85; g.fillStyle = n.kind === K.DRIVE ? theme.acc : theme.ink; g.fillText(t, x, y);
    }
    g.globalAlpha = 1; g.letterSpacing = '0px'; g.textBaseline = 'alphabetic';
  }

  drawCore(T, intro);

  // lit paths: each one grows out from the core, segment by segment; the label fades in on arrival
  const placed = driveLabels().map(d => ({ x: d.x - d.w / 2, y: d.y - 10, w: d.w, h: 20 }));
  g.lineCap = g.lineJoin = 'round';
  lit.forEach((h, k) => {
    const c = h.chain, gp = reduce ? 99 : (T - grow.t0 - k * .06) / .07;   // hops drawn so far
    const cp = curve(c), upto = Math.min(cp.length - 1, gp * CURVE_SEG), whole = Math.floor(upto);
    if (upto <= 0) return;
    const pts = cp.slice(0, whole + 1);
    if (upto > whole && cp[whole + 1]) { const a = cp[whole], b = cp[whole + 1], f = upto - whole; pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
    const line = () => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); };
    g.globalCompositeOperation = light ? 'source-over' : 'lighter';
    g.strokeStyle = theme.acc; g.globalAlpha = light ? .16 : .22; g.lineWidth = 7; line();
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.strokeStyle = theme.lit; g.lineWidth = 1.5; line();
    g.fillStyle = theme.lit;
    for (let j = 1; j < c.length - 1 && j <= gp; j++) { g.beginPath(); g.arc(c[j].px, c[j].py, 2.4, 0, 6.3); g.fill(); }   // the folders it passes
    const arrived = clamp01((gp - (c.length - 1)) / 3);
    if (arrived > 0) {
      const n = h.node, tint = tintOf(h), spr = sprites.type[typeOf(h.name, h.kind)] || sprites.acc;
      g.globalAlpha = arrived; g.drawImage(spr, n.px - 18, n.py - 18, 36, 36);
      g.fillStyle = theme.lit; g.beginPath(); g.arc(n.px, n.py, 4.2, 0, 6.3); g.fill();
      g.strokeStyle = tint; g.globalAlpha = .8 * arrived; g.lineWidth = 1; g.beginPath(); g.arc(n.px, n.py, 9, 0, 6.3); g.stroke(); g.globalAlpha = 1;
      label(n, h.name, sub(h), tint, placed, k === 0, arrived * Math.max(.45, facing(n)));
    }
  });

  if (sel) {
    const ph = reduce ? 0 : (T * 1.1) % 1;
    g.strokeStyle = theme.acc; g.globalAlpha = .9 - ph * .9; g.lineWidth = 1.2;
    g.beginPath(); g.arc(sel.px, sel.py, 12 + ph * 16, 0, 6.3); g.stroke(); g.globalAlpha = 1;
  }
  if (hover && hover.kind !== K.ROOT) {
    g.strokeStyle = theme.lit; g.lineWidth = 1; g.beginPath(); g.arc(hover.px, hover.py, 8, 0, 6.3); g.stroke();
    const isFile = hover.kind === K.FILE || hover.kind === K.LINK;
    const info = isFile ? fmt(hover.size) : `${num(hover.count)} ITEMS · ${fmt(hover.size)}`;
    label(hover, hover.kind === K.DRIVE ? hover.name + '\\' : hover.name, hover.recent ? `${info} · ${ago(hover.recent)}` : info, null, [], true);
  }
}
function startLoop() { if (running) return; running = true; last = performance.now(); perf.t0 = 0; requestAnimationFrame(frame); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickClock(); tickStats(); startLoop(); } });

// ---------------------------------------------------------------- settings in the popover
async function setPrefs(patch) {
  try { const s2 = await invoke('update_settings', { patch }); if (st) st.settings = s2; await refreshStatus(); }
  catch (e) { toast(String(e)); }
}
function renderPrefs() {
  if (!st || !st.settings) return;
  const S = st.settings, e = st.sem || {};
  computeCaps();
  const fpsNow = caps.fps60 ? S.fps : '30', visNow = lite() ? 'lite' : 'full';
  document.querySelectorAll('[data-fps]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.fps === fpsNow)); b.disabled = b.dataset.fps !== '30' && !caps.fps60; b.title = b.disabled ? caps.why.fps60 : ''; });
  document.querySelectorAll('[data-vis]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.vis === visNow)); b.disabled = b.dataset.vis === 'full' && !caps.full; b.title = b.disabled ? caps.why.full : ''; });
  const why = [...new Set([!caps.fps60 && caps.why.fps60, !caps.full && caps.why.full].filter(Boolean))];
  $('pcap').hidden = !why.length;
  $('pcap').innerHTML = esc(why.join(' ')) + (S.perf_cap ? '<button type="button" id="pretry">TRY AGAIN</button>' : '');
  $('psaver').setAttribute('aria-pressed', String(!!S.saver)); $('psaver').textContent = 'Screen saver: ' + (S.saver ? `ON · after ${S.saver_minutes} min` : 'OFF');
  $('psvmin').hidden = !S.saver;
  document.querySelectorAll('[data-svmin]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.svmin === S.saver_minutes)));
  renderFeeds();
  $('plive').setAttribute('aria-pressed', String(!!S.live)); $('plive').textContent = 'Live activity: ' + (S.live ? 'ON' : 'OFF');
  $('psem').setAttribute('aria-pressed', String(!!(S.semantic && e.available)));
  $('psem').disabled = !caps.sem && !S.semantic; $('psem').title = caps.sem ? '' : caps.why.sem;
  $('psem').textContent = e.installing ? 'Search by meaning: installing…' : !e.available ? 'Search by meaning: install' : 'Search by meaning: ' + (S.semantic ? 'ON' : 'OFF');
  $('psemline').innerHTML = e.installing ? `<span>${esc(engineMsg)}</span>` : e.available && S.semantic ? `<span>runs on</span> ${esc(e.device || deviceName(S.sem_device))}` : '';
}
$('pfps').onclick = e => { const b = e.target.closest('[data-fps]'); if (b) setPrefs({ fps: b.dataset.fps }); };
$('pvis').onclick = e => { const b = e.target.closest('[data-vis]'); if (b) setPrefs({ visuals: b.dataset.vis }); };
$('plive').onclick = () => setPrefs({ live: !setting('live', true) });
$('psem').onclick = () => {
  const e = st && st.sem || {};
  if (e.installing) return;
  if (!e.available) { openSetup(false); return; }
  setPrefs({ semantic: !setting('semantic', false) });
};
$('psetup').onclick = () => { $('pop').hidden = true; openSetup(false); };
$('ptray').onclick = () => setPrefs({ tray_start: !setting('tray_start', false) });
$('pcap').onclick = e => { if (e.target.id === 'pretry') { setPrefs({ perf_cap: 0 }).then(() => { computeCaps(); toast('Orbis will try the smoother settings again'); }); } };
$('psaver').onclick = async () => {
  const on = !setting('saver', false);
  await setPrefs({ saver: on });
  if (setting('saver', false) === on) toast(on ? `Orbis is now the screen saver, after ${setting('saver_minutes', 10)} idle minutes` : 'Orbis is no longer the screen saver');
};
$('psvmin').onclick = e => { const b = e.target.closest('[data-svmin]'); if (b) setPrefs({ saver_minutes: +b.dataset.svmin }); };
$('psvprev').onclick = () => { $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false'); invoke('start_saver'); };
const deviceName = d => ({ NPU: 'the NPU', GPU: 'the Intel GPU', CPU: 'the CPU' }[d] || 'the best device here');

// ---------------------------------------------------------------- time travel
// Drag back up to 60 days: the globe glows where files changed that day (the busiest folders named,
// with how many), and the panel lists that day's files, newest first, with changes per hour.
let ttMode = null, ttDeb = null, ttSeq = 0;
const dayStart = d => { const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - d); return t; };
const dayName = d => d === 1 ? 'Yesterday' : dayStart(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
async function travel(d) {
  clearTimeout(ttDeb);
  if (!d) { leaveTravel(); return; }
  $('ttlab').textContent = dayName(d); $('ttnow').textContent = '◷ ' + (d === 1 ? 'YESTERDAY' : dayStart(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase());
  ttDeb = setTimeout(async () => {
    const my = ++ttSeq, from = dayStart(d), to = new Date(from); to.setDate(to.getDate() + 1);
    let r; try { r = await invoke('activity', { from: Math.floor(from / 1000), to: Math.floor(to / 1000), tz: -from.getTimezoneOffset() }); } catch (e) { toast(String(e)); return; }
    if (my !== ttSeq) return;
    const counts = new Map(r.folders.map(([id, c]) => [id, c])), top = Math.max(1, ...r.folders.map(f => f[1]));
    const marks = r.folders.map(([id]) => G.get(id)).filter(n => n && n.kind !== K.ROOT && n.kind !== K.DRIVE).slice(0, 10);
    if (hasQuery() || sel) resetAll();
    ttMode = { d, total: r.total, hours: r.hours, counts, marks, folders: r.folders.length, files: r.files.map(makeNameHit) };
    hot = r.folders.map(([id, c]) => G.get(id)).filter(Boolean).slice(0, 40).map(n => ({ n, h: .35 + .65 * Math.log1p(counts.get(n.id)) / Math.log1p(top), ph: hash(n.id, 9) * 6.28 }));
    cursor = 0; renderAll();
  }, 140);
}
function leaveTravel() {
  if (!ttMode && $('ttr').value === '0') return;
  ttMode = null; ttSeq++; $('ttr').value = '0'; $('ttnow').textContent = '◷ NOW'; $('ttlab').textContent = 'Drag back in time';
  dropExtras([]); computeHeat(); renderAll();
}
function renderTravel() {
  const t = ttMode, maxH = Math.max(1, ...t.hours);
  $('rh').textContent = dayName(t.d).toUpperCase();
  $('rmeta').textContent = `${num(t.total)} changes · ${num(t.folders)} folders`;
  rows = t.files;
  if (cursor >= rows.length) cursor = 0;
  $('rlist').innerHTML = `<div class="tth" title="Changes per hour">${t.hours.map((v, i) => `<i style="height:${v ? 8 + 92 * v / maxH : 2}%" title="${String(i).padStart(2, '0')}:00 · ${num(v)}"></i>`).join('')}</div>
    <div class="tthl"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>`
    + (rows.length ? rows.map((h, i) => nameRow(h, i)).join('') : '<div class="empty">Nothing changed on this day.</div>');
  const cur = $('rlist').querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  if (qlOn && rows[cursor] !== qlFor) { if (canQuick(rows[cursor])) openQuick(rows[cursor]); else closeQuick(); }
}
$('ttr').addEventListener('input', e => travel(+e.target.value));
$('ttnow').onclick = () => leaveTravel();

// ---------------------------------------------------------------- news ticker
// Optional, off by default: headlines from your chosen RSS feeds scroll along the bottom, pausing
// under the mouse; a click opens the story in your browser. Fetched only while on, every 15 minutes.
const NEWS_EVERY = 15 * 60 * 1000;
let newsItems = [], newsTimer = null;
const newsOn = () => setting('news', false) && W > 1050;
async function refreshNews() {
  clearTimeout(newsTimer);
  if (!setting('news', false)) { newsItems = []; $('news').hidden = true; return; }
  try { newsItems = await invoke('news', { feeds: setting('news_feeds', []) }); } catch { /* offline: keep what we had */ }
  renderNews();
  newsTimer = setTimeout(refreshNews, NEWS_EVERY);
}
function renderNews() {
  const t = $('ntrack');
  $('news').hidden = !setting('news', false) || !newsItems.length;
  if ($('news').hidden) return;
  const one = newsItems.map((n, i) => `<a href="#" data-news="${i}" dir="auto"><i>${esc(n.source)}</i>${esc(n.title)}</a><span class="nsep">•</span>`).join('');
  t.innerHTML = one + one;                       // twice, so the loop is seamless
  requestAnimationFrame(() => { t.style.animationDuration = Math.max(60, t.scrollWidth / 2 / 26) + 's'; });   // ~26 px a second: time to read
}
$('ntrack').addEventListener('click', e => {
  const n = e.target.closest('[data-news]'); if (!n) return;
  e.preventDefault(); invoke('open_link', { url: newsItems[+n.dataset.news].link }).catch(err => toast(String(err)));
});
function renderFeeds() {
  const on = setting('news', false), feeds = setting('news_feeds', []);
  $('pnews').setAttribute('aria-pressed', String(on)); $('pnews').textContent = 'News ticker: ' + (on ? 'ON' : 'OFF');
  $('pfeeds').innerHTML = !on ? '' : `<div class="feeds">${feeds.map((f, i) => `<span class="feed" title="${esc(f)}">${esc(hostName(f))}<button type="button" data-rmfeed="${i}" aria-label="Remove ${esc(f)}">×</button></span>`).join('')}</div>
    <div class="wkey"><input id="feedurl" placeholder="Add a feed: https://…/rss" spellcheck="false" autocomplete="off"><button type="button" data-addfeed>ADD</button></div>`;
}
const hostName = u => { try { return new URL(u).hostname.replace(/^(www|feeds|rss)\./, ''); } catch { return u; } };
async function addFeed() {
  const url = $('feedurl').value.trim(); if (!url) return;
  const btn = $('pfeeds').querySelector('[data-addfeed]'); btn.textContent = 'CHECKING…'; btn.disabled = true;
  try {
    const name = await invoke('check_feed', { url });
    await setPrefs({ news_feeds: [...setting('news_feeds', []).filter(f => f !== url), url] });
    toast(`Added ${name}`); refreshNews();
  } catch (e) { toast(String(e)); btn.textContent = 'ADD'; btn.disabled = false; }
}
$('pnews').onclick = () => setPrefs({ news: !setting('news', false) }).then(() => { refreshNews(); if (drift.on) fitGlobe(); });
$('pfeeds').addEventListener('click', e => {
  const r = e.target.closest('[data-rmfeed]');
  if (r) { setPrefs({ news_feeds: setting('news_feeds', []).filter((_, i) => i !== +r.dataset.rmfeed) }).then(refreshNews); return; }
  if (e.target.closest('[data-addfeed]')) addFeed();
});
$('pfeeds').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'feedurl') { e.preventDefault(); addFeed(); } });

// ---------------------------------------------------------------- workspaces
// What you open together, opened together: "> ws <name>". Orbis suggests groups from what you open
// from it; "+ WORKSPACE" on a selected file or folder adds it to one.
let wsd = null;
const wsKindLabel = { file: 'FILE', folder: 'FOLDER', vscode: 'VS CODE', app: 'APP' };
async function openWs() {
  $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false');
  try { wsd = await invoke('workspaces'); } catch (e) { toast(String(e)); return; }
  renderWs(); $('wsd').hidden = false;
}
function renderWs() {
  const item = (w, i, k, own) => `<span class="wsi" title="${esc(i.target)}"><i>${wsKindLabel[i.kind] || i.kind}</i>${esc(i.name)}${own ? `<button type="button" data-wsrm="${k}" data-wsname="${esc(w.name)}" aria-label="Remove ${esc(i.name)}">×</button>` : ''}</span>`;
  $('wsbox').innerHTML = `<h1 id="wsT">WORKSPACES</h1>
    <p class="lead">Things you open together, opened together: type <b>&gt; ws</b> and the name. Add a file or folder with <b>+ WORKSPACE</b> on a selected result.</p>
    ${wsd.suggested.length ? `<div class="rcs"><div class="rcsh"><b>Suggested</b><span>Opened together more than once</span></div>
      ${wsd.suggested.map((w, k) => `<div class="rcg"><div class="rcgh"><b dir="auto">${esc(w.name)}</b><button type="button" data-wssave="${k}">SAVE</button></div><div class="wsl">${w.items.map((i, n) => item(w, i, n, false)).join('')}</div></div>`).join('')}</div>` : ''}
    <div class="rcs"><div class="rcsh"><b>Yours</b><span>${wsd.saved.length ? '' : 'None yet'}</span></div>
      ${wsd.saved.map(w => `<div class="rcg"><div class="rcgh"><b dir="auto">${esc(w.name)}</b><small>${w.items.length} item${w.items.length === 1 ? '' : 's'}</small>
        <button type="button" data-wsopen="${esc(w.name)}">OPEN</button><button type="button" data-wsdel="${esc(w.name)}">DELETE</button></div>
        <div class="wsl">${w.items.map((i, n) => item(w, i, n, true)).join('') || '<small>Empty: add files or folders with + WORKSPACE.</small>'}</div></div>`).join('')}</div>
    <div class="add"><input id="wsnew" placeholder="New workspace name, e.g. GPS" spellcheck="false" autocomplete="off"><button type="button" data-wsnew>CREATE</button></div>
    <div class="acts2"><button type="button" data-wsclose>CLOSE</button></div>`;
}
async function wsSave(ws) { try { await invoke('save_workspace', { ws }); wsd = await invoke('workspaces'); loadWsCmds(); if (!$('wsd').hidden) renderWs(); } catch (e) { toast(String(e)); } }
$('pws').onclick = openWs;
$('wsd').addEventListener('click', async e => {
  if (!wsd) return;
  const t = e.target, g = s => t.closest(s);
  if (g('[data-wsclose]')) { $('wsd').hidden = true; return; }
  if (g('[data-wssave]')) { const w = wsd.suggested[+g('[data-wssave]').dataset.wssave]; await wsSave(w); toast(`Saved ${w.name}`); return; }
  if (g('[data-wsopen]')) { const name = g('[data-wsopen]').dataset.wsopen; try { const n = await invoke('open_workspace', { name }); toast(`Opened ${name} · ${n} item${n === 1 ? '' : 's'}`); } catch (err) { toast(String(err)); } return; }
  if (g('[data-wsdel]')) { await invoke('delete_workspace', { name: g('[data-wsdel]').dataset.wsdel }).catch(err => toast(String(err))); wsd = await invoke('workspaces'); loadWsCmds(); renderWs(); return; }
  if (g('[data-wsrm]')) { const b = g('[data-wsrm]'), w = wsd.saved.find(x => x.name === b.dataset.wsname); if (w) await wsSave({ name: w.name, items: w.items.filter((_, n) => n !== +b.dataset.wsrm) }); return; }
  if (g('[data-wsnew]')) { const name = $('wsnew').value.trim(); if (name) await wsSave({ name, items: [] }); }
});
$('wsd').addEventListener('keydown', e => { if (e.key === 'Escape') { $('wsd').hidden = true; e.stopPropagation(); } if (e.key === 'Enter' && e.target.id === 'wsnew') { e.preventDefault(); $('wsd').querySelector('[data-wsnew]').click(); } });
// "+ WORKSPACE" on a selected file or folder
async function addToWorkspace(h, how) {
  const path = hitPath(h); if (!path) return;
  let o; try { o = await invoke('workspaces'); } catch { return; }
  const box = $('detail').querySelector('.wspick');
  const isDir = h.kind !== K.FILE;
  box.innerHTML = `<select id="wspickname">${o.saved.map(w => `<option>${esc(w.name)}</option>`).join('')}<option value="">New workspace…</option></select>
    <input id="wspicknew" placeholder="Name" spellcheck="false" ${o.saved.length ? 'hidden' : ''}>
    ${isDir ? '<label><input type="checkbox" id="wspickcode"> in VS Code</label>' : ''}<button type="button" id="wspickgo">ADD</button>`;
  const sel = $('wspickname'); if (!o.saved.length) sel.value = '';
  sel.onchange = () => { $('wspicknew').hidden = !!sel.value; };
  $('wspickgo').onclick = async () => {
    const name = sel.value || $('wspicknew').value.trim(); if (!name) { toast('Give the workspace a name'); return; }
    const w = o.saved.find(x => x.name === name) || { name, items: [] };
    const kind = !isDir ? 'file' : $('wspickcode') && $('wspickcode').checked ? 'vscode' : 'folder';
    if (!w.items.some(i => i.kind === kind && i.target.toLowerCase() === path.toLowerCase())) w.items.push({ kind, target: path, name: h.name });
    await wsSave(w); box.innerHTML = ''; toast(`Added to ${name}`);
  };
}

// ---------------------------------------------------------------- reclaim space
// Copies of the same folder or file, big files untouched for a year, old installers in Downloads.
// Nothing is ticked for you; what you tick goes to the Recycle Bin after a second click.
let rc = null;
async function openReclaim() {
  $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false');
  rc = { r: null, picked: new Set(), armed: false };
  $('reclaimbox').innerHTML = '<h1 id="rcT">RECLAIM SPACE</h1><p class="lead">Looking for copies, forgotten big files and old installers…</p>';
  $('reclaim').hidden = false;
  try { rc.r = await invoke('reclaim_report'); } catch (e) { toast(String(e)); $('reclaim').hidden = true; rc = null; return; }
  renderReclaim();
}
const rcSize = p => rc.r && [...rc.r.dup_folders, ...rc.r.dup_files].flatMap(g => g.items).concat(rc.r.big_old, rc.r.installers).find(x => x.path === p);
function renderReclaim() {
  const r = rc.r, P = rc.picked;
  const sel = [...P].reduce((s, p) => s + ((rcSize(p) || {}).size || 0), 0);
  const row = (p, note) => `<label class="rci"><input type="checkbox" data-rc="${esc(p.path)}"${P.has(p.path) ? ' checked' : ''}>
    <span><b dir="auto" title="${esc(p.path)}">${esc(shortPath(p.path))}</b><small>${fmt(p.size)} · ${day(p.mtime)}${note ? ' · ' + note : ''}</small></span>
    <button type="button" data-rcshow="${esc(p.path)}" title="Show in Explorer">FOLDER</button></label>`;
  const groups = (list, what) => list.map(g => `<div class="rcg"><div class="rcgh"><b dir="auto">${esc(g.name)}</b><small>${g.items.length} ${what} of ${fmt(g.size)} · ${fmt(g.wasted)} to free</small></div>
    ${g.items.map((p, i) => row(p, i === 0 ? 'newest' : '')).join('')}</div>`).join('');
  const sec = (key, title, why, body, n, extra) => n ? `<div class="rcs"><div class="rcsh"><b>${title}</b><span>${why}</span>${extra ? `<button type="button" data-rcpick="${key}">${extra}</button>` : ''}</div>${body}</div>` : '';
  $('reclaimbox').innerHTML = `<h1 id="rcT">RECLAIM SPACE</h1>
    <p class="lead">${r.total ? `Up to <b>${fmt(r.total)}</b> could be freed from copies and old installers. Big untouched files are listed for you to review.` : 'No copies or old installers found.'} Tick what you want gone: it goes to the Recycle Bin, so you can still bring it back.</p>
    ${sec('dupf', 'Duplicate folders', 'Same name, size and contents in several places', groups(r.dup_folders, 'copies'), r.dup_folders.length, 'TICK EXTRA COPIES')}
    ${sec('dupfi', 'Duplicate files', 'Same file in several places (contents compared)', groups(r.dup_files, 'copies'), r.dup_files.length, 'TICK EXTRA COPIES')}
    ${sec('big', 'Big files untouched for a year', 'Over 500 MB, not changed in 12 months', r.big_old.map(p => row(p)).join(''), r.big_old.length)}
    ${sec('inst', 'Old installers', 'Setup files, disk images and archives in Downloads, over a month old', r.installers.map(p => row(p)).join(''), r.installers.length, 'TICK ALL')}
    <div class="acts2"><span class="rcsum">${P.size ? `${P.size} ticked · ${fmt(sel)}` : 'Nothing ticked'}</span><button type="button" data-rcact="close">CLOSE</button>
      <button type="button" class="pri${rc.armed ? ' danger' : ''}" data-rcact="go"${P.size ? '' : ' disabled'}>${rc.armed ? `CLICK AGAIN TO MOVE ${fmt(sel)} TO THE RECYCLE BIN` : 'MOVE TO RECYCLE BIN'}</button></div>`;
}
$('preclaim').onclick = openReclaim;
$('reclaim').addEventListener('change', e => { const c = e.target.closest('[data-rc]'); if (!c || !rc) return; if (c.checked) rc.picked.add(c.dataset.rc); else rc.picked.delete(c.dataset.rc); rc.armed = false; renderReclaim(); });
$('reclaim').addEventListener('click', async e => {
  if (!rc || !rc.r) return;
  const show = e.target.closest('[data-rcshow]'); if (show) { e.preventDefault(); act('reveal_item', { path: show.dataset.rcshow }); return; }
  const pick = e.target.closest('[data-rcpick]');
  if (pick) {
    const k = pick.dataset.rcpick, r = rc.r;
    if (k === 'dupf' || k === 'dupfi') (k === 'dupf' ? r.dup_folders : r.dup_files).forEach(g => g.items.slice(1).forEach(p => rc.picked.add(p.path)));   // keep the newest copy
    else r.installers.forEach(p => rc.picked.add(p.path));
    rc.armed = false; renderReclaim(); return;
  }
  const a = e.target.closest('[data-rcact]'); if (!a) return;
  if (a.dataset.rcact === 'close') { $('reclaim').hidden = true; rc = null; return; }
  if (!rc.armed) { rc.armed = true; renderReclaim(); return; }
  a.disabled = true; a.textContent = 'MOVING…';
  try {
    const out = await invoke('recycle_items', { paths: [...rc.picked] });
    toast(`Moved ${out.done} to the Recycle Bin · ${fmt(out.freed)} freed${out.failed.length ? ` · ${out.failed.length} could not be moved` : ''}`);
  } catch (err) { toast(String(err)); }
  openReclaim();
});
$('reclaim').addEventListener('keydown', e => { if (e.key === 'Escape') { $('reclaim').hidden = true; rc = null; e.stopPropagation(); } });

// ---------------------------------------------------------------- what Orbis searches
// File types that show in results (instant) and places the scan leaves out (a re-scan). The choices
// and the places as they are on this PC come from Rust (scope_options).
let scope = null;
async function openScope() {
  let o; try { o = await invoke('scope_options'); } catch (e) { toast(String(e)); return; }
  const S = st.settings;
  scope = { o, all: !!S.all_types, types: new Set(S.types), places: new Set(S.skip_places), custom: [...S.skip_custom],
    before: JSON.stringify([...S.skip_places].sort()) + JSON.stringify(S.skip_custom) };
  $('pop').hidden = true; $('gear').setAttribute('aria-expanded', 'false');
  renderScope(); $('scope').hidden = false;
}
function renderScope() {
  const s = scope, o = s.o, known = new Set(o.groups.flatMap(g => g.exts)), off = s.all ? ' disabled' : '';
  const own = [...s.types].filter(e => !known.has(e)).sort();
  const grp = g => {
    const on = g.exts.filter(e => s.types.has(e)).length;
    return `<div class="sgrp${s.all ? ' off' : ''}"><div class="sgh"><b>${esc(g.label)}</b><span>${on} of ${g.exts.length}</span>
      <button type="button" class="sw2" role="switch" aria-checked="${on === g.exts.length}" aria-label="${esc(g.label)}" data-grp="${g.key}"${off}></button></div>
      <div class="exts">${g.exts.map(e => `<button type="button" class="ext" aria-pressed="${s.types.has(e)}" data-ext="${e}"${off}>${e}</button>`).join('')}</div></div>`;
  };
  $('scopebox').innerHTML = `
    <h1 id="scT">WHAT ORBIS SEARCHES</h1>
    <p class="lead">Leave out the file types you never look for and the system folders full of program files. Fewer results, and the right ones.</p>
    <div class="opt"><b>Only these file types</b><button type="button" class="sw2 ctl" role="switch" aria-checked="${!s.all}" data-all></button>
      <small>${s.all ? 'Off: every file type shows in results.' : 'Only the types below show in results. Folders always show, and type:xyz in the search box still finds any type.'}</small></div>
    <div class="sgrid">${o.groups.map(grp).join('')}
      <div class="sgrp${s.all ? ' off' : ''}"><div class="sgh"><b>Your own types</b><span>${own.length}</span></div>
        <div class="exts">${own.map(e => `<span class="ext own">${esc(e)}<button type="button" data-rmext="${esc(e)}" aria-label="Remove ${esc(e)}"${off}>×</button></span>`).join('')}
          <span class="addx"><input id="scext" placeholder="e.g. sldprt, .cr2" spellcheck="false" autocomplete="off"${off}><button type="button" data-addext${off}>ADD</button></span></div></div></div>
    <div class="opt"><b>Places to leave out</b><span></span>
      <small>These folders stay out of the map and your results. Leaving one out removes it from the index straight away, with no re-scan; taking one back in reads only that folder. The Recycle Bin and System Volume Information are always left out.</small></div>
    <div class="plist">${o.places.map(p => `<label class="place"><input type="checkbox" data-place="${p.key}"${s.places.has(p.key) ? ' checked' : ''}><span><b>${esc(p.label)}</b><small>${esc(p.paths.join(' · ') || 'not on this PC')}</small></span></label>`).join('')}
      ${s.custom.map((c, i) => `<div class="place own"><span><b>${esc(c)}</b><small>your folder</small></span><button type="button" data-rmplace="${i}" aria-label="Stop leaving out ${esc(c)}">×</button></div>`).join('')}</div>
    <div class="add"><input id="scplace" placeholder="Leave out another folder, e.g. D:\\Games" spellcheck="false" autocomplete="off"><button type="button" data-addplace>ADD</button></div>
    <div class="acts2"><button type="button" data-scope="cancel">CANCEL</button><button type="button" class="pri" data-scope="apply">APPLY</button></div>`;
}
function addExts() {
  const box = $('scext'), raw = box.value.trim();
  const v = raw.toLowerCase().split(/[\s,;]+/).map(x => x.replace(/^\*?\./, '')).filter(x => /^[a-z0-9_+-]{1,12}$/.test(x));
  if (raw && !v.length) { toast('Type an extension, like sldprt or .cr2'); return; }
  v.forEach(x => scope.types.add(x)); renderScope(); $('scext').focus();
}
async function addPlace() {
  const raw = $('scplace').value.trim(); if (!raw) return;
  try {
    const p = await invoke('check_folder', { path: raw });
    if (!scope.custom.some(c => c.toLowerCase() === p.toLowerCase())) scope.custom.push(p);
    renderScope(); $('scplace').focus();
  } catch (e) { toast(String(e)); }
}
async function applyScope() {
  const s = scope, places = [...s.places].sort(), moved = JSON.stringify(places) + JSON.stringify(s.custom) !== s.before;
  await setPrefs({ all_types: s.all, types: [...s.types].sort(), skip_places: places, skip_custom: s.custom });
  $('scope').hidden = true; scope = null;
  toast(moved ? 'Saved. Updating the index…' : 'Saved');
  if (hasQuery()) runQuery($('q').value);
}
$('pscope').onclick = openScope;
$('scope').addEventListener('click', e => {
  const s = scope; if (!s) return;
  const t = e.target;
  if (t.closest('[data-all]')) { s.all = !s.all; renderScope(); return; }
  const g = t.closest('[data-grp]');
  if (g) { if (g.disabled) return; const grp = s.o.groups.find(x => x.key === g.dataset.grp), full = grp.exts.every(x => s.types.has(x)); grp.exts.forEach(x => full ? s.types.delete(x) : s.types.add(x)); renderScope(); return; }
  const x = t.closest('[data-ext]');
  if (x) { if (x.disabled) return; const v = x.dataset.ext; if (s.types.has(v)) s.types.delete(v); else s.types.add(v); renderScope(); return; }
  const rx = t.closest('[data-rmext]'); if (rx) { s.types.delete(rx.dataset.rmext); renderScope(); return; }
  if (t.closest('[data-addext]')) { addExts(); return; }
  const rp = t.closest('[data-rmplace]'); if (rp) { s.custom.splice(+rp.dataset.rmplace, 1); renderScope(); return; }
  if (t.closest('[data-addplace]')) { addPlace(); return; }
  const act = t.closest('[data-scope]'); if (!act) return;
  if (act.dataset.scope === 'cancel') { $('scope').hidden = true; scope = null; } else applyScope();
});
$('scope').addEventListener('change', e => { const c = e.target.closest('[data-place]'); if (c && scope) { if (c.checked) scope.places.add(c.dataset.place); else scope.places.delete(c.dataset.place); } });
$('scope').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('scope').hidden = true; scope = null; e.stopPropagation(); return; }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'scext') { e.preventDefault(); addExts(); }
  else if (e.target.id === 'scplace') { e.preventDefault(); addPlace(); }
});

// ---------------------------------------------------------------- first-run setup
// Orbis looks at the PC and suggests settings: motion, effects, live activity, search by meaning
// (and where it runs), drives and document folders. Everything stays changeable in the popover.
let profile = null, wiz = null, engineMsg = '', enginePct = 0;
function recommend(p) {
  const tier = p.ram_gb >= 15 && p.cores >= 8 ? 'high' : p.ram_gb >= 7.5 && p.cores >= 4 ? 'mid' : 'low';
  const semOk = p.arch === 'x86_64';
  return {
    tier, semOk,
    fps: tier === 'low' ? '30' : p.battery ? 'auto' : '60',
    visuals: tier === 'low' || !GLP ? 'lite' : 'full',
    live: tier !== 'low',
    semantic: semOk && p.ram_gb >= 7.5,
    sem_device: p.npu_usable ? 'NPU' : p.intel_gpu ? 'GPU' : 'CPU',
  };
}
// what this PC can run smoothly. Hardware sets the first limits; the smoothness guard (below) adds
// its own when the PC turns out slower than its specs suggest (settings.perf_cap).
let caps = { fps60: true, full: true, sem: true, why: {} };
function computeCaps(hwOnly) {
  const p = profile; if (!p) return caps;
  const R = recommend(p), cap = hwOnly ? 0 : setting('perf_cap', 0), soft = !GLP || GL_SOFT;
  const c = {
    fps60: R.tier !== 'low' && cap < 1,
    full: !soft && R.tier !== 'low' && cap < 2,
    sem: R.semOk && p.ram_gb >= 7.5,
    why: {
      fps60: R.tier === 'low' ? `This PC (${p.cores} threads, ${p.ram_gb} GB) stays smooth at 30 fps.` : cap >= 1 ? 'This PC could not keep 60 fps smooth, so Orbis runs at 30.' : '',
      full: soft ? 'Your graphics run without hardware acceleration, so Orbis uses lite effects.' : R.tier === 'low' ? 'Full effects need more memory and processor power than this PC has.'
        : cap >= 2 ? 'This PC could not keep the full effects smooth, so Orbis uses lite effects.' : '',
      sem: !R.semOk ? 'Needs a 64-bit Intel or AMD processor.' : p.ram_gb < 7.5 ? `Needs 8 GB of memory; this PC has ${p.ram_gb} GB.` : '',
    },
  };
  if (!hwOnly) caps = c;
  return c;
}
// settings saved on another PC, or before a driver change, are brought within these limits
async function clampToCaps() {
  const patch = {};
  if (!caps.fps60 && setting('fps', 'auto') !== '30') patch.fps = '30';
  if (!caps.full && setting('visuals', 'full') !== 'lite') patch.visuals = 'lite';
  if (!caps.sem && setting('semantic', false)) patch.semantic = false;
  if (Object.keys(patch).length) await setPrefs(patch);
}
const fpsTarget = () => {
  if (saverOn || !caps.fps60) return 30;
  const f = setting('fps', 'auto');
  return f === '30' || (f === 'auto' && onBattery()) ? 30 : 60;
};
// the smoothness guard: if Orbis keeps missing its frame rate for half a minute while it has the screen
// to itself (and the PC isn't busy with other work), it steps down: 60 fps -> 30 fps -> lite effects
const perf = { t0: 0, n: 0, prev: 0, bad: 0 };
function perfSample(now) {
  if (!perf.t0 || now - perf.prev > 400) { perf.t0 = now; perf.n = 0; perf.prev = now; return; }   // a pause is not slowness
  perf.prev = now; perf.n++;
  if (now - perf.t0 < 10000) return;
  const got = perf.n * 1000 / (now - perf.t0), want = fpsTarget();
  perf.t0 = now; perf.n = 0;
  const fair = T > 20 && (document.hasFocus() || saverOn) && stats && stats.cpu < 85 && profile && $('wiz').hidden;
  if (!fair) { perf.bad = 0; return; }
  perf.bad = got < want * .7 ? perf.bad + 1 : 0;
  if (perf.bad >= 3) { perf.bad = 0; stepDown(); }
}
async function stepDown() {
  const cap = setting('perf_cap', 0);
  if (fpsTarget() === 60 && cap < 1) { await setPrefs({ perf_cap: 1, fps: '30' }); toast('Orbis switched to 30 fps to stay smooth on this PC'); }
  else if (!lite() && cap < 2) { await setPrefs({ perf_cap: 2, fps: '30', visuals: 'lite' }); toast('Orbis switched to lite effects to stay smooth on this PC'); }
  computeCaps();
}
async function openSetup(first) {
  try { profile = await invoke('system_profile'); } catch (e) { toast(String(e)); return; }
  const S = st.settings, R = recommend(profile), installed = !!(st.sem && st.sem.available), hw = computeCaps(true);
  const defaults = profile.user_folders.filter(f => /\\(desktop|documents|downloads)$/i.test(f));
  wiz = {
    first, R, installed,
    fps: first ? R.fps : S.fps, visuals: first ? R.visuals : S.visuals, live: first ? R.live : S.live,
    semantic: first ? (installed ? S.semantic || R.semantic : R.semantic) : S.semantic && installed,
    sem_device: S.sem_device === 'auto' ? R.sem_device : S.sem_device,
    drives: S.drives.length ? [...S.drives] : profile.drives.map(d => d.name),
    doc_roots: S.doc_roots.length ? [...S.doc_roots] : defaults,
    autostart: !!st.autostart, saver: !!S.saver, hw,
  };
  if (!hw.fps60) wiz.fps = '30';
  if (!hw.full) wiz.visuals = 'lite';
  if (!hw.sem) wiz.semantic = false;
  renderWiz();
  $('wiz').hidden = false;
}
function renderWiz() {
  const p = profile, w = wiz, R = w.R, rec = ok => ok ? '<span class="rec">RECOMMENDED</span>' : '';
  const sw = (key, on, dis) => `<button type="button" class="sw2 ctl" role="switch" aria-checked="${on}" data-sw="${key}"${dis ? ' disabled' : ''}></button>`;
  const hw = w.hw, semWhy = !hw.sem ? `Not available on this PC: ${hw.why.sem}`
    : p.npu_usable ? `Runs on your ${esc(p.npus[0])} — the processor stays free while it reads and searches.`
    : p.intel_gpu ? 'No AI accelerator (NPU) here, so it runs on the Intel graphics. Reading documents takes a little longer.'
    : 'No AI accelerator (NPU) here, so it runs on the processor. Reading documents takes longer the first time.';
  const dl = w.installed ? '' : ' Needs a one-time download of about 1.1 GB (a private Python, OpenVINO and the language model).';
  $('wizbox').innerHTML = `
    <h1 id="wizT">${w.first ? 'WELCOME TO ORBIS' : 'SETUP'}</h1>
    <p class="lead">Orbis looked at this PC and suggests the settings below. Everything stays on this computer, and you can change any of it later from the palette menu.</p>
    <div class="pc">
      <span>Processor</span><b>${esc(p.cpu)} · ${p.cores} threads</b>
      <span>Memory</span><b>${p.ram_gb} GB</b>
      <span>Graphics</span><b>${esc(p.gpus.join(' · ') || 'unknown')}${GLP ? '' : ' (no WebGL — lite effects)'}</b>
      <span>AI accelerator</span><b>${esc(p.npus.join(' · ') || 'none')}</b>
      <span>Windows</span><b>${esc(p.os)} · ${esc(p.arch)}${p.battery ? ' · laptop' : ''}</b>
    </div>
    <div class="opt"><b>Motion ${rec(w.fps === R.fps)}</b>
      <select class="ctl" data-sel="fps"><option value="60"${hw.fps60 ? '' : ' disabled'}>Smooth · 60 fps</option><option value="auto"${hw.fps60 ? '' : ' disabled'}>Automatic · 60 plugged in, 30 on battery</option><option value="30">Eco · 30 fps</option></select>
      <small>${!hw.fps60 ? esc(hw.why.fps60) : p.battery ? 'Saves battery when unplugged, full smoothness when plugged in.' : 'This PC has power to spare.'} If Orbis can't keep it smooth, it steps down by itself.</small></div>
    <div class="opt"><b>Visual effects ${rec(w.visuals === R.visuals)}</b>
      <select class="ctl" data-sel="visuals"><option value="full"${hw.full ? '' : ' disabled'}>Full · glows and landmarks</option><option value="lite">Lite · the map and the core only</option></select>
      <small>${!hw.full ? esc(hw.why.full) : 'Your graphics handle the full look easily.'}</small></div>
    <div class="opt"><b>Live activity ${rec(w.live === R.live)}</b>${sw('live', w.live)}
      <small>Folders light up when files change in them. Windows sends the notifications, so it costs almost nothing.</small></div>
    <div class="opt"><b>Search by meaning ${rec(w.semantic === R.semantic && hw.sem)}</b>${sw('semantic', w.semantic, !hw.sem)}
      <small>Find documents by describing them when you don't remember the name — in English, Arabic and about 100 other languages. ${semWhy}${dl}</small>
      ${w.semantic && hw.sem ? `<select data-sel="sem_device" style="grid-column:1;justify-self:start;margin-top:6px">
        ${p.npu_usable ? '<option value="NPU">Run on the NPU</option>' : ''}${p.intel_gpu ? '<option value="GPU">Run on the Intel GPU</option>' : ''}<option value="CPU">Run on the processor</option></select>` : ''}
      ${w.installing ? `<div class="bar"><i style="width:${enginePct}%"></i></div><small style="grid-column:1 / span 2">${esc(engineMsg)}</small>` : ''}</div>
    ${w.semantic && hw.sem ? `<div class="opt"><b>Folders to read documents from</b><span></span>
      <small>PDF, Word, Excel, PowerPoint and text files in these folders (and their subfolders).</small>
      <div class="chips">${w.doc_roots.map((d, i) => `<span>${esc(d)}<button type="button" data-rmroot="${i}" aria-label="Remove ${esc(d)}">×</button></span>`).join('') || '<span>none</span>'}</div>
      <div class="add"><input id="wizroot" placeholder="Add a folder, e.g. D:\\Work" spellcheck="false"><button type="button" data-addroot>ADD</button></div></div>` : ''}
    <div class="opt"><b>Drives on the map</b><span></span>
      <small>Orbis maps every folder on these drives. Windows' own folders and app caches are always left out.</small>
      <div class="chips">${p.drives.map(d => `<label><input type="checkbox" data-drive="${esc(d.name)}"${w.drives.includes(d.name) ? ' checked' : ''}>${esc(d.name)} · ${fmt(d.total)}${d.system ? ' · Windows' : ''}</label>`).join('')}</div></div>
    <div class="opt"><b>Start with Windows</b>${sw('autostart', w.autostart)}
      <small>Open Orbis full screen when you sign in.</small></div>
    <div class="opt"><b>Screen saver</b>${sw('saver', w.saver)}
      <small>When the PC sits idle, Orbis takes over the screen: it catches up on indexing, then shows the time and the PC's health (processor, memory, drives).</small></div>
    <div class="acts2">${w.first ? '<button type="button" data-wiz="skip">SKIP</button>' : '<button type="button" data-wiz="skip">CANCEL</button>'}<button type="button" class="pri" data-wiz="apply">${w.installing ? 'CLOSE' : 'APPLY'}</button></div>`;
  $('wizbox').querySelectorAll('[data-sel]').forEach(x => { x.value = w[x.dataset.sel]; });
}
$('wiz').addEventListener('click', async e => {
  const w = wiz; if (!w) return;
  const t = e.target;
  const swb = t.closest('[data-sw]'); if (swb && !swb.disabled) { w[swb.dataset.sw] = !w[swb.dataset.sw]; renderWiz(); return; }
  const rm = t.closest('[data-rmroot]'); if (rm) { w.doc_roots.splice(+rm.dataset.rmroot, 1); renderWiz(); return; }
  if (t.closest('[data-addroot]')) { const v = $('wizroot').value.trim().replace(/[\\/]+$/, ''); if (v && !w.doc_roots.includes(v)) w.doc_roots.push(v); renderWiz(); return; }
  const dr = t.closest('[data-drive]');
  if (dr) { const d = dr.dataset.drive; w.drives = dr.checked ? [...new Set([...w.drives, d])] : w.drives.filter(x => x !== d); if (!w.drives.length) { w.drives = [d]; dr.checked = true; } return; }
  const act = t.closest('[data-wiz]'); if (!act) return;
  if (act.dataset.wiz === 'skip' || w.installing) {
    if (w.first) await setPrefs({ setup_done: true });
    $('wiz').hidden = true; return;
  }
  const allDrives = profile.drives.map(d => d.name), needInstall = w.semantic && !w.installed && w.hw.sem;
  await setPrefs({
    fps: w.fps, visuals: w.visuals, live: w.live, sem_device: w.sem_device, doc_roots: w.doc_roots, setup_done: true, saver: w.saver, perf_cap: 0,
    semantic: w.semantic && w.installed, drives: w.drives.length === allDrives.length ? [] : w.drives,
  });
  if (w.autostart !== !!st.autostart) { try { await invoke('set_autostart', { on: w.autostart }); } catch (err) { toast(String(err)); } }
  computeCaps();
  if (needInstall) { w.installing = true; engineMsg = 'Starting…'; enginePct = 2; renderWiz(); invoke('install_engine'); return; }
  $('wiz').hidden = true; toast('Settings saved');
});
$('wiz').addEventListener('change', e => { const x = e.target.closest('[data-sel]'); if (x && wiz) { wiz[x.dataset.sel] = x.value; renderWiz(); } });
listen('engine-progress', e => { engineMsg = e.payload.msg; enginePct = e.payload.pct; if (wiz && wiz.installing && !$('wiz').hidden) renderWiz(); renderPrefs(); });
listen('engine-done', async e => {
  if (wiz) wiz.installing = false;
  if (e.payload.ok) { toast('Search by meaning is ready. Orbis is now reading your documents in the background.'); if (!$('wiz').hidden) $('wiz').hidden = true; }
  else toast('The search engine could not be installed: ' + e.payload.error);
  await refreshStatus();
});

// ---------------------------------------------------------------- screen saver
// Windows starts it after the idle minutes chosen in settings (or the Preview button does). The globe
// keeps turning; a big clock sits top left. On the right: the index catching up, then, once everything
// is indexed, the PC's health. Any key, click or real mouse movement ends it.
let saverT0 = 0, saverPt = null, svTick = null, svKey = '', scannedNow = 0;
function setSaver(on) {
  if (on === saverOn) return;
  saverOn = on;
  document.body.classList.toggle('saver', on); $('saver').hidden = !on;
  clearInterval(svTick); svKey = '';
  if (on) {
    if (hasQuery() || sel) resetAll();
    $('pop').hidden = true;
    saverT0 = performance.now(); saverPt = null;
    let n = 0;
    svTick = setInterval(() => { tickClock(); renderSaver(); if (++n % 3 === 0) refreshStatus(); if (n % 60 === 0) recap(); }, 1000);
    tickClock(); refreshStatus().then(renderSaver);
  } else { $('q').focus(); }
  if (drift.on) fitGlobe();
}
function endSaver() { if (!saverOn || performance.now() - saverT0 < 1500) return; invoke('exit_saver'); setSaver(false); }
listen('saver', e => setSaver(!!e.payload));
addEventListener('keydown', e => { if (saverOn) { e.preventDefault(); e.stopPropagation(); endSaver(); } }, true);
addEventListener('pointerdown', e => { if (saverOn) { e.preventDefault(); e.stopPropagation(); endSaver(); } }, true);
addEventListener('wheel', () => { if (saverOn) endSaver(); }, { capture: true, passive: true });
addEventListener('pointermove', e => {
  if (!saverOn || performance.now() - saverT0 < 1500) return;
  if (!saverPt) { saverPt = [e.screenX, e.screenY]; return; }
  if (Math.hypot(e.screenX - saverPt[0], e.screenY - saverPt[1]) > 12) endSaver();   // not the odd twitch
}, true);
// the day so far, on the health screen: how much changed, where most, and when (from time travel's data)
async function recap() {
  const el = $('svToday'); if (!el) return;
  const from = dayStart(0);
  let r; try { r = await invoke('activity', { from: Math.floor(from / 1000), to: Math.floor(Date.now() / 1000) + 60, tz: -from.getTimezoneOffset() }); } catch { return; }
  const top = r.folders.map(([id]) => G.get(id)).filter(n => n && n.kind !== K.ROOT && n.kind !== K.DRIVE).map(n => n.name).filter((v, i, all) => all.indexOf(v) === i).slice(0, 3);
  const maxH = Math.max(1, ...r.hours), now = new Date().getHours();
  el.innerHTML = r.total ? `<p><b>${num(r.total)}</b> files changed in <b>${num(r.folders.length)}</b> folders${top.length ? ` · busiest: <b dir="auto">${esc(top.join(', '))}</b>` : ''}</p>
    <div class="tth">${r.hours.map((v, i) => `<i style="height:${v ? 8 + 92 * v / maxH : 2}%;opacity:${i > now ? .25 : 1}"></i>`).join('')}</div>
    <div class="tthl"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>` : '<p>A quiet day so far: no files changed.</p>';
}
const RING = 251.3;
const gauge = (k, label, big) => `<div class="gg${big ? ' big' : ''}" data-g="${esc(k)}"><div class="ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="tk" cx="50" cy="50" r="48"/><circle class="trk" cx="50" cy="50" r="40"/><circle class="val" cx="50" cy="50" r="40" transform="rotate(-90 50 50)"/></svg><b></b></div><span class="gl">${esc(label)}</span><small></small></div>`;
function setGauge(k, p, val, subText, warn) {
  const el = $('svBody').querySelector(`[data-g="${CSS.escape(k)}"]`); if (!el) return;
  el.querySelector('.val').style.strokeDasharray = `${(clamp01(p) * RING).toFixed(1)} ${RING}`;
  el.querySelector('b').textContent = val; el.querySelector('small').textContent = subText; el.classList.toggle('warn', !!warn);
}
const stage = (k, label) => `<div class="stg" data-s="${k}"><div class="stg-h"><span>${label}</span><b></b></div><div class="pbar"><i></i></div><small></small></div>`;
function setStage(k, p, right, subText) {
  const el = $('svBody').querySelector(`[data-s="${k}"]`); if (!el) return;
  el.classList.toggle('ok', p === 1); el.querySelector('.pbar').classList.toggle('ind', p == null);
  if (p != null) el.querySelector('.pbar i').style.width = (clamp01(p) * 100).toFixed(1) + '%';
  el.querySelector('b').textContent = right; el.querySelector('small').textContent = subText;
}
const upFor = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} D ${h} H` : h ? `${h} H ${m} MIN` : `${m} MIN`; };
function renderSaver() {
  if (!saverOn || !st) return;
  const e = st.sem || {}, docsOn = setting('semantic', false) && e.available;
  const checking = performance.now() - saverT0 < 4000, busy = checking || st.building || (docsOn && e.live) || !st.ready;
  const S = stats, phase = busy ? (checking ? 'check' : 'index') : 'health';
  const key = phase + '|' + (S ? S.drives.map(d => d.name).join(',') + (S.battery != null ? '|b' : '') : '') + '|' + docsOn;
  if (key !== svKey) {
    svKey = key;
    $('svPh').innerHTML = phase === 'health' ? '<b>SYSTEM HEALTH</b><span>Every file is indexed. Here is how the PC is doing.</span>'
      : `<b>${phase === 'check' ? 'CHECKING THE INDEX' : 'UPDATING THE INDEX'}</b><span>While you're away, Orbis catches up on your files. System health follows when it's done.</span>`;
    $('svBody').innerHTML = phase !== 'health' ? stage('drives', 'DRIVES') + (docsOn ? stage('docs', 'DOCUMENTS') : '')
      : `<div class="sv-big">${gauge('cpu', 'PROCESSOR', true)}${gauge('mem', 'MEMORY', true)}</div>
         <div class="sv-spark"><svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polygon/><polyline/></svg><span>PROCESSOR · LAST 3 MINUTES</span></div>
         <div class="sv-lbl">DRIVES${S && S.battery != null ? ' & POWER' : ''}</div>
         <div class="sv-small">${S ? S.drives.map(d => gauge('d' + d.name, d.name)).join('') + (S.battery != null ? gauge('pwr', 'BATTERY') : '') : ''}</div>
         <div class="sv-lbl">TODAY</div><div class="sv-today" id="svToday">…</div>
         <div class="sv-meta" id="svMeta"></div>`;
    recap();
  }
  if (phase !== 'health') {
    const scanned = scannedNow || st.scanned || 0, total = scanTotal();
    if (!st.ready || st.building) setStage('drives', total ? Math.min(.99, scanned / total) : null, total ? `${Math.min(99, Math.round(scanned / total * 100))}%` : num(scanned), `${num(scanned)} items scanned so far`);
    else setStage('drives', 1, num(st.items), `up to date · scanned ${ago(st.built_at).toLowerCase()}`);
    if (docsOn) {
      if (e.live) setStage('docs', e.of ? e.done / e.of : null, e.of ? `${Math.round(e.done / e.of * 100)}%` : '', `reading ${num(e.done)} of ${num(e.of)}`);
      else setStage('docs', 1, num(e.files), 'up to date');
    }
    return;
  }
  if (!S) return;
  const mem = S.mem_used / S.mem_total;
  setGauge('cpu', S.cpu / 100, Math.round(S.cpu) + '%', `${profile ? profile.cores + ' threads' : ''}`, S.cpu > 90);
  setGauge('mem', mem, Math.round(mem * 100) + '%', `${fmt(S.mem_used)} of ${fmt(S.mem_total)}`, mem > .9);
  for (const d of S.drives) { const u = 1 - d.free / d.total; setGauge('d' + d.name, u, Math.round(u * 100) + '%', fmt(d.free) + ' free', u > .9); }
  if (S.battery != null) setGauge('pwr', S.battery / 100, S.battery + '%', S.charging ? 'plugged in' : 'on battery', S.battery < 20 && !S.charging);
  const pts = cpuHist.length > 1 ? cpuHist.map((v, i) => `${(i / (cpuHist.length - 1) * 100).toFixed(1)},${(40 - v / 100 * 38).toFixed(1)}`).join(' ') : '';
  const sp = $('svBody').querySelector('.sv-spark svg');
  if (sp && pts) { sp.querySelector('polyline').setAttribute('points', pts); sp.querySelector('polygon').setAttribute('points', `0,40 ${pts} 100,40`); }
  const docs = docsOn ? e.files : 0;
  $('svMeta').textContent = `UP ${upFor(S.uptime)} · ${num(st.items)} ITEMS${docs ? ` · ${num(docs)} DOCUMENTS` : ''} · INDEXED ${ago(st.built_at)}`;
}

// ---------------------------------------------------------------- startup
async function loadBase() {
  const list = await invoke('base_graph');
  const q = $('q').value.trim(), first = !G.size;
  G.clear(); nameHits = []; semHits = []; sel = null; selHit = null; selInfo = null;
  list.forEach(n => addNode(n, true));
  ROOT = [...G.values()].find(n => n.kind === K.ROOT) || null;
  buildWeb(); computeHeat(); glBuild(); buildPathIndex(); pickLandmarks();
  $('overlay').hidden = true; $('q').disabled = false;
  await refreshStatus(); tickStats();
  if (q) runSearch(q); else { renderAll(); if (first && !reduce) { startDrift(); cam.fold = 1; } else if (drift.on) fitGlobe(); else fitAll(); if (view.to && first) Object.assign(view, view.to, { to: null }); }
  if (first) { introT0 = reduce ? -99 : T; setTimeout(() => document.body.classList.remove('boot'), reduce ? 0 : 900); }
  loadDock();
  $('q').focus();
}
listen('index-progress', e => { scannedNow = e.payload; $('ovS').textContent = `${num(e.payload)} items scanned`; });
// a scan walks more entries than the map keeps, so progress is measured against the last full scan
const scanTotal = () => { try { return +localStorage.getItem('orbis.scanTotal') || 0; } catch { return 0; } };
listen('index-reshaped', e => {
  const [was, now, secs] = e.payload, d = now - was;
  toast(`${d < 0 ? `Left out ${num(-d)} items` : `Added back ${num(d)} items`} · no re-scan · ${secs.toFixed(1)} s`);
});
listen('index-built', e => {
  try { if (scannedNow) localStorage.setItem('orbis.scanTotal', String(scannedNow)); } catch {}
  scannedNow = 0;
  if (!saverOn) toast(`Drives re-scanned in ${Math.round(e.payload)} s`);
});
listen('index-ready', () => loadBase());
setInterval(() => { if (G.size) computeHeat(); }, 600000);   // heat ages: re-rank every 10 minutes
(async () => {
  glInit(); resize(); applyTheme('ice', false); tickClock(); startLoop();
  const s = await refreshStatus();
  if (s) { applyTheme(s.theme, false); kiosk = s.kiosk; renderWin(); if (s.saver_active) setSaver(true); }
  // what this PC can run smoothly: limits for the settings, and anything saved beyond them is brought down
  invoke('system_profile').then(p => { profile = p; computeCaps(); renderPrefs(); clampToCaps(); }).catch(() => {});
  refreshNews(); loadWsCmds();
  if (s && s.settings && !s.settings.setup_done && !s.saver_active) setTimeout(() => { if (!saverOn) openSetup(true); }, 2200);   // after the map has assembled
  tickStats();
  if (s && s.ready) { loadBase(); return; }
  document.body.classList.remove('boot');
  $('overlay').hidden = false;
  // "index-ready" can fire before this page listens, so also ask once a second
  const poll = setInterval(async () => {
    const x = await invoke('status');
    if (x.ready) { clearInterval(poll); if (!$('overlay').hidden) loadBase(); }
    else $('ovS').textContent = `${num(x.scanned)} items scanned`;
  }, 1000);
})();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ModuleFactory from 'manifold';
import { computePlan, buildTray } from './geometry.js';
import { buildBinarySTL } from './stl.js';
import { buildStep } from './step.js';
import { PACKAGE_GROUPS, findPackage, CUSTOM_ID } from './packages.js';
import { LATTICE_PITCH, MIN_SPAN, MAX_SPAN, spanOutline } from './constants.js';

// ---------- engine init ----------
const mod = await ModuleFactory(); mod.setup();
document.getElementById('loading').remove();

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const els = {
  screw: $('screw'),
  partsList: $('partsList'), addPart: $('addPart'),
  clearance: $('clearance'),
  span: $('span'), spanLabel: $('spanLabel'), sizeLabel: $('sizeLabel'),
  hud: $('hud'),
  dlStl: $('dlStl'), dlStep: $('dlStep'),
};

// ---------- package dropdowns ----------
function fillPackageSelect(sel) {
  const custom = document.createElement('option');
  custom.value = CUSTOM_ID;
  custom.textContent = 'Custom';
  sel.appendChild(custom);
  for (const g of PACKAGE_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.group;
    for (const p of g.items) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = `${p.name} — ${p.x} x ${p.y} x ${p.z}`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

function selectPackage(sel, id, dims) {
  sel.value = id;
  const p = findPackage(id);
  if (p) { dims.x.value = p.x; dims.y.value = p.y; dims.z.value = p.z; }
}
function addPartEntry(item = {}) {
  const entry = document.createElement('div');
  entry.className = 'package-entry';

  const head = document.createElement('div');
  head.className = 'package-entry-head';
  const packageLabel = document.createElement('label');
  packageLabel.textContent = 'Package';
  const pkg = document.createElement('select');
  pkg.className = 'pkg-select';
  fillPackageSelect(pkg);
  packageLabel.appendChild(pkg);

  const quantityLabel = document.createElement('label');
  quantityLabel.textContent = 'Count';
  const quantity = document.createElement('input');
  quantity.className = 'quantity';
  quantity.type = 'number';
  quantity.min = '1';
  quantity.step = '1';
  quantity.value = String(item.quantity ?? 1);
  quantityLabel.appendChild(quantity);

  const remove = document.createElement('button');
  remove.className = 'remove-part';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = 'Remove package type';
  remove.setAttribute('aria-label', 'Remove package type');
  head.append(packageLabel, quantityLabel, remove);
  entry.appendChild(head);

  const dimensions = document.createElement('div');
  dimensions.className = 'row';
  for (const axis of ['x', 'y', 'z']) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = `${axis.toUpperCase()} (mm)`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0.1';
    input.max = axis === 'x' ? '160' : axis === 'y' ? '110' : '8.5';
    input.className = `dim-${axis}`;
    input.value = String(item[axis] ?? '');
    label.appendChild(input);
    wrap.appendChild(label);
    dimensions.appendChild(wrap);
  }
  entry.appendChild(dimensions);
  els.partsList.appendChild(entry);
  if (item.pkg) pkg.value = item.pkg;
  syncRemoveButtons();
  return entry;
}
function syncRemoveButtons() {
  const entries = [...els.partsList.children];
  for (const entry of entries) entry.querySelector('.remove-part').disabled = entries.length === 1;
}
addPartEntry({ x: 5, y: 5, z: 1, quantity: 1 });

// ---------- URL hash state ----------
function applyHash() {
  if (!location.hash || location.hash.length < 2) return;
  try {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get('s') === 'M3' || q.get('s') === 'M4') els.screw.value = q.get('s');
    if (q.get('c')) els.clearance.value = q.get('c');
    if (q.get('span')) els.span.value = q.get('span');
    else if (q.get('hw') === '1') els.span.value = '4';
    let items = [];
    if (q.get('items')) {
      const parsed = JSON.parse(q.get('items'));
      if (Array.isArray(parsed)) items = parsed.filter(item => item && typeof item === 'object' && !Array.isArray(item));
    } else if (q.get('pkg') || q.get('x')) {
      items.push({
        pkg: q.get('pkg') || CUSTOM_ID, x: q.get('x') || 5, y: q.get('y') || 5, z: q.get('z') || 1,
        quantity: (Number(q.get('cols')) || 1) * (Number(q.get('rows')) || 1),
      });
      if (q.get('t') === '1') items.push({
        pkg: q.get('pkgB') || CUSTOM_ID, x: q.get('xb') || 5, y: q.get('yb') || 5, z: q.get('zb') || 1,
        quantity: (Number(q.get('colsB')) || 1) * (Number(q.get('rowsB')) || 1),
      });
    }
    if (items.length) {
      els.partsList.replaceChildren();
      for (const item of items) addPartEntry(item);
    }
  } catch { /* ignore malformed hash */ }
}
function writeHash() {
  const items = [...els.partsList.children].map((entry) => {
    const pkg = entry.querySelector('.pkg-select').value;
    return {
      pkg,
      x: entry.querySelector('.dim-x').value,
      y: entry.querySelector('.dim-y').value,
      z: entry.querySelector('.dim-z').value,
      quantity: entry.querySelector('.quantity').value,
    };
  });
  const q = new URLSearchParams({
    s: els.screw.value,
    c: els.clearance.value,
    span: els.span.value,
    items: JSON.stringify(items),
  });
  history.replaceState(null, '', '#' + q.toString());
}

// ---------- input ----------
function readInput() {
  const inp = {
    screw: els.screw.value,
    clearance: els.clearance.value === '' ? undefined : +els.clearance.value,
    parts: [...els.partsList.children].map((entry) => {
      const pkg = entry.querySelector('.pkg-select').value;
      const p = findPackage(pkg);
      return {
        name: p ? p.name : 'Custom',
        x: +entry.querySelector('.dim-x').value,
        y: +entry.querySelector('.dim-y').value,
        z: +entry.querySelector('.dim-z').value,
        quantity: +entry.querySelector('.quantity').value,
      };
    }),
    span: +els.span.value,
  };
  return inp;
}

// ---------- three.js scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f1ea);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
camera.up.set(0, 0, 1);   // Z-up: do not rotate geometry data
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(180, -120, 320);
scene.add(key);
const fill = new THREE.DirectionalLight(0xe8e2d4, 0.45);
fill.position.set(-220, 160, 180);
scene.add(fill);

const trayMat = new THREE.MeshStandardMaterial({ color: 0x9fb1bf, metalness: 0.12, roughness: 0.55, flatShading: true });
const trayGeo = new THREE.BufferGeometry();
const trayMesh = new THREE.Mesh(trayGeo, trayMat);
scene.add(trayMesh);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x232a33, transparent: true, opacity: 0.85 });
let edgeLines = null;
function updateEdges() {
  if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines = null; }
  if (!trayMesh.geometry.index) return;
  edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(trayMesh.geometry, 25), edgeMat);
  scene.add(edgeLines);
}

// Ghost components are color-coded by package entry.
const ghostMats = [0x465361, 0x8a6d3b, 0x587a62, 0x77618a, 0x9a654f, 0x4f7d88]
  .map(color => new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
const unitBox = new THREE.BoxGeometry(1, 1, 1);
let ghostParts = [];
function updateGhostParts(plan) {
  for (const m of ghostParts) { scene.remove(m); m.dispose(); }
  ghostParts = [];
  const build = (index, part) => {
    const ps = plan.pockets.filter(p => p.part === index);
    if (!ps.length) return null;
    const m = new THREE.InstancedMesh(unitBox, ghostMats[index % ghostMats.length], ps.length);
    const m4 = new THREE.Matrix4();
    ps.forEach((p, i) => {
      m4.makeScale(part.x, part.y, part.z);
      m4.setPosition(p.cx, p.cy, p.floorZ + part.z / 2);
      m.setMatrixAt(i, m4);
    });
    m.instanceMatrix.needsUpdate = true;
    scene.add(m);
    return m;
  };
  for (const [index, item] of plan.parts.entries()) {
    const mesh = build(index, item.part);
    if (mesh) ghostParts.push(mesh);
  }
}

// Plate lattice, always shown
const plateGroup = new THREE.Group();
scene.add(plateGroup);
const latticeMat = new THREE.MeshBasicMaterial({ color: 0xb9b2a2 });
const usedHoleMat = new THREE.MeshBasicMaterial({ color: 0xdaa520 });
const plateMat = new THREE.MeshStandardMaterial({ color: 0xe2dcd0, transparent: true, opacity: 0.5, roughness: 0.9 });
function updateLattice(plan) {
  plateGroup.clear();
  const W = plan.outline.x + 60, D = plan.outline.y + 60;
  const plateSlab = new THREE.Mesh(new THREE.BoxGeometry(W, D, 3), plateMat);
  plateSlab.position.set(0, 0, -1.5);
  plateGroup.add(plateSlab);

  const holeGeo = new THREE.CylinderGeometry(1.6, 1.6, 0.15, 16);
  holeGeo.rotateX(Math.PI / 2); // align cylinder axis to +Z
  const inst = [];
  const iMax = Math.ceil(W / 2 / LATTICE_PITCH) + 1;
  const jMax = Math.ceil(D / 2 / LATTICE_PITCH) + 1;
  for (let i = -iMax; i <= iMax; i++) {
    for (let j = -jMax; j <= jMax; j++) {
      if (((i + j) % 2 + 2) % 2 !== (plan.latticeParity || 0)) continue;
      const x = (plan.latticeOrigin?.x || 0) + i * LATTICE_PITCH;
      const y = (plan.latticeOrigin?.y || 0) + j * LATTICE_PITCH;
      if (Math.abs(x) > W / 2 - 2 || Math.abs(y) > D / 2 - 2) continue;
      inst.push({ x, y, used: plan.holes.some(h => Math.abs(h.x - x) < 1e-6 && Math.abs(h.y - y) < 1e-6) });
    }
  }
  for (const mat of [latticeMat, usedHoleMat]) {
    const pts = inst.filter(p => (mat === usedHoleMat) === p.used);
    if (!pts.length) continue;
    const m = new THREE.InstancedMesh(holeGeo, mat, pts.length);
    const m4 = new THREE.Matrix4();
    pts.forEach((p, i) => { m4.makeTranslation(p.x, p.y, -0.05); m.setMatrixAt(i, m4); });
    m.instanceMatrix.needsUpdate = true;
    plateGroup.add(m);
  }
}

let framedOutline = '';
function reframe(outline) {
  const r = Math.hypot(outline.x, outline.y) / 2 + 30;
  camera.position.set(r * 0.9, -r * 1.15, r * 0.95);
  controls.target.set(0, 0, 3);
  controls.update();
  needsRender = true;
}

function resize() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();

let needsRender = true;
controls.addEventListener('change', () => { needsRender = true; });
window.addEventListener('resize', () => { resize(); needsRender = true; });
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  if (needsRender) { renderer.render(scene, camera); needsRender = false; }
}
tick();

// ---------- panel divider (drag to resize) ----------
{
  const divider = $('divider');
  let dragging = false;
  divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    divider.classList.add('dragging');
    try { divider.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.min(560, Math.max(240, e.clientX));
    document.documentElement.style.setProperty('--pw', w + 'px');
    needsRender = true;
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    try { divider.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    resize(); needsRender = true;
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
  new ResizeObserver(() => { resize(); needsRender = true; }).observe(canvas);
}

// ---------- mesh handoff ----------
function geometryFromMesh(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  g.computeVertexNormals();
  return g;
}

// ---------- HUD ----------
function renderHud(plan) {
  if (!plan.ok) {
    els.hud.style.color = '#000';
    els.hud.textContent = plan.errors.join(' · ');
  } else {
    els.hud.style.color = '#000';
    els.hud.textContent = '';
  }
}

// ---------- rebuild ----------
let seq = 0, current = null;   // current = { plan, built }
async function rebuild() {
  const mySeq = ++seq;
  const plan = computePlan(readInput());
  renderHud(plan);
  if (!plan.ok) { setDownloadsEnabled(false); return; }
  await new Promise(r => setTimeout(r));          // let the HUD paint before the WASM call
  if (mySeq !== seq) return;
  let built;
  try { built = buildTray(mod, plan); } catch (e) { renderHud({ ...plan, ok: false, errors: [e.message] }); setDownloadsEnabled(false); return; }
  if (mySeq !== seq) { built.manifold.delete(); return; }
  if (current) { current.built.manifold.delete(); trayMesh.geometry.dispose(); }
  current = { plan, built };
  trayMesh.geometry = geometryFromMesh(built.mesh);
  updateEdges();
  updateGhostParts(plan); updateLattice(plan);
  const outlineKey = `${plan.outline.x}x${plan.outline.y}`;
  if (framedOutline !== outlineKey) { reframe(plan.outline); framedOutline = outlineKey; }
  setDownloadsEnabled(true);
  window.__trayGen = { plan, mesh: built.mesh, rebuild, renderer, buildBinarySTL, buildStep };
  writeHash();
  needsRender = true;
}
function setDownloadsEnabled(on) {
  els.dlStl.disabled = !on;
  els.dlStep.disabled = !on;
}

let debounceT = null;
function scheduleRebuild() {
  clearTimeout(debounceT);
  debounceT = setTimeout(rebuild, 120);
}

// ---------- events ----------
els.partsList.addEventListener('change', (event) => {
  const target = event.target;
  const entry = target.closest('.package-entry');
  if (target.classList.contains('pkg-select')) {
    selectPackage(target, target.value, {
      x: entry.querySelector('.dim-x'),
      y: entry.querySelector('.dim-y'),
      z: entry.querySelector('.dim-z'),
    });
  }
  if (target.classList.contains('remove-part')) {
    entry.remove();
    syncRemoveButtons();
  }
  scheduleRebuild();
});
els.partsList.addEventListener('input', scheduleRebuild);
els.partsList.addEventListener('click', (event) => {
  if (!event.target.classList.contains('remove-part')) return;
  event.target.closest('.package-entry').remove();
  syncRemoveButtons();
  scheduleRebuild();
});
els.addPart.addEventListener('click', () => {
  addPartEntry({ x: 5, y: 5, z: 1, quantity: 1 });
  scheduleRebuild();
});
function syncSpan() {
  const n = Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.round(+els.span.value || MAX_SPAN)));
  els.span.value = String(n);
  const size = spanOutline(n);
  els.spanLabel.textContent = n === 1 ? '1 column' : `${n} columns`;
  els.sizeLabel.textContent = size.label + ' tray for the staging plate.';
}
els.span.addEventListener('input', () => { syncSpan(); scheduleRebuild(); });
for (const e of [els.screw, els.clearance]) {
  e.addEventListener('input', scheduleRebuild);
  e.addEventListener('change', scheduleRebuild);
}

// ---------- downloads ----------
function safeName(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function fileBase() {
  const p = current.plan;
  const packageNames = p.input.parts.map(item => `${item.quantity}x-${safeName(item.name)}`).join('_');
  let base = `lumen-tray_${packageNames}_${p.input.screw}`;
  if (p.input.span < MAX_SPAN) base += `_${p.input.span}col`;
  return base;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
els.dlStl.addEventListener('click', () => {
  if (!current || !current.built) return;
  download(new Blob([buildBinarySTL(current.built.mesh)], { type: 'model/stl' }), fileBase() + '.stl');
});
els.dlStep.addEventListener('click', () => {
  if (!current || !current.built) return;
  const text = buildStep(current.built.mesh, fileBase());
  download(new Blob([text], { type: 'application/step' }), fileBase() + '.step');
});

// ---------- boot ----------
applyHash();
if (els.clearance.value === '') els.clearance.value = 0.3;
syncSpan();
syncRemoveButtons();
resize();
rebuild();

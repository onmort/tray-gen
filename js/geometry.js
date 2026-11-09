// js/geometry.js  (manifold-3d v3.5.4 vendored; see PLAN.md Task 1)
import {
  VISION_Z, TRAY_H, MIN_FLOOR, EDGE_WALL, PIN1_CHAMFER, CORNER_FILLET, TOP_CHAMFER,
  CB_DEPTH, MAX_PART_Z,
  PLATE_Y, MIN_SPAN, MAX_SPAN, spanOutline, COLUMN_PITCH, LATTICE_PITCH, SCREWS, DEFAULTS, LIMITS, CYL_SEGMENTS, WALL,
} from './constants.js';

const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);
const round3 = (v) => Math.round(v * 1000) / 1000;

function mergeIntervals(iv) {
  if (!iv.length) return [];
  iv.sort((a, b) => a[0] - b[0]);
  const out = [iv[0].slice()];
  for (let i = 1; i < iv.length; i++) {
    const last = out[out.length - 1];
    if (iv[i][0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[i][1]);
    else out.push(iv[i].slice());
  }
  return out;
}

// Plate lattice as origin + 15 mm steps. Origin is reduced into (-7.5, 7.5]
// so a tray whose screws are offset from its center still lines up.
export function latticeFrame(pts) {
  const p = LATTICE_PITCH;
  const mod = (v) => {
    let m = ((v % p) + p) % p;
    if (m > p / 2) m -= p;
    return m;
  };
  const x = mod(pts[0][0]), y = mod(pts[0][1]);
  const i = Math.round((pts[0][0] - x) / p);
  const j = Math.round((pts[0][1] - y) / p);
  return { x, y, parity: ((i + j) % 2 + 2) % 2 };
}

// Two screws, in the corners that share an edge with the pin-1 chamfer
// (-X, +Y): bottom-left and top-right. Both are on the outer columns, one
// lattice step in from the 120 mm plate edges, so they stay on the same rows
// after the outline is shortened.
export function mountingHoles(span) {
  const { span: n } = spanOutline(span);
  const x = (n - 1) / 2 * COLUMN_PITCH;
  const y = PLATE_Y / 2 - LATTICE_PITCH;
  return [[-x, -y], [x, y]];
}

export function holeParityOk([x, y]) {
  const i = Math.round(x / LATTICE_PITCH), j = Math.round(y / LATTICE_PITCH);
  return Math.abs(x - i * LATTICE_PITCH) < 1e-6 && Math.abs(y - j * LATTICE_PITCH) < 1e-6
      && ((i + j) % 2 === 0);
}

function computeMultiPartPlan(raw) {
  const errors = [], warnings = [];
  const screwKey = raw.screw === 'M3' ? 'M3' : 'M4';
  const screw = { ...SCREWS[screwKey], key: screwKey };
  const clearance = num(raw.clearance, DEFAULTS.clearance);
  const wall = WALL;
  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.round(num(raw.span, MAX_SPAN))));
  const items = raw.parts.map(item => ({
    part: {
      name: (item && item.name) || 'custom',
      x: num(item && item.x, 0), y: num(item && item.y, 0), z: num(item && item.z, 0),
    },
    quantity: Number(item && item.quantity),
  }));
  const input = { screw: screwKey, clearance, wall, parts: items, span };
  if (!items.length) errors.push('Add at least one package type.');
  if (clearance < LIMITS.clearance.min || clearance > LIMITS.clearance.max) {
    errors.push(`Clearance must be ${LIMITS.clearance.min} to ${LIMITS.clearance.max} mm per side.`);
  }
  for (const { part, quantity } of items) {
    if (!(part.x > 0) || !(part.y > 0)) errors.push(`Part ${part.name} X and Y must be > 0 mm.`);
    if (!(part.z > 0)) errors.push(`Part ${part.name} Z (height) must be > 0 mm.`);
    if (part.z > MAX_PART_Z) errors.push(`Part ${part.name} height ${part.z} mm exceeds ${MAX_PART_Z} mm (needs ${MIN_FLOOR} mm floor under a 10 mm vision plane).`);
    if (!Number.isSafeInteger(quantity) || quantity < 1) errors.push(`Part ${part.name} count must be a positive whole number.`);
  }

  const outline = spanOutline(span);
  const innerW = outline.x - 2 * EDGE_WALL;
  const innerD = outline.y - 2 * EDGE_WALL;
  const holePts = mountingHoles(span);
  const holes = holePts.map(([x, y]) => ({ x, y, thru: screw.thru, cbDia: screw.cbDia, cbDepth: CB_DEPTH }));
  const keepoutR = screw.cbDia / 2 + wall;
  const lattice = latticeFrame(holePts);
  const parts = items.map(({ part, quantity }) => {
    const pocket = { w: round3(part.x + 2 * clearance), d: round3(part.y + 2 * clearance) };
    return {
      part, quantity, floorZ: round3(VISION_Z - part.z), pocket,
      pitch: { x: round3(pocket.w + wall), y: round3(pocket.d + wall) },
    };
  });
  const grids = [];
  let totalH = 0, maxW = 0;
  if (errors.length === 0) {
    for (const [index, item] of parts.entries()) {
      const maxCols = Math.floor((innerW + wall) / item.pitch.x + 1e-9);
      if (maxCols < 1) {
        errors.push(`Part ${item.part.name} is too wide to fit in this tray.`);
        continue;
      }
      const cols = Math.min(item.quantity, maxCols);
      const rows = Math.ceil(item.quantity / cols);
      const width = item.pocket.w + (cols - 1) * item.pitch.x;
      const height = item.pocket.d + (rows - 1) * item.pitch.y;
      grids.push({ index, cols, rows, width, height });
      maxW = Math.max(maxW, width);
      totalH += height;
    }
    totalH += Math.max(0, grids.length - 1) * wall;
    if (totalH > innerD + 1e-6) {
      errors.push('The requested package counts do not fit in the tray. Increase the tray width or reduce the counts.');
    }
    if (maxW > innerW + 1e-6) {
      errors.push('The requested package layout is wider than the tray. Increase the tray width.');
    }
  }

  const pockets = [];
  if (errors.length === 0) {
    const xLimit = Math.max(0, (innerW - maxW) / 2);
    const yLimit = Math.max(0, (innerD - totalH) / 2);
    const offsets = (limit) => {
      const values = [0];
      for (let n = 0.5; n <= limit; n += 0.5) values.push(n, -n);
      if (Math.abs(limit * 2 - Math.round(limit * 2)) > 1e-6) values.push(limit, -limit);
      return values.filter(v => Math.abs(v) <= limit + 1e-6).sort((a, b) => Math.abs(a) - Math.abs(b));
    };
    let chosen = null;
    for (const yShift of offsets(yLimit)) {
      for (const xShift of offsets(xLimit)) {
        let cursorTop = totalH / 2 + yShift;
        let clear = true;
        const placed = [];
        for (const grid of grids) {
          const item = parts[grid.index];
          for (let row = 0; row < grid.rows && clear; row++) {
            const count = Math.min(grid.cols, item.quantity - row * grid.cols);
            const cy = cursorTop - item.pocket.d / 2 - row * item.pitch.y;
            const rowWidth = item.pocket.w + (count - 1) * item.pitch.x;
            const x0 = xShift - rowWidth / 2;
            for (let col = 0; col < count; col++) {
              const cx = x0 + item.pocket.w / 2 + col * item.pitch.x;
              if (holes.some(h => rectHitsCircle(cx, cy, item.pocket.w, item.pocket.d, h.x, h.y, keepoutR))) {
                clear = false;
                break;
              }
              placed.push({
                cx: round3(cx), cy: round3(cy), w: item.pocket.w, d: item.pocket.d,
                floorZ: item.floorZ, part: grid.index, col, row,
              });
            }
          }
          cursorTop -= grid.height + wall;
        }
        if (clear) { chosen = placed; break; }
      }
      if (chosen) break;
    }
    if (chosen) pockets.push(...chosen);
    else errors.push('The requested package layout conflicts with the mounting-hole keepouts. Change the tray width or package counts.');
  }

  const outlinePoly = filletPolygon(outlinePolygon(outline, PIN1_CHAMFER), CORNER_FILLET);
  const a0 = shoelace(outlinePoly);
  const a1 = shoelace(offsetPolygon(outlinePoly, TOP_CHAMFER / 2));
  const a2 = shoelace(offsetPolygon(outlinePoly, TOP_CHAMFER));
  const ring = (TOP_CHAMFER / 6) * (a0 + 4 * a1 + a2);
  const slab = a0 * (TRAY_H - TOP_CHAMFER) + ring;
  const pocketVol = pockets.reduce((a, p) => a + p.w * p.d * (TRAY_H - p.floorZ), 0);
  const holeVol = holes.reduce((a, h) => a + Math.PI * (h.thru / 2) ** 2 * (TRAY_H - h.cbDepth) + Math.PI * (h.cbDia / 2) ** 2 * h.cbDepth, 0);
  return {
    ok: errors.length === 0, errors, warnings, input, outline, trayH: TRAY_H,
    latticeOrigin: { x: lattice.x, y: lattice.y }, latticeParity: lattice.parity,
    floorZ: parts[0]?.floorZ ?? 0, pocket: parts[0]?.pocket ?? null, pitch: parts[0]?.pitch ?? null,
    parts, grids, pockets, holes, screw, keepoutR, chamfer: PIN1_CHAMFER,
    stats: {
      pocketCount: pockets.length, pocketCounts: parts.map(item => item.quantity),
      volumeEstimateCm3: round3((slab - pocketVol - holeVol) / 1000),
    },
  };
}

// Axis-aligned rect (center cx,cy; size w,d) vs circle (hx,hy,r) intersection test.
// Tolerant at exact tangency (dist == r): a pocket edge exactly `wall` away from
// a counterbore edge is by design a keepout hit-free tangency, and float noise
// must not flip it into an overlap.
function rectHitsCircle(cx, cy, w, d, hx, hy, r) {
  const dx = Math.max(Math.abs(hx - cx) - w / 2, 0);
  const dy = Math.max(Math.abs(hy - cy) - d / 2, 0);
  return dx * dx + dy * dy < r * r - 1e-9;
}

export function computePlan(raw) {
  if (Array.isArray(raw.parts)) return computeMultiPartPlan(raw);
  const errors = [], warnings = [];

  const screwKey = raw.screw === 'M3' ? 'M3' : 'M4';
  const screw = { ...SCREWS[screwKey], key: screwKey };
  const clearance = num(raw.clearance, DEFAULTS.clearance);
  const wall = WALL;   // fixed 1.5 mm, not user-adjustable
  const colsOverride = raw.cols == null || raw.cols === '' ? null : Math.floor(num(raw.cols, 0));
  const rowsOverride = raw.rows == null || raw.rows === '' ? null : Math.floor(num(raw.rows, 0));
  const colsBOverride = raw.colsB == null || raw.colsB === '' ? null : Math.floor(num(raw.colsB, 0));
  const rowsBOverride = raw.rowsB == null || raw.rowsB === '' ? null : Math.floor(num(raw.rowsB, 0));

  // ---- validation ----
  const readPart = (p) => ({
    name: (p && p.name) || 'custom',
    x: num(p && p.x, 0), y: num(p && p.y, 0), z: num(p && p.z, 0),
  });
  const part = readPart(raw.part);
  const twoParts = raw.partB != null;
  const partB = twoParts ? readPart(raw.partB) : null;
  const split = Math.min(0.85, Math.max(0.15, num(raw.split, 0.5)));
  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.round(num(raw.span, MAX_SPAN))));
  const input = { screw: screwKey, clearance, wall, part, partB, twoParts, split, span, cols: colsOverride, rows: rowsOverride, colsB: colsBOverride, rowsB: rowsBOverride };
  const validatePart = (p, tag) => {
    if (!(p.x > 0) || !(p.y > 0)) errors.push(`Part ${tag} X and Y must be > 0 mm.`);
    if (!(p.z > 0)) errors.push(`Part ${tag} Z (height) must be > 0 mm.`);
    if (p.z > MAX_PART_Z) errors.push(`Part ${tag} height ${p.z} mm exceeds ${MAX_PART_Z} mm (needs ${MIN_FLOOR} mm floor under a 10 mm vision plane).`);
  };
  if (clearance < LIMITS.clearance.min || clearance > LIMITS.clearance.max) errors.push(`Clearance must be ${LIMITS.clearance.min} to ${LIMITS.clearance.max} mm per side.`);
  validatePart(part, 'A');
  if (twoParts) validatePart(partB, 'B');

  const outline = spanOutline(span);
  const innerW = outline.x - 2 * EDGE_WALL;
  const innerD = outline.y - 2 * EDGE_WALL;

  // ---- holes ----
  const holePts = mountingHoles(span);
  const holes = holePts.map(([x, y]) => ({ x, y, thru: screw.thru, cbDia: screw.cbDia, cbDepth: CB_DEPTH }));
  const keepoutR = screw.cbDia / 2 + wall;
  const lattice = latticeFrame(holePts);

  const specFor = (p) => {
    const pocket = { w: round3(p.x + 2 * clearance), d: round3(p.y + 2 * clearance) };
    return { part: p, floorZ: round3(VISION_Z - p.z), pocket, pitch: { x: round3(pocket.w + wall), y: round3(pocket.d + wall) } };
  };
  const specA = specFor(part);
  const specB = twoParts ? specFor(partB) : null;

  // ---- regions: the whole usable area for one part, or a two-way split with a
  // wall-wide neutral strip between them ----
  const regions = [];
  if (!twoParts) {
    regions.push({ key: 'A', cx: 0, cy: 0, w: innerW, d: innerD, spec: specA });
  } else {
    // Split along X. A top/bottom split was checked and fits fewer pockets:
    // the mounting holes eat both ends of each band.
    const availW = innerW - wall;
    const wA = availW * split, wB = availW * (1 - split);
    regions.push({ key: 'A', cx: -innerW / 2 + wA / 2, cy: 0, w: wA, d: innerD, spec: specA });
    regions.push({ key: 'B', cx: innerW / 2 - wB / 2, cy: 0, w: wB, d: innerD, spec: specB });
  }

  // Largest full rectangle of pockets in the region. OpenPnP needs every
  // cell filled, so the grid stays rectangular. A single part stays centered.
  // Two parts may shift each grid off its region's center to clear the screws.
  function fitGrid(region, caps, centered) {
    const { pocket, pitch } = region.spec;
    let maxCols = Math.floor((region.w + wall) / pitch.x + 1e-9);
    let maxRows = Math.floor((region.d + wall) / pitch.y + 1e-9);
    if (caps && caps.cols != null) maxCols = Math.min(maxCols, caps.cols);
    if (caps && caps.rows != null) maxRows = Math.min(maxRows, caps.rows);
    if (maxCols < 1 || maxRows < 1) return { cols: 0, rows: 0, x0: 0, y0: 0 };
    const xMin = region.cx - region.w / 2 + pocket.w / 2;
    const xMaxE = region.cx + region.w / 2 - pocket.w / 2;
    const yMin = region.cy - region.d / 2 + pocket.d / 2;
    const yMaxE = region.cy + region.d / 2 - pocket.d / 2;
    const clear = (x0, y0, cols, rows) => {
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const cx = x0 + i * pitch.x, cy = y0 + j * pitch.y;
        if (cx < xMin - 1e-6 || cx > xMaxE + 1e-6 || cy < yMin - 1e-6 || cy > yMaxE + 1e-6) return false;
        for (const h of holes) if (rectHitsCircle(cx, cy, pocket.w, pocket.d, h.x, h.y, keepoutR)) return false;
      }
      return true;
    };
    let best = null;
    for (let rows = maxRows; rows >= 1; rows--) {
      if (best && maxCols * rows <= best.cols * best.rows) break;
      const ySpan = (rows - 1) * pitch.y;
      const y0Lo = yMin, y0Hi = yMaxE - ySpan;
      if (y0Hi < y0Lo - 1e-9) continue;
      for (let cols = maxCols; cols >= 1; cols--) {
        if (best && cols * rows <= best.cols * best.rows) break;
        const xSpan = (cols - 1) * pitch.x;
        const x0Lo = xMin, x0Hi = xMaxE - xSpan;
        if (x0Hi < x0Lo - 1e-9) continue;
        const cx0 = region.cx - xSpan / 2, cy0 = region.cy - ySpan / 2;
        if (centered) {
          if (cy0 < y0Lo - 1e-9 || cy0 > y0Hi + 1e-9) continue;
          if (cx0 < x0Lo - 1e-9 || cx0 > x0Hi + 1e-9) continue;
          if (!clear(cx0, cy0, cols, rows)) continue;
          best = { cols, rows, x0: cx0, y0: cy0 };
          break;
        }
        let found = null;
        for (let y0 = y0Lo; y0 <= y0Hi + 1e-6; y0 += 0.5) {
          const yy = Math.min(y0, y0Hi);
          const bad = [];
          for (let j = 0; j < rows; j++) {
            const cy = yy + j * pitch.y;
            for (const h of holes) {
              const dyOut = Math.max(Math.abs(h.y - cy) - pocket.d / 2, 0);
              if (dyOut >= keepoutR) continue;
              const reach = Math.sqrt(keepoutR * keepoutR - dyOut * dyOut);
              bad.push([h.x - pocket.w / 2 - reach - 0.02, h.x + pocket.w / 2 + reach + 0.02]);
            }
          }
          const forbid = [];
          for (const [a, b] of bad) for (let i = 0; i < cols; i++) forbid.push([a - i * pitch.x, b - i * pitch.x]);
          const blocked = mergeIntervals(forbid);
          let cursor = x0Lo;
          const gaps = [];
          for (const [a, b] of blocked) {
            if (b < cursor) continue;
            if (a > cursor) gaps.push([cursor, Math.min(a, x0Hi)]);
            cursor = Math.max(cursor, b);
            if (cursor > x0Hi) break;
          }
          if (cursor <= x0Hi + 1e-9) gaps.push([cursor, x0Hi]);
          for (const [g0, g1] of gaps) {
            if (g1 < g0 - 1e-6) continue;
            const x0 = cx0 < g0 ? g0 : cx0 > g1 ? g1 : cx0;
            if (!clear(x0, yy, cols, rows)) continue;
            const dist = (x0 - cx0) ** 2 + (yy - cy0) ** 2;
            if (!found || dist < found.dist) found = { x0, y0: yy, dist };
          }
        }
        if (!found) continue;
        best = { cols, rows, x0: found.x0, y0: found.y0 };
        break;
      }
    }
    return best || { cols: 0, rows: 0, x0: 0, y0: 0 };
  }

  // ---- pockets ----
  const pockets = [];
  const grids = {};
  if (errors.length === 0) {
    for (const region of regions) {
      const caps = region.key === 'A'
        ? { cols: colsOverride, rows: rowsOverride }
        : { cols: colsBOverride, rows: rowsBOverride };
      const g = fitGrid(region, caps, !twoParts);
      grids[region.key] = g;
      if (g.cols < 1 || g.rows < 1) {
        warnings.push(`Part ${region.key}: no pocket fits in its region. Move the split slider or shrink the part.`);
        continue;
      }
      const x0 = g.x0, y0 = g.y0;
      for (let ri = 0; ri < g.rows; ri++) for (let ci = 0; ci < g.cols; ci++) {
        pockets.push({
          cx: round3(x0 + ci * region.spec.pitch.x), cy: round3(y0 + ri * region.spec.pitch.y),
          w: region.spec.pocket.w, d: region.spec.pocket.d, floorZ: region.spec.floorZ,
          part: region.key, col: ci, row: ri,
        });
      }
    }
    if (pockets.length === 0) errors.push('No pockets fit in the tray. Reduce part size or clearance.');
    // safety net: verify no pocket actually touches a keepout
    for (const p of pockets) {
      if (holes.some(h => rectHitsCircle(p.cx, p.cy, p.w, p.d, h.x, h.y, keepoutR))) {
        errors.push('Internal error: pocket grid overlaps a mounting hole.');
        pockets.length = 0;
        break;
      }
    }
  }

  // Rough solid volume for the status bar (slab minus pockets minus holes).
  // Slab = full outline below the chamfer + the chamfer ring on top. The ring's
  // cross-section area A(t) is quadratic in the inset t, so Simpson over
  // t = 0, T/2, T on exact convex offsets integrates it exactly.
  const outlinePoly = filletPolygon(outlinePolygon(outline, PIN1_CHAMFER), CORNER_FILLET);
  const a0 = shoelace(outlinePoly);
  const a1 = shoelace(offsetPolygon(outlinePoly, TOP_CHAMFER / 2));
  const a2 = shoelace(offsetPolygon(outlinePoly, TOP_CHAMFER));
  const ring = (TOP_CHAMFER / 6) * (a0 + 4 * a1 + a2);
  const slab = a0 * (TRAY_H - TOP_CHAMFER) + ring;
  const pocketVol = pockets.reduce((a, p) => a + p.w * p.d * (TRAY_H - p.floorZ), 0);
  const holeVol = holes.reduce((a, h) => a + Math.PI * (h.thru / 2) ** 2 * (TRAY_H - h.cbDepth) + Math.PI * (h.cbDia / 2) ** 2 * h.cbDepth, 0);

  return {
    ok: errors.length === 0,
    errors, warnings, input,
    outline, trayH: TRAY_H,
    latticeOrigin: { x: lattice.x, y: lattice.y }, latticeParity: lattice.parity,
    floorZ: specA.floorZ, pocket: specA.pocket, pitch: specA.pitch,
    parts: {
      A: { part, floorZ: specA.floorZ, pocket: specA.pocket },
      B: twoParts ? { part: partB, floorZ: specB.floorZ, pocket: specB.pocket } : null,
    },
    twoParts, split,
    grid: grids.A || { cols: 0, rows: 0 },
    gridB: twoParts ? (grids.B || { cols: 0, rows: 0 }) : null,
    pockets, holes, screw, keepoutR,
    chamfer: PIN1_CHAMFER,
    stats: {
      pocketCount: pockets.length,
      pocketCountA: pockets.filter(p => p.part === 'A').length,
      pocketCountB: pockets.filter(p => p.part === 'B').length,
      volumeEstimateCm3: round3((slab - pocketVol - holeVol) / 1000),
    },
  };
}

// ---------- solid construction (manifold-3d) ----------

export function volumeOf(m) {
  if (typeof m.volume === 'function') return m.volume();
  return m.getProperties().volume;
}

function outlinePolygon(outline, chamfer) {
  const hx = outline.x / 2, hy = outline.y / 2;
  // CCW starting bottom-left; chamfer cuts the (-X,+Y) corner.
  return [
    [-hx, -hy], [hx, -hy], [hx, hy],
    [-hx + chamfer, hy], [-hx, hy - chamfer],
  ];
}

// Round every 90-degree corner of a CCW polygon with an arc (the pin-1 chamfer
// ends are 135 degrees and stay sharp).
export function filletPolygon(poly, radius, segments = 16) {
  const n = poly.length, out = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, s) => [a[0] * s, a[1] * s];
  const norm = (a) => mul(a, 1 / (Math.hypot(a[0], a[1]) || 1));
  for (let i = 0; i < n; i++) {
    const p = poly[i], prev = poly[(i - 1 + n) % n], next = poly[(i + 1) % n];
    const d1 = norm(sub(prev, p)), d2 = norm(sub(next, p));
    const theta = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
    if (Math.abs(theta - Math.PI / 2) > 1e-6) { out.push(p); continue; }
    const t = radius / Math.tan(theta / 2);
    const c = add(p, mul(norm(add(d1, d2)), radius / Math.sin(theta / 2)));
    const t1 = add(p, mul(d1, t)), t2 = add(p, mul(d2, t));
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let da = (a2 - a1) % (2 * Math.PI); if (da < 0) da += 2 * Math.PI;
    if (da > Math.PI) da -= 2 * Math.PI;
    out.push(t1);
    for (let s = 1; s < segments; s++) {
      const a = a1 + da * (s / segments);
      out.push([c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]);
    }
    out.push(t2);
  }
  return out;
}

// Inward offset of a convex CCW polygon by d (exact edge-line intersections).
function offsetPolygon(poly, d) {
  const n = poly.length, lines = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const e = [q[0] - p[0], q[1] - p[1]];
    const L = Math.hypot(e[0], e[1]) || 1;
    const nx = -e[1] / L, ny = e[0] / L;   // left normal = inward for CCW
    lines.push([p[0] + nx * d, p[1] + ny * d, e[0] / L, e[1] / L]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1, dx1, dy1] = lines[(i - 1 + n) % n];
    const [x2, y2, dx2, dy2] = lines[i];
    const den = dx1 * dy2 - dy1 * dx2;
    const t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / den;
    out.push([x1 + t * dx1, y1 + t * dy1]);
  }
  return out;
}

const shoelace = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

function rectPolygon(cx, cy, w, d) {
  const hw = w / 2, hd = d / 2;
  return [[cx - hw, cy - hd], [cx + hw, cy - hd], [cx + hw, cy + hd], [cx - hw, cy + hd]];
}

/**
 * @param {object} mod  initialized manifold module (after mod.setup())
 * @param {object} plan output of computePlan(); must have plan.ok === true
 * @returns {{ manifold, mesh: {positions, indices}, triCount: number, volume: number }}
 *   Caller must call result.manifold.delete() when done.
 */
export function buildTray(mod, plan) {
  if (!plan.ok) throw new Error('buildTray called with an invalid plan: ' + plan.errors.join(' '));
  const { Manifold, CrossSection } = mod;
  const H = plan.trayH;
  const temps = [];
  const keep = (m) => (temps.push(m), m);

  // 1. Slab: pin-1 chamfer + filleted corners, with a handling chamfer on the top rim.
  const poly = filletPolygon(outlinePolygon(plan.outline, plan.chamfer), CORNER_FILLET);
  const outlineCS = keep(new CrossSection([poly]));
  const body = keep(Manifold.extrude(outlineCS, H - TOP_CHAMFER));
  const innerCS = keep(new CrossSection([offsetPolygon(poly, TOP_CHAMFER)]));
  const cap = keep(Manifold.extrude(innerCS, TOP_CHAMFER).translate([0, 0, H - TOP_CHAMFER]));
  const slab = keep(Manifold.hull([body, cap]));

  const cutters = [];

  // 2. Pockets: one extruded cross-section per distinct floor depth, each from
  //    its floorZ up through the top (+1).
  const byFloor = new Map();
  for (const p of plan.pockets) {
    if (!byFloor.has(p.floorZ)) byFloor.set(p.floorZ, []);
    byFloor.get(p.floorZ).push(rectPolygon(p.cx, p.cy, p.w, p.d));
  }
  for (const [fz, rects] of byFloor) {
    const pocketCS = keep(new CrossSection(rects));
    cutters.push(keep(Manifold.extrude(pocketCS, H - fz + 1).translate([0, 0, fz])));
  }

  // 3. Holes: through hole (overshoot both ends) + counterbore from the top.
  for (const h of plan.holes) {
    cutters.push(keep(Manifold.cylinder(H + 2, h.thru / 2, h.thru / 2, CYL_SEGMENTS).translate([h.x, h.y, -1])));
    cutters.push(keep(Manifold.cylinder(h.cbDepth + 1, h.cbDia / 2, h.cbDia / 2, CYL_SEGMENTS).translate([h.x, h.y, H - h.cbDepth])));
  }

  const tray = Manifold.difference([slab, ...cutters]);
  for (const t of temps) t.delete();

  const status = tray.status();
  if (status !== 'NoError') { tray.delete(); throw new Error('manifold boolean failed: ' + status); }

  const m = tray.getMesh();
  const rawPos = m.numProp === 3
    ? m.vertProperties
    : stripToXYZ(m.vertProperties, m.numProp);
  // Copy out of WASM heap: the returned arrays must survive later memory growth
  // (a detached view would make downloads throw or emit garbage).
  const positions = new Float32Array(rawPos);
  const indices = new Uint32Array(m.triVerts);
  return {
    manifold: tray,
    mesh: { positions, indices },
    triCount: m.triVerts.length / 3,
    volume: volumeOf(tray),
  };
}

function stripToXYZ(props, numProp) {
  const n = props.length / numProp, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[3*i] = props[i*numProp]; out[3*i+1] = props[i*numProp+1]; out[3*i+2] = props[i*numProp+2]; }
  return out;
}

/** Volume of the intersection of `manifold` with a small cube centred at (x,y,z). Used by tests. */
export function probeVolume(mod, manifold, x, y, z, size = 0.5) {
  const cube = mod.Manifold.cube([size, size, size], true).translate([x, y, z]);
  const inter = mod.Manifold.intersection([manifold, cube]);
  const v = volumeOf(inter);
  cube.delete(); inter.delete();
  return v;
}

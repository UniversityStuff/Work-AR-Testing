// Demo 2: four A4 sheets mark the corners of a table; the model fills the
// whole table. The table size is measured from the markers themselves (or
// typed in), so no tape measure is needed.
import { THREE, ARScene, MarkerTracker, runLoop, homographyRms } from './ar.js';
import { TABLE_CORNERS, CORNER_INSET, DEFAULT_TABLE, tableBoard, boardCorrespondences } from './config.js';
import { ModelStage } from './models.js';
import { createViewer } from './viewer.js';
import { $, bootStartOverlay } from './ui.js';

const STORE_KEY = 'ar-demo-table';
const SAMPLES_NEEDED = 25;

function loadTable() {
  try {
    const t = JSON.parse(localStorage.getItem(STORE_KEY));
    if (t && t.width > 0.3 && t.depth > 0.3) return t;
  } catch {}
  return null;
}
function saveTable(t) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(t)); } catch {}
}

const cornerIds = new Set(TABLE_CORNERS.map((c) => c.id));

// Finds the marker spacing (half-distances hx, hy between marker centers)
// that lets all visible corner markers fit a single plane mapping best.
function fitSpacing(markers, start) {
  const f = ([hx, hy]) => {
    if (hx < 0.05 || hy < 0.05) return Infinity;
    const board = { markerSize: tableBoard(DEFAULT_TABLE).markerSize,
      markers: TABLE_CORNERS.map((c) => ({ id: c.id, x: c.sx * hx, y: c.sy * hy })) };
    const { obj, img } = boardCorrespondences(board, markers);
    return homographyRms(obj, img);
  };
  // Nelder-Mead in 2D.
  let s = [start, [start[0] * 1.15, start[1]], [start[0], start[1] * 1.15]].map((p) => ({ p, v: f(p) }));
  for (let it = 0; it < 120; it++) {
    s.sort((a, b) => a.v - b.v);
    const [best, mid, worst] = s;
    if (Math.abs(worst.v - best.v) < 1e-4 && it > 20) break;
    const c = [(best.p[0] + mid.p[0]) / 2, (best.p[1] + mid.p[1]) / 2];
    const at = (t) => [c[0] + t * (worst.p[0] - c[0]), c[1] + t * (worst.p[1] - c[1])];
    const r = { p: at(-1) }; r.v = f(r.p);
    if (r.v < best.v) {
      const e = { p: at(-2) }; e.v = f(e.p);
      s[2] = e.v < r.v ? e : r;
    } else if (r.v < mid.v) {
      s[2] = r;
    } else {
      const k = { p: at(0.5) }; k.v = f(k.p);
      if (k.v < worst.v) s[2] = k;
      else s = s.map((q, i) => (i === 0 ? q : { p: [(q.p[0] + best.p[0]) / 2, (q.p[1] + best.p[1]) / 2], v: 0 }))
        .map((q) => ({ p: q.p, v: f(q.p) }));
    }
  }
  s.sort((a, b) => a.v - b.v);
  return { hx: s[0].p[0], hy: s[0].p[1], rms: s[0].v };
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const cm = (m) => Math.round(m * 100);

bootStartOverlay(() => {
  const ar = new ARScene({ video: $('#video'), canvas: $('#gl'), debugCanvas: $('#debug') });
  const tracker = new MarkerTracker($('#video'), { maxSide: 1280 }); // corner markers are far away
  const anchor = ar.anchor('table');
  const stage = new ModelStage(anchor);
  createViewer(stage, { defaultModel: 'site' });

  // Outline of the table as currently calibrated.
  const outline = new THREE.LineLoop(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9, depthTest: false }));
  outline.renderOrder = 20;
  anchor.add(outline);

  let table = loadTable() || { ...DEFAULT_TABLE };
  let board = tableBoard(table);
  let outlineUntil = 0;
  function applyTable(t, persist = true) {
    table = t;
    board = tableBoard(t);
    stage.setArea(t.width, t.depth, 0.97);
    const w = t.width / 2, d = t.depth / 2;
    outline.geometry.setFromPoints([[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, y]) => new THREE.Vector3(x, y, 0.002)));
    outlineUntil = performance.now() + 6000;
    if (persist) saveTable(t);
    $('#table-size').textContent = `${cm(t.width)} × ${cm(t.depth)} cm`;
  }
  applyTable(table, false);

  // ---- automatic measuring
  let measuring = null; // { hx: [], hy: [], rms: [] }
  const startMeasuring = () => { measuring = { hx: [], hy: [], rms: [] }; $('#table-sheet').classList.add('hidden'); };
  if (!loadTable()) startMeasuring();

  function measureStep(markers) {
    const seen = markers.filter((m) => cornerIds.has(m.id));
    if (new Set(seen.map((m) => m.id)).size < 3) return;
    const start = [table.width / 2 - CORNER_INSET.x, table.depth / 2 - CORNER_INSET.y];
    const r = fitSpacing(seen, start);
    if (!Number.isFinite(r.rms)) return;
    measuring.hx.push(r.hx);
    measuring.hy.push(r.hy);
    measuring.rms.push(r.rms);
    const n = measuring.hx.length;
    const est = { width: 2 * (median(measuring.hx) + CORNER_INSET.x), depth: 2 * (median(measuring.hy) + CORNER_INSET.y) };
    if (n % 5 === 1) applyTable(est, false); // refitting the model is not free; do it now and then
    if (n >= SAMPLES_NEEDED) {
      const rms = median(measuring.rms);
      measuring = null;
      applyTable(est);
      flash(rms > 4
        ? `⚠️ Measured ${cm(est.width)} × ${cm(est.depth)} cm, but the sheets don't line up well. Check that each sheet is in its labelled corner with the arrow towards you.`
        : `✓ Table measured: ${cm(est.width)} × ${cm(est.depth)} cm`);
    }
  }

  let flashUntil = 0, flashText = '', bannerText = null;
  const flash = (text) => { flashText = text; flashUntil = performance.now() + 5000; };

  // ---- table settings sheet
  $('#table-btn').addEventListener('click', () => {
    $('#table-w').value = cm(table.width);
    $('#table-d').value = cm(table.depth);
    $('#table-sheet').classList.remove('hidden');
  });
  $('#table-close').addEventListener('click', () => $('#table-sheet').classList.add('hidden'));
  $('#table-measure').addEventListener('click', startMeasuring);
  $('#table-save').addEventListener('click', () => {
    const w = parseFloat($('#table-w').value) / 100, d = parseFloat($('#table-d').value) / 100;
    if (w >= 0.5 && d >= 0.5) {
      measuring = null;
      applyTable({ width: w, depth: d });
      $('#table-sheet').classList.add('hidden');
    }
  });

  runLoop({
    tracker,
    ar,
    onMarkers(markers, now) {
      if (measuring) measureStep(markers);
      const { obj, img } = boardCorrespondences(board, markers);
      if (obj.length) ar.updateAnchor('table', obj, img, now);
    },
    onFrame(now) {
      const tracked = ar.isVisible('table');
      const seen = ar.lastMarkers.filter((m) => cornerIds.has(m.id)).length;
      $('#track-chip').classList.toggle('on', tracked);
      $('#track-label').textContent = tracked ? `Tracking · ${seen}/4 corners` : 'Searching';
      outline.visible = !!measuring || now < outlineUntil;

      const banner = $('#banner');
      let text = null;
      if (measuring) {
        text = `📏 Measuring the table: step back until at least 3 corner sheets are in view (${measuring.hx.length}/${SAMPLES_NEEDED})`
          + (measuring.hx.length ? `<br><b>${cm(table.width)} × ${cm(table.depth)} cm</b>` : '');
      } else if (now < flashUntil) {
        text = flashText;
      } else if (!tracked) {
        text = '<span class="big">🗺️</span>Point the camera at the table and its corner sheets';
      }
      banner.classList.toggle('hidden', text == null);
      if (text != null && text !== bannerText) banner.innerHTML = text;
      bannerText = text;
    },
  });

  window.arDebug = { ar, tracker, stage, get table() { return table; }, get measuring() { return measuring; }, startMeasuring };
});

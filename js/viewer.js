// Shared model-viewer UI for both demos: model picker, rotate, BIM layers,
// pan/zoom/turn gestures, loading progress, credits and a "clean view" toggle.
import { MODELS } from './config.js';
import { loadModel, loadTiles } from './models.js';
import { $ } from './ui.js';

// Touch on the camera view moves the model across the paper: one finger drags,
// two fingers pinch to zoom and twist to turn around the point between them.
// The mouse wheel zooms (desktop). Streamed models load finer tiles as you zoom.
function attachGestures(stage, camera, onChange) {
  const canvas = $('#gl');
  const pointers = new Map(); // pointerId -> last CSS position
  const hit = (p) => stage.pointOnArea(p.x, p.y, camera);

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = { x: e.clientX, y: e.clientY };
    const other = [...pointers].find(([id]) => id !== e.pointerId)?.[1];
    const p1 = hit(last), q1 = hit(now);
    if (p1 && q1) {
      if (other) {
        const o = hit(other);
        if (o) stage.moveView(p1, q1, o, o);
      } else {
        stage.moveView(p1, q1);
      }
      onChange();
    }
    pointers.set(e.pointerId, now);
  });
  const end = (e) => pointers.delete(e.pointerId);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = hit({ x: e.clientX, y: e.clientY });
    if (!p) return;
    stage.zoomView(p, Math.exp(-e.deltaY * 0.002));
    onChange();
  }, { passive: false });
}

export function createViewer(stage, { defaultModel, camera }) {
  let loadToken = 0;
  let current = null;

  const chips = $('#model-chips');
  chips.innerHTML = MODELS.map((m) => `<button class="pill" data-model="${m.id}">${m.name}<small>${m.kind}</small></button>`).join('')
    + '<label class="pill file">Open .glb…<small>your own model</small><input type="file" id="file-input" accept=".glb,.gltf" hidden></label>';
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (b) show(MODELS.find((m) => m.id === b.dataset.model));
  });
  $('#file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) show({ id: 'file', name: file.name, kind: 'Your file', up: 'auto', credit: 'Loaded from this device', url: URL.createObjectURL(file) });
  });

  $('#rotate-btn').addEventListener('click', () => stage.rotate());
  const updateReset = () => { $('#reset-btn').hidden = !stage.viewChanged; };
  $('#reset-btn').addEventListener('click', () => { stage.resetView(); updateReset(); });
  attachGestures(stage, camera, updateReset);
  $('#layers-btn').addEventListener('click', () => { $('#layers').hidden = !$('#layers').hidden; });
  $('#hide-btn').addEventListener('click', () => document.body.classList.toggle('clean'));
  $('#layers').addEventListener('change', (e) => {
    if (e.target.matches('input[data-layer]')) stage.setLayerVisible(e.target.dataset.layer, e.target.checked);
  });

  function setLoading(text, fraction) {
    $('#loading').hidden = text == null;
    $('#loading-text').textContent = text ?? '';
    $('#loading-bar').style.width = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : '100%';
    $('#loading-bar').classList.toggle('indeterminate', !Number.isFinite(fraction));
  }

  async function show(def) {
    const token = ++loadToken;
    current = def;
    for (const b of chips.querySelectorAll('[data-model]')) b.classList.toggle('active', b.dataset.model === def.id);
    $('#model-name').textContent = def.name;
    $('#model-kind').textContent = def.kind;
    $('#model-credit').textContent = def.credit;
    setLoading(`Loading ${def.name}${def.note ? ` (${def.note})` : ''}…`, NaN);
    try {
      const model = def.tiles ? await loadTiles(def) : (await loadModel(def, (f, bytes) => {
        if (token === loadToken) setLoading(`Loading ${def.name}… ${(bytes / 1e6).toFixed(1)} MB`, f);
      })).scene;
      if (token !== loadToken) return model.userData.tiles?.dispose();
      stage.setModel(model, def);
      updateReset();
      const layers = stage.layers();
      $('#layers-btn').hidden = layers.length < 2;
      $('#layers').hidden = true;
      $('#layers').innerHTML = layers.map((l) =>
        `<label class="pill"><input type="checkbox" data-layer="${l}" checked> ${l.replace(/-/g, ' ')}</label>`).join('');
      if (def.tiles) {
        // Tiles stream in once the markers are in view.
        setLoading(`Streaming ${def.name}…`, NaN);
        model.userData.ready.then(() => token === loadToken && setLoading(null));
      } else {
        setLoading(null);
      }
    } catch (e) {
      if (token !== loadToken) return;
      setLoading(null);
      window.showDiagnostic?.(`Could not load "${def.name}": ${e.message || e}.`
        + (def.missing ? ` ${def.missing}` : ''));
    }
  }

  // ?tiles=<url of tileset.json> streams any tileset, e.g. one in cloud storage.
  const tilesUrl = new URLSearchParams(location.search).get('tiles');
  if (tilesUrl) show({ id: 'url', name: 'Tileset', kind: '3D Tiles (streamed)', credit: tilesUrl, tiles: tilesUrl });
  else show(MODELS.find((m) => m.id === defaultModel) || MODELS[0]);
  return { get current() { return current; } };
}

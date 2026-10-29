// Loads glTF/GLB models (BIM conversions or drone scans) or streams 3D Tiles
// tilesets, and fits them onto a rectangular area of a tracked anchor (an A4
// sheet or a table).
import { THREE } from './ar.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';
import { estimateBytesUsed } from '../vendor/three/addons/utils/BufferGeometryUtils.js';
import { TilesRenderer } from '../vendor/3d-tiles-renderer/src/three/TilesRenderer.js';
import { GLTFExtensionsPlugin } from '../vendor/3d-tiles-renderer/src/plugins/three/GLTFExtensionsPlugin.js';
import { ReorientationPlugin } from '../vendor/3d-tiles-renderer/src/plugins/three/ReorientationPlugin.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(new URL('../vendor/three/addons/libs/draco/', import.meta.url).href);
loader.setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);

function loadUrl(url, onProgress) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, (e) => onProgress?.(e.total ? e.loaded / e.total : NaN, e.loaded), reject);
  });
}

// Tries def.url, then def.fallbackUrl.
export async function loadModel(def, onProgress) {
  const urls = [def.url, def.fallbackUrl].filter(Boolean);
  let lastError;
  for (const url of urls) {
    try {
      return await loadUrl(url, onProgress);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('No model URL');
}

const MB = 1e6;

// GPU memory of a loaded tile. The tile renderer measures this with
// THREE.TextureUtils, which three r160 doesn't have, so it would count every
// tile as 0 bytes and never enforce its memory budget.
function sceneBytes(scene) {
  let bytes = 0;
  const seen = new Set();
  scene.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      bytes += estimateBytesUsed(o.geometry);
    }
    for (const m of [o.material].flat()) {
      const img = m?.map?.image;
      if (img && !seen.has(img)) {
        seen.add(img);
        bytes += (img.width * img.height * 4 * 4) / 3; // RGBA plus mipmaps
      }
    }
  });
  return bytes;
}

// Streams a 3D Tiles tileset (def.tiles = URL of tileset.json): the phone only
// downloads the tiles in view, at the detail the current distance needs. Returns
// the tiles' group; ModelStage keeps the tile renderer updated every frame.
export async function loadTiles(def) {
  // Fail early with a clear message instead of a console error per frame.
  const res = await fetch(def.tiles);
  if (!res.ok) throw new Error(`${def.tiles} returned HTTP ${res.status}`);
  await res.json();

  const tiles = new TilesRenderer(new URL(def.tiles, location.href).href);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco, meshoptDecoder: MeshoptDecoder }));
  // Moves georeferenced (ECEF) tilesets to the origin. Either way the result is Y up, like glTF.
  tiles.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }));
  // Stay well inside a phone's GPU memory; least recently used tiles are dropped first.
  tiles.lruCache.minBytesSize = 150 * MB;
  tiles.lruCache.maxBytesSize = 250 * MB;
  tiles.addEventListener('load-model', ({ scene, tile }) => {
    prepareMaterials(scene);
    tile.cached.bytesUsed = sceneBytes(scene);
  });
  tiles.group.userData.tiles = tiles;
  tiles.group.userData.ready = new Promise((resolve) => {
    const done = () => { tiles.removeEventListener('load-model', done); resolve(); };
    tiles.addEventListener('load-model', done);
  });
  return tiles.group;
}

// Transform from obj's frame into the frame of `frame` (an ancestor, or null),
// built from local matrices only, so it doesn't depend on the tracked pose.
function matrixTo(obj, frame) {
  const m = new THREE.Matrix4();
  for (let o = obj; o && o !== frame; o = o.parent) {
    o.updateMatrix();
    m.premultiply(o.matrix);
  }
  return m;
}

// Up to n vertex positions of everything under root, in root's parent frame.
function samplePoints(root, n = 30000) {
  const meshes = [];
  let total = 0;
  root.traverse((o) => {
    if (o.isMesh && o.visible && o.geometry.attributes.position) {
      meshes.push(o);
      total += o.geometry.attributes.position.count;
    }
  });
  const step = Math.max(1, Math.floor(total / n));
  const pts = [], v = new THREE.Vector3();
  for (const mesh of meshes) {
    const m = matrixTo(mesh, root.parent);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += step) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).toArray());
  }
  return pts;
}

// Percentile-based bounds, so stray scan fragments don't shrink the model.
function robustBounds(pts, lo = 0.005, hi = 0.995) {
  const out = { min: [], max: [] };
  for (let k = 0; k < 3; k++) {
    const a = pts.map((p) => p[k]).sort((x, y) => x - y);
    out.min[k] = a[Math.floor(lo * (a.length - 1))];
    out.max[k] = a[Math.ceil(hi * (a.length - 1))];
  }
  return out;
}

// Rotation that turns the model's up direction into +z (out of the paper).
function upRotation(model, mode) {
  if (mode !== 'auto') return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  // Scans of buildings are wider than tall, and most of their surface is near the ground.
  const pts = samplePoints(model, 20000);
  const b = robustBounds(pts);
  const ext = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  const k = ext.indexOf(Math.min(...ext));
  const vals = pts.map((p) => p[k]).sort((x, y) => x - y);
  const median = vals[vals.length >> 1];
  const sign = median - b.min[k] < b.max[k] - median ? 1 : -1;
  const up = new THREE.Vector3().setComponent(k, sign);
  return new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 0, 1));
}

// Scans often ship 8K textures; phones run out of GPU memory on those.
const MAX_TEXTURE = 4096;
function limitTexture(tex) {
  const img = tex.image;
  const w = img?.width, h = img?.height;
  if (!w || Math.max(w, h) <= MAX_TEXTURE) return;
  const k = MAX_TEXTURE / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  tex.image = c;
  tex.needsUpdate = true;
}

// Photogrammetry textures already contain the lighting; render them unlit.
function prepareMaterials(model) {
  model.traverse((o) => {
    // Point clouds (LiDAR tiles): three sizes points in scene metres, ignoring the
    // model's fit scale, so a 1 "m" point would cover the sheet. Use pixels instead.
    if (o.isPoints) {
      o.material.sizeAttenuation = false;
      o.material.size = 1.5; // CSS px; three multiplies by the renderer's pixel ratio
      return;
    }
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => {
      if (m.map) limitTexture(m.map);
      // Already unlit materials (e.g. tiles) are kept: the tile renderer disposes the ones it made.
      if (m.map && !m.isMeshBasicMaterial) {
        return new THREE.MeshBasicMaterial({ map: m.map, side: THREE.DoubleSide, transparent: m.transparent, opacity: m.opacity });
      }
      m.side = THREE.DoubleSide;
      return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
}

// Bounds of the root bounding volume of a tileset, in the frame of `frame`. The
// full mesh of a tileset is never loaded, so this is what it is fitted to.
function tilesBounds(tiles, frame) {
  const box = new THREE.Box3(), m = new THREE.Matrix4();
  if (!tiles.getOrientedBoundingBox(box, m)) return null;
  m.premultiply(matrixTo(tiles.group, frame));
  const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(m);
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], v.getComponent(k));
      out.max[k] = Math.max(out.max[k], v.getComponent(k));
    }
  }
  return out;
}

// Zoom range of the user's view, relative to the model fitted to the area.
const MIN_ZOOM = 0.25, MAX_ZOOM = 2000;

// anchor -> stage (area center) -> view (user pan/zoom/turn) -> yaw (90° steps)
//   -> fit (scale/offset) -> up -> model
export class ModelStage {
  constructor(anchor) {
    this.stage = new THREE.Group();
    this.view = new THREE.Group();
    this.yaw = new THREE.Group();
    this.fit = new THREE.Group();
    this.up = new THREE.Group();
    anchor.add(this.stage);
    this.stage.add(this.view);
    this.view.add(this.yaw);
    this.yaw.add(this.fit);
    this.fit.add(this.up);
    this.area = { width: 0.2, depth: 0.2, margin: 0.95 };
    this.model = null;
    this.turns = 0;
  }

  setModel(model, def = {}) {
    if (this.model) this.up.remove(this.model);
    this.tiles?.dispose();
    this.model = model;
    this.tiles = model.userData.tiles || null;
    if (this.tiles) {
      this.hookTiles();
      // The root bounding volume is known once tileset.json is in.
      this.tiles.addEventListener('load-tile-set', () => this.refit());
      this.up.quaternion.copy(upRotation(model)); // the tile renderer's output is Y up
    } else {
      prepareMaterials(model);
      this.robust = def.up === 'auto';
      this.up.quaternion.copy(upRotation(model, def.up));
    }
    this.up.add(model);
    this.resetView();
    this.refit();
  }

  // Where a screen point (CSS px) hits the area's plane, in the stage frame
  // (x/y on the paper), or null if the area isn't tracked or the ray misses it.
  pointOnArea(clientX, clientY, camera) {
    for (let o = this.stage; o; o = o.parent) if (!o.visible) return null;
    this.stage.updateWorldMatrix(true, false);
    const ndc = new THREE.Vector3((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2, 0.5);
    const inv = this.stage.matrixWorld.clone().invert();
    const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    const dir = ndc.applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld).applyMatrix4(inv).sub(origin);
    const t = -origin.z / dir.z;
    if (!(t > 0) || !Number.isFinite(t)) return null;
    return new THREE.Vector2(origin.x + t * dir.x, origin.y + t * dir.y);
  }

  // Moves the view so the paper points p1/p2 end up at q1/q2: one pair pans,
  // two pairs also zoom and turn around them (pinch).
  moveView(p1, q1, p2 = null, q2 = null) {
    const v = this.view;
    let s = 1, a = 0;
    const pm = p1.clone(), qm = q1.clone();
    if (p2 && q2) {
      const dp = p2.clone().sub(p1), dq = q2.clone().sub(q1);
      if (dp.length() < 1e-4) return;
      s = THREE.MathUtils.clamp(dq.length() / dp.length(), MIN_ZOOM / v.scale.x, MAX_ZOOM / v.scale.x);
      a = Math.atan2(dq.y, dq.x) - Math.atan2(dp.y, dp.x);
      pm.add(p2).multiplyScalar(0.5);
      qm.add(q2).multiplyScalar(0.5);
    }
    const d = new THREE.Vector2(v.position.x, v.position.y).sub(pm).rotateAround(new THREE.Vector2(), a).multiplyScalar(s).add(qm);
    v.position.set(d.x, d.y, 0);
    v.rotation.z += a;
    v.scale.multiplyScalar(s);
  }

  // Zooms by factor k around paper point p (mouse wheel).
  zoomView(p, k) {
    const e = new THREE.Vector2(0.01, 0);
    this.moveView(p, p, p.clone().add(e), p.clone().add(e.multiplyScalar(k)));
  }

  resetView() {
    this.view.position.set(0, 0, 0);
    this.view.rotation.set(0, 0, 0);
    this.view.scale.setScalar(1);
  }

  get viewChanged() {
    const v = this.view;
    return v.position.lengthSq() > 1e-8 || Math.abs(v.rotation.z) > 1e-4 || Math.abs(v.scale.x - 1) > 1e-4;
  }

  // The tile renderer picks tiles for the camera that draws them, so update it
  // right before each frame is drawn, when the anchor pose is final.
  hookTiles() {
    if (this.hooked) return;
    this.hooked = true;
    let scene = this.stage;
    while (scene.parent) scene = scene.parent;
    const size = new THREE.Vector2(), prev = scene.onBeforeRender;
    scene.onBeforeRender = (renderer, s, camera, ...rest) => {
      prev.call(scene, renderer, s, camera, ...rest);
      const { tiles } = this;
      if (!tiles) return;
      // Download nothing for a pose that isn't shown (the root tileset.json loads regardless).
      let shown = true;
      for (let o = this.stage; o; o = o.parent) shown &&= o.visible;
      if (!shown && tiles.root) return;
      tiles.setCamera(camera);
      // CSS pixels, so the detail doesn't depend on the screen's pixel density.
      renderer.getSize(size);
      tiles.setResolution(camera, size.x, size.y);
      tiles.update();
    };
    // Shown in the debug overlay (see ARScene._drawDebug).
    (scene.userData.debugLines ||= []).push(() => {
      const { tiles } = this;
      if (!tiles) return null;
      let depth = 0;
      for (const t of tiles.visibleTiles) depth = Math.max(depth, t.__depth);
      const { visible, downloading, parsing, failed } = tiles.stats;
      return `tiles: ${visible} shown, depth ${depth} · ${downloading + parsing} loading`
        + `${failed ? `, ${failed} failed` : ''} · ${(tiles.lruCache.cachedBytes / MB).toFixed(0)} MB cached`;
    });
  }

  setArea(width, depth, margin = this.area.margin) {
    this.area = { width, depth, margin };
    this.refit();
  }

  rotate() {
    this.turns = (this.turns + 1) % 4;
    this.refit();
  }

  // Layer names come from node names "<discipline>|<IfcClass>" written by tools/ifc2glb.py.
  layers() {
    const names = new Set();
    this.model?.traverse((o) => o.isMesh && o.name.includes('|') && names.add(o.name.split('|')[0]));
    return [...names];
  }

  setLayerVisible(layer, visible) {
    this.model?.traverse((o) => o.isMesh && o.name.split('|')[0] === layer && (o.visible = visible));
  }

  refit() {
    if (!this.model) return;
    this.yaw.rotation.z = this.turns * Math.PI / 2;
    this.fit.scale.setScalar(1);
    this.fit.position.set(0, 0, 0);
    const b = this.tiles ? tilesBounds(this.tiles, this.fit)
      : this.robust ? robustBounds(samplePoints(this.up)) : robustBounds(samplePoints(this.up), 0, 1);
    if (!b) return;
    // samplePoints gives coordinates in fit's frame; the footprint is turned by yaw.
    const odd = this.turns % 2 === 1;
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1];
    const fw = odd ? sy : sx, fd = odd ? sx : sy;
    const { width, depth, margin } = this.area;
    const s = Math.min((width * margin) / fw, (depth * margin) / fd);
    this.fit.scale.setScalar(s);
    this.fit.position.set(-s * (b.min[0] + b.max[0]) / 2, -s * (b.min[1] + b.max[1]) / 2, -s * b.min[2]);
    this.scale = s;
  }
}

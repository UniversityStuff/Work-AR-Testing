// Loads glTF/GLB models (BIM conversions or drone scans) and fits them onto a
// rectangular area of a tracked anchor (an A4 sheet or a table).
import { THREE } from './ar.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from '../vendor/three/addons/libs/meshopt_decoder.module.js';

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

// Up to n vertex positions of everything under root, in root's parent frame.
function samplePoints(root, n = 30000) {
  root.updateWorldMatrix(true, true);
  const toParent = root.parent ? new THREE.Matrix4().copy(root.parent.matrixWorld).invert() : new THREE.Matrix4();
  const meshes = [];
  let total = 0;
  root.traverse((o) => {
    if (o.isMesh && o.visible && o.geometry.attributes.position) {
      meshes.push(o);
      total += o.geometry.attributes.position.count;
    }
  });
  const step = Math.max(1, Math.floor(total / n));
  const pts = [], v = new THREE.Vector3(), m = new THREE.Matrix4();
  for (const mesh of meshes) {
    m.multiplyMatrices(toParent, mesh.matrixWorld);
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

// Photogrammetry textures already contain the lighting; render them unlit.
function prepareMaterials(model) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const out = mats.map((m) => {
      if (m.map) return new THREE.MeshBasicMaterial({ map: m.map, side: THREE.DoubleSide, transparent: m.transparent, opacity: m.opacity });
      m.side = THREE.DoubleSide;
      return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
}

// anchor -> stage (area center) -> yaw (90° steps) -> fit (scale/offset) -> up -> model
export class ModelStage {
  constructor(anchor) {
    this.stage = new THREE.Group();
    this.yaw = new THREE.Group();
    this.fit = new THREE.Group();
    this.up = new THREE.Group();
    anchor.add(this.stage);
    this.stage.add(this.yaw);
    this.yaw.add(this.fit);
    this.fit.add(this.up);
    this.area = { width: 0.2, depth: 0.2, margin: 0.95 };
    this.model = null;
    this.turns = 0;
  }

  setModel(model, def = {}) {
    if (this.model) this.up.remove(this.model);
    this.model = model;
    prepareMaterials(model);
    this.robust = def.up === 'auto';
    this.up.quaternion.copy(upRotation(model, def.up));
    this.up.add(model);
    this.refit();
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
    const b = this.robust ? robustBounds(samplePoints(this.up)) : robustBounds(samplePoints(this.up), 0, 1);
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

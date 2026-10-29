// Minimal marker-based AR runtime for phone browsers:
// camera -> ArUco detection (worker) -> planar pose -> three.js overlay.
import * as THREE from '../vendor/three/three.module.min.js';
import { DICTIONARY, MAX_HAMMING } from './config.js';

export { THREE };

const params = new URLSearchParams(location.search);
export const DEBUG = params.has('debug');

// ---------------------------------------------------------------- camera

export async function startCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('The camera needs a secure page. Open the demo via https:// (or http://localhost).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const track = stream.getVideoTracks()[0];
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  return stream;
}

// Keeps the screen on and goes fullscreen; both are best effort.
export async function enterPresentationMode() {
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch {}
  const lock = async () => { try { await navigator.wakeLock?.request('screen'); } catch {} };
  lock();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && lock());
}

// ---------------------------------------------------------------- detection

export class MarkerTracker {
  constructor(video, { maxSide = 960 } = {}) {
    this.video = video;
    this.maxSide = maxSide;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.worker = new Worker(new URL('./detector-worker.js', import.meta.url));
    this.busy = false;
    this.detectMs = 0;
    this.listeners = [];
    this.worker.onmessage = (e) => {
      this.busy = false;
      this.detectMs = e.data.ms;
      for (const fn of this.listeners) fn(e.data.markers, performance.now());
    };
  }

  onDetect(fn) { this.listeners.push(fn); }

  // Call once per animation frame; skips frames while the worker is busy.
  tick() {
    const { video } = this;
    if (this.busy || !video.videoWidth) return;
    const s = Math.min(1, this.maxSide / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    this.busy = true;
    this.worker.postMessage(
      { width: w, height: h, data: img.data.buffer, scale: s, dictionary: DICTIONARY, maxHamming: MAX_HAMMING },
      [img.data.buffer],
    );
  }
}

// ---------------------------------------------------------------- pose

// Solves A x = b for a small dense system (Gaussian elimination, partial pivoting).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function normalizer(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return { mx, my, s };
}

// Homography (3x3, row-major) mapping plane points (x, y) to image points.
function homography(obj, img) {
  const no = normalizer(obj), ni = normalizer(img);
  const A = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  for (let i = 0; i < obj.length; i++) {
    const X = (obj[i].x - no.mx) * no.s, Y = (obj[i].y - no.my) * no.s;
    const u = (img[i].x - ni.mx) * ni.s, v = (img[i].y - ni.my) * ni.s;
    const rows = [
      [[X, Y, 1, 0, 0, 0, -u * X, -u * Y], u],
      [[0, 0, 0, X, Y, 1, -v * X, -v * Y], v],
    ];
    for (const [r, rhs] of rows) {
      for (let j = 0; j < 8; j++) {
        b[j] += r[j] * rhs;
        for (let k = 0; k < 8; k++) A[j][k] += r[j] * r[k];
      }
    }
  }
  const h = solve(A, b);
  if (!h) return null;
  const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  // H = Ti^-1 * Hn * To
  const To = [[no.s, 0, -no.s * no.mx], [0, no.s, -no.s * no.my], [0, 0, 1]];
  const TiInv = [[1 / ni.s, 0, ni.mx], [0, 1 / ni.s, ni.my], [0, 0, 1]];
  return mul3(mul3(TiInv, Hn), To);
}

function mul3(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i][j] += a[i][k] * b[k][j];
  return r;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Rodrigues: rotation matrix (rows) from axis-angle vector w.
function rodrigues(w) {
  const th = norm(w);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = scale(w, 1 / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

function project(R, t, K, p) {
  const x = R[0][0] * p.x + R[0][1] * p.y + t[0];
  const y = R[1][0] * p.x + R[1][1] * p.y + t[1];
  const z = R[2][0] * p.x + R[2][1] * p.y + t[2];
  return { x: K.f * x / z + K.cx, y: K.f * y / z + K.cy };
}

function residuals(R, t, K, obj, img) {
  const r = [];
  for (let i = 0; i < obj.length; i++) {
    const p = project(R, t, K, obj[i]);
    r.push(p.x - img[i].x, p.y - img[i].y);
  }
  return r;
}

// Gauss-Newton / Levenberg refinement of the reprojection error.
function refine(R, t, K, obj, img, iterations = 6) {
  let r0 = residuals(R, t, K, obj, img);
  let e0 = r0.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const J = [];
    const steps = [1e-5, 1e-5, 1e-5, 1e-5, 1e-5, 1e-5];
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0];
      d[k] = steps[k];
      const Rk = mul3(rodrigues(d.slice(0, 3)), R);
      const tk = add(t, d.slice(3));
      const rk = residuals(Rk, tk, K, obj, img);
      J.push(rk.map((v, i) => (v - r0[i]) / steps[k]));
    }
    const A = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => {
      let s = 0;
      for (let n = 0; n < r0.length; n++) s += J[i][n] * J[j][n];
      return s;
    }));
    const g = Array.from({ length: 6 }, (_, i) => {
      let s = 0;
      for (let n = 0; n < r0.length; n++) s -= J[i][n] * r0[n];
      return s;
    });
    for (let i = 0; i < 6; i++) A[i][i] *= 1 + lambda;
    const d = solve(A, g);
    if (!d) break;
    const R1 = mul3(rodrigues(d.slice(0, 3)), R), t1 = add(t, d.slice(3));
    const r1 = residuals(R1, t1, K, obj, img);
    const e1 = r1.reduce((s, v) => s + v * v, 0);
    if (e1 < e0) {
      R = R1; t = t1; r0 = r1;
      const done = e0 - e1 < 1e-6 * e0;
      e0 = e1;
      lambda *= 0.3;
      if (done) break;
    } else {
      lambda *= 10;
    }
  }
  return { R, t, error: Math.sqrt(e0 / obj.length) };
}

// Pose of a plane (z = 0) from >= 4 point correspondences.
// Returns rotation R (rows, OpenCV camera frame: x right, y down, z forward) and t.
export function solvePlanarPose(obj, img, K) {
  const H = homography(obj, img);
  if (!H) return null;
  // M = K^-1 H
  const M = H.map((row, i) => row.slice());
  for (let j = 0; j < 3; j++) {
    M[0][j] = (H[0][j] - K.cx * H[2][j]) / K.f;
    M[1][j] = (H[1][j] - K.cy * H[2][j]) / K.f;
  }
  const h1 = [M[0][0], M[1][0], M[2][0]], h2 = [M[0][1], M[1][1], M[2][1]], h3 = [M[0][2], M[1][2], M[2][2]];
  let l = 1 / Math.sqrt(norm(h1) * norm(h2));
  if (h3[2] * l < 0) l = -l;
  // Closest pair of orthonormal axes to the (noisy) homography columns.
  const a = scale(h1, 1 / norm(h1)), b = scale(h2, 1 / norm(h2));
  const c = add(a, b), d = sub(a, b);
  const cn = scale(c, 1 / norm(c)), dn = scale(d, 1 / norm(d));
  const r1 = scale(add(cn, dn), Math.SQRT1_2), r2 = scale(sub(cn, dn), Math.SQRT1_2);
  const r3 = cross(r1, r2);
  const R = [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]];
  const t = scale(h3, l);
  if (t[2] <= 0) return null;
  return refine(R, t, K, obj, img);
}

// ---------------------------------------------------------------- rendering

const FLIP = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);

class Anchor {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    scene.add(this.group);
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.targetPos = new THREE.Vector3();
    this.targetQuat = new THREE.Quaternion();
    this.lastSeen = -Infinity;
    this.tracked = false;
  }
}

export class ARScene {
  constructor({ video, canvas, debugCanvas = null, holdMs = 500 }) {
    this.video = video;
    this.canvas = canvas;
    this.debugCanvas = debugCanvas;
    this.holdMs = holdMs;
    const fParam = parseFloat(params.get('f'));
    // Focal length as a fraction of the longer image side (~ typical phone main camera).
    this.focalFactor = Number.isFinite(fParam) ? fParam : 0.75;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(0.3, 1, 0.6);
    this.scene.add(sun);

    this.anchors = new Map();
    this.lastMarkers = [];
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  get K() {
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    return { f: this.focalFactor * Math.max(vw, vh), cx: vw / 2, cy: vh / 2 };
  }

  // Mapping from video pixels to CSS pixels for <video style="object-fit: cover">.
  get view() {
    const W = innerWidth, H = innerHeight;
    const vw = this.video.videoWidth || W, vh = this.video.videoHeight || H;
    const s = Math.max(W / vw, H / vh);
    return { W, H, s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
  }

  resize() {
    const { W, H } = this.view;
    this.renderer.setSize(W, H, false);
    if (this.debugCanvas) {
      this.debugCanvas.width = W * devicePixelRatio;
      this.debugCanvas.height = H * devicePixelRatio;
    }
    this._projKey = '';
  }

  _updateProjection() {
    const key = `${innerWidth}x${innerHeight}:${this.video.videoWidth}x${this.video.videoHeight}`;
    if (key === this._projKey) return;
    this._projKey = key;
    this.resize();
    this._projKey = key;
    const K = this.K, { W, H, s, ox, oy } = this.view;
    const fx = K.f * s, cx = K.cx * s + ox, cy = K.cy * s + oy;
    const near = 0.01, far = 100;
    this.camera.projectionMatrix.set(
      2 * fx / W, 0, 1 - 2 * cx / W, 0,
      0, 2 * fx / H, 2 * cy / H - 1, 0,
      0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
      0, 0, -1, 0,
    );
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  anchor(name) {
    if (!this.anchors.has(name)) this.anchors.set(name, new Anchor(this.scene));
    return this.anchors.get(name).group;
  }

  isVisible(name) { return !!this.anchors.get(name)?.tracked; }

  // obj: plane points in the anchor's frame (meters); img: matching video pixels.
  updateAnchor(name, obj, img, now) {
    const pose = solvePlanarPose(obj, img, this.K);
    if (!pose || pose.error > 12) return false;
    const a = this.anchors.get(name) || (this.anchor(name), this.anchors.get(name));
    const { R, t } = pose;
    this._m.set(
      R[0][0], R[0][1], R[0][2], t[0],
      R[1][0], R[1][1], R[1][2], t[1],
      R[2][0], R[2][1], R[2][2], t[2],
      0, 0, 0, 1,
    ).premultiply(FLIP);
    this._m.decompose(a.targetPos, a.targetQuat, this._s);
    if (!a.tracked) {
      a.pos.copy(a.targetPos);
      a.quat.copy(a.targetQuat);
    }
    a.lastSeen = now;
    return true;
  }

  render(now, dt) {
    this._updateProjection();
    const k = 1 - Math.exp(-dt / 0.045); // light smoothing against corner jitter
    for (const a of this.anchors.values()) {
      a.tracked = now - a.lastSeen < this.holdMs;
      a.group.visible = a.tracked;
      if (!a.tracked) continue;
      // Snap on large jumps (fast motion) instead of sliding across the screen.
      if (a.pos.distanceTo(a.targetPos) > 0.25 * a.targetPos.length()) {
        a.pos.copy(a.targetPos);
        a.quat.copy(a.targetQuat);
      } else {
        a.pos.lerp(a.targetPos, k);
        a.quat.slerp(a.targetQuat, k);
      }
      a.group.matrix.compose(a.pos, a.quat, this._s.set(1, 1, 1));
      a.group.matrixWorldNeedsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
    if (this.debugCanvas) this._drawDebug();
  }

  _drawDebug() {
    const ctx = this.debugCanvas.getContext('2d');
    const { s, ox, oy } = this.view, dpr = devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineWidth = 2;
    ctx.font = 'bold 14px system-ui';
    for (const m of this.lastMarkers) {
      const pts = m.corners.map((c) => [c.x * s + ox, c.y * s + oy]);
      ctx.strokeStyle = '#00ff88';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#ff2d55';
      ctx.fillRect(pts[0][0] - 4, pts[0][1] - 4, 8, 8);
      ctx.fillStyle = '#00ff88';
      ctx.fillText(`#${m.id}`, pts[0][0] + 6, pts[0][1] - 6);
    }
  }
}

// Runs the camera/detection/render loop. onMarkers(markers, now) feeds anchors;
// onFrame(now, dt) animates content.
export function runLoop({ tracker, ar, onMarkers, onFrame }) {
  tracker.onDetect((markers, now) => {
    ar.lastMarkers = markers;
    onMarkers(markers, now);
  });
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tracker.tick();
    onFrame?.(now, dt);
    ar.render(now, dt * 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- content helpers

// A camera-facing label drawn on a canvas. draw(ctx, w, h) paints it.
export function makeLabel(widthPx, heightPx, worldHeight, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  sprite.scale.set(worldHeight * widthPx / heightPx, worldHeight, 1);
  sprite.redraw = (fn = draw) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, widthPx, heightPx);
    fn(ctx, widthPx, heightPx);
    texture.needsUpdate = true;
  };
  sprite.redraw(draw);
  return sprite;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Standard callout card: title + lines, accent bar on the left.
export function drawCard(ctx, w, h, { title, lines = [], accent = '#38bdf8', bg = 'rgba(15,23,42,0.88)' }) {
  roundRect(ctx, 4, 4, w - 8, h - 8, 28);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.fillStyle = accent;
  roundRect(ctx, 4, 4, 18, h - 8, [28, 0, 0, 28]);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(h * 0.2)}px system-ui, sans-serif`;
  ctx.fillText(title, 44, h * 0.12, w - 70);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `500 ${Math.round(h * 0.14)}px system-ui, sans-serif`;
  lines.forEach((l, i) => ctx.fillText(l, 44, h * (0.42 + i * 0.2), w - 70));
}

// Line from a part to its callout (both in the same anchor's frame).
export function leaderLine(color = 0xffffff) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  line.renderOrder = 9;
  line.setEnds = (a, b) => {
    const p = geo.attributes.position;
    p.setXYZ(0, a.x, a.y, a.z);
    p.setXYZ(1, b.x, b.y, b.z);
    p.needsUpdate = true;
    geo.computeBoundingSphere();
  };
  return line;
}

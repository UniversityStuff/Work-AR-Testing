// Demo 1: a single A4 sheet becomes a workstation with a virtual machine on it.
// The user is guided through a 4-step filter change while we measure what
// holding the phone costs (taps, lost tracking, no free hand).
import { THREE, ARScene, MarkerTracker, runLoop, makeLabel, drawCard, leaderLine } from './ar.js';
import { BOARD, markerCorners } from './config.js';
import { $, bootStartOverlay, formatTime, metric } from './ui.js';

const STEPS = [
  { title: 'Unscrew the 4 cover screws', detail: 'Torx T20, counter-clockwise. Put the screws in the tray on the left.',
    label: { title: 'Unscrew 4×', lines: ['Torx T20', 'counter-clockwise'], accent: '#f59e0b' } },
  { title: 'Lift off the cover', detail: 'Lift it straight up and put it down with the gasket facing up.',
    label: { title: 'Lift cover', lines: ['straight up', 'gasket side up'], accent: '#38bdf8' } },
  { title: 'Swap the filter cartridge', detail: 'Pull the old FX-200 out, insert the new one (part no. 3B-117) until it clicks.',
    label: { title: 'Replace filter', lines: ['FX-200 · 3B-117', 'old one = special waste'], accent: '#ef4444' } },
  { title: 'Close and check', detail: 'Refit the cover and tighten the screws to 2 Nm. The status LED must turn green.',
    label: { title: 'Close & check', lines: ['screws: 2 Nm', 'LED must turn green'], accent: '#22c55e' } },
];
const DONE_LABEL = { title: 'Unit ready ✓', lines: ['filter changed', 'next service: 6 months'], accent: '#22c55e' };

// ---------------------------------------------------------------- virtual machine (meters, z = up from paper)

const W = 0.12, D = 0.085, H = 0.045, T = 0.004;

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, transparent: true, ...extra });
}
function box(w, d, h, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
  m.position.set(x, y, z);
  return m;
}
function cylinderZ(r, h, material, segments = 32) {
  const g = new THREE.CylinderGeometry(r, r, h, segments);
  g.rotateX(Math.PI / 2); // three.js cylinders stand on y; ours stand on z
  return new THREE.Mesh(g, material);
}

function buildMachine() {
  const root = new THREE.Group();
  const housingMat = mat(0x475569, { transparent: false });
  const darkMat = mat(0x1e293b, { transparent: false });

  // Housing: open box so the inside is visible once the cover is off.
  const housing = new THREE.Group();
  housing.add(box(W, D, T, darkMat, 0, 0, T / 2));
  housing.add(box(W, T, H, housingMat, 0, -D / 2 + T / 2, H / 2));
  housing.add(box(W, T, H, housingMat, 0, D / 2 - T / 2, H / 2));
  housing.add(box(T, D, H, housingMat, -W / 2 + T / 2, 0, H / 2));
  housing.add(box(T, D, H, housingMat, W / 2 - T / 2, 0, H / 2));
  housing.add(box(0.045, 0.002, 0.016, mat(0xe2e8f0, { transparent: false }), 0.02, -D / 2 - 0.001, H * 0.55)); // type plate
  const pipe = cylinderZ(0.007, 0.04, mat(0x94a3b8, { metalness: 0.7, transparent: false }));
  pipe.rotation.y = Math.PI / 2;
  pipe.position.set(W / 2 + 0.02, 0.012, 0.026);
  housing.add(pipe);
  const motor = cylinderZ(0.015, 0.028, mat(0x64748b, { metalness: 0.6, transparent: false }));
  motor.position.set(-0.03, 0, T + 0.014);
  housing.add(motor);
  root.add(housing);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0xef4444, emissiveIntensity: 1 }));
  led.position.set(-0.035, -D / 2 - 0.002, H * 0.6);
  root.add(led);

  const coverMat = mat(0x2563eb, { metalness: 0.4, roughness: 0.4 });
  const cover = box(W + 0.004, D + 0.004, 0.006, coverMat);
  root.add(cover);

  const screwMat = mat(0xd1d5db, { metalness: 0.9, roughness: 0.3 });
  const slotMat = mat(0x111827);
  const screws = [];
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const s = new THREE.Group();
    s.add(cylinderZ(0.0045, 0.0035, screwMat));
    s.add(box(0.0065, 0.0012, 0.001, slotMat, 0, 0, 0.0018));
    s.add(box(0.0012, 0.0065, 0.001, slotMat, 0, 0, 0.0018));
    s.home = { x: sx * (W / 2 - 0.008), y: sy * (D / 2 - 0.008) };
    root.add(s);
    screws.push(s);
  }

  const filter = (bodyColor, capColor) => {
    const g = new THREE.Group();
    const body = cylinderZ(0.017, 0.034, mat(bodyColor));
    const cap = cylinderZ(0.019, 0.004, mat(capColor));
    cap.position.z = 0.019;
    g.add(body, cap);
    g.materials = [body.material, cap.material];
    return g;
  };
  const oldFilter = filter(0x92400e, 0x57534e);
  const newFilter = filter(0xf1f5f9, 0x22c55e);
  root.add(oldFilter, newFilter);

  return { root, cover, coverMat, screws, screwMat, oldFilter, newFilter, led };
}

// Arrow along +z (shaft + cone), used to show motion directions.
function arrow(color, length = 0.04) {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const shaft = cylinderZ(0.003, length * 0.6, m, 12);
  shaft.position.z = length * 0.3;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.008, length * 0.4, 16).rotateX(Math.PI / 2), m);
  head.position.z = length * 0.8;
  g.add(shaft, head);
  g.renderOrder = 8;
  g.traverse((o) => (o.renderOrder = 8));
  return g;
}

// Curved arrow (3/4 circle) around +z that shows "turn counter-clockwise".
function turnArrow(color) {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0013, 8, 32, Math.PI * 1.5), m);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.003, 0.007, 12), m);
  head.position.set(0, -0.009, 0); // arc ends at 270°, head points along the counter-clockwise tangent
  head.rotation.z = -Math.PI / 2;
  g.add(arc, head);
  g.traverse((o) => (o.renderOrder = 8));
  return g;
}

// ---------------------------------------------------------------- per-step target poses

// state 0..3 = showing step i, 4 = finished
function targets(state, m) {
  const t = new Map();
  const assembled = state === 0 || state === 4;
  m.screws.forEach((s, i) => {
    t.set(s, assembled
      ? { x: s.home.x, y: s.home.y, z: H + 0.006 + 0.00175, rz: 0, op: 1 }
      : { x: -0.106, y: -0.03 + i * 0.02, z: 0.002, rz: -Math.PI * 6, op: 1 });
  });
  const coverOff = state === 2 || state === 3;
  t.set(m.cover, coverOff ? { x: 0, y: 0.072, z: 0.047, rx: 1.35, op: 0.9 } : { x: 0, y: 0, z: H + 0.003, rx: 0, op: 1 });
  const filterIn = { x: 0.022, y: 0, z: T + 0.017, op: 1 };
  const filterOut = { x: 0.022, y: 0, z: 0.12, op: 0 };
  t.set(m.oldFilter, state <= 2 ? filterIn : filterOut);
  t.set(m.newFilter, state <= 2 ? filterOut : filterIn);
  return t;
}

const LEADER_TARGET = [
  new THREE.Vector3(0, 0, H + 0.008),
  new THREE.Vector3(0, 0, H + 0.006),
  new THREE.Vector3(0.022, 0, H),
  new THREE.Vector3(0, 0, H),
  new THREE.Vector3(-0.035, -D / 2, H * 0.6),
];

// ---------------------------------------------------------------- app

bootStartOverlay(() => {
  const ar = new ARScene({ video: $('#video'), canvas: $('#gl'), debugCanvas: $('#debug') });
  const tracker = new MarkerTracker($('#video'));
  const board = ar.anchor('board');
  const machine = buildMachine();
  board.add(machine.root);

  const label = makeLabel(560, 260, 0.038, (ctx, w, h) => drawCard(ctx, w, h, STEPS[0].label));
  label.center.set(0.5, 0);
  label.position.set(0.1, -0.01, 0.05);
  const leader = leaderLine(0xffffff);
  board.add(label, leader);

  const upArrow = arrow(0x38bdf8);
  const downArrow = arrow(0x22c55e);
  downArrow.rotation.x = Math.PI;
  const turnArrows = machine.screws.map(() => turnArrow(0xf59e0b));
  board.add(upArrow, downArrow, ...turnArrows);

  // Every movable part keeps its current pose and eases towards the step's target.
  const parts = [...machine.screws, machine.cover, machine.oldFilter, machine.newFilter];
  for (const p of parts) p.cur = { x: 0, y: 0, z: 0, rx: 0, rz: 0, op: 1 };

  let state = 0;
  let stats;
  const reset = () => {
    state = 0;
    stats = { start: performance.now(), end: 0, taps: 0, lost: 0, lostMs: 0, everTracked: false, wasTracked: false };
    const t = targets(0, machine);
    for (const p of parts) Object.assign(p.cur, { rx: 0, rz: 0 }, t.get(p));
    showStep();
  };

  function showStep() {
    const step = STEPS[state];
    label.redraw((ctx, w, h) => drawCard(ctx, w, h, step ? step.label : DONE_LABEL));
    if (!step) return;
    $('#step-kicker').textContent = `Step ${state + 1} of ${STEPS.length}`;
    $('#step-title').textContent = step.title;
    $('#step-detail').textContent = step.detail;
    $('#back-btn').disabled = state === 0;
    $('#next-btn').textContent = state === STEPS.length - 1 ? 'Done, finish' : 'Done, next';
  }

  function go(delta) {
    stats.taps++;
    state = Math.max(0, Math.min(STEPS.length, state + delta));
    showStep();
    if (state === STEPS.length) {
      stats.end = performance.now();
      $('#card').hidden = true;
      setTimeout(showSummary, 2200);
    }
  }
  $('#next-btn').addEventListener('click', () => go(1));
  $('#back-btn').addEventListener('click', () => go(-1));
  $('#restart-btn').addEventListener('click', () => {
    $('#summary').classList.add('hidden');
    reset();
  });

  function showSummary() {
    const total = stats.end - stats.start;
    $('#summary-metrics').innerHTML = [
      metric(formatTime(total), 'total time'),
      metric(stats.taps, 'screen taps to get through 4 steps', true),
      metric(`${stats.lost}×`, `tracking lost (${formatTime(stats.lostMs)} without guidance)`, stats.lost > 0),
      metric('1 of 2', 'hands busy holding the phone the whole time', true),
    ].join('');
    $('#summary').classList.remove('hidden');
  }

  runLoop({
    tracker,
    ar,
    onMarkers(markers, now) {
      const obj = [], img = [];
      for (const m of markers) {
        const def = BOARD.markers.find((b) => b.id === m.id);
        if (!def) continue;
        obj.push(...markerCorners(def.x, def.y, BOARD.markerSize));
        img.push(...m.corners);
      }
      if (obj.length) ar.updateAnchor('board', obj, img, now);
    },
    onFrame(now, dt) {
      const tracked = ar.isVisible('board');
      const finished = state === STEPS.length;
      if (tracked) stats.everTracked = true;
      if (stats.everTracked && !finished) {
        if (stats.wasTracked && !tracked) stats.lost++;
        if (!tracked) stats.lostMs += dt * 1000;
      }
      stats.wasTracked = tracked;

      $('#banner').classList.toggle('hidden', tracked || finished);
      $('#card').hidden = !stats.everTracked || finished;
      $('#track-chip').classList.toggle('on', tracked);
      $('#track-label').textContent = tracked ? 'Tracking' : 'Searching';
      $('#timer').textContent = formatTime((stats.end || now) - stats.start);

      // Ease parts towards the current step's pose.
      const k = 1 - Math.exp(-dt * 5);
      const t = targets(state, machine);
      for (const p of parts) {
        const goal = t.get(p), c = p.cur;
        for (const key of ['x', 'y', 'z', 'rx', 'rz', 'op']) c[key] += ((goal[key] ?? 0) - c[key]) * k;
        p.position.set(c.x, c.y, c.z);
        p.rotation.set(c.rx, 0, c.rz);
        p.traverse((o) => o.material && (o.material.opacity = c.op));
        p.visible = c.op > 0.02;
      }

      // Pulse the part the current step is about.
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      const glow = (material, on, color) => {
        material.emissive.set(on ? color : 0x000000);
        material.emissiveIntensity = on ? 0.25 + 0.6 * pulse : 0;
      };
      glow(machine.screwMat, state === 0, 0xf59e0b);
      glow(machine.coverMat, state === 1, 0x38bdf8);
      machine.oldFilter.materials.forEach((m) => glow(m, state === 2, 0xef4444));
      machine.newFilter.materials.forEach((m) => glow(m, state === 3, 0x22c55e));

      // LED: blinking red until the job is done, then solid green.
      const ledMat = machine.led.material;
      if (finished) {
        ledMat.emissive.set(0x22c55e);
        ledMat.color.set(0x14532d);
        ledMat.emissiveIntensity = 1.4;
      } else {
        ledMat.emissive.set(0xef4444);
        ledMat.color.set(0x7f1d1d);
        ledMat.emissiveIntensity = Math.sin(now / 250) > 0 ? 1.4 : 0.1;
      }

      // Motion hints.
      const bob = (now / 900) % 1;
      turnArrows.forEach((a, i) => {
        a.visible = state === 0;
        const s = machine.screws[i];
        a.position.set(s.home.x, s.home.y, H + 0.014);
        a.rotation.z = now / 300;
      });
      upArrow.visible = state === 1 || state === 2;
      if (state === 1) upArrow.position.set(0, 0, H + 0.012 + bob * 0.03);
      if (state === 2) upArrow.position.set(0.022, 0, H + 0.004 + bob * 0.03);
      upArrow.traverse((o) => o.material && (o.material.opacity = 1 - bob));
      downArrow.visible = state === 3;
      downArrow.position.set(0, 0, H + 0.06 - bob * 0.03);
      downArrow.traverse((o) => o.material && (o.material.opacity = 1 - bob));

      leader.setEnds(label.position, LEADER_TARGET[state]);
    },
  });

  reset();
  window.arDebug = { ar, tracker, get state() { return state; }, get stats() { return stats; }, go };
});

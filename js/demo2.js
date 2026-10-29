// Demo 2: four A4 station sheets spread around the room. A repair job sends
// the user from station to station; each station shows live info in AR.
// We measure how much of the job happened without guidance in view.
import { THREE, ARScene, MarkerTracker, runLoop, makeLabel, roundRect } from './ar.js';
import { STATIONS, STATION_MARKER_SIZE, markerCorners } from './config.js';
import { $, bootStartOverlay, formatTime, metric } from './ui.js';

const TASKS = [
  { station: 'A', title: 'Pick 1× sensor X-12', detail: 'Bin A-03, top shelf. Take one sensor and confirm.' },
  { station: 'C', title: 'Calibrate the sensor', detail: 'Put it on the test bench and keep the camera on the station until calibration is done.', dwellMs: 5000 },
  { station: 'B', title: 'Install the sensor in P-200', detail: 'Line 2: plug in connector X3 and tighten to 2 Nm.' },
  { station: 'D', title: 'Pack and label order #4711', detail: 'Box size M, pallet 2, for the 14:30 pickup.' },
];
const byKey = Object.fromEntries(STATIONS.map((s) => [s.key, s]));
const stationLabel = (key) => `${key} · ${byKey[key].name}`;

// ---------------------------------------------------------------- 3D content per station

function std(color, extra) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, ...extra });
}

function icon(key, color) {
  const g = new THREE.Group();
  const c = new THREE.Color(color);
  if (key === 'A') { // storage: stacked crates
    [[0, 0, 0.012, 0.05], [0.006, -0.004, 0.036, 0.04], [-0.004, 0.003, 0.056, 0.03]].forEach(([x, y, z, s]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s * 0.8), std(c.clone().offsetHSL(0, 0, (z - 0.03) * 4)));
      m.position.set(x, y, z);
      g.add(m);
    });
  } else if (key === 'B') { // assembly: gear
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.012, 32).rotateX(Math.PI / 2), std(c, { metalness: 0.6 }));
    g.add(ring);
    for (let i = 0; i < 10; i++) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.01, 0.012), std(c, { metalness: 0.6 }));
      const a = (i / 10) * Math.PI * 2;
      tooth.position.set(Math.cos(a) * 0.032, Math.sin(a) * 0.032, 0);
      tooth.rotation.z = a;
      g.add(tooth);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.016, 20).rotateX(Math.PI / 2), std(0x1f2937));
    g.add(hub);
    g.position.z = 0.03;
  } else if (key === 'C') { // test bench: gauge with moving needle
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.008, 48).rotateX(Math.PI / 2), std(0xf8fafc));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.004, 12, 48), std(c, { metalness: 0.5 }));
    rim.position.z = 0.004;
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.03, 0.002), std(0xef4444));
    needle.geometry.translate(0, 0.013, 0);
    needle.position.z = 0.006;
    g.add(dial, rim, needle);
    g.needle = needle;
    g.position.z = 0.03;
  } else { // shipping: parcel
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.04), std(0xc08a4d));
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.012, 0.041), std(c));
    box.position.z = tape.position.z = 0.02;
    g.add(box, tape);
  }
  return g;
}

function frame(size, width) {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
  const h = size / 2 + width / 2;
  for (const [x, y, w, d] of [[0, h, size + 2 * width, width], [0, -h, size + 2 * width, width], [h, 0, width, size], [-h, 0, width, size]]) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m);
    bar.position.set(x, y, 0.001);
    bar.renderOrder = 5;
    g.add(bar);
  }
  g.material = m;
  return g;
}

function drawPanel(ctx, w, h, st, status) {
  roundRect(ctx, 4, 4, w - 8, h - 8, 34);
  ctx.fillStyle = 'rgba(15,23,42,0.9)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = status.color;
  ctx.stroke();
  // badge
  ctx.fillStyle = st.color;
  ctx.beginPath();
  ctx.arc(80, 86, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 60px system-ui, sans-serif';
  ctx.fillText(st.key, 80, 90);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 50px system-ui, sans-serif';
  ctx.fillText(st.name, 150, 80, w - 180);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 32px system-ui, sans-serif';
  ctx.fillText(st.info[0], 150, 122, w - 180);
  ctx.fillText(st.info[1], 40, 186, w - 80);
  // status strip
  roundRect(ctx, 24, h - 96, w - 48, 72, 20);
  ctx.fillStyle = status.color;
  ctx.fill();
  ctx.fillStyle = status.ink;
  ctx.font = '700 34px system-ui, sans-serif';
  ctx.fillText(status.text, 46, h - 48, w - 92);
}

function buildStation(ar, st) {
  const anchor = ar.anchor(`st-${st.key}`);
  const fr = frame(STATION_MARKER_SIZE + 0.012, 0.008);
  const ic = icon(st.key, st.color);
  const iconHolder = new THREE.Group();
  iconHolder.scale.setScalar(1.8);
  iconHolder.add(ic);
  const panel = makeLabel(640, 340, 0.15, () => {});
  panel.center.set(0.5, 0);
  panel.position.set(0, STATION_MARKER_SIZE / 2 + 0.01, 0.03);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, depthTest: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.BufferGeometry(), ringMat);
  ring.renderOrder = 6;
  ring.position.z = 0.002;
  anchor.add(fr, iconHolder, panel, ring);
  return { st, anchor, frame: fr, icon: ic, iconHolder, panel, ring, panelKey: '', ringProgress: -1 };
}

// ---------------------------------------------------------------- app

bootStartOverlay(() => {
  const ar = new ARScene({ video: $('#video'), canvas: $('#gl'), debugCanvas: $('#debug') });
  const tracker = new MarkerTracker($('#video'), { maxSide: 1280 }); // far-away markers need resolution
  const stations = STATIONS.map((st) => buildStation(ar, st));
  const byId = new Map(STATIONS.map((s) => [s.id, s]));

  let current, done, stats, dwell, lastVisible, prevSeen, finished;
  const reset = () => {
    current = 0;
    done = new Set();
    dwell = 0;
    finished = false;
    lastVisible = false;
    prevSeen = new Set();
    stats = { start: performance.now(), end: 0, taps: 0, noGuideMs: 0, aims: 0, wrong: 0, interrupts: 0 };
    renderCard();
  };

  const task = () => TASKS[current];

  function renderCard() {
    const t = task();
    if (!t) return;
    $('#task-kicker').textContent = `Task ${current + 1} of ${TASKS.length} · Station ${stationLabel(t.station)}`;
    $('#task-title').textContent = t.title;
    $('#task-detail').textContent = t.detail;
    $('#dwell').hidden = !t.dwellMs;
    $('#done-btn').hidden = !!t.dwellMs;
    $('#task-chips').innerHTML = TASKS.map((x, i) => {
      const cls = i < current ? 'done' : i === current ? 'current' : '';
      return `<span class="step-chip ${cls}"><b style="background:${byKey[x.station].color}">${x.station}</b>${byKey[x.station].name}</span>`;
    }).join('');
  }

  function complete() {
    done.add(task().station);
    current++;
    dwell = 0;
    if (current >= TASKS.length) {
      finished = true;
      stats.end = performance.now();
      $('#card').hidden = true;
      setTimeout(showSummary, 1500);
    } else {
      renderCard();
    }
  }

  $('#done-btn').addEventListener('click', () => {
    stats.taps++;
    if (task() && ar.isVisible(`st-${task().station}`)) complete();
  });
  $('#restart-btn').addEventListener('click', () => {
    $('#summary').classList.add('hidden');
    $('#card').hidden = false;
    reset();
  });

  function showSummary() {
    const total = stats.end - stats.start;
    const share = total ? Math.round((100 * stats.noGuideMs) / total) : 0;
    $('#summary-metrics').innerHTML = [
      metric(formatTime(total), 'total time'),
      metric(`${share} %`, `of the time no AR guidance in view (${formatTime(stats.noGuideMs)})`, true),
      metric(`${stats.aims}×`, 'raised and aimed the phone at a station', true),
      metric(`${stats.interrupts}×`, 'calibration paused because the camera slipped off', stats.interrupts > 0),
      metric(`${stats.wrong}×`, 'looked at the wrong station'),
      metric(stats.taps, 'screen taps'),
    ].join('');
    $('#summary').classList.remove('hidden');
  }

  function statusFor(key) {
    const t = task();
    if (done.has(key)) return { text: '✓ Done', color: '#334155', ink: '#cbd5e1' };
    if (t && t.station === key) return { text: `▶ Your task: ${t.title}`, color: '#22c55e', ink: '#052e16' };
    const next = t ? `Next: ${stationLabel(t.station)}` : 'Job complete';
    return { text: `Not now · ${next}`, color: '#475569', ink: '#f1f5f9' };
  }

  runLoop({
    tracker,
    ar,
    onMarkers(markers, now) {
      for (const m of markers) {
        const st = byId.get(m.id);
        if (st) ar.updateAnchor(`st-${st.key}`, markerCorners(0, 0, STATION_MARKER_SIZE), m.corners, now);
      }
    },
    onFrame(now, dt) {
      const t = task();
      const seen = new Set(STATIONS.filter((s) => ar.isVisible(`st-${s.key}`)).map((s) => s.key));
      const anyVisible = seen.size > 0;
      const targetVisible = !!t && seen.has(t.station);

      if (!finished) {
        if (!anyVisible) stats.noGuideMs += dt * 1000;
        if (anyVisible && !lastVisible) stats.aims++;
        for (const k of seen) if (!prevSeen.has(k) && t && k !== t.station && !done.has(k)) stats.wrong++;
        // Calibration only runs while the camera stays on the test bench.
        if (t?.dwellMs) {
          if (targetVisible) dwell += dt * 1000;
          else if (dwell > 0 && prevSeen.has(t.station)) stats.interrupts++;
          $('#dwell-bar').style.width = `${Math.min(100, (100 * dwell) / t.dwellMs)}%`;
          if (dwell >= t.dwellMs) complete();
        }
      }
      lastVisible = anyVisible;
      prevSeen = seen;

      // HUD
      $('#timer').textContent = formatTime((stats.end || now) - stats.start);
      $('#track-chip').classList.toggle('on', anyVisible);
      $('#track-label').textContent = anyVisible ? `Seeing ${[...seen].join(', ')}` : 'No station';
      const cur = task();
      $('#done-btn').disabled = !cur || !seen.has(cur.station);
      $('#done-btn').textContent = cur && seen.has(cur.station) ? 'Done' : `Find station ${cur?.station ?? ''} first`;
      const banner = $('#banner');
      const wrongOnly = cur && anyVisible && !seen.has(cur.station);
      banner.classList.toggle('hidden', finished || (anyVisible && !wrongOnly));
      banner.classList.toggle('wrong', !!wrongOnly);
      if (cur) {
        banner.innerHTML = wrongOnly
          ? `✋ Wrong station. Go to <b>${stationLabel(cur.station)}</b>`
          : `🚶 Walk to <b>${stationLabel(cur.station)}</b> and point the camera at it`;
      }

      // 3D content
      for (const s of stations) {
        const key = s.st.key;
        if (!s.anchor.visible) continue;
        const status = statusFor(key);
        const isTarget = cur && cur.station === key;
        const panelKey = status.text;
        if (panelKey !== s.panelKey) {
          s.panelKey = panelKey;
          s.panel.redraw((ctx, w, h) => drawPanel(ctx, w, h, s.st, status));
        }
        s.frame.material.color.set(done.has(key) ? 0x64748b : isTarget ? 0x22c55e : 0xef4444);
        s.frame.material.opacity = isTarget ? 0.55 + 0.4 * Math.sin(now / 160) : 0.75;
        s.iconHolder.position.z = 0.06 + 0.012 * Math.sin(now / 400 + key.charCodeAt(0));
        if (key === 'C') s.icon.needle.rotation.z = -1.2 + 2.4 * (isTarget && cur.dwellMs ? dwell / cur.dwellMs : 0.5 + 0.1 * Math.sin(now / 300));
        else s.icon.rotation.z = now / 1400;

        // Progress ring around the marker while calibrating.
        const p = isTarget && cur.dwellMs ? Math.min(1, dwell / cur.dwellMs) : 0;
        if (Math.abs(p - s.ringProgress) > 0.004) {
          s.ringProgress = p;
          s.ring.geometry.dispose();
          const r = STATION_MARKER_SIZE / 2 + 0.03;
          s.ring.geometry = p > 0 ? new THREE.RingGeometry(r, r + 0.012, 64, 1, Math.PI / 2, -p * Math.PI * 2) : new THREE.BufferGeometry();
        }
      }
    },
  });

  reset();
  window.arDebug = { ar, tracker, get current() { return current; }, get stats() { return stats; } };
});

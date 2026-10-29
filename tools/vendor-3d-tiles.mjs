#!/usr/bin/env node
// Copies NASA-AMMOS 3d-tiles-renderer into vendor/3d-tiles-renderer/ as plain
// ES modules: bare 'three' imports are rewritten to the vendored three.js r160
// (vendor/three/), so pages need no bundler and no import map.
//   node tools/vendor-3d-tiles.mjs
// 0.3.46 is the last release that supports three r160 (0.4.0 needs r166+).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.3.46';
const THREE_VERSION = '0.160.0';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'vendor', '3d-tiles-renderer');
const threeDir = path.join(root, 'vendor', 'three');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pack = (spec) => {
  const file = execFileSync(npm, ['pack', spec, '--silent'], { cwd: tmp, shell: process.platform === 'win32' }).toString().trim().split('\n').pop();
  const dir = path.join(tmp, spec.split('@')[0]);
  fs.mkdirSync(dir);
  // Relative paths: GNU tar on Windows reads "C:" as a remote host.
  execFileSync('tar', ['xzf', path.join('..', file)], { cwd: dir });
  return path.join(dir, 'package');
};
const tiles = pack(`3d-tiles-renderer@${VERSION}`);
const three = pack(`three@${THREE_VERSION}`);

// three.js addons the library needs that aren't vendored yet.
const pass = path.join(threeDir, 'addons', 'postprocessing', 'Pass.js');
fs.mkdirSync(path.dirname(pass), { recursive: true });
fs.copyFileSync(path.join(three, 'examples', 'jsm', 'postprocessing', 'Pass.js'), pass);

fs.rmSync(out, { recursive: true, force: true });
const copy = (src, dst) => {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'r3f') copy(s, d); // React bindings, not used
    } else if (e.name.endsWith('.js')) {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
};
copy(path.join(tiles, 'src'), path.join(out, 'src'));
fs.copyFileSync(path.join(tiles, 'LICENSE'), path.join(out, 'LICENSE'));

const rel = (from, to) => {
  const r = path.relative(path.dirname(from), to).split(path.sep).join('/');
  return r.startsWith('.') ? r : `./${r}`;
};
const target = (spec) => {
  if (spec === 'three') return path.join(threeDir, 'three.module.min.js');
  if (spec.startsWith('three/examples/jsm/')) return path.join(threeDir, 'addons', spec.slice('three/examples/jsm/'.length));
  if (spec === '3d-tiles-renderer/plugins') return path.join(out, 'src', 'plugins', 'index.js');
  if (spec === '3d-tiles-renderer') return path.join(out, 'src', 'index.js');
  return null;
};
const rewrite = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  // Only real import/export statements (at the start of a line), not strings or comments.
  const res = src.replace(/^(\s*(?:import|export)\b[^;'"(=]*?\bfrom\s*|\s*import\s*)(['"])([^'"\n]+)\2/gm, (m, pre, q, spec) => {
    if (spec.startsWith('.')) return m;
    const t = target(spec);
    if (!t) throw new Error(`${file}: unknown import '${spec}'`);
    if (!fs.existsSync(t)) throw new Error(`${file}: '${spec}' -> ${t} does not exist`);
    return `${pre}${q}${rel(file, t)}${q}`;
  });
  fs.writeFileSync(file, res);
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) rewrite(p);
});
walk(path.join(out, 'src'));
rewrite(pass);
fs.writeFileSync(path.join(out, 'VERSION'), `3d-tiles-renderer ${VERSION} (https://github.com/NASA-AMMOS/3DTilesRendererJS)\n`
  + `three imports rewritten to vendor/three (r${THREE_VERSION.split('.')[1]}) by tools/vendor-3d-tiles.mjs\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`vendored 3d-tiles-renderer ${VERSION} into ${path.relative(root, out)}`);

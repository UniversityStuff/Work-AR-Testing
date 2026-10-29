#!/usr/bin/env python3
"""Turn a large GLB/glTF/OBJ model (a drone scan, or a BIM model converted with
tools/ifc2glb.py) into a 3D Tiles tileset that the AR demos stream: the phone
only downloads the tiles in view, at the detail it needs.

    pip install trimesh numpy pillow
    # Obj2Tiles (OpenDroneMap, AGPL-3.0): unzip a release from
    # https://github.com/OpenDroneMap/Obj2Tiles/releases next to this script
    # (tools/Obj2Tiles/), put it on the PATH, or pass --obj2tiles.
    python3 tools/glb2tiles.py scan.glb -o models/tiles/my-scan

Steps: the model's up axis is found (guessed like `up: 'auto'` in js/models.js,
or given with --up), the model is moved to the origin with the ground at height
0 and written as a Y-up OBJ with its textures; Obj2Tiles then decimates it into --lods
levels of detail (the coarsest has 1/lods of the triangles and is the first
download), splits each level into tiles (a quadtree: the coarsest is one tile,
every finer level has 4x the tiles) and writes tileset.json with b3dm (glTF) tiles and unlit
materials (scan textures already contain the lighting). The tileset is local
(no globe position), +Z up, in the model's units. Then add an entry to
MODELS in js/config.js with `tiles: 'models/tiles/my-scan/tileset.json'`.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import trimesh


def guess_up(points):
    """Index and sign of the up axis: scans of buildings are wider than tall,
    and most of their surface is near the ground (same rule as js/models.js)."""
    lo, hi = np.percentile(points, [0.5, 99.5], axis=0)
    k = int(np.argmin(hi - lo))
    median = np.median(points[:, k])
    return k, (1 if median - lo[k] < hi[k] - median else -1)


def to_z_up(k, sign):
    """Rotation matrix that turns axis k (with sign) into +Z."""
    up = np.zeros(3)
    up[k] = sign
    if np.allclose(up, [0, 0, 1]):
        return np.eye(4)
    return trimesh.geometry.align_vectors(up, [0, 0, 1])


def material_of(mesh):
    """(diffuse rgb, texture image or None) of a trimesh mesh."""
    vis = mesh.visual
    mat = getattr(vis, 'material', None)
    if mat is not None:
        img = getattr(mat, 'baseColorTexture', None) or getattr(mat, 'image', None)
        color = getattr(mat, 'baseColorFactor', None)
        if color is None:
            color = getattr(mat, 'diffuse', None)
        rgb = np.asarray(color if color is not None else [255, 255, 255], dtype=float)[:3]
        if rgb.max() > 1:
            rgb = rgb / 255
        return rgb, img if getattr(vis, 'uv', None) is not None else None
    if hasattr(vis, 'main_color'):
        return np.asarray(vis.main_color[:3], dtype=float) / 255, None
    return np.ones(3), None


def write_obj(meshes, folder):
    """OBJ + MTL + textures, one material per mesh. Positions are shared across
    UV seams and between meshes (OBJ indexes positions and UVs separately):
    glTF splits vertices at every seam, and Obj2Tiles won't decimate such open
    edges, so the coarse levels of detail would stay almost full size."""
    pos, ids = np.unique(np.round(np.concatenate([m.vertices for m in meshes]), 5), axis=0, return_inverse=True)
    ids = ids.reshape(-1)
    obj = ['mtllib model.mtl'] + ['v %.5f %.5f %.5f' % tuple(v) for v in pos]
    mtl = []
    nv = nt = 0
    for i, m in enumerate(meshes):
        rgb, img = material_of(m)
        name = f'm{i}'
        mtl += [f'newmtl {name}', 'Ka 0 0 0', 'Kd %.4f %.4f %.4f' % tuple(rgb), 'Ks 0 0 0', 'illum 1']
        if img is not None:
            tex = f'{name}.png' if img.mode in ('RGBA', 'LA', 'P') else f'{name}.jpg'
            (img if tex.endswith('.png') else img.convert('RGB')).save(os.path.join(folder, tex), quality=92)
            mtl.append(f'map_Kd {tex}')
        obj += [f'o part{i}', f'usemtl {name}']
        f = ids[m.faces + nv] + 1
        if img is not None:
            obj += ['vt %.6f %.6f' % tuple(t) for t in m.visual.uv]
            ft = m.faces + 1 + nt
            obj += [f'f {a}/{x} {b}/{y} {c}/{z}' for (a, b, c), (x, y, z) in zip(f, ft)]
            nt += len(m.visual.uv)
        else:
            obj += [f'f {a} {b} {c}' for a, b, c in f]
        nv += len(m.vertices)
    with open(os.path.join(folder, 'model.obj'), 'w') as fh:
        fh.write('\n'.join(obj) + '\n')
    with open(os.path.join(folder, 'model.mtl'), 'w') as fh:
        fh.write('\n'.join(mtl) + '\n')


def find_obj2tiles(given):
    here = os.path.dirname(os.path.abspath(__file__))
    for c in [given, os.path.join(here, 'Obj2Tiles', 'Obj2Tiles.exe'), os.path.join(here, 'Obj2Tiles', 'Obj2Tiles'),
              shutil.which('Obj2Tiles')]:
        if c and os.path.isfile(c):
            return c
    sys.exit('Obj2Tiles not found. Download it from https://github.com/OpenDroneMap/Obj2Tiles/releases '
             'and unzip it into tools/Obj2Tiles/, or pass --obj2tiles.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', help='.glb, .gltf or .obj')
    ap.add_argument('-o', '--out', required=True, help='output folder (gets tileset.json)')
    ap.add_argument('--up', default='auto', choices=['auto', 'y', 'z', '-y', '-z', 'x', '-x'],
                    help="up axis of the input (glTF is normally 'y'; default: guess)")
    ap.add_argument('--lods', type=int, default=3,
                    help='levels of detail (default 3; use 5 or more above ~500k triangles)')
    ap.add_argument('--divisions', type=int, default=0,
                    help='quadtree depth of the coarsest level (default 0: one tile; every finer level adds one)')
    ap.add_argument('--max-texture', type=int, default=2048, help='largest texture side in pixels (default 2048)')
    ap.add_argument('--decimation', default='Aggressive', choices=['Quality', 'Standard', 'Aggressive'],
                    help='Obj2Tiles decimation mode (default Aggressive; the others keep texture seams '
                         'intact but barely shrink scans with many texture charts)')
    ap.add_argument('--obj2tiles', help='path to the Obj2Tiles executable')
    a = ap.parse_args()
    a.out = os.path.abspath(a.out)
    exe = find_obj2tiles(a.obj2tiles)

    scene = trimesh.load(a.input, force='scene')
    meshes = [m for m in scene.dump(concatenate=False) if isinstance(m, trimesh.Trimesh) and len(m.faces)]
    pts = np.concatenate([m.vertices for m in meshes])
    if a.up == 'auto':
        k, sign = guess_up(pts[:: max(1, len(pts) // 200000)])
    else:
        k, sign = 'xyz'.index(a.up[-1]), -1 if a.up.startswith('-') else 1
    print(f'{len(meshes)} meshes, {sum(len(m.faces) for m in meshes)} triangles, up axis {"-" if sign < 0 else "+"}{"xyz"[k]}')

    rot = to_z_up(k, sign)
    for m in meshes:
        m.apply_transform(rot)
    pts = np.concatenate([m.vertices for m in meshes])
    lo, hi = np.percentile(pts, [0.5, 99.5], axis=0)
    shift = np.array([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    for m in meshes:
        m.apply_translation(shift)
    print('size %.1f x %.1f x %.1f (model units)' % tuple(hi - lo))
    # Obj2Tiles reads the OBJ like glTF (Y up) and writes a Z-up tileset from it.
    z_to_y = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
    for m in meshes:
        m.apply_transform(z_to_y)

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'obj')
        os.makedirs(src)
        write_obj(meshes, src)
        if os.path.isdir(a.out):  # empty it (removing the folder itself fails on Windows while it is open)
            for e in os.scandir(a.out):
                shutil.rmtree(e.path) if e.is_dir() else os.remove(e.path)
        cmd = [exe, os.path.join(src, 'model.obj'), a.out,
               '--local',            # no globe position: tileset frame = model frame, +Z up
               '--octree',           # each finer level gets one more split: a real LOD hierarchy
               '--no-root-content',  # the root would repeat the coarsest level
               '--b3dm',             # 3D Tiles 1.0 (glTF in b3dm): readable by every 3D Tiles viewer
               '--unlit',            # scan textures already contain the lighting
               '--lods', str(a.lods), '--divisions', str(a.divisions),
               '--max-texture-size', str(a.max_texture), '--lod-texture-scale', '0.5',
               '--texture-quality', '80', '--decimation-mode', a.decimation]
        print(' '.join(cmd), flush=True)
        subprocess.run(cmd, check=True, cwd=tmp)

    total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(a.out) for f in fs)
    count = sum(len(fs) for _, _, fs in os.walk(a.out))
    print(f'{a.out}: {count} files, {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Convert one or more IFC files (e.g. a federated BIM model) into a single GLB
that the AR demos can load.

    pip install ifcopenshell trimesh numpy
    python3 tools/ifc2glb.py Building-Architecture.ifc Building-Structural.ifc ... -o models/my-model.glb

Meshes are grouped per file ("discipline") and IFC class so the phone has few
draw calls. Node names are "<discipline>|<IfcClass>", which the viewer uses for
the layer toggles. Output is standard glTF (Y up, meters).
"""
import argparse
import collections
import os

import ifcopenshell
import ifcopenshell.geom
import numpy as np
import trimesh

SKIP = {'IfcSpace', 'IfcSpatialZone', 'IfcOpeningElement', 'IfcAnnotation', 'IfcGrid', 'IfcVirtualElement'}

# Used when an element has no colour of its own.
FALLBACK = {
    'IfcWall': (0.85, 0.83, 0.78, 1), 'IfcSlab': (0.7, 0.7, 0.7, 1), 'IfcRoof': (0.6, 0.25, 0.2, 1),
    'IfcWindow': (0.55, 0.75, 0.9, 0.5), 'IfcDoor': (0.6, 0.45, 0.3, 1), 'IfcBeam': (0.65, 0.65, 0.7, 1),
    'IfcColumn': (0.65, 0.65, 0.7, 1), 'IfcGeographicElement': (0.35, 0.6, 0.3, 1),
    'IfcPipeSegment': (0.2, 0.45, 0.85, 1), 'IfcDuctSegment': (0.8, 0.6, 0.2, 1),
}


def element_color(geom, i_face):
    mats, ids = geom.materials, geom.material_ids
    if mats and ids and ids[i_face] >= 0:
        m = mats[ids[i_face]]
        d = m.diffuse
        rgb = (d.r(), d.g(), d.b()) if callable(getattr(d, 'r', None)) else tuple(d)[:3]
        alpha = 1.0 - (m.transparency if m.transparency == m.transparency else 0.0)
        return tuple(round(float(c), 3) for c in rgb) + (round(alpha, 2),)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ifc', nargs='+')
    ap.add_argument('-o', '--out', required=True)
    args = ap.parse_args()

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    # (discipline, class, rgba) -> lists of vertex/normal/face arrays
    groups = collections.defaultdict(lambda: {'v': [], 'f': [], 'count': 0})
    for path in args.ifc:
        discipline = os.path.splitext(os.path.basename(path))[0]
        model = ifcopenshell.open(path)
        it = ifcopenshell.geom.iterator(settings, model, os.cpu_count() or 1)
        if not it.initialize():
            continue
        while True:
            shape = it.get()
            element = model.by_id(shape.id)
            # Coordination/georeference helper objects are not part of the building.
            if shape.type not in SKIP and getattr(element, 'ObjectType', None) != 'origin':
                g = shape.geometry
                v = np.array(g.verts, dtype=np.float64).reshape(-1, 3)
                f = np.array(g.faces, dtype=np.int64).reshape(-1, 3)
                if len(f):
                    # Split faces by their material colour.
                    colors = [element_color(g, i) or FALLBACK.get(shape.type, (0.75, 0.75, 0.75, 1)) for i in range(len(f))]
                    for rgba in set(colors):
                        sel = f[[c == rgba for c in colors]]
                        grp = groups[(discipline, shape.type, rgba)]
                        used, inverse = np.unique(sel.ravel(), return_inverse=True)
                        base = sum(len(a) for a in grp['v'])
                        grp['v'].append(v[used])
                        grp['f'].append(inverse.reshape(-1, 3) + base)
                    groups[(discipline, shape.type, colors[0])]['count'] += 1
            if not it.next():
                break

    scene = trimesh.Scene()
    # IFC is Z up; glTF is Y up: (x, y, z) -> (x, z, -y)
    to_gltf = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64)
    for (discipline, cls, rgba), grp in sorted(groups.items()):
        v = np.concatenate(grp['v']) @ to_gltf.T
        f = np.concatenate(grp['f'])
        # Flat shading: one vertex per face corner with the face normal (BIM
        # geometry is mostly planar, and IfcOpenShell often returns no normals).
        tri = v[f]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        v = tri.reshape(-1, 3)
        n = np.repeat(fn, 3, axis=0)
        f = np.arange(len(v)).reshape(-1, 3)
        mat = trimesh.visual.material.PBRMaterial(
            baseColorFactor=[int(c * 255) for c in rgba], metallicFactor=0.0, roughnessFactor=0.8,
            alphaMode='BLEND' if rgba[3] < 0.99 else 'OPAQUE', doubleSided=True)
        mesh = trimesh.Trimesh(vertices=v, faces=f, vertex_normals=n, process=False,
                               visual=trimesh.visual.TextureVisuals(material=mat))
        scene.add_geometry(mesh, geom_name=f'{discipline}|{cls}|{len(scene.geometry)}', node_name=f'{discipline}|{cls}')
    scene.export(args.out, file_type='glb', include_normals=True)
    tris = sum(len(g.faces) for g in scene.geometry.values())
    print(f'{args.out}: {len(scene.geometry)} meshes, {tris} triangles, {os.path.getsize(args.out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()

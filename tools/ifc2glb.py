#!/usr/bin/env python3
"""Convert one or more IFC files (e.g. a federated BIM model) into a single GLB
that the AR demos can load.

    pip install ifcopenshell trimesh numpy scipy   # scipy only for --focus
    python3 tools/ifc2glb.py Building-Architecture.ifc Building-Structural.ifc ... -o models/my-model.glb

Meshes are grouped per file ("discipline") and IFC class so the phone has few
draw calls. Node names are "<discipline>|<IfcClass>", which the viewer uses for
the layer toggles. Output is standard glTF (Y up, meters).

For a railway file, --rail-layers groups by rail system (track, signalling,
cables, ...) instead of by file, and --focus/--margin crop long linear models
(kilometres of track) to the area around the given classes:

    python3 tools/ifc2glb.py crossing.ifc --rail-layers --focus IfcSignal,IfcDoor --margin 40 -o models/crossing.glb

Files written against the IFC 4.3 release candidates (IFC4X3_RC*) are read as
IFC4X3_ADD2.
"""
import argparse
import collections
import os
import re

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
    # Railway (IFC 4.3). "<class>.<PredefinedType>" wins over "<class>".
    'IfcRail': (0.55, 0.56, 0.6, 1), 'IfcTrackElement': (0.62, 0.6, 0.56, 1), 'IfcCourse': (0.45, 0.42, 0.38, 1),
    'IfcCableSegment': (0.12, 0.12, 0.12, 1), 'IfcCableCarrierSegment': (0.5, 0.5, 0.5, 1),
    'IfcSignal': (0.95, 0.75, 0.1, 1), 'IfcSign': (0.9, 0.9, 0.9, 1), 'IfcSensor': (0.2, 0.45, 0.85, 1),
    'IfcJunctionBox': (0.3, 0.5, 0.75, 1), 'IfcDoor.BOOM_BARRIER': (0.85, 0.15, 0.12, 1),
    'IfcMember': (0.6, 0.6, 0.62, 1), 'IfcRailing': (0.85, 0.75, 0.2, 1), 'IfcFooting': (0.7, 0.7, 0.68, 1),
    'IfcFurniture': (0.35, 0.55, 0.4, 1), 'IfcBuiltElement': (0.8, 0.72, 0.6, 1),
    'IfcDiscreteAccessory': (0.75, 0.45, 0.15, 1), 'IfcTransformer': (0.4, 0.45, 0.4, 1),
}

# --rail-layers: IFC class -> layer name. Anything else goes to "other".
RAIL_LAYERS = {
    'IfcRail': 'track', 'IfcTrackElement': 'track', 'IfcCourse': 'track', 'IfcKerb': 'track',
    'IfcSignal': 'signalling', 'IfcSign': 'signalling', 'IfcSensor': 'signalling', 'IfcJunctionBox': 'signalling',
    'IfcDoor': 'signalling', 'IfcMember': 'signalling', 'IfcFooting': 'signalling', 'IfcRailing': 'signalling',
    'IfcStair': 'signalling', 'IfcDiscreteAccessory': 'signalling', 'IfcElementAssembly': 'signalling',
    'IfcCableSegment': 'cables', 'IfcCableCarrierSegment': 'cables', 'IfcCableFitting': 'cables',
    'IfcTransformer': 'energy', 'IfcElectricDistributionBoard': 'energy', 'IfcSwitchingDevice': 'energy',
    'IfcBuiltElement': 'technical-building', 'IfcFurniture': 'technical-building',
    'IfcController': 'technical-building', 'IfcCommunicationsAppliance': 'technical-building',
}


def element_color(geom, i_face):
    mats, ids = geom.materials, geom.material_ids
    if mats and ids and ids[i_face] >= 0:
        m = mats[ids[i_face]]
        if m.name.startswith('DefaultMaterial'):  # IfcOpenShell's stand-in for "no style"
            return None
        d = m.diffuse
        rgb = (d.r(), d.g(), d.b()) if callable(getattr(d, 'r', None)) else tuple(d)[:3]
        alpha = 1.0 - (m.transparency if m.transparency == m.transparency else 0.0)
        return tuple(round(float(c), 3) for c in rgb) + (round(alpha, 2),)
    return None


def open_ifc(path):
    try:
        return ifcopenshell.open(path)
    except ifcopenshell.SchemaError:
        with open(path, encoding='utf-8', errors='replace') as fh:
            text = fh.read()
        patched = re.sub(r"'IFC4X3_RC\d'", "'IFC4X3_ADD2'", text, count=1)
        if patched == text:
            raise
        return ifcopenshell.file.from_string(patched)


def clip(v, f, lo, hi):
    """Cut a mesh (IFC coordinates, Z up) to the x/y box lo..hi."""
    mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
    for axis in (0, 1):
        for origin, sign in ((lo, 1), (hi, -1)):
            if not len(mesh.faces):
                break
            normal = np.zeros(3)
            normal[axis] = sign
            mesh = trimesh.intersections.slice_mesh_plane(mesh, normal, [origin[0], origin[1], 0])
    return np.asarray(mesh.vertices), np.asarray(mesh.faces)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ifc', nargs='+')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--rail-layers', action='store_true', help='layer by rail system instead of by file')
    ap.add_argument('--focus', help='comma-separated IFC classes; crop the model to the area around them')
    ap.add_argument('--margin', type=float, default=30.0, help='metres kept around --focus (default 30)')
    args = ap.parse_args()

    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    # (discipline, class, rgba) -> lists of vertex/normal/face arrays
    groups = collections.defaultdict(lambda: {'v': [], 'f': [], 'count': 0})
    for path in args.ifc:
        discipline = os.path.splitext(os.path.basename(path))[0]
        model = open_ifc(path)
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
                    fallback = (FALLBACK.get(f'{shape.type}.{getattr(element, "PredefinedType", None)}')
                                or FALLBACK.get(shape.type, (0.75, 0.75, 0.75, 1)))
                    colors = [element_color(g, i) or fallback for i in range(len(f))]
                    layer = RAIL_LAYERS.get(shape.type, 'other') if args.rail_layers else discipline
                    for rgba in set(colors):
                        sel = f[[c == rgba for c in colors]]
                        grp = groups[(layer, shape.type, rgba)]
                        used, inverse = np.unique(sel.ravel(), return_inverse=True)
                        base = sum(len(a) for a in grp['v'])
                        grp['v'].append(v[used])
                        grp['f'].append(inverse.reshape(-1, 3) + base)
                    groups[(layer, shape.type, colors[0])]['count'] += 1
            if not it.next():
                break

    if args.focus:
        focus = set(args.focus.split(','))
        pts = [np.concatenate(g['v']) for (_, cls, _), g in groups.items() if cls in focus]
        if not pts:
            raise SystemExit(f'--focus: none of {sorted(focus)} found')
        pts = np.concatenate(pts)
        lo, hi = pts[:, :2].min(axis=0) - args.margin, pts[:, :2].max(axis=0) + args.margin
        for key, grp in list(groups.items()):
            v, f = clip(np.concatenate(grp['v']), np.concatenate(grp['f']), lo, hi)
            if len(f):
                grp['v'], grp['f'] = [v], [f]
            else:
                del groups[key]

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

# AR BIM viewer: phone demo for the AR-glasses case

Two short AR demos that place a complete building model (BIM or a drone scan) on printed
fiducial markers (ArUco). They run in **Chrome on Android** as a plain web page: no app, no
install, no build step.

| | Demo 1: one A4 sheet | Demo 2: four A4 sheets on the table corners |
|---|---|---|
| Markers | 4 small markers in the corners of one landscape A4 sheet (IDs 0–3). One visible marker is enough. | 1 large marker per portrait A4 sheet, one sheet per table corner (IDs 4–7) |
| Model size | Scaled to fill the sheet | Scaled to fill the whole table |
| Setup | Lay the sheet on a table | Push each sheet into its labelled corner; the demo measures the table from the sheets (or type the size) |

## Models

| Model | Type | Source | License |
|---|---|---|---|
| Level crossing, Toivola (FI) | Railway BIM, IFC 4.3: track, ballast, boom barrier, signals, axle counters, cables, technical building | [bSI-RailwayRoom/IFC-Rail-Sample-Files, UT_DPE_5](https://github.com/bSI-RailwayRoom/IFC-Rail-Sample-Files/tree/main/7_Domain%20Physical%20Elements%20(DPE)/UT_DPE_5), data owner Finnish Transport Infrastructure Agency (FTIA) | Published as a public sample; the repository states no license |
| Single-family house | BIM, IFC4 (architecture, structure, HVAC, landscaping) | [buildingSMART Sample-Test-Files, "Simple-Scene"](https://github.com/buildingSMART/Sample-Test-Files) | CC BY 4.0, © buildingSMART International Ltd. |
| House, road, rail & bridge site | BIM, IFC4, all 10 discipline models of the same scene | same | same |
| Commercial building | Textured drone photogrammetry (RealityScan), 951 photos | [Matt1Up/drone-building-scans-dataset](https://github.com/Matt1Up/drone-building-scans-dataset), flat-roof scan | CC BY 4.0, Matt1up |
| Abandoned train station | Textured drone photogrammetry, streamed as 3D Tiles (200k triangles, 3 levels of detail) | [Vasilis Haroupas, "Abandoned Train Station"](https://zenodo.org/records/10340913) | CC BY 4.0, Vasilis Haroupas |

The BIM models were converted from IFC with `tools/ifc2glb.py` and are committed in `models/`.
The drone scan (about 22 MB) is downloaded from Hugging Face at runtime. To bundle it instead
(e.g. for offline presentations), run `tools/fetch-models.sh` and commit `models/drone-flat-roof.glb`.

### Railway point cloud (SNCF Réseau)

About 1.3 km of double-track line with catenary, colourised and classified LiDAR, 150 million
points in 16 LAZ tiles (1.1 GB, 2013, RGF93 CC44). Source:
[SNCF Réseau, "Nuage de points 3D des infrastructures ferroviaires"](https://www.data.gouv.fr/datasets/nuage-de-points-3d-des-infrastructures-ferroviaires),
ODbL 1.0. The dataset does not say how it was captured. It is too large for the repository,
so `tools/fetch-sncf-pointcloud.sh` downloads it to `models/source/sncf-rail/` and converts it
with [py3dtiles](https://py3dtiles.org) into a streamable 3D Tiles point cloud in
`models/tiles/sncf-rail/` (both ignored by git). Serve it from the laptop over USB or any
static host.

Any other glTF/GLB can be loaded on the phone with **Open .glb…**, for example your own drone
scan exported from DJI Terra, Pix4D, RealityScan or Polycam. For a model with a large
georeferenced offset or Z-up axes, the viewer finds the up axis and centers the model
automatically. Keep scans for phones under ~50 MB, with textures of 4096 px or less.

### Converting your own IFC model

```bash
pip install ifcopenshell trimesh numpy
```
```bash
python3 tools/ifc2glb.py architecture.ifc structure.ifc mep.ifc -o models/my-building.glb
```

Then add an entry to `MODELS` in `js/config.js`. Each IFC file becomes a layer that can be toggled in the viewer.

For railway models, `--rail-layers` makes the layers track, signalling, cables, energy and
technical building instead, and `--focus` crops kilometres of track to the area around the
listed classes (needs `pip install scipy`). The level crossing was made with:

```bash
python3 tools/ifc2glb.py Signaling_LC_incl_Track_Cables.ifc --rail-layers --focus IfcSignal,IfcDoor,IfcSensor,IfcJunctionBox,IfcCableSegment,IfcBuiltElement,IfcFurniture --margin 12 -o models/rail-level-crossing.glb
```

### Streaming large models (3D Tiles)

A phone can't load a scan of a whole station or a large federated BIM model as one GLB (it runs
out of memory, and the download takes too long). For those, the model is cut into a
[3D Tiles](https://www.ogc.org/standard/3dtiles/) tileset: several levels of detail, each split
into tiles. The phone downloads only the tiles in view, at the detail the current distance
needs: coarse when the whole model is on the sheet, finer as you move closer to one part. Tiles
it no longer needs are dropped (at most ~250 MB are kept). The debug overlay shows how many tiles
are drawn, how deep in the hierarchy (depth) and how much is cached.

Make a tileset from a GLB, glTF or OBJ (a drone scan, or a BIM model converted with
`tools/ifc2glb.py`) with `tools/glb2tiles.py`. It needs [Obj2Tiles](https://github.com/OpenDroneMap/Obj2Tiles/releases)
(OpenDroneMap, open source; unzip a release into `tools/Obj2Tiles/` or put it on the PATH):

```bash
pip install trimesh numpy pillow
```
```bash
python3 tools/glb2tiles.py my-scan.glb -o models/tiles/my-scan
```

Use `--lods 5` (or more) for models above ~500k triangles, so the first download (the coarsest
level) stays small; `--up y` or `--up z` if the guessed up axis is wrong. Then add an entry with
`tiles` instead of `url` to `MODELS` in `js/config.js`:

```js
{ id: 'my-scan', name: 'My scan', kind: 'Drone scan (streamed)', tiles: 'models/tiles/my-scan/tileset.json', credit: '…' },
```

Any other 3D Tiles tileset (Cesium ion export, DJI Terra, Pix4D, ContextCapture, …) can be
opened without changing the code: add `?tiles=<URL of tileset.json>` to the demo URL, e.g.
`demo1.html?tiles=models/tiles/my-scan/tileset.json`. Georeferenced tilesets are moved to the
sheet automatically.

`tools/make-tiles.sh` downloads and converts the two railway station scans. The abandoned
station (10 MB) is committed. The Mount Royal station (Katie Wolfe, CC BY 4.0, 1M triangles,
about 110 MB of tiles) is not; after running the script, open it with
`demo1.html?tiles=models/tiles/mount-royal-station/tileset.json`.

**Hosting tiles:** a tileset is a folder of plain static files, so anything that serves this demo
serves tiles too: the laptop over USB (`python3 -m http.server`), GitHub Pages (keep each file
under 100 MB and the whole site under 1 GB), or cloud storage (S3, Azure Blob, Google Cloud
Storage) for big models. When the tiles are on another host than the demo, that host must allow
cross-origin requests (CORS) from the demo's address.

## Run it

1. **Print** the sheets on DIN A4 at 100 % scale (matte paper works best):
   - [`markers/demo1-board-A4.pdf`](markers/demo1-board-A4.pdf): 1 page, landscape
   - [`markers/demo2-table-corners-A4.pdf`](markers/demo2-table-corners-A4.pdf): 4 pages, portrait

   Or open `markers.html` and print from the browser.
2. **Place** them. For Demo 1, lay the sheet flat on a table. For Demo 2, push each sheet into its
   labelled corner of the table with the arrow pointing to the side you stand on.
3. **Open** the site on the phone over **HTTPS** (browsers only allow the camera on secure
   pages), choose a demo and tap *Start camera*.
4. **Demo 2, first run:** step back until at least three corner sheets are in view. The table is
   measured in a few seconds and remembered on the phone. 📏 measures again or lets you type the size.

👁 hides all controls for a clean view while presenting.

### Hosting options (camera needs HTTPS or localhost)

- **GitHub Pages** (simplest): go to *Settings → Pages → Deploy from a branch*, pick the branch
  that holds these files and `/ (root)`, then wait 1–2 minutes for the deploy to finish (see the
  *Actions* tab). The demo is then at `https://<owner>.github.io/<repo>/`, e.g.
  `https://universitystuff.github.io/Work-AR-Testing/`.
  Private repos need a paid GitHub plan for Pages.
- **Any static HTTPS host** works too (Netlify Drop, Cloudflare Pages, an internal web server).
- **Laptop + USB cable**, no hosting needed:
  ```bash
  python3 -m http.server 8000
  ```
  ```bash
  adb reverse tcp:8000 tcp:8000
  ```
  Then open `http://localhost:8000` in Chrome on the phone.
- Opening the files directly (double-click, `file://`, or the file view on github.com) or over
  plain `http://` with an IP address does **not** work. The pages show a red message explaining
  the problem when that happens.

## Tips and troubleshooting

- Use good, even light and avoid glare on the paper.
- The debug overlay (marker outlines, status lines and red/green/blue axes at the tracked origin) is on by default; `?nodebug` hides it. `?bg=video` shows the camera through the `<video>` element instead of drawing it inside WebGL.
- The camera focal length is estimated automatically from the markers (best while two or more
  markers are in view at an angle) and remembered on the phone. `?f=0.85` forces a value (as a
  fraction of the longer image side). The debug status lines show the estimate, the pose
  error and how many triangles are being drawn.
- If the table measurement warns that the sheets don't line up, check that each sheet is in its
  labelled corner and that all arrows point to the front.

## How it works

```
camera (getUserMedia) ──► frame downscaled to ≤960/1280 px ──► Web Worker: js-aruco2 (ARUCO_MIP_36h12)
                                                                       │ marker IDs + corners
three.js + GLTFLoader ◄── smoothed pose ◄── homography + Levenberg-Marquardt refinement (js/ar.js)
```

- `js/config.js`: marker IDs, sizes and layouts, plus the model list. Both `markers.html`
  (printing) and the trackers read it.
- `js/ar.js`: camera, detection worker, planar pose estimation and the three.js scene.
- `js/models.js`: GLB loading (Draco and meshopt supported), up-axis detection and fitting the
  model to the sheet or the table. Tilesets are streamed with 3d-tiles-renderer, fitted to their
  root bounding volume, and updated right before every frame with the AR camera, so tile detail
  follows the real distance and the estimated focal length.
- `js/viewer.js`: model picker, rotate, BIM layers and the clean-view toggle.
- `js/demo1.js` / `js/demo2.js`: the two setups. Demo 2 measures the table by finding the marker
  spacing for which all visible corner markers fit one plane mapping.
- `vendor/`: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0,
  [three.js](https://threejs.org) r160 with its glTF/Draco/meshopt addons, and
  [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) 0.3.46 (the last release
  for three r160; its `three` imports are rewritten to `vendor/three/` by
  `tools/vendor-3d-tiles.mjs`, so no bundler is needed) (all MIT or Apache-2.0, licenses included).

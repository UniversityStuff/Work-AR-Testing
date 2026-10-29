#!/usr/bin/env bash
# Downloads the two railway station drone scans and turns them into streamed
# 3D Tiles tilesets with tools/glb2tiles.py (needs Python with trimesh, numpy,
# pillow, and Obj2Tiles; see that script).
#   tools/make-tiles.sh
# models/tiles/abandoned-station (10 MB) is committed. models/tiles/mount-royal-station
# (about 110 MB) is not; open it with demo1.html?tiles=models/tiles/mount-royal-station/tileset.json
# Sources (both CC BY 4.0):
#   Vasilis Haroupas, "Abandoned Train Station", https://zenodo.org/records/10340913
#   Katie Wolfe, "Mount Royal Train Station", https://zenodo.org/records/10313120
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() {
  echo "Downloading $1"
  curl -fL --retry 3 -o "$tmp/$2" "$1"
}

fetch "https://zenodo.org/api/records/10340913/files/5142b456d67546fc9abbd29d1693639e.glb/content" abandoned.glb
"$PY" tools/glb2tiles.py "$tmp/abandoned.glb" -o models/tiles/abandoned-station

# 1M triangles: more levels, so the first download (the coarsest level) stays small.
fetch "https://zenodo.org/api/records/10313120/files/4d85efed1df547988c00c6f604b7814a.glb/content" mount-royal.glb
"$PY" tools/glb2tiles.py "$tmp/mount-royal.glb" -o models/tiles/mount-royal-station --lods 5

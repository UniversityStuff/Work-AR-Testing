#!/usr/bin/env bash
# Downloads SNCF Réseau's open railway point cloud (about 2 km of track, 16 LAZ
# tiles, ~1.1 GB, colourised and classified, RGF93 CC44 / EPSG:3944) and turns
# it into a 3D Tiles point cloud the viewer can stream (~2.3 GB, not committed).
#   pip install "py3dtiles[las]"
#   tools/fetch-sncf-pointcloud.sh
# Source: https://www.data.gouv.fr/datasets/nuage-de-points-3d-des-infrastructures-ferroviaires
# License: ODbL 1.0, © SNCF Réseau
set -euo pipefail
cd "$(dirname "$0")/.."
src=models/source/sncf-rail
out=models/tiles/sncf-rail
mkdir -p "$src" "$(dirname "$out")"

# File list (name + URL) published next to the dataset.
curl -fsSL "https://www.data.gouv.fr/api/1/datasets/r/0fa60b39-2349-4b66-8e83-731e616baca0" |
  "${PYTHON:-python3}" -c 'import json, sys; [print(f["file"]["filename"], f["file"]["url"]) for f in json.load(sys.stdin)]' |
  tr -d '\r' > "$src/files.txt"

while read -r name url; do
  [ -s "$src/$name" ] && continue
  echo "Downloading $name"
  curl -fL --retry 3 -o "$src/$name" "$url"
done < "$src/files.txt"

py3dtiles convert "$src"/*.laz --out "$out" --overwrite

# py3dtiles puts the map offset (EPSG:3944, millions of metres) into the root
# transform. The tile renderer would take that for a position on the globe and
# tilt the model, so keep it only as metadata: the viewer centres models anyway.
"${PYTHON:-python3}" - "$out/tileset.json" <<'EOF'
import json, sys
path = sys.argv[1]
t = json.load(open(path))
m = t['root'].pop('transform', None)
if m:
    t['asset'].setdefault('extras', {})['epsg3944_offset'] = m[12:15]
json.dump(t, open(path, 'w'))
EOF
du -sh "$out"

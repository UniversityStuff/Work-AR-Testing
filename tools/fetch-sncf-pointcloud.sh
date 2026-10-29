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

# Keep the source coordinates (metres, Z up); the tileset's root transform
# carries the offset, and the viewer centres the model on the markers.
py3dtiles convert "$src"/*.laz --out "$out" --overwrite
du -sh "$out"

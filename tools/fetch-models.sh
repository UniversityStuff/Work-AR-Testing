#!/usr/bin/env bash
# Downloads the drone scan into models/ so the demo doesn't have to fetch it
# from Hugging Face at runtime (e.g. for offline presentations).
#   tools/fetch-models.sh
# Source: https://github.com/Matt1Up/drone-building-scans-dataset (CC BY 4.0)
set -euo pipefail
cd "$(dirname "$0")/.."
url="https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/model/flat-roof.glb"
echo "Downloading $url"
curl -fL --retry 3 -o models/drone-flat-roof.glb "$url"
ls -lh models/drone-flat-roof.glb

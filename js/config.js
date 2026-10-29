// Single source of truth for the printed sheets, the trackers and the models.
// All sizes are in meters. Sheet/table coordinates: origin at the center,
// +x to the right, +y away from the viewer (towards the top edge / back of
// the table), +z up out of the paper.

export const DICTIONARY = 'ARUCO_MIP_36h12';
// Reject detections with more flipped bits than this (36h12 can correct up to 5).
export const MAX_HAMMING = 3;

// Demo 1: one DIN A4 sheet in landscape with a marker in every corner.
// Any single visible marker is enough to track the whole sheet.
const BOARD_W = 0.297, BOARD_H = 0.210, BOARD_MARKER = 0.05, BOARD_MARGIN = 0.014;
const bx = BOARD_W / 2 - BOARD_MARGIN - BOARD_MARKER / 2;
const by = BOARD_H / 2 - BOARD_MARGIN - BOARD_MARKER / 2;

export const BOARD = {
  page: { width: BOARD_W, height: BOARD_H },
  markerSize: BOARD_MARKER,
  markers: [
    { id: 0, x: -bx, y: by },   // top left
    { id: 1, x: bx, y: by },    // top right
    { id: 2, x: bx, y: -by },   // bottom right
    { id: 3, x: -bx, y: -by },  // bottom left
  ],
};

// Demo 2: four DIN A4 sheets (portrait), one per table corner, all with their
// bottom edge facing the front of the table. The marker is centered on the
// sheet, so a sheet pushed into a corner has its marker center this far from
// the side edge (x) and the front/back edge (y):
export const CORNER_PAGE = { width: 0.210, height: 0.297 };
export const CORNER_MARKER_SIZE = 0.17;
export const CORNER_INSET = { x: CORNER_PAGE.width / 2, y: CORNER_PAGE.height / 2 };

export const TABLE_CORNERS = [
  { id: 4, key: 'front-left', label: 'Front left', sx: -1, sy: -1 },
  { id: 5, key: 'front-right', label: 'Front right', sx: 1, sy: -1 },
  { id: 6, key: 'back-right', label: 'Back right', sx: 1, sy: 1 },
  { id: 7, key: 'back-left', label: 'Back left', sx: -1, sy: 1 },
];

export const DEFAULT_TABLE = { width: 1.6, depth: 0.8 }; // outer table size

// Marker layout for a table of the given outer size.
export function tableBoard({ width, depth }) {
  const hx = width / 2 - CORNER_INSET.x, hy = depth / 2 - CORNER_INSET.y;
  return {
    markerSize: CORNER_MARKER_SIZE,
    markers: TABLE_CORNERS.map((c) => ({ id: c.id, x: c.sx * hx, y: c.sy * hy })),
  };
}

// Models the viewer can show. `url` is tried first, then `fallbackUrl`; `tiles` is a 3D Tiles tileset.json.
// Models are standard glTF (Y up). `up: 'auto'` guesses the up axis for scans
// exported in other conventions.
const BS_CREDIT = 'buildingSMART International, "Simple-Scene" sample (IFC4), CC BY 4.0';
const DRONE_CREDIT = 'Matt1up, "drone-building-scans" flat-roof reconstruction, CC BY 4.0';
const FTIA_CREDIT = 'Finnish Transport Infrastructure Agency (FTIA), Toivola level crossing, via buildingSMART IFC Rail sample files (UT_DPE_5)';
export const MODELS = [
  { id: 'crossing', name: 'Level crossing, Toivola (FI)', kind: 'Rail BIM (IFC 4.3)', url: 'models/rail-level-crossing.glb', credit: FTIA_CREDIT },
  { id: 'house', name: 'Single-family house', kind: 'BIM (IFC)', url: 'models/bim-house.glb', credit: BS_CREDIT },
  { id: 'site', name: 'House, road, rail & bridge site', kind: 'BIM (IFC)', url: 'models/bim-site.glb', credit: BS_CREDIT },
  {
    id: 'drone', name: 'Commercial building', kind: 'Drone scan', up: 'auto', credit: DRONE_CREDIT,
    url: 'models/drone-flat-roof.glb',
    fallbackUrl: 'https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/main/flat-roof/model/flat-roof.glb',
    note: 'about 22 MB, loads from Hugging Face',
  },
  // 3D Tiles tilesets (tools/glb2tiles.py) are streamed: only the tiles in view, at the detail needed.
  {
    id: 'station-tiles', name: 'Abandoned train station', kind: 'Drone scan (streamed)', tiles: 'models/tiles/abandoned-station/tileset.json',
    credit: 'Vasilis Haroupas, "Abandoned Train Station", CC BY 4.0',
  },
];

// Corners of a square marker in the order the detector reports them
// (top-left, top-right, bottom-right, bottom-left), around center (cx, cy).
export function markerCorners(cx, cy, size) {
  const h = size / 2;
  return [
    { x: cx - h, y: cy + h },
    { x: cx + h, y: cy + h },
    { x: cx + h, y: cy - h },
    { x: cx - h, y: cy - h },
  ];
}

// Image/plane correspondences for all detected markers that belong to a board.
export function boardCorrespondences(board, markers) {
  const obj = [], img = [];
  for (const m of markers) {
    const def = board.markers.find((b) => b.id === m.id);
    if (!def) continue;
    obj.push(...markerCorners(def.x, def.y, board.markerSize));
    img.push(...m.corners);
  }
  return { obj, img };
}

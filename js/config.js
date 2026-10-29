// Single source of truth for the printed sheets and the trackers.
// All sizes are in meters. Sheet coordinates: origin as noted, +x to the
// right, +y towards the top edge of the sheet, +z out of the paper.

export const DICTIONARY = 'ARUCO_MIP_36h12';
// Reject detections with more flipped bits than this (36h12 can correct up to 5).
export const MAX_HAMMING = 3;

// Demo 1: one DIN A4 sheet in landscape with a marker in every corner.
// Any single visible marker is enough to track the whole sheet, so hands
// can cover parts of it while "working".
const BOARD_W = 0.297, BOARD_H = 0.210, BOARD_MARKER = 0.05, BOARD_MARGIN = 0.014;
const bx = BOARD_W / 2 - BOARD_MARGIN - BOARD_MARKER / 2;
const by = BOARD_H / 2 - BOARD_MARGIN - BOARD_MARKER / 2;

export const BOARD = {
  page: { width: BOARD_W, height: BOARD_H },     // origin = center of the sheet
  markerSize: BOARD_MARKER,
  markers: [
    { id: 0, x: -bx, y: by },   // top left
    { id: 1, x: bx, y: by },    // top right
    { id: 2, x: bx, y: -by },   // bottom right
    { id: 3, x: -bx, y: -by },  // bottom left
  ],
};

// Demo 2: four DIN A4 sheets (portrait), one big marker each, placed apart.
// Origin of each station = center of its marker.
export const STATION_PAGE = { width: 0.210, height: 0.297 };
export const STATION_MARKER_SIZE = 0.17;
export const STATION_MARKER_TOP = 0.02; // distance from top edge of the page

export const STATIONS = [
  { id: 4, key: 'A', name: 'Storage',    color: '#3b82f6', info: ['Bin A-03 · Sensor X-12', '14 pcs in stock'] },
  { id: 5, key: 'B', name: 'Assembly',   color: '#f59e0b', info: ['Line 2 · Unit P-200', 'Cycle 48 s · OEE 87 %'] },
  { id: 6, key: 'C', name: 'Test bench', color: '#a855f7', info: ['Temp 41 °C · 2.3 bar', 'Bench free'] },
  { id: 7, key: 'D', name: 'Shipping',   color: '#10b981', info: ['Order #4711', 'Pickup today 14:30'] },
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

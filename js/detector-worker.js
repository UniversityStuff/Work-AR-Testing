// Runs ArUco detection off the main thread so the camera preview stays smooth.
importScripts('../vendor/aruco/cv.js', '../vendor/aruco/aruco.js');

let detector = null;
let allocated = 0;

onmessage = (e) => {
  const { width, height, data, scale, dictionary, maxHamming } = e.data;
  if (!detector) detector = new AR.Detector({ dictionaryName: dictionary, maxHammingDistance: maxHamming + 1 });

  // Typed buffers are much faster than the library's default plain arrays.
  if (allocated !== width * height) {
    allocated = width * height;
    detector.grey = new CV.Image(width, height, new Uint8ClampedArray(allocated));
    detector.thres = new CV.Image(width, height, new Uint8ClampedArray(allocated));
  }

  const t0 = performance.now();
  const found = detector.detect({ width, height, data: new Uint8ClampedArray(data) });
  const markers = found.map((m) => {
    // Contour corners are the centers of the outermost black pixels; the real
    // edge lies half a pixel further out, so push each corner away from the center.
    const cx = m.corners.reduce((s, c) => s + c.x, 0) / 4, cy = m.corners.reduce((s, c) => s + c.y, 0) / 4;
    return {
      id: m.id,
      corners: m.corners.map((c) => ({
        x: (c.x + 0.5 + 0.5 * Math.sign(c.x - cx)) / scale,
        y: (c.y + 0.5 + 0.5 * Math.sign(c.y - cy)) / scale,
      })),
    };
  });
  postMessage({ markers, ms: performance.now() - t0 });
};

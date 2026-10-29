# AR at Work: phone demo for the AR-glasses case

Two short hands-on AR demos that use printed fiducial markers (ArUco). They run in
**Chrome on Android** as a plain web page: no app, no install, no build step.
Each demo ends with a summary of what holding the phone cost the user (taps,
tracking losses, time without guidance in view), which you can use to argue for
AR glasses.

| | Demo 1: one A4 sheet | Demo 2: four A4 sheets spread apart |
|---|---|---|
| Scenario | Guided filter change at one workstation | Repair order across four stations (A → C → B → D) |
| Markers | 4 corner markers on one landscape A4 sheet (IDs 0–3). One visible marker is enough. | 1 large marker per portrait A4 sheet (IDs 4–7) |
| AR content | Virtual machine on the sheet, animated parts, arrows, callouts | Live info panel, 3D icon and task status above each station; progress ring while calibrating |
| Measured | total time, taps, tracking losses, time without guidance | total time, % of time with no AR guidance in view, times the phone was aimed, calibration interruptions, wrong-station views, taps |

## Run it

1. **Print** the sheets on DIN A4 at 100 % scale (matte paper works best):
   - [`markers/demo1-board-A4.pdf`](markers/demo1-board-A4.pdf): 1 page, landscape
   - [`markers/demo2-stations-A4.pdf`](markers/demo2-stations-A4.pdf): 4 pages, portrait

   Or open `markers.html` and print from the browser.
2. **Place** them. For Demo 1, lay the sheet flat on a table. For Demo 2, tape the four
   sheets around the room a few meters apart, at chest height (on walls, shelves or tables).
3. **Open** the site on the phone over **HTTPS** (browsers only allow the camera on secure
   pages), choose a demo and tap *Start camera*.

### Hosting options (camera needs HTTPS or localhost)

- **GitHub Pages** (simplest): go to *Settings → Pages → Deploy from a branch*, pick the branch
  and `/ (root)`. The demo is then at `https://<owner>.github.io/<repo>/`.
  Private repos need a paid GitHub plan for Pages.
- **Any static HTTPS host** works too (Netlify Drop, Cloudflare Pages, an internal web server).
  Upload the folder as it is.
- **Laptop + USB cable**, no hosting needed:
  ```bash
  python3 -m http.server 8000
  ```
  ```bash
  adb reverse tcp:8000 tcp:8000
  ```
  Then open `http://localhost:8000` in Chrome on the phone. Chrome treats `localhost` as secure.

## Tips and troubleshooting

- Use good, even light and avoid glare on the paper. In Demo 2 the large markers are detected from about 3–4 m away.
- `?debug` (e.g. `demo1.html?debug`) outlines the detected markers and their IDs.
- `?f=0.85` overrides the assumed camera focal length (as a fraction of the longer image side;
  the default of 0.75 fits most phone main cameras). Change it if 3D objects seem to float or
  sink relative to the paper at steep viewing angles.

## How it works

```
camera (getUserMedia) ──► frame downscaled to ≤960/1280 px ──► Web Worker: js-aruco2 (ARUCO_MIP_36h12)
                                                                       │ marker IDs + corners
three.js overlay ◄── smoothed pose ◄── homography + Levenberg-Marquardt refinement (js/ar.js)
```

- `js/config.js` is the single source of truth for marker IDs, sizes and positions. Both
  `markers.html` (printing) and the trackers read it, so the printed sheets and the
  tracking always match.
- `js/ar.js` has the camera, the detection worker, planar pose estimation and the three.js scene
  (the projection is matched to the `object-fit: cover` video).
- `js/demo1.js` and `js/demo2.js` hold the scenario logic and the 3D content.
- `vendor/` holds the libraries, committed so the demo also works without CDN access:
  [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 and
  [three.js](https://threejs.org) r160 (both MIT, licenses included).

To change the scenario text (e.g. to translate it or use your own process), edit `STEPS` in
`js/demo1.js`, `TASKS` in `js/demo2.js` and `STATIONS` in `js/config.js`.

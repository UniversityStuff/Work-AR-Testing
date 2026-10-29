// Small DOM helpers shared by both demos.
import { startCamera, enterPresentationMode, DEBUG } from './ar.js';

export const $ = (sel) => document.querySelector(sel);

window.__appReady = true; // seen by diagnostics.js

// Wires up the start overlay: on tap, go fullscreen, open the camera, then call onReady().
export function bootStartOverlay(onReady) {
  const overlay = $('#start'), button = $('#start-btn'), err = $('#start-error');
  if (!DEBUG) $('#debug').remove();
  button.addEventListener('click', async () => {
    button.disabled = true;
    err.hidden = true;
    try {
      await enterPresentationMode();
      await startCamera($('#video'));
      overlay.classList.add('hidden');
      onReady();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in the browser settings and try again.'
        : (e.message || String(e));
      button.disabled = false;
    }
  });
}

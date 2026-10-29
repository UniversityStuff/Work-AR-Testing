// Small DOM helpers shared by both demos.
import { startCamera, enterPresentationMode, DEBUG } from './ar.js';

export const $ = (sel) => document.querySelector(sel);

export function formatTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

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

export function metric(value, label, bad = false) {
  return `<div class="metric${bad ? ' bad' : ''}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
}

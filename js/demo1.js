// Demo 1: a whole BIM model (or drone scan) standing on one A4 sheet.
import { ARScene, MarkerTracker, runLoop } from './ar.js';
import { BOARD, boardCorrespondences } from './config.js';
import { ModelStage } from './models.js';
import { createViewer } from './viewer.js';
import { $, bootStartOverlay } from './ui.js';

bootStartOverlay(() => {
  const ar = new ARScene({ video: $('#video'), canvas: $('#gl'), debugCanvas: $('#debug') });
  const tracker = new MarkerTracker($('#video'));
  const stage = new ModelStage(ar.anchor('board'));
  stage.setArea(BOARD.page.width, BOARD.page.height, 0.96);
  createViewer(stage, { defaultModel: 'crossing' });

  runLoop({
    tracker,
    ar,
    onMarkers(markers, now) {
      const { obj, img } = boardCorrespondences(BOARD, markers);
      if (obj.length) ar.updateAnchor('board', obj, img, now);
    },
    onFrame() {
      const tracked = ar.isVisible('board');
      $('#banner').classList.toggle('hidden', tracked);
      $('#track-chip').classList.toggle('on', tracked);
      $('#track-label').textContent = tracked ? 'Tracking' : 'Searching';
    },
  });

  window.arDebug = { ar, tracker, stage };
});

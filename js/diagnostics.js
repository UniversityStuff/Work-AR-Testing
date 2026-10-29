// Classic (non-module) script loaded first on every page. If something goes
// wrong (wrong way of opening the page, a script that fails to load, a runtime
// error), it shows a visible message instead of leaving a dead page.
(function () {
  var box = null;
  function show(msg) {
    if (!box) {
      box = document.createElement('div');
      box.id = 'diagnostics';
      box.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99;padding:12px 14px;border-radius:12px;' +
        'background:#7f1d1d;color:#fff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
        'white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent += (box.textContent ? '\n\n' : '') + msg;
  }
  window.showDiagnostic = show;

  function check() {
    if (location.protocol === 'file:') {
      show('This page was opened as a local file (file://). Browsers block the camera and the scripts there.\n' +
        'Open it through a web server instead: GitHub Pages (https://…github.io/…) or "python3 -m http.server" plus "adb reverse" (see README).');
    } else if (!window.isSecureContext) {
      show('This page is not a secure page (' + location.origin + '). Chrome only allows the camera on https:// or http://localhost.\n' +
        'Use the GitHub Pages https:// link, or connect the phone by USB and run "adb reverse tcp:8000 tcp:8000", then open http://localhost:8000.');
    }
    // Pages with type="module" scripts set window.__appReady once they have loaded.
    if (document.documentElement.hasAttribute('data-needs-app')) {
      setTimeout(function () {
        if (!window.__appReady && location.protocol !== 'file:') {
          show('The demo scripts did not load. Your browser may be too old (use a current Chrome), or files are missing on the server.\n' +
            'Check that ' + new URL('js/ar.js', location.href) + ' opens.');
        }
      }, 6000);
    }
  }

  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      show('Could not load ' + (e.target.src || e.target.href));
    } else {
      show('Error: ' + (e.message || e.error) + (e.filename ? '\n' + e.filename + ':' + e.lineno : ''));
    }
  }, true);
  // three.js reports shader/WebGL failures only on the console; surface them.
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var text = Array.prototype.map.call(arguments, function (a) { return a && a.message || String(a); }).join(' ');
      if (/THREE|WebGL|shader|GL_/i.test(text)) show('console.' + level + ': ' + text.slice(0, 600));
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show('Error: ' + (r && (r.message || r.name) || r));
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();

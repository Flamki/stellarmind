// Accessibility enhancements — Closes #35
(function () {
  'use strict';

  function injectSkipLink() {
    var skipLink = document.createElement('a');
    skipLink.href = '#main-content';
    skipLink.className = 'skip-link';
    skipLink.textContent = 'Skip to main content';
    document.body.prepend(skipLink);
  }

  function injectLiveRegion() {
    var region = document.createElement('div');
    region.id = 'aria-live-region';
    region.className = 'sr-only';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
  }

  function setupFocusTraps() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          var dialog = node.matches && node.matches('[role="dialog"], dialog')
            ? node
            : node.querySelector && node.querySelector('[role="dialog"], dialog');
          if (!dialog) return;

          var focusable = dialog.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (focusable.length === 0) return;

          var first = focusable[0];
          var last = focusable[focusable.length - 1];

          dialog.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') return;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          });

          setTimeout(function () { first.focus(); }, 100);
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    injectSkipLink();
    injectLiveRegion();
    setupFocusTraps();
  }
})();

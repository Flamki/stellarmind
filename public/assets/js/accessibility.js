/**
 * StellarMind Accessibility Module
 * Keyboard navigation, focus management, ARIA live regions
 * Closes #35
 */
(function () {
  'use strict';

  // ── Skip Link Injection ──────────────────────────────────────
  function injectSkipLink() {
    const skip = document.createElement('a');
    skip.href = '#main-content';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to main content';
    document.body.prepend(skip);
  }

  // ── Main Content Anchor ──────────────────────────────────────
  function ensureMainContentAnchor() {
    let main = document.querySelector('#main-content');
    if (!main) {
      const contentArea = document.querySelector('.main-content, main, [role="main"]');
      if (contentArea) {
        contentArea.id = 'main-content';
        contentArea.setAttribute('tabindex', '-1');
      } else {
        // Fallback: wrap main area
        const wrapper = document.querySelector('.content, .page-content, .dashboard-content');
        if (wrapper) {
          wrapper.id = 'main-content';
          wrapper.setAttribute('tabindex', '-1');
        }
      }
    }
  }

  // ── Live Region Announcer ────────────────────────────────────
  const announcer = (function () {
    let el = document.getElementById('a11y-announcer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'a11y-announcer';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      el.className = 'sr-only';
      document.body.appendChild(el);
    }
    return {
      announce: function (message) {
        el.textContent = '';
        // Force re-announce by clearing then setting
        requestAnimationFrame(() => {
          el.textContent = message;
        });
      },
    };
  })();

  // ── Focus Trap for Modals ────────────────────────────────────
  function trapFocus(container) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    function handleKeyDown(e) {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown);
    first.focus();

    // Return cleanup function
    return () => container.removeEventListener('keydown', handleKeyDown);
  }

  // ── Observe Modal Openings ───────────────────────────────────
  function observeModals() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const dialogs = node.querySelectorAll
            ? node.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal')
            : [];
          dialogs.forEach((dialog) => {
            if (dialog.getAttribute('aria-modal') === 'true') {
              trapFocus(dialog);
            }
          });
          // Also check if node itself is a modal
          if (
            node.getAttribute &&
            (node.getAttribute('aria-modal') === 'true' ||
              node.getAttribute('role') === 'dialog' ||
              node.classList.contains('modal'))
          ) {
            trapFocus(node);
          }
        });

        // Announce page changes
        if (mutation.target && mutation.target.getAttribute('aria-live') === 'polite') {
          return; // Don't double-announce
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // ── Keyboard Navigation for Cards / Panels ──────────────────
  function enhanceCardKeyboardNav() {
    document.addEventListener('keydown', (e) => {
      // Enter/Space on card-like elements
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target.closest('[role="button"], .card[tabindex]');
        if (target && target !== e.target) {
          e.preventDefault();
          target.click();
        }
      }
    });
  }

  // ── Initialize ──────────────────────────────────────────────
  function init() {
    injectSkipLink();
    ensureMainContentAnchor();
    observeModals();
    enhanceCardKeyboardNav();

    // Expose announcer globally for page scripts
    window.__a11y = {
      announce: announcer.announce,
      trapFocus: trapFocus,
    };

    console.log('[a11y] Accessibility module initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

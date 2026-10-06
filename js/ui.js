/**
 * ui.js — Shared UI primitives (modal dialog + toast notification)
 *
 * Extracted from app.js so the Blue/Red builder pages can reuse the exact
 * same modal and toast behaviour. Depends only on:
 *   • #modal-overlay / #modal-title / #modal-body / #modal-footer markup
 *   • .modal-* and .toast CSS in css/style.css
 * Must be loaded before any script that calls showModal() or showToast().
 */

// ─────────────────────────────────────────────────────────────────────────────
// Modal dialog
// ─────────────────────────────────────────────────────────────────────────────

let _modalResolve = null;

/**
 * Show a blocking in-page modal dialog.
 *
 * @param {object}   config
 * @param {string}   config.title    — Dialog heading
 * @param {string}   config.message  — Body text (plain text; no HTML)
 * @param {Array}    config.buttons  — Button descriptors, rendered left-to-right.
 *                                     Each: { label, value, style }
 *                                     style: 'primary' | 'secondary' | 'danger'
 *                                     Defaults to a single OK button.
 * @returns {Promise<any>}  Resolves with the `value` of the button clicked,
 *                          or false if dismissed via the ESC key.
 *
 * Usage:
 *   const ok = await showModal({
 *     title:   'Confirm Reset',
 *     message: 'All local changes will be lost.',
 *     buttons: [
 *       { label: 'Reset', value: true,  style: 'danger'     },
 *       { label: 'Cancel', value: false, style: 'secondary' }
 *     ]
 *   });
 *   if (ok) { ... }
 */
function showModal({ title, message, html: htmlBody, buttons = [{ label: 'OK', value: true, style: 'primary' }] }) {
  return new Promise(resolve => {
    _modalResolve = resolve;

    document.getElementById('modal-title').textContent = title;
    const bodyEl = document.getElementById('modal-body');
    if (htmlBody !== undefined) {
      bodyEl.innerHTML = htmlBody;
    } else {
      bodyEl.textContent = message || '';
    }

    const footer = document.getElementById('modal-footer');
    footer.innerHTML = '';
    for (const btn of buttons) {
      const el     = document.createElement('button');
      el.className = `btn btn-${btn.style || 'secondary'}`;
      el.textContent = btn.label;
      el.addEventListener('click', () => _resolveModal(btn.value));
      footer.appendChild(el);
    }

    document.getElementById('modal-overlay').classList.remove('hidden');

    // Put focus on the first button so keyboard users can act immediately
    const firstBtn = footer.querySelector('.btn');
    if (firstBtn) firstBtn.focus();
  });
}

function _resolveModal(value) {
  document.getElementById('modal-overlay').classList.add('hidden');
  if (_modalResolve) {
    _modalResolve(value);
    _modalResolve = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast notification
// ─────────────────────────────────────────────────────────────────────────────

function showToast(message, isError = false) {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id    = 'toast';
  toast.className = `toast ${isError ? 'toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* ============================================================
   ORAMA CAFÉ — shared UI helpers
   Toast notifications + promise-based confirm/prompt dialogs,
   so screens don't use the blocking native alert()/confirm()/
   prompt() popups. No dependencies.
   Load with:  <script src="/js/orama.js"></script>
   ============================================================ */
(function (global) {
  'use strict';

  var ICONS = { success: '✓', error: '✕', warning: '!', info: 'i' };

  function toastWrap() {
    var w = document.querySelector('.o-toast-wrap');
    if (!w) {
      w = document.createElement('div');
      w.className = 'o-toast-wrap';
      document.body.appendChild(w);
    }
    return w;
  }

  /**
   * Show a toast. type: 'success' | 'error' | 'warning' | 'info'
   * Returns nothing. Auto-dismisses (errors linger a little longer).
   */
  function toast(msg, type, opts) {
    type = type || 'info';
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'o-toast o-toast--' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    var icon = document.createElement('span');
    icon.className = 'o-toast__icon';
    icon.textContent = ICONS[type] || ICONS.info;

    var body = document.createElement('span');
    body.className = 'o-toast__msg';
    body.textContent = msg;

    el.appendChild(icon);
    el.appendChild(body);
    toastWrap().appendChild(el);

    requestAnimationFrame(function () { el.classList.add('is-in'); });

    var ms = opts.duration || (type === 'error' ? 5000 : 3000);
    var timer = setTimeout(remove, ms);
    el.addEventListener('click', function () { clearTimeout(timer); remove(); });

    function remove() {
      el.classList.remove('is-in');
      setTimeout(function () { el.remove(); }, 220);
    }
  }

  // Shorthands
  toast.success = function (m, o) { toast(m, 'success', o); };
  toast.error   = function (m, o) { toast(m, 'error', o); };
  toast.warning = function (m, o) { toast(m, 'warning', o); };
  toast.info    = function (m, o) { toast(m, 'info', o); };

  /* ---- dialog core ---------------------------------------- */
  function buildDialog(inner) {
    var overlay = document.createElement('div');
    overlay.className = 'o-dialog-overlay';
    var box = document.createElement('div');
    box.className = 'o-dialog';
    box.appendChild(inner);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('is-in'); });
    return {
      overlay: overlay,
      close: function () {
        overlay.classList.remove('is-in');
        setTimeout(function () { overlay.remove(); }, 180);
      }
    };
  }

  /**
   * Promise-based replacement for window.confirm().
   * Resolves true (confirmed) or false (cancelled / dismissed).
   * opts: { okText, cancelText, danger:Boolean }
   */
  function confirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var frag = document.createElement('div');

      var msg = document.createElement('div');
      msg.className = 'o-dialog__msg';
      msg.textContent = message;

      var actions = document.createElement('div');
      actions.className = 'o-dialog__actions';

      var cancel = document.createElement('button');
      cancel.className = 'btn btn--secondary';
      cancel.textContent = opts.cancelText || 'Cancelar';

      var ok = document.createElement('button');
      ok.className = 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary');
      ok.textContent = opts.okText || 'Aceptar';

      actions.appendChild(cancel);
      actions.appendChild(ok);
      frag.appendChild(msg);
      frag.appendChild(actions);

      var d = buildDialog(frag);
      function done(val) { d.close(); resolve(val); }
      cancel.addEventListener('click', function () { done(false); });
      ok.addEventListener('click', function () { done(true); });
      d.overlay.addEventListener('click', function (e) { if (e.target === d.overlay) done(false); });
      ok.focus();
    });
  }

  /**
   * Promise-based replacement for window.prompt().
   * Resolves the entered string, or null if cancelled.
   * opts: { value, placeholder, okText, cancelText, type }
   */
  function prompt(label, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var frag = document.createElement('div');

      var msg = document.createElement('div');
      msg.className = 'o-dialog__msg';
      msg.textContent = label;

      var input = document.createElement('input');
      input.className = 'input o-dialog__input';
      input.type = opts.type || 'text';
      if (opts.value != null) input.value = opts.value;
      if (opts.placeholder) input.placeholder = opts.placeholder;

      var actions = document.createElement('div');
      actions.className = 'o-dialog__actions';

      var cancel = document.createElement('button');
      cancel.className = 'btn btn--secondary';
      cancel.textContent = opts.cancelText || 'Cancelar';

      var ok = document.createElement('button');
      ok.className = 'btn btn--primary';
      ok.textContent = opts.okText || 'Aceptar';

      actions.appendChild(cancel);
      actions.appendChild(ok);
      frag.appendChild(msg);
      frag.appendChild(input);
      frag.appendChild(actions);

      var d = buildDialog(frag);
      function done(val) { d.close(); resolve(val); }
      cancel.addEventListener('click', function () { done(null); });
      ok.addEventListener('click', function () { done(input.value); });
      d.overlay.addEventListener('click', function (e) { if (e.target === d.overlay) done(null); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      });
      input.focus();
    });
  }

  global.Orama = { toast: toast, confirm: confirm, prompt: prompt };
})(window);

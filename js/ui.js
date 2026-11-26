/*
 * Общие элементы интерфейса: уведомление-«снэкбар» и модальные окна
 * (роль диалога, ловушка фокуса, возврат фокуса, Esc / Enter).
 */
(function () {
  'use strict';

  const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
  const $ = id => document.getElementById(id);
  const stack = []; // открытые окна: { el, opener }

  /* ---------- Снэкбар ---------- */
  let snackbarTimer = null;
  function snackbar(message) {
    const el = $('snackbar');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(snackbarTimer);
    snackbarTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  /* ---------- Модальные окна ---------- */
  function visibleFocusable(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  function showModal(el) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    const already = stack.find(s => s.el === el);
    if (!already) stack.push({ el, opener: document.activeElement });
    el.style.display = 'flex';
    const dialog = el.querySelector('.modal');
    const target = el.querySelector('[data-autofocus]') || (dialog && visibleFocusable(dialog)[0]);
    if (target) target.focus();
  }

  function hideModal(el) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    el.style.display = 'none';
    el.querySelectorAll('.error-text').forEach(e => { e.style.display = 'none'; });
    const idx = stack.findIndex(s => s.el === el);
    if (idx === -1) return;
    const opener = stack[idx].opener;
    stack.splice(idx, 1);
    if (opener && opener.isConnected && typeof opener.focus === 'function' && !stack.length) {
      try { opener.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function topModal() {
    return stack.length ? stack[stack.length - 1].el : null;
  }

  function dismissTop() {
    const el = topModal();
    if (!el) return;
    const btn = el.querySelector('.modal-cancel') || el.querySelector('.modal-confirm');
    if (btn) btn.click(); else hideModal(el);
  }

  document.addEventListener('keydown', function (e) {
    const el = topModal();
    if (!el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissTop();
    } else if (e.key === 'Tab') {
      const items = visibleFocusable(el.querySelector('.modal') || el);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text' && e.target.id !== 'promptInput') {
      const ok = el.querySelector('.modal-confirm:not(:disabled)');
      if (ok) { e.preventDefault(); ok.click(); }
    }
  });

  // Клик по затемнённому фону = отмена.
  document.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('modal-overlay') && e.target === topModal()) dismissTop();
  });

  /* ---------- Alert / Confirm / Prompt ---------- */
  function alertModal(title, message, callback) {
    $('alertTitle').textContent = title || 'Уведомление';
    $('alertMessage').textContent = message || '';
    const modal = $('alertModal');
    showModal(modal);
    $('alertOkBtn').onclick = function () {
      hideModal(modal);
      if (callback) callback();
    };
  }

  function confirmModal(title, message, onConfirm, onCancel, isDanger) {
    $('confirmTitle').textContent = title || 'Подтверждение';
    $('confirmMessage').textContent = message || '';
    const modal = $('confirmModal');
    const yes = $('confirmYesBtn');
    yes.classList.toggle('danger', !!isDanger);
    showModal(modal);
    yes.onclick = function () {
      hideModal(modal);
      if (onConfirm) onConfirm();
    };
    $('confirmNoBtn').onclick = function () {
      hideModal(modal);
      if (onCancel) onCancel();
    };
  }

  function promptModal(title, message, defaultValue, onConfirm, onCancel) {
    $('promptTitle').textContent = title || 'Ввод';
    $('promptMessage').textContent = message || '';
    const input = $('promptInput');
    input.value = defaultValue || '';
    const modal = $('promptModal');
    showModal(modal);
    input.focus();
    $('promptOkBtn').onclick = function () {
      const val = input.value.trim();
      hideModal(modal);
      if (onConfirm) onConfirm(val);
    };
    $('promptCancelBtn').onclick = function () {
      hideModal(modal);
      if (onCancel) onCancel();
    };
    input.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('promptOkBtn').click(); }
    };
  }

  window.TabelUI = {
    snackbar, showModal, hideModal,
    alert: alertModal, confirm: confirmModal, prompt: promptModal
  };
})();

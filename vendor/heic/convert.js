/* Обработчик сообщений для sandbox-iframe: принимает HEIC/HEIF Blob и возвращает JPEG Blob. */
(function () {
  'use strict';
  window.addEventListener('message', async function (ev) {
    if (ev.source !== window.parent) return;
    const msg = ev.data;
    if (!msg || msg.type !== 'convert' || !(msg.blob instanceof Blob)) return;
    try {
      const out = await window.heic2any({ blob: msg.blob, toType: 'image/jpeg', quality: Number(msg.quality) || 0.9 });
      const blob = Array.isArray(out) ? out[0] : out;
      window.parent.postMessage({ type: 'result', id: msg.id, blob: blob }, '*');
    } catch (e) {
      window.parent.postMessage({ type: 'error', id: msg.id, message: String((e && e.message) || e) }, '*');
    }
  });
  window.parent.postMessage({ type: 'ready' }, '*');
})();

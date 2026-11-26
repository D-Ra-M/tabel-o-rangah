/*
 * Подготовка фото. Фото в таблице показывается маленьким, поэтому храним компактное
 * JPEG-превью (до 400 px по длинной стороне) вместо исходника.
 *
 * HEIC/HEIF конвертируется библиотекой heic2any. Ей нужны eval и blob-воркеры, поэтому
 * она запускается в изолированном sandbox-iframe (vendor/heic/convert.html) со своей
 * политикой безопасности: у неё нет доступа к данным приложения, а в самой странице
 * приложения строгая CSP без 'unsafe-eval'.
 */
(function () {
  'use strict';

  const MAX_INPUT = 30 * 1024 * 1024;   // исходный файл
  const THUMB_SIDE = 400;               // длинная сторона превью, px
  const JPEG_QUALITY = 0.82;
  const MAX_DATA_URL = 700000;          // потолок для готового превью

  const HEIC_URL = './vendor/heic/convert.html';

  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name || '') || /image\/(heic|heif)/i.test(file.type || '');
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
      reader.readAsDataURL(blob);
    });
  }

  /* ---------- HEIC через изолированный iframe ---------- */
  let frame = null;
  let frameReady = null;
  let seq = 0;
  const pending = new Map();

  function onFrameMessage(ev) {
    if (!frame || ev.source !== frame.contentWindow) return;
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      if (frame._onReady) frame._onReady();
      return;
    }
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.type === 'result' && msg.blob instanceof Blob) job.resolve(msg.blob);
    else job.reject(new Error('Не удалось преобразовать HEIC/HEIF. Выберите JPG или PNG.'));
  }

  function getFrame() {
    if (frameReady) return frameReady;
    frameReady = new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('title', 'Конвертер HEIC');
      iframe.tabIndex = -1;
      iframe.className = 'heic-frame';
      frame = iframe;
      const fail = () => {
        frameReady = null;
        frame = null;
        iframe.remove();
        reject(new Error('Для обработки HEIC/HEIF требуется интернет. Выберите JPG или PNG либо повторите попытку позже.'));
      };
      const timer = setTimeout(fail, 20000);
      iframe._onReady = () => { clearTimeout(timer); resolve(iframe); };
      iframe.onerror = () => { clearTimeout(timer); fail(); };
      window.addEventListener('message', onFrameMessage);
      iframe.src = HEIC_URL;
      document.body.appendChild(iframe);
    });
    return frameReady;
  }

  function convertHeic(file) {
    return getFrame().then(f => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Преобразование HEIC заняло слишком много времени.'));
      }, 90000);
      pending.set(id, { resolve, reject, timer });
      f.contentWindow.postMessage({ type: 'convert', id, blob: file, quality: 0.9 }, '*');
    }));
  }

  /* ---------- Превью ---------- */
  async function loadBitmap(blob) {
    try {
      if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
    } catch (e) { /* пробуем через <img> */ }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Формат изображения не поддерживается этим браузером.'));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function bitmapToThumb(bitmap) {
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    if (!width || !height) {
      if (bitmap.close) bitmap.close();
      throw new Error('Не удалось определить размер изображения.');
    }
    const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (bitmap.close) bitmap.close();
      throw new Error('Не удалось подготовить изображение.');
    }
    ctx.fillStyle = '#ffffff'; // JPEG без прозрачности
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось сжать изображение.')), 'image/jpeg', JPEG_QUALITY);
    });
    const dataUrl = await readAsDataUrl(blob);
    if (dataUrl.length > MAX_DATA_URL) throw new Error('Даже после сжатия фото получилось слишком большим. Выберите другое изображение.');
    return dataUrl;
  }

  // Файл (JPG/PNG/WebP/AVIF/GIF/HEIC) -> data-URL с компактным JPEG-превью.
  async function process(file) {
    let source = file;
    if (isHeic(file)) source = await convertHeic(file);
    return bitmapToThumb(await loadBitmap(source));
  }

  window.TabelPhoto = { MAX_INPUT, isHeic, process };
})();

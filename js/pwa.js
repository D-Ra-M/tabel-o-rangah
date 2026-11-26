/* Установка приложения (PWA) и регистрация service worker. */
(function () {
  'use strict';

  const UI = window.TabelUI;
  const installBtn = document.getElementById('installAppBtn');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  let installPrompt = null;

  if (!isStandalone) {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installPrompt = event;
      installBtn.hidden = false;
    });

    installBtn.addEventListener('click', async () => {
      if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        installBtn.hidden = true;
        return;
      }
      // Safari/iOS не предоставляет beforeinstallprompt.
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      UI.alert('Установка приложения', isIOS
        ? 'Чтобы установить приложение: нажмите «Поделиться» в Safari, затем «На экран Домой».'
        : 'Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».');
    });

    window.addEventListener('appinstalled', () => {
      installBtn.hidden = true;
      installPrompt = null;
    });
  }

  // Service worker нужен и в установленном приложении, поэтому регистрируем всегда.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              UI.snackbar('Доступна новая версия. Перезапустите приложение, чтобы обновиться.');
            }
          });
        });
      }).catch((error) => {
        console.warn('Не удалось зарегистрировать Service Worker:', error);
      });
    });
  }
})();

/* Быстрые проверки целостности проекта (запускаются в CI и перед публикацией). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;
function check(ok, message) {
  if (!ok) { failed++; console.error('✗ ' + message); } else console.log('✓ ' + message);
}
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// 1. Все файлы из APP_SHELL service worker существуют (иначе он не установится).
const sw = read('service-worker.js');
const shell = [...sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
shell.filter(u => u !== './').forEach(u => check(fs.existsSync(path.join(root, u)), 'APP_SHELL: ' + u));

// 2. Все скрипты, стили и иконки, на которые ссылается index.html, существуют и закэшированы.
const html = read('index.html');
[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1])
  .filter(u => !/^(https?:|data:)/.test(u))
  .forEach(u => {
    check(fs.existsSync(path.join(root, u)), 'index.html ссылается на существующий файл: ' + u);
    if (/\.(js|css)$/.test(u) && !u.startsWith('vendor/heic/')) check(shell.includes('./' + u), 'в кэше service worker: ' + u);
  });

// 3. Иконки манифеста существуют.
JSON.parse(read('manifest.webmanifest')).icons.forEach(i => check(fs.existsSync(path.join(root, i.src)), 'иконка манифеста: ' + i.src));

// 4. Нет inline-обработчиков и inline-стилей (иначе строгая CSP их заблокирует).
check(!/\son[a-z]+\s*=\s*"/i.test(html), 'в index.html нет inline-обработчиков (onclick=…)');
check(!/\sstyle\s*=\s*"/i.test(html), 'в index.html нет inline-стилей (style=…)');
check(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'в index.html нет inline-скриптов');
check(!/<style[\s>]/i.test(html), 'в index.html нет <style>');
['js/app.js', 'js/ui.js', 'js/photo.js', 'js/storage.js'].forEach(f => {
  const src = read(f);
  check(!/setAttribute\(\s*['"]style['"]/.test(src) && !/style="/.test(src), f + ': нет inline-стилей в разметке');
  check(!/\son(click|change|input)=/.test(src), f + ': нет inline-обработчиков в разметке');
});

// 5. Внешних адресов в коде нет (нет CDN и сторонних запросов).
['index.html', 'js/app.js', 'js/ui.js', 'js/photo.js', 'js/storage.js', 'js/pwa.js', 'service-worker.js'].forEach(f => {
  check(!/https?:\/\/(?!www\.w3\.org)/.test(read(f)), f + ': нет внешних URL');
});

// 6. Данные из vendor имеют лицензии.
check(fs.existsSync(path.join(root, 'vendor/SORTABLE-LICENSE.txt')), 'лицензия SortableJS');
check(fs.existsSync(path.join(root, 'vendor/heic/HEIC2ANY-LICENSE.md')), 'лицензия heic2any');

if (failed) { console.error('\nПроверок не пройдено: ' + failed); process.exit(1); }
console.log('\nВсе проверки пройдены');

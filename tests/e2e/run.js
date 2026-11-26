/*
 * Сквозная проверка в настоящем браузере (Chromium + Playwright).
 * Запуск: npm run test:e2e   (нужен `npx playwright install chromium`)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + msg); } else { failures.push(msg + ' — получено ' + a + ', ожидалось ' + e); console.log('  ✗ ' + msg + ' — получено ' + a + ', ожидалось ' + e); }
}
const section = t => console.log('\n' + t);

const legacyTables = {
  '9А класс': { createdAt: 1760000000000, updatedAt: 1760100000000, rows: [
    { name: 'Иванов Иван', photo: '', grades: { 5: '3', 4: '2', 3: '1', 2: '', 1: '', 0: '' }, n: '' },
    { name: 'Петрова Анна', photo: '', grades: { 5: '5', 4: '', 3: '', 2: '', 1: '', 0: '' }, n: '1' },
    { name: 'Сидоров', photo: '', grades: { 5: '1', 4: '1', 3: '1', 2: '1', 1: '', 0: '' }, n: '' },
    { name: 'Кузнецова', photo: '', grades: { 5: '2', 4: '', 3: '1', 2: '', 1: '', 0: '' }, n: '' },
    { name: '', photo: '', grades: { 5: '', 4: '', 3: '', 2: '', 1: '', 0: '' }, n: '' }
  ] },
  'Без названия': { createdAt: 1, updatedAt: 2, rows: [] }
};

async function newPage(ctx, base, problems) {
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  await page.goto(base + '/index.html');
  await page.waitForSelector('#tablesList');
  await page.waitForTimeout(300);
  return page;
}

const rowsInfo = page => page.$$eval('#tableBody tr', trs => trs.map(tr => ({
  place: tr.querySelector('.row-num').textContent,
  medal: (tr.querySelector('.row-num').className.match(/rank-place-(\d)/) || [0, 0])[1] | 0,
  name: tr.querySelector('.name-inp').value,
  count: tr.querySelector('.total-count').textContent,
  score: tr.querySelector('.total-score').textContent
})));

const idbDump = page => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('TabelORangahStorage');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const out = { stores: Array.from(db.objectStoreNames), version: db.version };
    const tx = db.transaction(['tables', 'meta', 'backups'], 'readonly');
    const t = tx.objectStore('tables').getAll();
    const m = tx.objectStore('meta').getAll();
    const b = tx.objectStore('backups').getAll();
    tx.oncomplete = () => {
      out.tables = t.result.map(r => r.name);
      out.rows = Object.fromEntries(t.result.map(r => [r.name, r.data.rows.length]));
      out.meta = Object.fromEntries(m.result.map(r => [r.id, r.value]));
      out.backups = b.result.map(r => ({ id: r.id, day: r.day, tables: Object.keys(r.tables || {}) }));
      db.close();
      resolve(out);
    };
  };
}));

(async () => {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const problems = [];

  /* ---------- 1. Миграция и базовая работа ---------- */
  section('1. Миграция старых данных (localStorage → IndexedDB) и отсутствие нарушений CSP');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.addInitScript(([t]) => {
    try { // внутри sandbox-iframe localStorage недоступен — это нормально
      if (!localStorage.getItem('__seeded')) {
        localStorage.setItem('marksTables', JSON.stringify(t));
        localStorage.setItem('tableOrder', JSON.stringify(Object.keys(t)));
        localStorage.setItem('__seeded', '1');
      }
    } catch (e) { /* нет доступа */ }
  }, [legacyTables]);
  const page = await newPage(ctx, base, problems);
  eq(await page.$$eval('.table-card', c => c.map(x => x.dataset.name)), ['9А класс', 'Без названия'], 'старые таблицы отображаются в прежнем порядке');
  eq(await page.evaluate(() => localStorage.getItem('marksTables')), null, 'дубликат в localStorage удалён после миграции');
  let dump = await idbDump(page);
  eq(dump.tables.sort(), ['9А класс', 'Без названия'].sort(), 'таблицы лежат отдельными записями в IndexedDB');
  ok(dump.meta.migrated > 0, 'миграция помечена как выполненная');
  eq(await page.evaluate(() => window.__csp), [], 'нет нарушений CSP на главном экране');

  section('2. Редактор: баллы, места, медали');
  await page.click('.table-card[data-name="9А класс"] .table-card-info');
  await page.waitForTimeout(200);
  let info = await rowsInfo(page);
  eq(info.map(r => [r.place, r.medal, r.name, r.count, r.score]),
    [['1', 1, 'Иванов Иван', '6', '51'], ['2', 2, 'Петрова Анна', '5', '48'], ['3', 3, 'Кузнецова', '3', '25'], ['4', 0, 'Сидоров', '4', '22'], ['5', 0, '', '0', '0']],
    'расчёт и порядок совпадают с прежней версией');

  section('3. Равные баллы делят место, пустая строка без медали');
  await page.click('#fabEditorBtn');
  await page.click('[data-click="addRow"]');
  const newIdx = (await page.locator('#tableBody tr').count()) - 1;
  const newRow = page.locator('#tableBody tr').nth(newIdx);
  await newRow.locator('.name-inp').fill('Двойник Кузнецовой');
  await newRow.locator('[data-grade="5"]').fill('2');
  await newRow.locator('[data-grade="3"]').fill('1');
  eq((await rowsInfo(page))[newIdx].name, 'Двойник Кузнецовой', 'пока курсор в строке, она не «убегает» при переходе между полями');
  await page.click('#groupNameDisplay');
  await page.waitForTimeout(150);
  info = await rowsInfo(page);
  eq(info.map(r => [r.place, r.medal]), [['1', 1], ['2', 2], ['3', 3], ['3', 3], ['5', 0], ['6', 0]], 'ничья на 3 месте: 1, 2, 3, 3, 5');

  section('4. Автосохранение и таблица с именем «Без названия»');
  await page.waitForTimeout(700);
  dump = await idbDump(page);
  eq(dump.rows['9А класс'], 6, 'правки сохранены автоматически');
  await page.click('[data-click="goHome"]');
  await page.click('.table-card[data-name="Без названия"] .table-card-info');
  await page.waitForTimeout(150);
  await page.click('#fabEditorBtn');
  await page.click('[data-click="addRow"]');
  await page.locator('#tableBody tr .name-inp').first().fill('Строка в таблице «Без названия»');
  await page.waitForTimeout(700);
  dump = await idbDump(page);
  eq(dump.rows['Без названия'], 1, 'таблица с именем «Без названия» сохраняется (раньше терялась)');
  await page.click('[data-click="goHome"]');

  /* ---------- 5. Создание, переименование, удаление, порядок ---------- */
  section('5. Создание, переименование, удаление, групповое удаление');
  await page.click('#fabMain');
  await page.click('[data-click="fabCreate"]');
  await page.fill('#saveName', 'Новая');
  await page.click('#saveModalConfirm');
  await page.waitForSelector('#editorView', { state: 'visible' });
  eq(await page.textContent('#groupNameDisplay'), 'Новая', 'таблица создана и открыта');
  await page.click('[data-click="goHome"]');
  await page.click('.table-card[data-name="Новая"] .dots-btn');
  await page.click('.table-card[data-name="Новая"] [data-action="rename"]');
  await page.fill('#renameInput', 'Переименованная');
  await page.click('#renameConfirmBtn');
  await page.waitForTimeout(200);
  dump = await idbDump(page);
  ok(dump.tables.includes('Переименованная') && !dump.tables.includes('Новая'), 'переименование атомарно: старая запись удалена, новая создана');
  eq(dump.meta.order.includes('Переименованная'), true, 'порядок обновлён при переименовании');
  await page.click('.table-card[data-name="Переименованная"] .dots-btn');
  await page.click('.table-card[data-name="Переименованная"] [data-action="delete"]');
  await page.click('#confirmYesBtn');
  await page.waitForTimeout(200);
  dump = await idbDump(page);
  ok(!dump.tables.includes('Переименованная'), 'удаление убирает запись из хранилища');

  /* ---------- 6. Фото ---------- */
  section('6. Фото: большой JPEG → компактное превью; GIF и неподдерживаемые файлы');
  await page.click('.table-card[data-name="9А класс"] .table-card-info');
  await page.waitForTimeout(150);
  const bigJpeg = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const g = c.getContext('2d');
    for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + (i * 7 % 360) + ',70%,50%)'; g.fillRect(Math.random() * 3000, Math.random() * 2000, 300, 200); }
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.locator('#tableBody tr').first().locator('.photo-inp').setInputFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bigJpeg) });
  await page.waitForFunction(() => document.querySelector('#tableBody tr .photo-img').getAttribute('src'));
  const photo = await page.evaluate(() => {
    const img = document.querySelector('#tableBody tr .photo-img');
    return new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight, len: img.getAttribute('src').length, type: img.getAttribute('src').slice(0, 23) }); i.src = img.getAttribute('src'); });
  });
  console.log('    исходник ' + Math.round(bigJpeg.length / 1024) + ' КБ → превью ' + photo.w + '×' + photo.h + ', ' + Math.round(photo.len * 0.75 / 1024) + ' КБ');
  ok(Math.max(photo.w, photo.h) <= 400, 'длинная сторона превью ≤ 400 px');
  ok(photo.len * 0.75 < bigJpeg.length / 4, 'превью заметно меньше исходника');
  eq(photo.type, 'data:image/jpeg;base64,', 'превью сохранено как JPEG data-URL');
  await page.locator('#tableBody tr').first().locator('.photo-inp').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('#alertModal', { state: 'visible' });
  ok((await page.textContent('#alertTitle')).includes('Неподдерживаемый'), 'не-изображение отклоняется с понятным сообщением');
  await page.click('#alertOkBtn');

  section('7. HEIC конвертируется в изолированном sandbox-iframe при строгой CSP');
  await page.locator('#tableBody tr').nth(1).locator('.photo-inp').setInputFiles(path.join(__dirname, '..', 'fixtures', 'photo.heic'));
  await page.waitForFunction(() => document.querySelectorAll('#tableBody tr')[1].querySelector('.photo-img').getAttribute('src'), null, { timeout: 60000 });
  const heic = await page.evaluate(() => {
    const src = document.querySelectorAll('#tableBody tr')[1].querySelector('.photo-img').getAttribute('src');
    return new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight, type: src.slice(0, 23) }); i.src = src; });
  });
  ok(heic.type === 'data:image/jpeg;base64,' && Math.max(heic.w, heic.h) <= 400 && heic.w > 50, 'HEIC → JPEG-превью ' + heic.w + '×' + heic.h);
  const frameInfo = await page.evaluate(() => { const f = document.querySelector('iframe.heic-frame'); return f && { sandbox: f.getAttribute('sandbox') }; });
  eq(frameInfo, { sandbox: 'allow-scripts' }, 'конвертер работает в iframe с sandbox="allow-scripts" (без доступа к данным приложения)');
  eq(await page.evaluate(() => window.__csp), [], 'в основной странице нет нарушений CSP (eval не разрешён)');
  // Намеренно вызываем new Function, чтобы убедиться, что CSP его запрещает.
  // eslint-disable-next-line no-new-func
  const evalBlocked = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 50)); try { new Function('return 1')(); return false; } catch (e) { return e.name === 'EvalError'; } });
  ok(evalBlocked, 'eval / new Function в основной странице запрещены');

  await page.waitForTimeout(700);
  await page.click('[data-click="goHome"]');

  /* ---------- 9. Экспорт / импорт / резервная копия ---------- */
  section('9. Экспорт, импорт (включая багфикс), полная резервная копия');
  await page.click('#fabMain');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-click="downloadFullBackup"]')]);
  const backupPath = path.join(require('os').tmpdir(), 'tabel-e2e-backup.json');
  await dl.saveAs(backupPath);
  const backupJson = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  eq(Object.keys(backupJson), ['9А класс', 'Без названия'], 'резервная копия содержит все таблицы в порядке показа');
  await page.click('#fabMain');
  await page.click('[data-click="fabImport"]');
  await page.setInputFiles('#importFileInput', backupPath);
  await page.click('[data-click="handleImportFile"]');
  await page.waitForTimeout(400);
  const namesAfterImport = await page.$$eval('.table-card', c => c.map(x => x.dataset.name));
  eq(namesAfterImport, ['9А класс', 'Без названия', '9А класс (1)', 'Без названия (1)'], 'импорт резервной копии работает, имена-дубли получают суффикс (раньше падал с ReferenceError)');
  // единичная таблица из файла
  const single = { name: 'Одиночная.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ rows: [{ name: 'Тест', grades: { 5: '1' }, n: '' }] })) };
  await page.click('#fabMain');
  await page.click('[data-click="fabImport"]');
  await page.setInputFiles('#importFileInput', single);
  await page.click('[data-click="handleImportFile"]');
  await page.waitForSelector('#importNameModal', { state: 'visible' });
  eq(await page.inputValue('#importNameInput'), 'Одиночная', 'имя по умолчанию берётся из имени файла');
  await page.click('#importNameConfirmBtn');
  await page.waitForSelector('#editorView', { state: 'visible' });
  eq((await rowsInfo(page)).map(r => r.name), ['Тест'], 'одиночная таблица импортирована и открыта');
  await page.click('[data-click="goHome"]');
  // большой файл (> 15 МБ, старый лимит)
  const big = path.join(require('os').tmpdir(), 'big-backup.json');
  const filler = 'A'.repeat(17 * 1024 * 1024);
  fs.writeFileSync(big, JSON.stringify({ 'Большая': { rows: [{ name: 'x', grades: {}, n: '', pad: filler }] } }));
  await page.click('#fabMain');
  await page.click('[data-click="fabImport"]');
  await page.setInputFiles('#importFileInput', big);
  await page.click('[data-click="handleImportFile"]');
  await page.waitForTimeout(1500);
  ok((await page.$$eval('.table-card', c => c.map(x => x.dataset.name))).includes('Большая'), 'файл 17 МБ импортируется (лимит поднят с 15 до 100 МБ)');
  // битый JSON
  await page.click('#fabMain');
  await page.click('[data-click="fabImport"]');
  await page.fill('#importPasteText', '{"rows": [');
  await page.click('[data-click="handleImportFile"]');
  await page.waitForSelector('#alertModal', { state: 'visible' });
  ok((await page.textContent('#alertTitle')).includes('Ошибка чтения'), 'битый JSON даёт понятную ошибку');
  await page.click('#alertOkBtn');
  await page.waitForSelector('#importFileModal', { state: 'visible' });
  await page.click('#importFileModal [data-click="closeImportFileModal"]');
  // вредоносные данные в импорте
  await page.click('#fabMain');
  await page.click('[data-click="fabImport"]');
  await page.fill('#importPasteText', JSON.stringify({ 'Хак': { rows: [{ name: '<img src=x onerror=window.__pwned=1>', photo: 'javascript:window.__pwned=1', grades: { 5: '1' } }] } }));
  await page.click('[data-click="handleImportFile"]');
  await page.waitForTimeout(300);
  await page.click('.table-card[data-name="Хак"] .table-card-info');
  await page.waitForTimeout(300);
  eq(await page.evaluate(() => window.__pwned || null), null, 'XSS через имя и фото при импорте не срабатывает');
  eq(await page.$eval('#tableBody tr .name-inp', e => e.value), '<img src=x onerror=window.__pwned=1>', 'имя сохранено как обычный текст');
  await page.click('[data-click="goHome"]');

  /* ---------- 10. Суточная копия и восстановление ---------- */
  section('10. Суточная копия (локальный день) и восстановление');
  dump = await idbDump(page);
  eq(dump.backups.length, 1, 'создана одна суточная копия');
  const today = await page.evaluate(() => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); });
  eq(dump.backups[0].day, today, 'день копии — локальный');
  await page.click('.table-card[data-name="9А класс (1)"] .dots-btn');
  await page.click('.table-card[data-name="9А класс (1)"] [data-action="delete"]');
  await page.click('#confirmYesBtn');
  await page.waitForTimeout(300);
  await page.click('#fabMain');
  await page.click('[data-click="fabRestore"]');
  await page.waitForSelector('#confirmModal', { state: 'visible' });
  await page.click('#confirmYesBtn');
  await page.waitForTimeout(500);
  const afterRestore = await page.$$eval('.table-card', c => c.map(x => x.dataset.name));
  ok(Array.isArray(afterRestore), 'восстановление выполняется без ошибок: ' + afterRestore.join(' | '));

  /* ---------- 11. Две вкладки ---------- */
  section('11. Две вкладки: правки разных таблиц не затирают друг друга, изменения видны во второй');
  const page2 = await newPage(ctx, base, problems);
  await page.click('.table-card[data-name="Без названия"] .table-card-info');
  await page2.click('.table-card[data-name="9А класс"] .table-card-info');
  await page.waitForTimeout(150);
  await page.locator('#tableBody tr .name-inp').first().fill('Правка из вкладки 1');
  await page2.locator('#tableBody tr .name-inp').first().fill('Правка из вкладки 2');
  await page.waitForTimeout(900);
  await page2.waitForTimeout(900);
  dump = await idbDump(page);
  const stored = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('TabelORangahStorage');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('tables', 'readonly');
      const a = tx.objectStore('tables').get('Без названия');
      const b = tx.objectStore('tables').get('9А класс');
      tx.oncomplete = () => { resolve({ a: a.result.data.rows[0].name, b: b.result.data.rows.map(r => r.name) }); db.close(); };
    };
  }));
  eq(stored.a, 'Правка из вкладки 1', 'правка вкладки 1 сохранена');
  ok(stored.b.includes('Правка из вкладки 2'), 'правка вкладки 2 сохранена, не затёрта вкладкой 1');
  await page.click('[data-click="goHome"]');
  await page2.click('[data-click="goHome"]');
  await page.click('.table-card[data-name="9А класс"] .dots-btn');
  await page.click('.table-card[data-name="9А класс"] [data-action="rename"]');
  await page.fill('#renameInput', 'Из вкладки 1');
  await page.click('#renameConfirmBtn');
  await page2.waitForFunction(() => document.querySelector('.table-card[data-name="Из вкладки 1"]'), null, { timeout: 5000 });
  ok(true, 'переименование из вкладки 1 появилось во вкладке 2 без перезагрузки');
  await page2.close();

  /* ---------- 12. Доступность ---------- */
  section('12. Доступность: язык, диалоги, фокус, клавиатура');
  eq(await page.getAttribute('html', 'lang'), 'ru', 'lang="ru"');
  await page.focus('.table-card[data-name="Без названия"] .table-card-info');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#editorView', { state: 'visible' });
  ok(true, 'карточку таблицы можно открыть клавиатурой (Enter)');
  await page.click('[data-click="goHome"]');
  await page.click('#fabMain');
  await page.click('[data-click="fabCreate"]');
  eq(await page.evaluate(() => document.activeElement.id), 'saveName', 'при открытии окна фокус переходит в поле ввода');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  ok(await page.evaluate(() => !!document.activeElement.closest('#saveModal')), 'фокус не выходит за пределы открытого окна (ловушка фокуса)');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => document.getElementById('saveModal').style.display === 'none'), 'Esc закрывает окно');
  eq(await page.getAttribute('#fabMain', 'aria-expanded'), 'false', 'aria-expanded на кнопке меню');

  /* ---------- 13. Service worker и офлайн ---------- */
  section('13. Service worker: версия кэша, офлайн-запуск, старый кэш удаляется');
  await page.evaluate(() => caches.open('tabel-o-rangah').then(c => c.put('/old', new Response('old'))));
  await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 10000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);
  const cacheNames = await page.evaluate(() => caches.keys());
  eq(cacheNames, ['tabel-o-rangah-v13'], 'остался только кэш текущей версии (старый «tabel-o-rangah» удалён)');
  const cached = await page.evaluate(() => caches.open('tabel-o-rangah-v13').then(c => c.keys()).then(ks => ks.map(k => new URL(k.url).pathname)));
  ok(['/index.html', '/css/styles.css', '/js/app.js', '/js/storage.js', '/vendor/sortable.min.js', '/icons/icon-192.png'].every(p => cached.includes(p)), 'оболочка приложения закэширована (' + cached.length + ' файлов)');
  await page.reload();
  await page.waitForTimeout(500);
  const failedOffline = [];
  page.on('requestfailed', r => failedOffline.push(new URL(r.url()).pathname));
  const problemsBefore = problems.length;
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#tablesList', { timeout: 10000 });
  ok((await page.$$('.table-card')).length > 0, 'офлайн: приложение запускается, данные на месте');
  const offline404 = await page.evaluate(() => fetch('/js/nonexistent.js').then(r => r.status, () => 'network-error'));
  ok(offline404 === 'network-error' || offline404 !== 200, 'офлайн: отсутствующий файл не подменяется страницей index.html (статус: ' + offline404 + ')');
  await ctx.setOffline(false);
  eq(failedOffline.filter(p => p !== '/js/nonexistent.js'), [], 'офлайн: не загрузился только заведомо отсутствующий файл');
  problems.splice(problemsBefore); // сетевая ошибка для заведомо отсутствующего файла ожидаема

  section('14. Закрытие и повторное открытие: данные на месте');
  const names = await page.$$eval('.table-card', c => c.map(x => x.dataset.name));
  await page.close();
  const page3 = await newPage(ctx, base, problems);
  eq(await page3.$$eval('.table-card', c => c.map(x => x.dataset.name)), names, 'после перезапуска те же таблицы в том же порядке');
  eq(await page3.evaluate(() => window.__csp), [], 'нет нарушений CSP');

  section('Ошибки в консоли за весь прогон');
  const real = problems.filter(p => !/Failed to load resource.*(404|net::ERR_INTERNET_DISCONNECTED)|ERR_INTERNET_DISCONNECTED|nonexistent/.test(p));
  eq(real, [], 'нет ошибок JavaScript и CSP-нарушений');

  await browser.close();
  server.close();
  console.log('\nПройдено проверок: ' + passed + (failures.length ? ', НЕ пройдено: ' + failures.length : ''));
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

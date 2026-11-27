/*
 * Чтение таблиц из Excel (.xlsx / .xlsm) прямо в браузере, без сторонних библиотек и без сети.
 *
 * Файл Excel — это zip-архив с XML. Читаются только значения ячеек и картинки;
 * макросы (vbaProject.bin) никогда не выполняются и не разбираются.
 *
 * Ищутся блоки с заголовком «Имя» и колонками оценок 5, 4, 3, 2, 1, «О», «Н».
 * Название блока — ближайшая строка с текстом над заголовком («Группа А» и т. п.).
 * Каждый блок становится отдельной таблицей приложения.
 */
(function (root) {
  'use strict';

  const MAX_ENTRY = 60 * 1024 * 1024;   // предел распакованного размера одной части, байт
  const MAX_TOTAL = 200 * 1024 * 1024;  // предел распакованного размера всех частей, байт
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const GRADE_KEYS = ['5', '4', '3', '2', '1', '0'];

  /* ---------- zip ---------- */
  function readZipIndex(buf) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Это не файл Excel (.xlsx / .xlsm): архив не распознан.');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new Error('Файл Excel повреждён.');
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const usize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/^\/+/, '');
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new Error('Слишком большой файл Excel (zip64 не поддерживается).');
      entries.set(name, { method, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { view, bytes, entries };
  }

  async function inflateRaw(data, limit) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > limit) { try { await reader.cancel(); } catch (e) { /* уже закрыт */ } throw new Error('Файл Excel слишком большой после распаковки.'); }
      chunks.push(r.value);
    }
    const out = new Uint8Array(size);
    let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return out;
  }

  function makeZip(buf) {
    const zip = readZipIndex(buf);
    let total = 0;
    return {
      has: name => zip.entries.has(name),
      names: () => Array.from(zip.entries.keys()),
      async read(name) {
        const e = zip.entries.get(name);
        if (!e) return null;
        if (e.usize > MAX_ENTRY) throw new Error('Файл Excel содержит слишком большую часть: ' + name);
        const v = zip.view;
        if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error('Файл Excel повреждён.');
        const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
        const data = zip.bytes.subarray(start, start + e.csize);
        let out;
        if (e.method === 0) out = data;
        else if (e.method === 8) out = await inflateRaw(data, MAX_ENTRY);
        else throw new Error('Неподдерживаемый способ сжатия в файле Excel.');
        total += out.length;
        if (total > MAX_TOTAL) throw new Error('Файл Excel слишком большой после распаковки.');
        return out;
      }
    };
  }

  /* ---------- XML ---------- */
  function parseXml(bytes) {
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Файл Excel повреждён (ошибка XML).');
    return doc;
  }

  const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
  const first = (node, name) => node.getElementsByTagNameNS('*', name)[0] || null;

  async function readXml(zip, name) {
    const bytes = await zip.read(name);
    return bytes ? parseXml(bytes) : null;
  }

  // Путь части относительно файла, который на неё ссылается.
  function resolvePath(fromFile, target) {
    if (!target) return '';
    if (target[0] === '/') return target.replace(/^\/+/, '');
    const parts = fromFile.split('/').slice(0, -1);
    target.split('/').forEach(seg => {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    });
    return parts.join('/');
  }

  async function readRels(zip, partPath) {
    const dir = partPath.split('/').slice(0, -1).join('/');
    const relsPath = (dir ? dir + '/' : '') + '_rels/' + partPath.split('/').pop() + '.rels';
    const doc = await readXml(zip, relsPath);
    const map = new Map();
    if (doc) all(doc, 'Relationship').forEach(r => map.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', path: resolvePath(partPath, r.getAttribute('Target')) }));
    return map;
  }

  /* ---------- Ячейки ---------- */
  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function textOf(si) {
    let s = '';
    all(si, 't').forEach(t => {
      const p = t.parentNode && t.parentNode.localName;
      if (p === 'si' || p === 'r' || p === 'is') s += t.textContent;
    });
    return s;
  }

  async function readSharedStrings(zip) {
    const doc = await readXml(zip, 'xl/sharedStrings.xml');
    return doc ? all(doc, 'si').map(textOf) : [];
  }

  // Лист -> { rows: Map(номерСтроки -> Map(номерКолонки -> значение)) }, значения: строка | число
  function readSheet(doc, shared) {
    const rows = new Map();
    all(doc, 'c').forEach(c => {
      const m = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
      if (!m) return;
      const t = c.getAttribute('t');
      let value = null;
      if (t === 'inlineStr') {
        const is = first(c, 'is');
        value = is ? textOf(is) : '';
      } else {
        const v = first(c, 'v');
        if (!v) return;
        const raw = v.textContent;
        if (t === 's') value = shared[parseInt(raw, 10)];
        else if (t === 'str') value = raw;
        else if (t === 'b' || t === 'e') return;
        else { const n = parseFloat(raw); if (isFinite(n)) value = n; }
      }
      if (value === undefined || value === null || value === '') return;
      const r = parseInt(m[2], 10);
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r).set(colIndex(m[1]), value);
    });
    return rows;
  }

  /* ---------- Картинки листа ---------- */
  const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp' };

  // -> Map(номерСтроки(с 1) -> путь картинки в архиве); берётся первая картинка в строке
  async function readSheetImages(zip, sheetPath, sheetDoc) {
    const byRow = new Map();
    const drawingEl = first(sheetDoc, 'drawing');
    if (!drawingEl) return byRow;
    const rels = await readRels(zip, sheetPath);
    const rel = rels.get(drawingEl.getAttributeNS(NS_REL, 'id'));
    if (!rel) return byRow;
    const drawing = await readXml(zip, rel.path);
    if (!drawing) return byRow;
    const drawingRels = await readRels(zip, rel.path);
    ['twoCellAnchor', 'oneCellAnchor'].forEach(kind => {
      all(drawing, kind).forEach(anchor => {
        const from = first(anchor, 'from');
        const pic = first(anchor, 'pic');
        const blip = pic && first(pic, 'blip');
        if (!from || !blip) return;
        const rowEl = first(from, 'row');
        const link = drawingRels.get(blip.getAttributeNS(NS_REL, 'embed'));
        if (!rowEl || !link) return;
        const row = parseInt(rowEl.textContent, 10) + 1;
        if (isFinite(row) && !byRow.has(row)) byRow.set(row, link.path);
      });
    });
    return byRow;
  }

  /* ---------- Поиск блоков «Имя / 5 4 3 2 1 О Н» ---------- */
  function norm(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
  }

  const NAME_HEADERS = ['имя', 'фио', 'ф.и.о.', 'фамилия', 'фамилия имя', 'фамилия, имя', 'ученик'];

  function gradeOfHeader(v) {
    const t = norm(v).replace(/[.\s]/g, '');
    if (/^[1-5]$/.test(t)) return t;
    if (t === 'о' || t === 'o') return '0';   // кириллица и латиница
    if (t === 'н' || t === 'h') return 'n';
    return null;
  }

  function findHeaders(rows) {
    const nums = Array.from(rows.keys()).sort((a, b) => a - b);
    const headers = [];
    nums.forEach(r => {
      const cells = rows.get(r);
      let nameCol = 0;
      cells.forEach((v, c) => { if (!nameCol && typeof v === 'string' && NAME_HEADERS.includes(norm(v))) nameCol = c; });
      if (!nameCol) return;
      const cols = { name: nameCol };
      cells.forEach((v, c) => {
        if (c <= nameCol) return;
        const g = gradeOfHeader(v);
        if (g !== null && cols[g] === undefined) cols[g] = c;
      });
      // Недостающие колонки — по привычному расположению: Имя, Кол-во, 5, 4, 3, 2, 1, О, Н.
      ['5', '4', '3', '2', '1', '0', 'n'].forEach((g, i) => { if (cols[g] === undefined) cols[g] = nameCol + 2 + i; });
      headers.push({ row: r, cols: cols });
    });
    // Название блока: ближайшая непустая строка над заголовком (не выше 3 строк, не другой заголовок).
    headers.forEach((h, i) => {
      const prevHeader = i ? headers[i - 1].row : 0;
      for (let r = h.row - 1; r >= Math.max(prevHeader + 1, h.row - 3); r--) {
        const cells = rows.get(r);
        if (!cells) continue;
        const text = Array.from(cells.values()).find(v => typeof v === 'string' && v.trim() !== '');
        if (text !== undefined) { h.titleRow = r; h.title = text.replace(/\s+/g, ' ').trim(); break; }
      }
    });
    return headers;
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }

  function numStr(v) {
    const n = num(v);
    return n === 0 && (v === undefined || v === null || v === '') ? '' : String(n);
  }

  function buildGroups(sheetName, rows, headers, images, sheetCount) {
    const lastRow = Math.max.apply(null, Array.from(rows.keys()));
    return headers.map((h, i) => {
      const next = headers[i + 1];
      const end = next ? (next.titleRow || next.row) - 1 : lastRow;
      const out = [];
      let photos = 0;
      for (let r = h.row + 1; r <= end; r++) {
        const cells = rows.get(r);
        const image = images.get(r) || null;
        if (!cells && !image) continue;
        const get = c => (cells ? cells.get(c) : undefined);
        const nameVal = get(h.cols.name);
        const grades = {};
        GRADE_KEYS.forEach(g => { grades[g] = numStr(get(h.cols[g])); });
        if (image) photos++;
        out.push({
          name: nameVal == null ? '' : String(nameVal).trim(),
          grades: grades,
          n: numStr(get(h.cols.n)),
          image: image
        });
      }
      const filled = out.filter(x => x.name !== '' || GRADE_KEYS.some(g => num(x.grades[g]) !== 0) || num(x.n) !== 0).length;
      const fallback = sheetCount > 1 ? sheetName : 'Таблица';
      return { title: h.title || (headers.length > 1 ? fallback + ' ' + (i + 1) : fallback), sheet: sheetName, rows: out, filled: filled, photos: photos };
    });
  }

  /* ---------- Главная функция ---------- */
  async function parse(buffer) {
    const zip = makeZip(buffer);
    const workbook = await readXml(zip, 'xl/workbook.xml');
    if (!workbook) throw new Error('Это не файл Excel: не найден xl/workbook.xml.');
    const wbRels = await readRels(zip, 'xl/workbook.xml');
    const shared = await readSharedStrings(zip);
    const sheets = all(workbook, 'sheet').filter(s => s.getAttribute('state') !== 'hidden' && s.getAttribute('state') !== 'veryHidden');
    const groups = [];
    for (const s of sheets) {
      const rel = wbRels.get(s.getAttributeNS(NS_REL, 'id'));
      if (!rel || !zip.has(rel.path) || !/worksheet/i.test(rel.type)) continue;
      const doc = await readXml(zip, rel.path);
      const rows = readSheet(doc, shared);
      if (!rows.size) continue;
      const headers = findHeaders(rows);
      if (!headers.length) continue;
      const images = await readSheetImages(zip, rel.path, doc);
      groups.push.apply(groups, buildGroups(s.getAttribute('name') || 'Лист', rows, headers, images, sheets.length));
    }
    if (!groups.length) throw new Error('В файле не найдено таблиц с колонкой «Имя» и оценками 5, 4, 3, 2, 1, О, Н.');
    return {
      groups: groups,
      readImage: async function (path) {
        const bytes = await zip.read(path);
        if (!bytes) return null;
        const ext = (path.split('.').pop() || '').toLowerCase();
        return new Blob([bytes], { type: IMG_MIME[ext] || 'application/octet-stream' });
      }
    };
  }

  root.TabelXlsx = { parse };
})(typeof window !== 'undefined' ? window : globalThis);

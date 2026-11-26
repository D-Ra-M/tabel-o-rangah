/*
 * Чистая логика приложения: без обращения к DOM и хранилищу.
 * Работает и в браузере (window.TabelLogic), и в Node (для автотестов).
 */
(function (root) {
  'use strict';

  const MAX_NAME = 60;          // длина названия таблицы
  const MAX_ROW_NAME = 200;     // длина имени в строке
  const MAX_ROWS = 500;         // строк в таблице
  const PHOTO_MAX_LEN = 3000000; // допустимая длина data-URL фото при импорте
  const PHOTO_RE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+\/=]+$/;

  const GRADE_KEYS = ['5', '4', '3', '2', '1', '0'];
  // Вес каждой оценки в итоговом балле. «0» — опоздание (красное поле «О»).
  const GRADE_WEIGHTS = { 5: 10, 4: 8, 3: 5, 2: -1, 1: -2, 0: -1 };
  const ABSENCE_WEIGHT = -2;    // поле «Н» (пропуски)

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c] || c));
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function generateUniqueName(base, existingNames) {
    const taken = new Set(existingNames);
    let name = base;
    let counter = 1;
    while (taken.has(name)) {
      name = base + ' (' + counter + ')';
      counter++;
    }
    return name;
  }

  function getFileNameWithoutExtension(fileName) {
    return String(fileName || '').replace(/\.[^/.]+$/, '');
  }

  function normalizeTableName(name) {
    return String(name == null ? '' : name).trim().slice(0, MAX_NAME);
  }

  // Локальная дата YYYY-MM-DD (а не UTC — иначе граница суток уезжает на 3 часа).
  function dayKey(date) {
    const d = date || new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function cleanNum(v) {
    const n = parseFloat(v);
    return isFinite(n) ? String(Math.max(-9999, Math.min(9999, n))) : '';
  }

  function toTime(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function sanitizeRow(r) {
    r = (r && typeof r === 'object') ? r : {};
    const grades = {};
    GRADE_KEYS.forEach(g => { grades[g] = cleanNum(r.grades && r.grades[g]); });
    return {
      name: String(r.name == null ? '' : r.name).slice(0, MAX_ROW_NAME),
      photo: (typeof r.photo === 'string' && r.photo.length < PHOTO_MAX_LEN && PHOTO_RE.test(r.photo)) ? r.photo : '',
      grades: grades,
      n: cleanNum(r.n)
    };
  }

  function sanitizeTable(t) {
    const rows = (t && Array.isArray(t.rows)) ? t.rows.slice(0, MAX_ROWS) : [];
    return { rows: rows.map(sanitizeRow) };
  }

  // Таблица с проверенными строками и метками времени (для хранилища).
  function normalizeTable(t, now) {
    const stamp = now == null ? Date.now() : now;
    const created = toTime(t && (t.createdAt || t.savedAt), stamp);
    return Object.assign(sanitizeTable(t), {
      createdAt: created,
      updatedAt: toTime(t && (t.updatedAt || t.savedAt), created)
    });
  }

  function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  // Количество оценок (5..1) и итоговый балл строки.
  function calcRow(row) {
    let count = 0;
    let score = 0;
    const grades = (row && row.grades) || {};
    GRADE_KEYS.forEach(g => {
      const v = num(grades[g]);
      if (Number(g) >= 1) count += v;
      score += v * GRADE_WEIGHTS[g];
    });
    score += num(row && row.n) * ABSENCE_WEIGHT;
    return { count: round2(count), score: round2(score) };
  }

  function isRowEmpty(row) {
    if (String((row && row.name) || '').trim() !== '') return false;
    const grades = (row && row.grades) || {};
    if (GRADE_KEYS.some(g => num(grades[g]) !== 0)) return false;
    return num(row && row.n) === 0;
  }

  /*
   * Ранжирование. Возвращает массив в порядке показа:
   *   [{ index, place, medal, empty, count, score }]
   * Пустые строки идут в конец и места не получают.
   * Равные баллы делят место (1, 2, 2, 4), порядок равных сохраняется.
   */
  function rankRows(rows) {
    const items = rows.map((row, index) => {
      const calc = calcRow(row);
      return { index, empty: isRowEmpty(row), count: calc.count, score: calc.score };
    });
    items.sort((a, b) => {
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
    let position = 0;
    let prevScore = null;
    let prevPlace = 0;
    items.forEach(item => {
      position++;
      if (item.empty) {
        item.place = position;
        item.medal = 0;
        return;
      }
      item.place = (prevScore !== null && item.score === prevScore) ? prevPlace : position;
      item.medal = item.place <= 3 ? item.place : 0;
      prevScore = item.score;
      prevPlace = item.place;
    });
    return items;
  }

  const api = {
    MAX_NAME, MAX_ROW_NAME, MAX_ROWS, PHOTO_MAX_LEN, PHOTO_RE,
    GRADE_KEYS, GRADE_WEIGHTS, ABSENCE_WEIGHT,
    escapeHtml, formatDate, generateUniqueName, getFileNameWithoutExtension,
    normalizeTableName, dayKey, cleanNum, toTime,
    sanitizeRow, sanitizeTable, normalizeTable,
    calcRow, isRowEmpty, rankRows
  };

  root.TabelLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

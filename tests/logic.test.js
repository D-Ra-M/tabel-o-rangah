'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

const row = (name, g, n) => ({ name, grades: Object.assign({ 5: '', 4: '', 3: '', 2: '', 1: '', 0: '' }, g), n: n || '' });

test('calcRow: баллы и количество как в исходном приложении', () => {
  // Иванов: 3×5 + 2×4 + 1×3 => 30 + 16 + 5 = 51, оценок 6
  assert.deepEqual(L.calcRow(row('a', { 5: '3', 4: '2', 3: '1' })), { count: 6, score: 51 });
  // Петрова: 5×5, Н=1 => 50 − 2 = 48
  assert.deepEqual(L.calcRow(row('b', { 5: '5' }, '1')), { count: 5, score: 48 });
  // Сидоров: 5+4+3+2 по одной => 10+8+5−1 = 22, оценок 4
  assert.deepEqual(L.calcRow(row('c', { 5: '1', 4: '1', 3: '1', 2: '1' })), { count: 4, score: 22 });
  // Опоздание «О» (оценка 0) в количество не входит, но даёт −1
  assert.deepEqual(L.calcRow(row('d', { 0: '2' })), { count: 0, score: -2 });
});

test('calcRow: мусорные значения считаются нулём, дроби округляются', () => {
  assert.deepEqual(L.calcRow(row('x', { 5: 'abc', 4: '' }, 'z')), { count: 0, score: 0 });
  assert.equal(L.calcRow(row('x', { 3: '0.1' })).score, 0.5);
  assert.equal(L.calcRow(row('x', { 5: 'Infinity' })).score, 0);
  assert.deepEqual(L.calcRow(null), { count: 0, score: 0 });
});

test('isRowEmpty', () => {
  assert.equal(L.isRowEmpty(row('', {})), true);
  assert.equal(L.isRowEmpty(row('  ', { 5: '0' }, '0')), true);
  assert.equal(L.isRowEmpty(row('Имя', {})), false);
  assert.equal(L.isRowEmpty(row('', { 4: '1' })), false);
  assert.equal(L.isRowEmpty(row('', {}, '2')), false);
});

test('rankRows: сортировка по баллу, пустые строки в конце без места и медали', () => {
  const rows = [
    row('Иванов', { 5: '3', 4: '2', 3: '1' }),   // 51
    row('Петрова', { 5: '5' }, '1'),             // 48
    row('Сидоров', { 5: '1', 4: '1', 3: '1', 2: '1' }), // 22
    row('Кузнецова', { 5: '2', 3: '1' }),        // 25
    row('', {})                                  // пустая
  ];
  const r = L.rankRows(rows);
  assert.deepEqual(r.map(x => x.index), [0, 1, 3, 2, 4]);
  assert.deepEqual(r.map(x => x.place), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.map(x => x.medal), [1, 2, 3, 0, 0]);
  assert.equal(r[4].empty, true);
});

test('rankRows: равные баллы делят место (1, 2, 2, 4), порядок равных сохраняется', () => {
  const rows = [
    row('A', { 5: '5' }),  // 50
    row('B', { 5: '3' }),  // 30
    row('C', { 5: '3' }),  // 30
    row('D', { 5: '1' })   // 10
  ];
  const r = L.rankRows(rows);
  assert.deepEqual(r.map(x => x.index), [0, 1, 2, 3]);
  assert.deepEqual(r.map(x => x.place), [1, 2, 2, 4]);
  assert.deepEqual(r.map(x => x.medal), [1, 2, 2, 0]);
});

test('rankRows: единственная пустая строка не получает «золото»', () => {
  const r = L.rankRows([row('', {})]);
  assert.equal(r[0].medal, 0);
  const named = L.rankRows([row('Тест', { 5: '1' })]);
  assert.equal(named[0].medal, 1);
  assert.deepEqual(L.rankRows([]), []);
});

test('rankRows: все равны — все на первом месте', () => {
  const r = L.rankRows([row('A', { 5: '1' }), row('B', { 5: '1' }), row('C', { 5: '1' })]);
  assert.deepEqual(r.map(x => x.place), [1, 1, 1]);
});

test('sanitizeTable: ограничения и очистка данных', () => {
  const big = Array.from({ length: 600 }, (_, i) => ({ name: 'n' + i }));
  assert.equal(L.sanitizeTable({ rows: big }).rows.length, L.MAX_ROWS);
  assert.deepEqual(L.sanitizeTable(null), { rows: [] });
  assert.deepEqual(L.sanitizeTable({ rows: 'x' }), { rows: [] });
  const t = L.sanitizeTable({ rows: [{ name: 'x'.repeat(500), photo: 'javascript:alert(1)', grades: { 5: '99999', 4: '-99999', 3: 'abc' }, n: '2' }] });
  assert.equal(t.rows[0].name.length, L.MAX_ROW_NAME);
  assert.equal(t.rows[0].photo, '');
  assert.equal(t.rows[0].grades['5'], '9999');
  assert.equal(t.rows[0].grades['4'], '-9999');
  assert.equal(t.rows[0].grades['3'], '');
  assert.equal(t.rows[0].n, '2');
});

test('sanitizeTable: разрешены только data:image фото безопасных форматов', () => {
  const ok = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  assert.equal(L.sanitizeRow({ photo: ok }).photo, ok);
  assert.equal(L.sanitizeRow({ photo: 'data:image/svg+xml;base64,PHN2Zz4=' }).photo, '');
  assert.equal(L.sanitizeRow({ photo: 'data:text/html;base64,PGgxPg==' }).photo, '');
  assert.equal(L.sanitizeRow({ photo: 'https://evil.example/x.png' }).photo, '');
  assert.equal(L.sanitizeRow({ photo: 'data:image/png;base64,AAAA"onerror="x' }).photo, '');
});

test('normalizeTable: сохраняет метки времени и подставляет недостающие', () => {
  const t = L.normalizeTable({ rows: [], createdAt: 5, updatedAt: 9 }, 100);
  assert.equal(t.createdAt, 5);
  assert.equal(t.updatedAt, 9);
  const u = L.normalizeTable({ rows: [], savedAt: 7 }, 100);
  assert.equal(u.createdAt, 7);
  assert.equal(u.updatedAt, 7);
  const v = L.normalizeTable({ rows: [] }, 100);
  assert.equal(v.createdAt, 100);
});

test('generateUniqueName и normalizeTableName', () => {
  assert.equal(L.generateUniqueName('A', ['B']), 'A');
  assert.equal(L.generateUniqueName('A', ['A']), 'A (1)');
  assert.equal(L.generateUniqueName('A', ['A', 'A (1)']), 'A (2)');
  assert.equal(L.normalizeTableName('  ' + 'я'.repeat(100)).length, L.MAX_NAME);
  assert.equal(L.normalizeTableName(null), '');
});

test('escapeHtml экранирует опасные символы', () => {
  assert.equal(L.escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('dayKey: локальная дата, а не UTC', () => {
  assert.equal(L.dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(L.dayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
});

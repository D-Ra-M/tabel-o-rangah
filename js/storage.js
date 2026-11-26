/*
 * Хранилище. Основной драйвер — IndexedDB: каждая таблица лежит отдельной записью,
 * поэтому правка одной таблицы не перезаписывает остальные (и не затирает изменения
 * из другой вкладки). Если IndexedDB недоступна, включается запасной драйвер на localStorage.
 *
 * API (оба драйвера одинаковы):
 *   open()                 -> { tables, order, mode }
 *   loadAll()              -> { tables, order }
 *   commit({put, remove, order}) -> Promise   (put: {имя: таблица}, remove: [имена], order: [имена])
 *   getBackup()            -> { day, createdAt, tables, order } | null
 *   subscribe(cb)          — уведомления об изменениях из других вкладок
 */
(function () {
  'use strict';

  const L = window.TabelLogic;
  const DB_NAME = 'TabelORangahStorage';
  const DB_VERSION = 3;
  const CHANNEL_NAME = 'tabel-o-rangah-sync';
  const tabId = Math.random().toString(36).slice(2);

  let channel = null;
  let listeners = [];
  let queue = Promise.resolve();

  function enqueue(fn) {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function initChannel() {
    if (channel || typeof BroadcastChannel === 'undefined') return;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = ev => {
        const msg = ev.data;
        if (!msg || msg.from === tabId) return;
        listeners.forEach(cb => { try { cb(msg); } catch (e) { console.error(e); } });
      };
    } catch (e) { channel = null; }
  }

  function notify(names) {
    try { if (channel) channel.postMessage({ type: 'changed', from: tabId, names: names || [] }); } catch (e) {}
  }

  function subscribe(cb) {
    initChannel();
    listeners.push(cb);
  }

  function parseJson(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function toTablesObject(raw) {
    const out = Object.create(null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      Object.keys(raw).forEach(name => {
        const t = raw[name];
        if (t && typeof t === 'object' && Array.isArray(t.rows)) out[name] = L.normalizeTable(t);
      });
    }
    return out;
  }

  function consistentOrder(order, tables) {
    const seen = new Set();
    const result = [];
    (Array.isArray(order) ? order : []).forEach(name => {
      if (typeof name === 'string' && name in tables && !seen.has(name)) { seen.add(name); result.push(name); }
    });
    Object.keys(tables).forEach(name => { if (!seen.has(name)) result.push(name); });
    return result;
  }

  /* ---------------- IndexedDB ---------------- */

  function openDb(onBlocked) {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB недоступна')); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        ['data', 'backups'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
        if (!d.objectStoreNames.contains('tables')) d.createObjectStore('tables', { keyPath: 'name' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const d = request.result;
        d.onversionchange = () => d.close();
        resolve(d);
      };
      request.onerror = () => reject(request.error || new Error('Не удалось открыть IndexedDB'));
      request.onblocked = () => { if (onBlocked) onBlocked(); };
    });
  }

  function createIdbDriver(db) {
    async function loadAll() {
      const tx = db.transaction(['tables', 'meta'], 'readonly');
      const [records, orderRec] = await Promise.all([
        reqP(tx.objectStore('tables').getAll()),
        reqP(tx.objectStore('meta').get('order'))
      ]);
      const tables = Object.create(null);
      records.forEach(r => { tables[r.name] = r.data; });
      return { tables, order: consistentOrder(orderRec && orderRec.value, tables) };
    }

    // Перенос данных из прежних версий (один JSON в IndexedDB 'data' или в localStorage).
    async function migrateLegacy() {
      const flag = await reqP(db.transaction('meta', 'readonly').objectStore('meta').get('migrated'));
      if (flag) return;
      let rawTables = null;
      let rawOrder = null;
      if (db.objectStoreNames.contains('data')) {
        const store = db.transaction('data', 'readonly').objectStore('data');
        const [t, o] = await Promise.all([reqP(store.get('tables')), reqP(store.get('order'))]);
        if (t) rawTables = t.value;
        if (o) rawOrder = o.value;
      }
      let fromLocalStorage = false;
      if (rawTables == null) {
        try {
          rawTables = localStorage.getItem('marksTables');
          rawOrder = localStorage.getItem('tableOrder');
          fromLocalStorage = rawTables != null;
        } catch (e) {}
      }
      const tables = toTablesObject(parseJson(rawTables, {}));
      const order = consistentOrder(parseJson(rawOrder, []), tables);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['tables', 'meta'], 'readwrite');
        Object.keys(tables).forEach(name => tx.objectStore('tables').put({ name, data: tables[name] }));
        tx.objectStore('meta').put({ id: 'order', value: order });
        tx.objectStore('meta').put({ id: 'migrated', value: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Миграция отменена'));
      });
      // Дубликат в localStorage больше не нужен (экономит квоту); старая копия в IndexedDB остаётся нетронутой.
      if (fromLocalStorage) {
        try { localStorage.removeItem('marksTables'); localStorage.removeItem('tableOrder'); } catch (e) {}
      }
    }

    // Одна суточная копия «как было до первой правки за день». Своя транзакция:
    // сбой копии (например, нет места) не должен мешать самому сохранению.
    function ensureDailyBackup() {
      return new Promise(resolve => {
        try {
          const today = L.dayKey();
          const tx = db.transaction(['tables', 'meta', 'backups'], 'readwrite');
          const backups = tx.objectStore('backups');
          const getReq = backups.get('latest');
          getReq.onsuccess = () => {
            const cur = getReq.result;
            if (cur && cur.day === today) return;
            const tReq = tx.objectStore('tables').getAll();
            const oReq = tx.objectStore('meta').get('order');
            let pending = 2;
            const step = () => {
              if (--pending) return;
              if (!tReq.result.length) return;
              const tables = {};
              tReq.result.forEach(r => { tables[r.name] = r.data; });
              backups.put({
                id: 'latest', day: today, createdAt: Date.now(), tables,
                order: consistentOrder(oReq.result && oReq.result.value, tables)
              });
            };
            tReq.onsuccess = step;
            oReq.onsuccess = step;
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) { resolve(); }
      });
    }

    function commit(change) {
      const put = (change && change.put) || {};
      const remove = (change && change.remove) || [];
      const names = Object.keys(put).concat(remove);
      return enqueue(async () => {
        await ensureDailyBackup();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['tables', 'meta'], 'readwrite');
          const tables = tx.objectStore('tables');
          remove.forEach(name => tables.delete(name));
          Object.keys(put).forEach(name => tables.put({ name, data: put[name] }));
          if (change && change.order) tx.objectStore('meta').put({ id: 'order', value: change.order });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('Запись отменена'));
        });
        notify(names);
      });
    }

    async function getBackup() {
      const rec = await reqP(db.transaction('backups', 'readonly').objectStore('backups').get('latest'));
      if (!rec) return null;
      // Прежний формат копии хранил JSON-строку всех таблиц в поле value.
      const tables = toTablesObject(rec.tables || parseJson(rec.value, {}));
      if (!Object.keys(tables).length) return null;
      return { day: rec.day, createdAt: rec.createdAt, tables, order: consistentOrder(rec.order, tables) };
    }

    return { mode: 'indexeddb', loadAll, commit, getBackup, migrateLegacy };
  }

  /* ---------------- Запасной драйвер: localStorage ---------------- */

  function createLocalDriver() {
    let tables = Object.create(null);
    let order = [];

    function read() {
      try {
        tables = toTablesObject(parseJson(localStorage.getItem('marksTables'), {}));
        order = consistentOrder(parseJson(localStorage.getItem('tableOrder'), []), tables);
      } catch (e) { tables = Object.create(null); order = []; }
    }
    function write() {
      localStorage.setItem('marksTables', JSON.stringify(tables));
      localStorage.setItem('tableOrder', JSON.stringify(order));
    }
    async function loadAll() { read(); return { tables, order }; }
    function commit(change) {
      return enqueue(async () => {
        read();
        const put = (change && change.put) || {};
        ((change && change.remove) || []).forEach(name => { delete tables[name]; });
        Object.keys(put).forEach(name => { tables[name] = put[name]; });
        order = consistentOrder((change && change.order) || order, tables);
        write();
        notify(Object.keys(put));
      });
    }
    return { mode: 'localstorage', loadAll, commit, getBackup: async () => null, migrateLegacy: async () => {} };
  }

  /* ---------------- Публичный интерфейс ---------------- */

  let driver = null;

  async function open(options) {
    initChannel();
    try {
      const db = await openDb(options && options.onBlocked);
      driver = createIdbDriver(db);
      await driver.migrateLegacy();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      console.warn('IndexedDB недоступна, используется localStorage:', e);
      driver = createLocalDriver();
    }
    const data = await driver.loadAll();
    return { tables: data.tables, order: data.order, mode: driver.mode };
  }

  window.TabelStorage = {
    open,
    loadAll: () => driver.loadAll(),
    commit: change => driver.commit(change),
    getBackup: () => driver.getBackup(),
    subscribe,
    get mode() { return driver ? driver.mode : null; }
  };
})();

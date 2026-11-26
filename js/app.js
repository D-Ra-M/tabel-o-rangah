/*
 * Табель о рангах — основной код приложения.
 * Зависимости: logic.js, storage.js, ui.js, photo.js, Sortable.
 */
(function () {
  'use strict';

  const L = window.TabelLogic;
  const S = window.TabelStorage;
  const UI = window.TabelUI;
  const Photo = window.TabelPhoto;
  const $ = id => document.getElementById(id);

  const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

  /* ===== Состояние ===== */
  const state = {
    tables: Object.create(null), // имя -> { rows, createdAt, updatedAt }
    order: [],                   // порядок таблиц на главном экране
    current: null,               // имя открытой таблицы (null — нет открытой)
    dirty: false                 // есть несохранённые правки в редакторе
  };
  let isDraggingMode = false;
  let isBulkTableMode = false;
  let isBulkRowMode = false;
  let sortableInstance = null;
  let autoSaveTimer = null;

  /* ===== Хранилище ===== */
  function persistFailed(error) {
    console.error('Не удалось сохранить данные:', error);
    UI.snackbar('Не удалось сохранить данные. Освободите место в хранилище и скачайте резервную копию.');
  }

  function commit(change) {
    return S.commit(change).catch(persistFailed);
  }

  function getTableOrder() {
    const seen = new Set();
    const order = [];
    state.order.forEach(name => {
      if (name in state.tables && !seen.has(name)) { seen.add(name); order.push(name); }
    });
    Object.keys(state.tables).forEach(name => { if (!seen.has(name)) order.push(name); });
    state.order = order;
    return order;
  }

  function hasTable(name) {
    return Object.prototype.hasOwnProperty.call(state.tables, name);
  }

  /* ===== Признак изменений и автосохранение ===== */
  function markDirty() {
    state.dirty = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => autoSave(false), 400);
  }

  function resetDirty() {
    state.dirty = false;
  }

  function autoSave(showFeedback = true) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    if (!state.dirty) return;
    const name = state.current;
    if (name == null) {
      if (showFeedback) UI.snackbar('Таблица не сохранена (нет названия)');
      resetDirty();
      return;
    }
    const now = Date.now();
    const existing = hasTable(name) ? state.tables[name] : null;
    const table = Object.assign(collectTableData(), {
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    });
    state.tables[name] = table;
    if (!state.order.includes(name)) state.order.push(name);
    resetDirty();
    commit({ put: { [name]: table }, order: getTableOrder().slice() });
    if (showFeedback) UI.snackbar('Изменения сохранены');
  }

  // Сохраняем при сворачивании приложения, закрытии вкладки или уходе в фон.
  window.addEventListener('pagehide', () => autoSave(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autoSave(false);
  });

  /* ===== Навигация ===== */
  function showHome() {
    closeFab();
    closeEditorFab();
    if (isBulkRowMode) cancelBulkRowDelete();
    if (isBulkTableMode) cancelBulkTableDelete();
    if (isDraggingMode) toggleMoveMode();
    $('editorView').style.display = 'none';
    $('homeView').style.display = 'block';
    $('fabContainer').style.display = 'block';
    $('fabEditor').style.display = 'none';
    $('fabMain').classList.remove('rotated');
    state.current = null;
    renderTablesList();
  }

  function showEditor() {
    if (isDraggingMode) toggleMoveMode();
    $('fabContainer').style.display = 'none';
    $('fabEditor').style.display = 'block';
    $('homeView').style.display = 'none';
    $('editorView').style.display = 'flex';
    $('fabMain').classList.remove('rotated');
    $('fabEditorBtn').classList.remove('rotated');
  }

  function goHome() {
    autoSave();
    showHome();
  }

  /* ===== Плавающие кнопки ===== */
  function setFab(menuId, btnId, open) {
    $(menuId).classList.toggle('open', open);
    const btn = $(btnId);
    btn.classList.toggle('rotated', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggleFab() {
    if (isDraggingMode) { UI.snackbar('Сначала завершите перемещение (нажмите «Готово»)'); return; }
    setFab('fabMenu', 'fabMain', !$('fabMenu').classList.contains('open'));
  }

  function closeFab() { setFab('fabMenu', 'fabMain', false); }

  function toggleEditorFab() {
    if (isDraggingMode) { UI.snackbar('Сначала завершите перемещение (нажмите «Готово»)'); return; }
    setFab('fabEditorMenu', 'fabEditorBtn', !$('fabEditorMenu').classList.contains('open'));
  }

  function closeEditorFab() { setFab('fabEditorMenu', 'fabEditorBtn', false); }

  /* ===== Режим перетаскивания ===== */
  function toggleMoveMode() {
    if (!getTableOrder().length) { UI.snackbar('Нет таблиц для перемещения'); return; }
    autoSave();
    isDraggingMode = !isDraggingMode;
    if (sortableInstance) sortableInstance.option('disabled', !isDraggingMode);
    const doneBtn = $('fabDoneBtn');
    const fabMain = $('fabMain');
    const container = $('tablesList');
    if (isDraggingMode) {
      doneBtn.classList.add('visible');
      container.classList.add('sortable-enabled');
      fabMain.classList.add('rotated');
      closeFab();
      UI.snackbar('Перетаскивайте таблицы, затем нажмите «Готово»');
    } else {
      doneBtn.classList.remove('visible');
      container.classList.remove('sortable-enabled');
      fabMain.classList.remove('rotated');
      UI.snackbar('Режим перемещения выключен');
    }
    closeDropdowns();
    closeEditorFab();
  }

  /* ===== Список таблиц ===== */
  function renderTablesList() {
    const container = $('tablesList');
    const keys = getTableOrder();
    const hasTables = keys.length > 0;
    $('fabExport').classList.toggle('disabled', !hasTables);

    if (!hasTables) {
      container.innerHTML = '<div class="empty-state">Нет сохранённых таблиц.<br>Нажмите ✎ внизу справа, чтобы создать первую.</div>';
      if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
      $('fabDoneBtn').classList.remove('visible');
      $('fabMain').classList.remove('rotated');
      return;
    }

    container.innerHTML = keys.map(k => {
      const t = state.tables[k];
      const name = L.escapeHtml(k);
      return `<div class="table-card" data-name="${name}">
        <input class="table-select" type="checkbox" aria-label="Выбрать таблицу ${name}" data-change="bulkTableCount">
        <div class="table-card-info" data-action="open" role="button" tabindex="0" aria-label="Открыть таблицу ${name}">
          <div class="table-card-name">${name}</div>
          <div class="table-card-meta">Создано: ${L.formatDate(t.createdAt)}</div>
          <div class="table-card-meta">Изменено: ${L.formatDate(t.updatedAt)}</div>
        </div>
        <div class="table-card-actions">
          <button class="dots-btn" type="button" data-action="menu" aria-label="Действия с таблицей ${name}" aria-haspopup="menu" aria-expanded="false">⋮</button>
          <div class="dropdown-menu" role="menu">
            <button type="button" role="menuitem" data-action="move">Переместить</button>
            <button type="button" role="menuitem" data-action="rename">Переименовать</button>
            <button type="button" role="menuitem" class="delete" data-action="delete">Удалить</button>
          </div>
        </div>
      </div>`;
    }).join('');

    if (sortableInstance) sortableInstance.destroy();
    sortableInstance = typeof Sortable === 'undefined' ? null : new Sortable(container, {
      animation: 150,
      ghostClass: 'sortable-ghost',
      handle: '.table-card-info',
      disabled: !isDraggingMode,
      delay: 150,
      delayOnTouchOnly: true,
      touchStartThreshold: 4,
      onEnd: function () {
        state.order = Array.from(container.children).map(el => el.dataset.name).filter(n => hasTable(n));
        commit({ order: getTableOrder().slice() });
        UI.snackbar('Порядок таблиц обновлён');
      }
    });

    container.classList.toggle('sortable-enabled', isDraggingMode);
    $('fabDoneBtn').classList.toggle('visible', isDraggingMode);
    $('fabMain').classList.toggle('rotated', isDraggingMode);
  }

  function closeDropdowns() {
    document.querySelectorAll('.dropdown-menu.open').forEach(m => {
      m.classList.remove('open');
      const btn = m.parentElement && m.parentElement.querySelector('.dots-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleDropdown(event, btn) {
    event.stopPropagation();
    const menu = btn.parentElement.querySelector('.dropdown-menu');
    if (!menu) return;
    const wasOpen = menu.classList.contains('open');
    closeDropdowns();
    if (!wasOpen) {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  function handleCardAction(e, el) {
    const card = el.closest('.table-card');
    if (!card) return;
    const name = card.dataset.name;
    const action = el.dataset.action;
    if (isBulkTableMode) {
      if (action === 'menu' || action === 'rename' || action === 'delete' || action === 'move') return;
      const checkbox = card.querySelector('.table-select');
      if (checkbox && e.target !== checkbox) checkbox.checked = !checkbox.checked;
      updateBulkTableCount();
      return;
    }
    if (action === 'open') openTable(name);
    else if (action === 'menu') toggleDropdown(e, el);
    else if (action === 'move') { closeDropdowns(); toggleMoveMode(); }
    else if (action === 'rename') showRenameModal(name);
    else if (action === 'delete') deleteTable(name);
  }

  $('tablesList').addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (el) handleCardAction(e, el);
  });

  $('tablesList').addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.table-card-info')) {
      e.preventDefault();
      handleCardAction(e, e.target);
    } else if (e.key === 'Escape') {
      closeDropdowns();
    }
  });

  $('tablesList').addEventListener('change', function (e) {
    if (e.target.matches('.table-select')) updateBulkTableCount();
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.table-card-actions')) closeDropdowns();
    if (!isDraggingMode) {
      if (!$('fabContainer').contains(e.target)) closeFab();
      if (!$('fabEditor').contains(e.target)) closeEditorFab();
    }
  });

  /* ===== Групповое удаление таблиц и строк ===== */
  function setBulkButton(barId, count) {
    const b = document.querySelector('#' + barId + ' .bulk-confirm');
    b.disabled = !count;
    b.style.opacity = count ? '1' : '.45';
  }

  function startBulkTableDelete() {
    if (!getTableOrder().length) { UI.snackbar('Нет таблиц для удаления'); closeFab(); return; }
    isBulkTableMode = true;
    closeFab();
    $('tablesList').classList.add('bulk-table-mode');
    $('bulkTableBar').classList.add('visible');
    updateBulkTableCount();
    UI.snackbar('Отметьте таблицы для удаления');
  }

  function updateBulkTableCount() {
    const n = document.querySelectorAll('#tablesList .table-select:checked').length;
    $('bulkTableCount').textContent = 'Выбрано: ' + n;
    setBulkButton('bulkTableBar', n);
  }

  function cancelBulkTableDelete() {
    isBulkTableMode = false;
    $('tablesList').classList.remove('bulk-table-mode');
    $('bulkTableBar').classList.remove('visible');
    renderTablesList();
  }

  function confirmBulkTableDelete() {
    const names = Array.from(document.querySelectorAll('#tablesList .table-select:checked'))
      .map(x => x.closest('.table-card').dataset.name);
    if (!names.length) return;
    UI.confirm('Удалить таблицы?', 'Будет удалено таблиц: ' + names.length + '. Это действие нельзя отменить.', function () {
      names.forEach(n => { delete state.tables[n]; });
      state.order = getTableOrder().filter(n => !names.includes(n));
      commit({ remove: names, order: state.order.slice() });
      isBulkTableMode = false;
      $('tablesList').classList.remove('bulk-table-mode');
      $('bulkTableBar').classList.remove('visible');
      renderTablesList();
      UI.snackbar('Удалено таблиц: ' + names.length);
    }, null, true);
  }

  function startBulkRowDelete() {
    if (!document.querySelector('#tableBody tr')) { UI.snackbar('Нет строк для удаления'); closeEditorFab(); return; }
    isBulkRowMode = true;
    closeEditorFab();
    $('editorView').classList.add('bulk-row-mode');
    $('bulkRowBar').classList.add('visible');
    updateBulkRowCount();
    UI.snackbar('Отметьте строки для удаления');
  }

  function updateBulkRowCount() {
    const n = document.querySelectorAll('#tableBody .row-select:checked').length;
    $('bulkRowCount').textContent = 'Выбрано: ' + n;
    setBulkButton('bulkRowBar', n);
  }

  function cancelBulkRowDelete() {
    isBulkRowMode = false;
    $('editorView').classList.remove('bulk-row-mode');
    document.querySelectorAll('#tableBody .row-select').forEach(x => { x.checked = false; });
    $('bulkRowBar').classList.remove('visible');
  }

  function confirmBulkRowDelete() {
    const rows = Array.from(document.querySelectorAll('#tableBody .row-select:checked')).map(x => x.closest('tr')).filter(Boolean);
    if (!rows.length) return;
    UI.confirm('Удалить строки?', 'Будет удалено строк: ' + rows.length + '. Это действие нельзя отменить.', function () {
      rows.forEach(row => { stopRowMarquee(row); row.remove(); });
      isBulkRowMode = false;
      $('editorView').classList.remove('bulk-row-mode');
      $('bulkRowBar').classList.remove('visible');
      refreshTable();
      markDirty();
      UI.snackbar('Удалено строк: ' + rows.length);
    }, null, true);
  }

  /* ===== Удаление и переименование таблицы ===== */
  function deleteTable(name) {
    UI.confirm('Удаление таблицы', 'Удалить таблицу «' + name + '»?', function () {
      autoSave();
      delete state.tables[name];
      state.order = getTableOrder().filter(k => k !== name);
      commit({ remove: [name], order: state.order.slice() });
      renderTablesList();
      UI.snackbar('Таблица удалена');
      closeDropdowns();
    }, null, true);
  }

  let renameTarget = null;

  function showRenameModal(name) {
    closeDropdowns();
    autoSave();
    renameTarget = name;
    const input = $('renameInput');
    const btn = $('renameConfirmBtn');
    input.value = name;
    $('renameError').style.display = 'none';
    $('renameExistsError').style.display = 'none';
    btn.disabled = false;
    UI.showModal('renameModal');
    input.focus();
    input.select();
    input.oninput = function () {
      const val = this.value.trim();
      btn.disabled = val === '';
      $('renameError').style.display = 'none';
      $('renameExistsError').style.display = (val !== '' && val !== renameTarget && hasTable(val)) ? 'block' : 'none';
    };
  }

  function closeRenameModal() {
    UI.hideModal('renameModal');
    renameTarget = null;
  }

  function confirmRename() {
    const newName = L.normalizeTableName($('renameInput').value);
    if (!newName) {
      $('renameError').style.display = 'block';
      $('renameExistsError').style.display = 'none';
      return;
    }
    if (newName === renameTarget) { closeRenameModal(); return; }
    if (hasTable(newName)) {
      $('renameExistsError').style.display = 'block';
      $('renameError').style.display = 'none';
      return;
    }
    const oldName = renameTarget;
    const table = state.tables[oldName];
    state.tables[newName] = table;
    delete state.tables[oldName];
    state.order = getTableOrder().map(k => (k === oldName ? newName : k));
    commit({ remove: [oldName], put: { [newName]: table }, order: state.order.slice() });
    closeRenameModal();
    renderTablesList();
    UI.snackbar('Таблица переименована в «' + newName + '»');
  }

  /* ===== Открытие и создание таблицы ===== */
  function openTable(name) {
    if (isDraggingMode) { UI.snackbar('Сначала завершите перемещение (нажмите «Готово»)'); return; }
    autoSave();
    if (!hasTable(name)) return;
    applyTableData(state.tables[name]);
    state.current = name;
    $('groupNameDisplay').textContent = name;
    resetDirty();
    showEditor();
  }

  function fabCreate() {
    closeFab();
    const input = $('saveName');
    const btn = $('saveModalConfirm');
    input.value = '';
    $('saveNameError').style.display = 'none';
    btn.disabled = true;
    UI.showModal('saveModal');
    input.focus();
    input.oninput = function () {
      const val = this.value.trim();
      btn.disabled = val === '';
      $('saveNameError').textContent = 'Таблица с таким именем уже существует';
      $('saveNameError').style.display = (val !== '' && hasTable(val)) ? 'block' : 'none';
    };
  }

  function saveTable() {
    closeEditorFab();
    if (state.current == null) {
      UI.prompt('Сохранение таблицы', 'Введите название для новой таблицы', '', function (newName) {
        newName = L.normalizeTableName(newName);
        if (!newName) return;
        if (hasTable(newName)) {
          UI.alert('Ошибка', 'Таблица с таким именем уже существует. Введите другое название.');
          return;
        }
        const now = Date.now();
        const table = Object.assign(collectTableData(), { createdAt: now, updatedAt: now });
        state.tables[newName] = table;
        state.order.push(newName);
        commit({ put: { [newName]: table }, order: getTableOrder().slice() });
        state.current = newName;
        $('groupNameDisplay').textContent = newName;
        resetDirty();
        UI.snackbar('Таблица «' + newName + '» сохранена');
      });
      return;
    }
    // Явное сохранение: сначала приводим состояние к актуальному, затем пишем.
    state.dirty = true;
    autoSave(false);
    UI.snackbar('Таблица «' + state.current + '» сохранена');
  }

  function saveTableWithName() {
    const name = L.normalizeTableName($('saveName').value);
    const err = $('saveNameError');
    if (!name) {
      err.textContent = 'Введите название';
      err.style.display = 'block';
      return;
    }
    if (hasTable(name)) {
      err.textContent = 'Таблица с таким именем уже существует';
      err.style.display = 'block';
      return;
    }
    err.style.display = 'none';
    autoSave(false);
    const now = Date.now();
    const table = { rows: [], createdAt: now, updatedAt: now };
    state.tables[name] = table;
    state.order.push(name);
    commit({ put: { [name]: table }, order: getTableOrder().slice() });
    closeSaveModal();
    clearTableBody();
    state.current = name;
    $('groupNameDisplay').textContent = name;
    resetDirty();
    showEditor();
    UI.snackbar('Таблица «' + name + '» создана');
  }

  function closeSaveModal() {
    UI.hideModal('saveModal');
  }

  /* ===== Очистка ===== */
  function showClearModal() {
    closeEditorFab();
    UI.showModal('clearModal');
  }

  function closeClearModal() {
    UI.hideModal('clearModal');
  }

  function confirmClear() {
    closeClearModal();
    clearTableBody();
    markDirty();
    UI.snackbar('Таблица очищена');
  }

  /* ===== Окно имени при импорте ===== */
  let importDataCallback = null;

  function showImportNameModal(defaultName, callback) {
    const input = $('importNameInput');
    const btn = $('importNameConfirmBtn');
    input.value = defaultName || '';
    $('importNameError').style.display = 'none';
    $('importNameExistsError').style.display = 'none';
    btn.disabled = input.value.trim() === '';
    importDataCallback = callback;
    UI.showModal('importNameModal');
    input.focus();
    input.select();
    input.oninput = function () {
      const val = this.value.trim();
      btn.disabled = val === '';
      $('importNameError').style.display = 'none';
      $('importNameExistsError').textContent = 'Имя занято — таблица будет сохранена под другим именем';
      $('importNameExistsError').style.display = (val !== '' && hasTable(val)) ? 'block' : 'none';
    };
  }

  function closeImportNameModal() {
    UI.hideModal('importNameModal');
    importDataCallback = null;
  }

  function confirmImportName() {
    const name = L.normalizeTableName($('importNameInput').value);
    if (!name) {
      $('importNameError').style.display = 'block';
      $('importNameExistsError').style.display = 'none';
      return;
    }
    const finalName = hasTable(name) ? L.generateUniqueName(name, Object.keys(state.tables)) : name;
    const callback = importDataCallback;
    closeImportNameModal();
    if (callback) callback(finalName);
  }

  /* ===== Данные таблицы: чтение и применение ===== */
  function readRow(tr, withPhoto) {
    const grades = {};
    tr.querySelectorAll('.grade-inp').forEach(inp => { grades[inp.dataset.grade] = inp.value; });
    const row = { name: tr.querySelector('.name-inp').value, grades: grades, n: tr.querySelector('.n-inp').value };
    if (withPhoto) row.photo = tr.querySelector('.photo-img').getAttribute('src') || '';
    return row;
  }

  function collectTableData() {
    const rows = [];
    document.querySelectorAll('#tableBody tr').forEach(tr => rows.push(readRow(tr, true)));
    return { rows: rows };
  }

  function applyTableData(data) {
    clearTableBody();
    data = L.sanitizeTable(data);
    const fragment = document.createDocumentFragment();
    data.rows.forEach(r => {
      const tr = createRow();
      tr.querySelector('.name-inp').value = r.name || '';
      setRowPhoto(tr, r.photo);
      tr.querySelectorAll('.grade-inp').forEach(inp => {
        if (r.grades[inp.dataset.grade] !== undefined) inp.value = r.grades[inp.dataset.grade];
      });
      tr.querySelector('.n-inp').value = r.n;
      fragment.appendChild(tr);
    });
    $('tableBody').appendChild(fragment);
    refreshTable();
    setTimeout(() => {
      document.querySelectorAll('#tableBody .name-inp').forEach(startNameMarquee);
    }, 80);
    resetDirty();
  }

  function clearTableBody() {
    stopAllMarquee();
    $('tableBody').replaceChildren();
  }

  function setRowPhoto(tr, dataUrl) {
    const img = tr.querySelector('.photo-img');
    const lbl = tr.querySelector('.photo-wrap span');
    if (dataUrl) {
      img.src = dataUrl;
      img.style.display = 'block';
      if (lbl) lbl.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      if (lbl) lbl.style.display = 'block';
    }
  }

  /* ===== Прокрутка длинных имён (один общий цикл на все поля) ===== */
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const marqueeActive = new Set();
  let marqueeRaf = 0;
  let marqueeLast = 0;

  function marqueeStep(ts) {
    if (ts - marqueeLast >= 35) {
      marqueeLast = ts;
      marqueeActive.forEach(input => {
        if (!input.isConnected) { marqueeActive.delete(input); return; }
        const maxScroll = Math.max(0, input.scrollWidth - input.clientWidth);
        if (maxScroll <= 2) { marqueeActive.delete(input); input.scrollLeft = 0; return; }
        if (input._pauseUntil) {
          if (ts < input._pauseUntil) return;
          input._pauseUntil = 0;
          input.scrollLeft = 0;
          return;
        }
        if (input.scrollLeft >= maxScroll - 1) { input._pauseUntil = ts + 900; return; }
        input.scrollLeft = Math.min(maxScroll, input.scrollLeft + 1);
      });
    }
    marqueeRaf = marqueeActive.size ? requestAnimationFrame(marqueeStep) : 0;
  }

  function stopNameMarquee(input, reset) {
    marqueeActive.delete(input);
    input._pauseUntil = 0;
    if (reset) input.scrollLeft = 0;
  }

  function startNameMarquee(input) {
    if (!input || reduceMotion.matches) return;
    stopNameMarquee(input, true);
    if (document.activeElement === input) return;
    if (input.scrollWidth <= input.clientWidth + 2) return;
    marqueeActive.add(input);
    if (!marqueeRaf) marqueeRaf = requestAnimationFrame(marqueeStep);
  }

  function stopRowMarquee(tr) {
    const input = tr.querySelector('.name-inp');
    if (input) stopNameMarquee(input, false);
  }

  function stopAllMarquee() {
    marqueeActive.clear();
    if (marqueeRaf) { cancelAnimationFrame(marqueeRaf); marqueeRaf = 0; }
  }

  /* ===== Экспорт ===== */
  function fabExportAll() {
    if ($('fabExport').classList.contains('disabled')) { UI.snackbar('Нет таблиц для экспорта'); return; }
    autoSave();
    closeFab();
    const keys = getTableOrder();
    if (!keys.length) { UI.alert('Экспорт', 'Нет таблиц для экспорта'); return; }
    $('exportTableList').innerHTML = keys.map(k => {
      const name = L.escapeHtml(k);
      return `<div class="export-table-item">
        <span>${name}</span>
        <span class="export-btns">
          <button type="button" data-name="${name}" data-mode="file">Скачать</button>
          <button type="button" data-name="${name}" data-mode="copy">Копировать</button>
        </span>
      </div>`;
    }).join('');
    UI.showModal('exportSelectModal');
  }

  $('exportTableList').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'copy') copyTableText(b.dataset.name);
    else exportSingleTable(b.dataset.name);
  });

  function closeExportSelectModal() {
    UI.hideModal('exportSelectModal');
  }

  function tableJson(name) {
    if (!hasTable(name)) return null;
    const t = state.tables[name];
    return JSON.stringify(Object.assign(L.sanitizeTable(t), {
      createdAt: L.toTime(t.createdAt, Date.now()),
      updatedAt: L.toTime(t.updatedAt, Date.now())
    }), null, 2);
  }

  function showManualCopy(text) {
    const ta = $('manualCopyText');
    ta.value = text;
    UI.showModal('manualCopyModal');
    ta.focus();
    ta.select();
  }

  function closeManualCopy() {
    UI.hideModal('manualCopyModal');
  }

  async function copyTableText(name) {
    autoSave();
    const json = tableJson(name);
    if (json === null) { UI.alert('Ошибка', 'Таблица не найдена'); return; }
    try {
      await navigator.clipboard.writeText(json);
      closeExportSelectModal();
      UI.snackbar('Таблица «' + name + '» скопирована. Вставьте её в окне импорта');
    } catch (err) {
      closeExportSelectModal();
      showManualCopy(json);
    }
  }

  function downloadText(text, fileName, type) {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSingleTable(name) {
    autoSave();
    const json = tableJson(name);
    if (json === null) { UI.alert('Ошибка', 'Таблица не найдена'); return; }
    const fileName = (name.replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'table') + '.json';
    try {
      downloadText(json, fileName, 'application/json');
      closeExportSelectModal();
      UI.snackbar('Таблица «' + name + '» экспортирована');
    } catch (err) {
      UI.alert('Ошибка экспорта', 'Не удалось сохранить файл.');
    }
  }

  function downloadFullBackup() {
    closeFab();
    autoSave(false);
    const ordered = Object.create(null);
    getTableOrder().forEach(name => { ordered[name] = state.tables[name]; });
    downloadText(JSON.stringify(ordered, null, 2),
      'tabel-o-rangah-backup-' + L.dayKey() + '.json', 'application/json;charset=utf-8');
    UI.snackbar('Резервная копия подготовлена');
  }

  /* ===== Восстановление из автоматической копии ===== */
  async function fabRestore() {
    closeFab();
    autoSave(false);
    let backup = null;
    try { backup = await S.getBackup(); } catch (e) { console.error(e); }
    if (!backup) {
      UI.alert('Восстановление', 'Автоматическая копия ещё не создана. Она появляется при первой правке за день и хранит состояние на начало дня.');
      return;
    }
    const names = backup.order.filter(n => n in backup.tables);
    UI.confirm('Восстановить из копии?',
      'Копия от ' + L.formatDate(backup.createdAt) + ' (состояние на начало дня), таблиц: ' + names.length +
      '. Отсутствующие таблицы будут добавлены, а отличающиеся по содержимому — добавлены с пометкой «из копии». Текущие данные не изменятся.',
      function () {
        const put = {};
        let added = 0;
        names.forEach(name => {
          const t = backup.tables[name];
          if (hasTable(name)) {
            if (JSON.stringify(state.tables[name].rows) === JSON.stringify(t.rows)) return;
            const unique = L.generateUniqueName(L.normalizeTableName(name + ' (из копии)'), Object.keys(state.tables).concat(Object.keys(put)));
            put[unique] = t;
          } else {
            put[name] = t;
          }
          added++;
        });
        if (!added) { UI.snackbar('В копии нет ничего нового'); return; }
        Object.keys(put).forEach(n => { state.tables[n] = put[n]; state.order.push(n); });
        commit({ put: put, order: getTableOrder().slice() });
        renderTablesList();
        UI.snackbar('Восстановлено таблиц: ' + added);
      });
  }

  /* ===== Импорт ===== */
  function resetImportLabel() {
    $('importFileLabel').textContent = 'Выбрать файл';
  }

  (function setupImportPicker() {
    const input = $('importFileInput');
    const drop = $('fileDrop');
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      $('importFileLabel').textContent = f ? f.name : 'Выбрать файл';
    });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        input.files = dt.files;
        $('importFileLabel').textContent = f.name;
      } catch (err) { /* не критично */ }
    });
  })();

  function fabImport() {
    closeFab();
    resetImportLabel();
    $('importPasteText').value = '';
    $('importFileInput').value = '';
    UI.showModal('importFileModal');
  }

  function closeImportFileModal() {
    UI.hideModal('importFileModal');
  }

  function reopenImportModal() {
    UI.showModal('importFileModal');
  }

  function importSingleTable(data, fileName) {
    closeImportFileModal();
    const defaultName = L.normalizeTableName(L.getFileNameWithoutExtension(fileName)) || 'Импортированная';
    showImportNameModal(defaultName, function (finalName) {
      autoSave(false);
      if (hasTable(finalName)) finalName = L.generateUniqueName(finalName, Object.keys(state.tables));
      const now = Date.now();
      const table = Object.assign(L.sanitizeTable(data), { createdAt: now, updatedAt: now });
      state.tables[finalName] = table;
      state.order.push(finalName);
      commit({ put: { [finalName]: table }, order: getTableOrder().slice() });
      openTable(finalName);
      UI.snackbar('Таблица «' + finalName + '» импортирована');
    });
  }

  function importManyTables(data) {
    const now = Date.now();
    const renamed = [];
    const incoming = Object.create(null);
    Object.keys(data).forEach(key => {
      const t = data[key];
      if (!t || typeof t !== 'object' || Array.isArray(t) || !Array.isArray(t.rows)) return;
      let name = L.normalizeTableName(key) || 'Импортированная';
      if (hasTable(name) || name in incoming) {
        const unique = L.generateUniqueName(name, Object.keys(state.tables).concat(Object.keys(incoming)));
        renamed.push(name + ' → ' + unique);
        name = unique;
      }
      incoming[name] = Object.assign(L.sanitizeTable(t), {
        createdAt: L.toTime(t.createdAt || t.savedAt, now),
        updatedAt: L.toTime(t.updatedAt || t.savedAt, now)
      });
    });
    const names = Object.keys(incoming);
    if (!names.length) {
      closeImportFileModal();
      UI.alert('Ошибка импорта', 'В файле не найдено ни одной таблицы.', reopenImportModal);
      return;
    }
    autoSave(false);
    names.forEach(n => { state.tables[n] = incoming[n]; state.order.push(n); });
    commit({ put: incoming, order: getTableOrder().slice() });
    closeImportFileModal();
    renderTablesList();
    UI.snackbar('Импортировано ' + names.length + ' таблиц' + (renamed.length ? '. Переименованы: ' + renamed.join('; ') : ''));
  }

  function runImport(raw, fileName) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      closeImportFileModal();
      UI.alert('Ошибка чтения файла',
        err.message +
        '\n\nВозможные причины:\n• В файле есть незакрытая кавычка (например, в названии или фамилии)\n• Не хватает запятой между полями\n• Файл повреждён или содержит недопустимые символы\n\nПроверьте файл в любом текстовом редакторе и убедитесь, что он является корректным JSON.',
        reopenImportModal);
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      closeImportFileModal();
      UI.alert('Ошибка импорта', 'Неверный формат JSON', reopenImportModal);
      return;
    }
    if (Array.isArray(data.rows)) importSingleTable(data, fileName);
    else importManyTables(data);
  }

  function handleImportFile() {
    const file = $('importFileInput').files[0];
    const text = $('importPasteText').value.trim();
    if (!file && !text) {
      closeImportFileModal();
      UI.alert('Импорт', 'Выберите JSON-файл или вставьте текст таблицы', reopenImportModal);
      return;
    }
    if (file && file.size > IMPORT_MAX_BYTES) {
      closeImportFileModal();
      UI.alert('Импорт', 'Файл слишком большой (максимум ' + (IMPORT_MAX_BYTES / 1024 / 1024) + ' МБ)');
      return;
    }
    if (!file) { runImport(text, 'Импортированная'); return; }
    const reader = new FileReader();
    reader.onload = e => runImport(e.target.result, file.name);
    reader.onerror = function () {
      closeImportFileModal();
      UI.alert('Ошибка чтения файла', 'Не удалось прочитать файл. Попробуйте вставить текст таблицы вручную.', reopenImportModal);
    };
    reader.readAsText(file);
  }

  /* ===== Строки таблицы ===== */
  function createRow() {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-photo">
        <div class="photo-wrap">
          <img class="photo-img" alt="">
          <span aria-hidden="true">📷</span>
          <input type="file" accept="image/*,.heic,.heif" class="photo-inp" aria-label="Загрузить фото">
        </div>
      </td>
      <td class="row-num">1</td>
      <td><input type="text" class="name-inp" maxlength="200" placeholder="Имя" aria-label="Имя"></td>
      <td class="total-count">0</td>
      <td><input type="number" data-grade="5" class="grade-inp" placeholder="-" aria-label="Оценка 5"></td>
      <td><input type="number" data-grade="4" class="grade-inp" placeholder="-" aria-label="Оценка 4"></td>
      <td><input type="number" data-grade="3" class="grade-inp" placeholder="-" aria-label="Оценка 3"></td>
      <td><input type="number" data-grade="2" class="grade-inp" placeholder="-" aria-label="Оценка 2"></td>
      <td><input type="number" data-grade="1" class="grade-inp" placeholder="-" aria-label="Оценка 1"></td>
      <td><input type="number" data-grade="0" class="grade-inp late" placeholder="-" aria-label="Оценка 0"></td>
      <td><input type="number" class="n-inp late" placeholder="-" aria-label="Пропуски (Н)"></td>
      <td class="total-score">0</td>
      <td class="cell-actions">
        <input class="row-select" type="checkbox" aria-label="Выбрать строку">
        <button class="del-row-btn" type="button" aria-label="Удалить строку">×</button>
      </td>
    `;
    return tr;
  }

  async function handlePhotoUpload(e) {
    const inp = e.target;
    const wrap = inp.closest('.photo-wrap');
    if (!wrap) return;
    const tr = inp.closest('tr');
    const lbl = wrap.querySelector('span');
    const file = inp.files[0];
    if (!file) return;
    if (file.size > Photo.MAX_INPUT) {
      UI.alert('Фото слишком большое', 'Размер исходного файла превышает 30 МБ. Выберите фотографию меньшего размера.');
      inp.value = '';
      return;
    }
    if (!/^image\//i.test(file.type) && !Photo.isHeic(file)) {
      UI.alert('Неподдерживаемый файл', 'Выберите изображение в формате JPG, PNG, WebP, GIF, AVIF или HEIC/HEIF.');
      inp.value = '';
      return;
    }
    const oldLabel = lbl ? lbl.textContent : '';
    if (lbl) lbl.textContent = 'Обработка…';
    inp.disabled = true;
    try {
      const dataUrl = await Photo.process(file);
      if (tr.isConnected) {
        if (lbl) lbl.textContent = oldLabel || '📷';
        setRowPhoto(tr, dataUrl);
        markDirty();
      }
    } catch (error) {
      if (lbl) { lbl.textContent = oldLabel || '📷'; lbl.style.display = 'block'; }
      UI.alert('Не удалось добавить фото', error && error.message ? error.message : 'Попробуйте другое изображение.');
    } finally {
      inp.disabled = false;
      inp.value = '';
    }
  }

  function handleDeleteRow(e) {
    const btn = e.target.closest('.del-row-btn');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (!tr) return;
    const rowName = (tr.querySelector('.name-inp').value || '').trim();
    const label = rowName ? ' «' + rowName + '»' : '';
    UI.confirm('Удалить строку?', 'Вы действительно хотите удалить строку' + label + '? Это действие нельзя отменить.', function () {
      stopRowMarquee(tr);
      tr.remove();
      refreshTable();
      markDirty();
    }, null, true);
  }

  /* ===== Пересчёт, места и сортировка ===== */
  function updateRowTotals(tr) {
    const calc = L.calcRow(readRow(tr, false));
    tr.querySelector('.total-count').textContent = calc.count;
    tr.querySelector('.total-score').textContent = calc.score;
  }

  // Полный пересчёт: итоги, сортировка и места (с учётом равных баллов).
  function refreshTable() {
    const tb = $('tableBody');
    const trs = Array.from(tb.children);
    const ranked = L.rankRows(trs.map(tr => readRow(tr, false)));
    if (ranked.some((item, i) => item.index !== i)) {
      const frag = document.createDocumentFragment();
      ranked.forEach(item => frag.appendChild(trs[item.index]));
      tb.appendChild(frag);
    }
    ranked.forEach(item => {
      const tr = trs[item.index];
      tr.querySelector('.total-count').textContent = item.count;
      tr.querySelector('.total-score').textContent = item.score;
      const cell = tr.querySelector('.row-num');
      cell.textContent = item.place;
      cell.classList.toggle('rank-place-1', item.medal === 1);
      cell.classList.toggle('rank-place-2', item.medal === 2);
      cell.classList.toggle('rank-place-3', item.medal === 3);
    });
  }

  function addRow() {
    $('tableBody').appendChild(createRow());
    refreshTable();
    markDirty();
    closeEditorFab();
  }

  /* ===== События таблицы ===== */
  const tbody = $('tableBody');
  tbody.addEventListener('change', function (e) {
    if (e.target.type === 'file') handlePhotoUpload(e);
    if (e.target.classList.contains('row-select')) updateBulkRowCount();
  });
  tbody.addEventListener('click', handleDeleteRow);
  tbody.addEventListener('input', function (e) {
    const target = e.target;
    if (target.type === 'file' || target.tagName === 'BUTTON' || target.type === 'checkbox') return;
    markDirty();
    if (target.classList.contains('grade-inp') || target.classList.contains('n-inp')) {
      updateRowTotals(target.closest('tr'));
    }
  });
  tbody.addEventListener('blur', function (e) {
    const target = e.target;
    if (target.classList.contains('name-inp')) startNameMarquee(target);
    if (target.classList.contains('grade-inp') || target.classList.contains('n-inp')) {
      // Пока пользователь переходит между полями одной строки, строку не двигаем:
      // иначе она «убегает» из-под курсора. Пересортировка — когда фокус ушёл из строки.
      const next = e.relatedTarget;
      const tr = target.closest('tr');
      if (next && tr && tr.contains(next)) updateRowTotals(tr);
      else refreshTable();
    }
  }, true);
  tbody.addEventListener('focusin', function (e) {
    if (e.target.classList.contains('name-inp')) stopNameMarquee(e.target, true);
  });

  /* ===== Синхронизация с другими вкладками ===== */
  let syncTimer = null;

  function scheduleExternalSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(applyExternalChanges, 150);
  }

  async function applyExternalChanges() {
    let data;
    try { data = await S.loadAll(); } catch (e) { console.error(e); return; }
    const editing = state.current;
    const dirtyLocal = state.dirty && editing != null;
    const before = editing != null && hasTable(editing) ? state.tables[editing].updatedAt : null;
    state.tables = data.tables;
    state.order = data.order;
    if (dirtyLocal) {
      // Несохранённые локальные правки не теряем: они перезапишут таблицу при ближайшем автосохранении.
      return;
    }
    if (editing != null) {
      if (!hasTable(editing)) {
        UI.snackbar('Таблица удалена в другом окне');
        showHome();
      } else if (state.tables[editing].updatedAt !== before) {
        applyTableData(state.tables[editing]);
        UI.snackbar('Таблица обновлена из другого окна');
      }
      return;
    }
    if (!isDraggingMode && !isBulkTableMode) renderTablesList();
  }

  /* ===== Привязка кнопок разметки (data-click) ===== */
  const actions = {
    goHome, toggleMoveMode, fabCreate, startBulkTableDelete, fabImport, fabExportAll,
    downloadFullBackup, fabRestore, toggleFab, addRow, startBulkRowDelete, saveTable,
    showClearModal, toggleEditorFab,
    confirmBulkTableDelete, cancelBulkTableDelete, confirmBulkRowDelete, cancelBulkRowDelete,
    saveTableWithName, closeSaveModal, confirmRename, closeRenameModal,
    confirmClear, closeClearModal, confirmImportName, closeImportNameModal,
    closeExportSelectModal, closeManualCopy, handleImportFile, closeImportFileModal
  };

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-click]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.click];
    if (fn) fn(e, el);
  });

  /* ===== Запуск ===== */
  async function init() {
    try {
      const data = await S.open({
        onBlocked: () => UI.snackbar('Закройте другие вкладки приложения, чтобы завершить обновление хранилища.')
      });
      state.tables = data.tables;
      state.order = data.order;
      if (data.mode === 'localstorage') {
        UI.snackbar('Постоянное хранилище недоступно: данные сохраняются во временном хранилище браузера.');
      }
    } catch (error) {
      console.error('Ошибка инициализации хранилища:', error);
    }
    S.subscribe(scheduleExternalSync);
    showHome();
  }

  init();
})();

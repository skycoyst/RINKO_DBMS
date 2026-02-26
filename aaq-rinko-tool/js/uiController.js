/**
 * uiController.js
 * UI制御: スイムレーン・カード生成・ドラッグ&ドロップ・モーダル・トースト
 */
'use strict';

const uiController = (() => {

  // ─── ドラッグ状態 ───
  let dragCardId = null;
  let dragSourceEl = null;
  let selectedIds = new Set();

  // ─── スイムレーン生成 ───

  /**
   * スイムレーンを生成して #swimlanes に追加
   * @param {object} station
   * @returns {HTMLElement}
   */
  function createSwimlane(station) {
    const container = document.getElementById('swimlanes');

    const el = document.createElement('div');
    el.className = 'swimlane';
    el.dataset.stationId = station.id;

    el.innerHTML = `
      <div class="swimlane-header">
        <span class="station-link" onclick="mapController.openMapModal('${_esc(station.id)}', app.state.stations, app.getFileCounts())">${_esc(station.name)}</span>
        <span class="cat-${_esc(station.category)} badge-spaced">${_esc(station.category)}</span>
        <span class="badge badge-blue badge-spaced swimlane-count" data-station-id="${_esc(station.id)}">0</span>
        <div class="swimlane-actions">
          <button class="btn-secondary btn-sm" title="地点を編集"
            onclick="app.editStation('${_esc(station.id)}')">編集</button>
          <button class="btn-danger btn-sm" title="スイムレーンを削除"
            onclick="app.deleteSwimlane('${_esc(station.id)}')">削除</button>
        </div>
      </div>
      <div class="swimlane-body swim-drop-target"
           data-station-id="${_esc(station.id)}"
           ondragover="uiController.onDragOver(event)"
           ondrop="uiController.onDrop(event)">
        <div class="swim-placeholder">ファイルをここへドラッグ</div>
      </div>
    `;

    container.appendChild(el);
    return el;
  }

  /**
   * スイムレーンを削除
   * @param {string} stationId
   */
  function removeSwimlane(stationId) {
    const el = document.querySelector(`.swimlane[data-station-id="${stationId}"]`);
    if (el) el.remove();
  }

  /**
   * 全スイムレーンをクリア
   */
  function clearAllSwimlanes() {
    document.getElementById('swimlanes').innerHTML = '';
  }

  // ─── ファイルカード生成 ───

  /**
   * ファイルカードを生成して返す
   * @param {object} card
   * @returns {HTMLElement}
   */
  function createFileCard(card) {
    const el = document.createElement('div');
    el.className = 'file-card';
    el.dataset.cardId = card.id;
    el.draggable = true;
    el.title = card.fileName;

    const icon = card.parsed && card.parsed.warningFallback ? '⚠️' : '';

    const dtStr = card.parsed && card.parsed.firstDateTime ? card.parsed.firstDateTime : '—';
    const depStr = card.parsed && card.parsed.maxDepth !== null ? `${card.parsed.maxDepth} m` : '—';
    const cntStr = card.parsed && card.parsed.dataRows ? `${card.parsed.dataRows.length} 件` : '—';
    const gps = card.parsed && card.parsed.gpsCoord;
    const gpsStr = gps ? `${gps.lat.toFixed(4)}°N, ${gps.lon.toFixed(4)}°E` : '—';

    el.innerHTML = `
      ${icon ? `<div class="file-card-icon" title="ヘッダー行を69行目で検出">${icon}</div>` : ''}
      <div class="file-card-name">${_esc(card.fileName.replace(/\.csv$/i, ''))}</div>
      <div class="file-card-meta">
        <div>📅 ${_esc(dtStr)}</div>
        <div>⬇ ${_esc(depStr)}</div>
        <div># ${_esc(cntStr)}</div>
        <div>📍 ${_esc(gpsStr)}</div>
      </div>
    `;

    // カードクリック: 選択ロジック（またはプレビュー）
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;

      const isMulti = e.ctrlKey || e.metaKey;
      if (isMulti) {
        // 複数選択トグル
        if (selectedIds.has(card.id)) {
          selectedIds.delete(card.id);
          el.classList.remove('selected');
        } else {
          selectedIds.add(card.id);
          el.classList.add('selected');
        }
      } else {
        // 単一選択（既に選択されている場合はプレビューへ、そうでない場合は選択をリセットしてこれだけ選択）
        if (selectedIds.has(card.id) && selectedIds.size === 1) {
          showPreviewModal(card);
        } else {
          _clearSelection();
          selectedIds.add(card.id);
          el.classList.add('selected');
          // 選択された直後はプレビューを出さないようにすることもできるが、
          // ユーザビリティを考えて「選択済みならプレビュー」とした
        }
      }
    });

    // ドラッグ
    el.addEventListener('dragstart', (e) => {
      dragCardId = card.id;
      dragSourceEl = el.closest('.swim-drop-target, #unclassified-area');

      // ドラッグ対象が選択されていない場合は、それだけを選択状態にする
      if (!selectedIds.has(card.id)) {
        _clearSelection();
        selectedIds.add(card.id);
        el.classList.add('selected');
      }

      const dragIds = Array.from(selectedIds);
      el.classList.add('dragging');

      if (dragIds.length > 1) {
        el.classList.add('dragging-multiple');
        el.dataset.dragCount = dragIds.length;
      }

      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/json', JSON.stringify(dragIds));
      // フォールバック（古いブラウザ用）
      e.dataTransfer.setData('text/plain', card.id);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      el.classList.remove('dragging-multiple');
      delete el.dataset.dragCount;
      dragCardId = null;
      dragSourceEl = null;
    });

    return el;
  }

  /**
   * カードをドロップターゲットに挿入
   * @param {string} cardId
   * @param {string} stationId  '' = 未分類
   */
  function moveCardToArea(cardId, stationId) {
    const card = document.querySelector(`.file-card[data-card-id="${cardId}"]`);
    if (!card) return;

    let target;
    if (stationId === '') {
      target = document.getElementById('unclassified-area');
    } else {
      target = document.querySelector(`.swimlane[data-station-id="${stationId}"] .swim-drop-target`);
    }
    if (!target) return;

    _hidePlaceholder(target);
    target.appendChild(card);
    _updateCounts();
  }

  /**
   * カードを全エリアから削除
   * @param {string} cardId
   */
  function removeCard(cardId) {
    const el = document.querySelector(`.file-card[data-card-id="${cardId}"]`);
    if (el) el.remove();
    _updateCounts();
  }

  // ─── ドラッグ&ドロップ ───

  function onDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  }

  function onDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const json = e.dataTransfer.getData('application/json');
    const dragIds = json ? JSON.parse(json) : [e.dataTransfer.getData('text/plain') || dragCardId];

    if (!dragIds || dragIds.length === 0) return;

    const target = e.currentTarget;
    const newStationId = target.dataset.stationId || '';

    // app に通知して状態更新
    if (dragIds.length > 1) {
      app.moveCards(dragIds, newStationId);
    } else {
      app.moveCard(dragIds[0], newStationId);
    }

    // 移動後は選択解除
    _clearSelection();
  }

  function setupDragAndDrop() {
    // ドラッグオーバー解除
    document.querySelectorAll('.swim-drop-target').forEach(el => {
      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) {
          el.classList.remove('drag-over');
        }
      });
    });
  }

  // ─── 地点マスタ一覧（左ペイン） ───

  /**
   * 地点一覧を再描画
   * @param {object[]} stations
   * @param {Map<string,number>} fileCounts
   */
  function renderStationList(stations, fileCounts) {
    const container = document.getElementById('station-list');
    const countEl = document.getElementById('master-count');

    const validStations = stations.filter(s => !s._invalid);
    countEl.textContent = `${validStations.length} 件`;

    if (validStations.length === 0) {
      container.innerHTML = '<div class="station-list-empty">地点マスタを読み込んでください</div>';
      return;
    }

    container.innerHTML = '';

    // 地点追加ボタン
    const addBtn = document.createElement('div');
    addBtn.className = 'add-btn-wrap';
    addBtn.innerHTML = `
      <button onclick="app.addStationFromMap()" class="btn-secondary btn-sm btn-full">
        ＋ 地図から地点を追加
      </button>
    `;
    container.appendChild(addBtn);

    for (const st of validStations) {
      const fc = fileCounts ? (fileCounts.get(st.id) || 0) : 0;
      const item = document.createElement('div');
      item.className = 'station-item';
      item.dataset.stationId = st.id;

      item.innerHTML = `
        <div class="station-info">
          <span class="station-link"
            onclick="mapController.openMapModal('${_esc(st.id)}', app.state.stations, app.getFileCounts())">
            ${_esc(st.name)}
          </span>
          <span class="cat-${_esc(st.category)} badge-spaced">${_esc(st.category)}</span>
          <div class="station-meta">${_esc(st.id)} &nbsp;|&nbsp; ${fc} ファイル</div>
        </div>
        <div class="station-actions">
          <button class="btn-secondary btn-sm" onclick="app.editStation('${_esc(st.id)}')">編集</button>
          <button class="btn-danger btn-sm" onclick="app.deleteStation('${_esc(st.id)}')">削除</button>
        </div>
      `;
      container.appendChild(item);
    }
  }

  // ─── データプレビューモーダル ───

  /**
   * プレビューモーダルを表示
   * @param {object} card
   */
  function showPreviewModal(card) {
    if (!card.parsed || card.parsed.error) {
      showToast(`プレビュー不可: ${card.parsed ? card.parsed.error : '不明なエラー'}`, 'error');
      return;
    }

    const modal = document.getElementById('preview-modal');
    document.getElementById('preview-modal-title').textContent = card.fileName;

    const container = document.getElementById('preview-table-container');
    const headers = card.parsed.headerRow;
    const rows = card.parsed.dataRows.slice(0, 500);

    let html = '<table><thead><tr>';
    html += headers.map(h => `<th>${_esc(h)}</th>`).join('');
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      html += headers.map((_, i) => `<td>${_esc(row[i] !== undefined ? row[i] : '')}</td>`).join('');
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (card.parsed.dataRows.length > 500) {
      html += `<div class="preview-row-count">※ 最初の500行を表示（全${card.parsed.dataRows.length}行）</div>`;
    }
    container.innerHTML = html;

    modal.classList.remove('hidden');
  }

  /**
   * プレビューモーダルを閉じる
   */
  function closePreviewModal() {
    document.getElementById('preview-modal').classList.add('hidden');
  }

  // ─── 地点フォームモーダル ───

  /**
   * 地点追加フォームモーダルを開く
   * @param {object|null} station  null=追加、object=編集
   * @param {number|null} lat 地図クリック座標
   * @param {number|null} lon
   */
  function openStationFormModal(station = null, lat = null, lon = null) {
    const modal = document.getElementById('station-form-modal');
    document.getElementById('station-form-title').textContent = station ? '地点を編集' : '地点を追加';
    document.getElementById('sf-editing-id').value = station ? station.id : '';
    document.getElementById('sf-name').value = station ? station.name : '';
    document.getElementById('sf-id').value = station ? station.id : _generateNextId();
    document.getElementById('sf-category').value = station ? station.category : '定期';
    document.getElementById('sf-lat').value = station ? (station.lat || '') : (lat !== null ? lat.toFixed(6) : '');
    document.getElementById('sf-lon').value = station ? (station.lon || '') : (lon !== null ? lon.toFixed(6) : '');
    document.getElementById('sf-keywords').value = station ? (station.keywords || []).join('|') : '';
    document.getElementById('sf-note').value = station ? (station.note || '') : '';
    modal.classList.remove('hidden');
  }

  function closeStationFormModal() {
    document.getElementById('station-form-modal').classList.add('hidden');
  }

  // ─── 汎用確認ダイアログ ───

  /**
   * 確認ダイアログを表示
   * @param {string} title
   * @param {string} message
   * @param {Array<{label:string, type:string, callback:function}>} buttons
   */
  function showConfirm(title, message, buttons) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    const btnContainer = document.getElementById('confirm-buttons');
    btnContainer.innerHTML = '';
    for (const btn of buttons) {
      const el = document.createElement('button');
      el.className = btn.type === 'danger' ? 'btn-danger' : btn.type === 'primary' ? 'btn-primary' : 'btn-secondary';
      el.textContent = btn.label;
      el.onclick = () => {
        closeConfirm();
        btn.callback();
      };
      btnContainer.appendChild(el);
    }

    document.getElementById('confirm-dialog').classList.remove('hidden');
  }

  function closeConfirm() {
    document.getElementById('confirm-dialog').classList.add('hidden');
  }

  // ─── モーダル外クリックで閉じる ───

  function setupModalOutsideClick() {
    // 地図モーダルはモーダル外クリックでは閉じない（×ボタンのみ）
    document.getElementById('preview-modal').addEventListener('click', function (e) {
      if (e.target === this) closePreviewModal();
    });
    document.getElementById('station-form-modal').addEventListener('click', function (e) {
      if (e.target === this) closeStationFormModal();
    });
    document.getElementById('confirm-dialog').addEventListener('click', function (e) {
      if (e.target === this) closeConfirm();
    });
  }

  // ─── トースト通知 ───

  /**
   * トースト表示
   * @param {string} message
   * @param {'success'|'error'|'warn'|'info'} type
   * @param {number} duration ms
   */
  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ─── 出力ボタン有効化 ───

  function updateOutputButtons(hasCards) {
    const btnA = document.getElementById('btn-output-a');
    const btnB = document.getElementById('btn-output-b');
    btnA.disabled = !hasCards;
    btnB.disabled = !hasCards;
  }

  function showResetButton(show) {
    document.getElementById('btn-reset-master').classList.toggle('hidden', !show);
    document.getElementById('btn-download-master').classList.toggle('hidden', !show);
  }

  // ─── カード数バッジ更新 ───

  function _updateCounts() {
    // 未分類
    const unclassArea = document.getElementById('unclassified-area');
    const unclassCount = unclassArea.querySelectorAll('.file-card').length;
    document.getElementById('unclassified-count').textContent = unclassCount;
    _togglePlaceholder(unclassArea, unclassCount);

    // 各スイムレーン
    document.querySelectorAll('.swimlane').forEach(sl => {
      const sid = sl.dataset.stationId;
      const body = sl.querySelector('.swim-drop-target');
      const cnt = body ? body.querySelectorAll('.file-card').length : 0;
      const badge = document.querySelector(`.swimlane-count[data-station-id="${sid}"]`);
      if (badge) badge.textContent = cnt;
      if (body) _togglePlaceholder(body, cnt);
    });

    // 総カード数
    const total = document.querySelectorAll('.file-card').length;
    updateOutputButtons(total > 0);
  }

  function _togglePlaceholder(areaEl, count) {
    const ph = areaEl.querySelector('.swim-placeholder, .unclassified-placeholder');
    if (ph) ph.style.display = count > 0 ? 'none' : '';
  }

  function _hidePlaceholder(areaEl) {
    const ph = areaEl.querySelector('.swim-placeholder, .unclassified-placeholder');
    if (ph) ph.style.display = 'none';
  }

  // ─── 地点ID 自動生成 ───
  function _generateNextId() {
    const ids = app.state.stations.map(s => s.id);
    let max = 0;
    for (const id of ids) {
      const m = id.match(/ST(\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `ST${String(max + 1).padStart(3, '0')}`;
  }

  function _clearSelection() {
    selectedIds.clear();
    document.querySelectorAll('.file-card.selected').forEach(el => el.classList.remove('selected'));
  }

  // ─── XSS対策 ───
  function _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── 公開 API ───
  return {
    createSwimlane,
    removeSwimlane,
    clearAllSwimlanes,
    createFileCard,
    moveCardToArea,
    removeCard,
    onDragOver,
    onDrop,
    setupDragAndDrop,
    renderStationList,
    showPreviewModal,
    closePreviewModal,
    openStationFormModal,
    closeStationFormModal,
    showConfirm,
    closeConfirm,
    setupModalOutsideClick,
    showToast,
    updateOutputButtons,
    showResetButton,
    updateCounts: _updateCounts,
  };
})();

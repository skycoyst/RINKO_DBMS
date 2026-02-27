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
  let previewMap = null;
  let previewMarkers = [];

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
        <div class="swimlane-header-main">
          <div class="swimlane-info-col">
            <!-- 1行目: 地点 & ファイル数 -->
            <div class="swimlane-header-row">
              <span class="station-link" onclick="mapController.openMapModal('${_esc(station.id)}', app.state.stations, app.getFileCounts())" title="${_esc(station.name)}">
                ${_esc(station.name)}
              </span>
              <span class="badge badge-blue swimlane-count shrink-0" data-station-id="${_esc(station.id)}">0</span>
            </div>
            <!-- 2行目: 地点ID -->
            <div class="text-[12px] text-gray-500 truncate" title="ID: ${_esc(station.id)}">
              ID: ${_esc(station.id)}
            </div>
            <!-- 3行目: その他（カテゴリ） -->
            <div class="flex items-center">
              <span class="cat-${_esc(station.category)} !text-[9px] !px-1 !py-0">${_esc(station.category)}</span>
            </div>
          </div>
          <!-- 4行目: ボタン列 (横並び) -->
          <div class="swimlane-btn-col">
            <button class="btn-secondary btn-sm" title="地点を編集" onclick="app.editStation('${_esc(station.id)}')">編集</button>
            <button class="btn-danger btn-sm" title="スイムレーンから解除" onclick="app.deleteSwimlane('${_esc(station.id)}')">解除</button>
          </div>
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
    if (card.parsed && card.parsed.gpsCoord) {
      el.classList.add('has-gps');
    }
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
      <div class="file-card-delete" title="ファイルを削除" onclick="app.removeFile('${_esc(card.id)}', event)">×</div>
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

    // ─── 距離チェック（300m以上離れていたら警告） ───
    updateCardDistanceWarning(cardId, stationId);

    _updateCounts();
  }

  /**
   * カードの観測点と地点マスタの距離をチェックし、300m以上なら警告クラスを付与
   * @param {string} cardId
   * @param {string} stationId
   */
  function updateCardDistanceWarning(cardId, stationId) {
    const cardEl = document.querySelector(`.file-card[data-card-id="${cardId}"]`);
    if (!cardEl) return;

    if (!stationId) {
      cardEl.classList.remove('too-far');
      return;
    }

    const card = app.state.cards.get(cardId);
    const station = app.state.stations.find(s => s.id === stationId);

    if (card && card.parsed && card.parsed.gpsCoord && station && station.lat !== null && station.lon !== null) {
      const dist = dataProcessor.calculateDistance(
        card.parsed.gpsCoord.lat,
        card.parsed.gpsCoord.lon,
        station.lat,
        station.lon
      );

      if (dist !== null && dist > 300) {
        cardEl.classList.add('too-far');
        cardEl.title = `警告: 地点マスタから約${Math.round(dist)}m離れています\n${card.fileName}`;
      } else {
        cardEl.classList.remove('too-far');
        cardEl.title = card.fileName;
      }
    } else {
      cardEl.classList.remove('too-far');
      cardEl.title = card.fileName;
    }
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
    const listContainer = document.getElementById('station-list');
    const toolsContainer = document.getElementById('station-tools');
    const countEl = document.getElementById('master-count');

    const validStations = stations.filter(s => !s._invalid);
    countEl.textContent = `${validStations.length} 件`;

    // コンテナをクリア
    listContainer.innerHTML = '';
    toolsContainer.innerHTML = '';

    if (validStations.length === 0) {
      listContainer.innerHTML = `
        <div class="station-list-empty">
          地点マスタを読み込んでください
          <br>
          <button style="margin-top:8px; color:#2563EB; text-decoration:underline; font-size:0.75rem; background:none; border:none; cursor:pointer;"
            onclick="app.downloadMasterTemplate()">
            テンプレートをダウンロード
          </button>
        </div>`;
      return;
    }

    const swimlaneIds = app.state.swimlaneIds;

    // ─── テンプレート別一括追加 (fixed tools) ───
    const templateSet = new Set();
    for (const st of validStations) {
      if (st.templates) {
        for (const t of st.templates) templateSet.add(t);
      }
    }
    const templates = [...templateSet];

    if (templates.length > 0) {
      const catSection = document.createElement('div');
      catSection.className = 'category-batch-section';

      const label = document.createElement('div');
      label.className = 'category-batch-label';
      label.textContent = 'テンプレート別一括追加';
      catSection.appendChild(label);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'category-batch-btns';

      for (const tmpl of templates) {
        const btn = document.createElement('button');
        btn.className = 'btn-secondary btn-sm';
        btn.textContent = tmpl;
        btn.onclick = () => app.addSwimlanesByTemplate(tmpl);
        btnGroup.appendChild(btn);
      }

      const allBtn = document.createElement('button');
      allBtn.className = 'btn-secondary btn-sm';
      allBtn.textContent = '全て';
      allBtn.onclick = () => app.addAllSwimlanes();
      btnGroup.appendChild(allBtn);

      catSection.appendChild(btnGroup);
      toolsContainer.appendChild(catSection);
    }

    // 地点追加ボタン (fixed tools)
    const addBtn = document.createElement('div');
    addBtn.className = 'add-btn-wrap';
    addBtn.innerHTML = `
      <button onclick="app.addStationFromMap()" class="btn-secondary btn-sm btn-full">
        ＋ 地図から地点を追加
      </button>
    `;
    toolsContainer.appendChild(addBtn);

    // ─── 地点一覧 (scrollable list) ───
    for (const st of validStations) {
      const fc = fileCounts ? (fileCounts.get(st.id) || 0) : 0;
      const hasSwimlane = swimlaneIds && swimlaneIds.has(st.id);
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
          ${hasSwimlane
          ? `<span class="swimlane-added-badge" title="スイムレーン追加済み">✓</span>`
          : `<button class="btn-primary btn-sm" onclick="app.addSwimlane('${_esc(st.id)}')" title="スイムレーンに追加">＋</button>`
        }
          <button class="btn-secondary btn-sm" onclick="app.editStation('${_esc(st.id)}')">編集</button>
        </div>
      `;
      listContainer.appendChild(item);
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

    // ─── 地名・座標から登録ボタンの制御 ───
    const regBtn = document.getElementById('btn-register-from-preview');
    const gps = card.parsed && card.parsed.gpsCoord;

    if (gps) {
      regBtn.classList.remove('hidden');
      // 座標をデータ属性に保存して、ボタンクリック時に取得できるようにする
      regBtn.dataset.lat = gps.lat;
      regBtn.dataset.lon = gps.lon;
      regBtn.dataset.fileName = card.fileName;
    } else {
      regBtn.classList.add('hidden');
    }

    // ─── 地図表示 ───
    const mapDiv = document.getElementById('preview-map');

    if (gps) {
      mapDiv.classList.remove('hidden');
      _initPreviewMap(gps, app.state.stations);
    } else {
      mapDiv.classList.add('hidden');
    }
  }

  function _initPreviewMap(gps, stations) {
    if (!previewMap) {
      previewMap = L.map('preview-map').setView([gps.lat, gps.lon], 13);
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
        attribution: 'Map data © <a href="https://maps.gsi.go.jp/development/ichiran.html">Geospatial Information Authority of Japan</a>',
        maxZoom: 18,
      }).addTo(previewMap);
    } else {
      previewMap.setView([gps.lat, gps.lon], 13);
    }

    // 既存マーカーをクリア
    previewMarkers.forEach(m => previewMap.removeLayer(m));
    previewMarkers = [];

    // 地点マスタのマーカー
    for (const st of stations) {
      if (st._invalid || st.lat === null || st.lon === null) continue;
      const catColor = { 定点: '#2563EB', 臨時: '#D97706', 未設定: '#6B7280' };
      const color = catColor[st.category] || '#6B7280';
      const m = L.circleMarker([st.lat, st.lon], {
        radius: 6,
        color: 'white',
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      }).addTo(previewMap).bindPopup(`${_esc(st.name)} (${_esc(st.id)})`);
      previewMarkers.push(m);
    }

    // 観測地点（自分自身）のマーカー
    const selfIcon = L.divIcon({
      className: '',
      html: `<div style="
        width:20px;height:20px;border-radius:50%;
        background:#EF4444;border:3px solid white;
        box-shadow:0 0 10px rgba(239, 68, 68, 0.6);
        animation: pulse 1.5s infinite;
      "></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    // スタイルタグを追加（pulseアニメーション用）
    if (!document.getElementById('preview-map-styles')) {
      const style = document.createElement('style');
      style.id = 'preview-map-styles';
      style.innerHTML = `
        @keyframes pulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
      `;
      document.head.appendChild(style);
    }

    const mSelf = L.marker([gps.lat, gps.lon], { icon: selfIcon })
      .addTo(previewMap)
      .bindPopup('このファイルの観測位置');
    previewMarkers.push(mSelf);

    // DOMへの反映を待ってリサイズ
    setTimeout(() => {
      previewMap.invalidateSize();
    }, 100);
  }

  /**
   * プレビューモーダルを閉じる
   */
  function closePreviewModal() {
    document.getElementById('preview-modal').classList.add('hidden');
    // ボタンを隠しておく
    document.getElementById('btn-register-from-preview').classList.add('hidden');
  }

  /**
   * プレビュー内の「新規地点登録」ボタンクリック時
   */
  function onRegisterFromPreview() {
    const btn = document.getElementById('btn-register-from-preview');
    const lat = parseFloat(btn.dataset.lat);
    const lon = parseFloat(btn.dataset.lon);
    const fileName = btn.dataset.fileName || '';

    // プレビューを閉じて
    closePreviewModal();

    // 登録フォームを開く。ファイル名からある程度推測した名前を入れる
    let suggestedName = fileName.replace(/\.csv$/i, '');
    // 先頭の数字などを除去するロジックを dataProcessor から流用しても良いが、ここでは単純化
    suggestedName = suggestedName.replace(/^\d+/, '').replace(/^[\s\-_#.()[\]]+/, '');

    openStationFormModal(null, lat, lon);

    // フォームが開いた後、名前フィールドにカーソルを合わせる
    setTimeout(() => {
      const nameInput = document.getElementById('sf-name');
      if (nameInput) {
        nameInput.value = suggestedName;
        nameInput.focus();
        nameInput.select();
      }
    }, 100);
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
    document.getElementById('sf-category').value = station ? station.category : '未設定';
    document.getElementById('sf-lat').value = station ? (station.lat || '') : (lat !== null ? lat.toFixed(6) : '');
    document.getElementById('sf-lon').value = station ? (station.lon || '') : (lon !== null ? lon.toFixed(6) : '');
    document.getElementById('sf-keywords').value = station ? (station.keywords || []).join('|') : '';
    document.getElementById('sf-templates').value = station ? (station.templates || []).join('/') : '';
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
    let prefix = 'ST';

    for (const id of ids) {
      // 任意の英字プレフィックス + 数字の組み合わせを探す
      const m = id.match(/^([A-Za-z]+)(\d+)$/);
      if (m) {
        const num = parseInt(m[2], 10);
        if (num > max) {
          max = num;
          prefix = m[1]; // 最新（最大）のIDに使われているプレフィックスを継承
        }
      }
    }
    // 最大値 + 1 を 4桁のゼロ埋めで返す
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
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
    updateCardDistanceWarning,
    removeCard,
    onDragOver,
    onDrop,
    setupDragAndDrop,
    renderStationList,
    showPreviewModal,
    onRegisterFromPreview,
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

/**
 * app.js
 * メインロジック: 状態管理・イベント統合
 */
'use strict';

const app = (() => {

  // ─── アプリ状態 ───
  const state = {
    stations: [],          // 地点マスタ
    cards: new Map(),      // cardId → card object
    assignments: new Map(),// stationId → cardId[]  ('' = 未分類)
    cardOrder: [],         // 全カードIDの登録順
  };

  let cardSeq = 0;

  // ─── 初期化 ───

  function init() {
    document.getElementById('btn-output-a').addEventListener('click', () => outputCSV('A'));
    document.getElementById('btn-output-b').addEventListener('click', () => outputCSV('B'));
    document.getElementById('btn-reset-master').addEventListener('click', onResetMasterClick);

    // ドロップゾーン: dragover ビジュアル
    ['master-dropzone', 'obs-dropzone'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop',     () => el.classList.remove('drag-over'));
    });

    uiController.setupModalOutsideClick();
    uiController.setupDragAndDrop();
  }

  // ─── 地点マスタ読み込み ───

  async function onMasterDrop(e) {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => /\.csv$/i.test(f.name));
    if (files.length === 0) { uiController.showToast('CSVファイルをドロップしてください', 'warn'); return; }
    await loadMasterFile(files[0]);
  }

  async function onMasterFileSelect(e) {
    const file = e.target.files[0];
    if (file) await loadMasterFile(file);
    e.target.value = '';
  }

  async function loadMasterFile(file) {
    // 再アップロード時のダイアログ
    if (state.stations.length > 0) {
      uiController.showConfirm(
        '地点マスタの再アップロード',
        '地点マスタを再読み込みします。どの方法で更新しますか？',
        [
          {
            label: '全リセット', type: 'danger',
            callback: () => _doLoadMaster(file, 'reset'),
          },
          {
            label: '差分更新（IDが一致するスイムレーンを維持）', type: 'secondary',
            callback: () => _doLoadMaster(file, 'diff'),
          },
          { label: 'キャンセル', type: 'secondary', callback: () => {} },
        ]
      );
    } else {
      await _doLoadMaster(file, 'reset');
    }
  }

  async function _doLoadMaster(file, mode) {
    try {
      const text = await fileHandler.readFile(file, null);
      const { stations, errors } = fileHandler.parseMasterCSV(text);

      if (errors.length > 0) {
        errors.forEach(e => uiController.showToast(e, 'error', 6000));
      }

      if (stations.length === 0) {
        uiController.showToast('有効な地点データが見つかりません', 'error');
        return;
      }

      if (mode === 'reset') {
        // 全スイムレーン削除 → 全カードを未分類へ
        state.assignments.forEach((cardIds, sid) => {
          if (sid !== '') {
            for (const cid of cardIds) {
              uiController.moveCardToArea(cid, '');
              _moveAssignment(cid, sid, '');
            }
          }
        });
        uiController.clearAllSwimlanes();
        state.stations = stations;
        // スイムレーン生成
        for (const st of stations) {
          if (!st._invalid) uiController.createSwimlane(st);
        }
        state.assignments = new Map();
      } else {
        // 差分更新
        const existingIds = new Set(state.stations.map(s => s.id));
        const newIds      = new Set(stations.map(s => s.id));

        // 削除された地点のスイムレーン → カードを未分類へ
        for (const sid of existingIds) {
          if (!newIds.has(sid)) {
            const cardIds = state.assignments.get(sid) || [];
            for (const cid of cardIds) {
              uiController.moveCardToArea(cid, '');
              _moveAssignment(cid, sid, '');
            }
            uiController.removeSwimlane(sid);
          }
        }

        // 新規地点 → スイムレーン追加
        for (const st of stations) {
          if (st._invalid) continue;
          if (!existingIds.has(st.id)) {
            uiController.createSwimlane(st);
          }
        }

        state.stations = stations;
      }

      uiController.renderStationList(state.stations, getFileCounts());
      uiController.showResetButton(true);
      uiController.showToast(`地点マスタを読み込みました（${stations.filter(s=>!s._invalid).length}件）`, 'success');

      // 自動仕分け（未分類カードのみ対象）
      _autoAssignUnclassified();

    } catch (err) {
      uiController.showToast(`読み込みエラー: ${err.message}`, 'error', 6000);
    }
  }

  // ─── 観測データ読み込み ───

  async function onObsDrop(e) {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    await loadObservationFiles(files);
  }

  async function onObsFileSelect(e) {
    const files = [...e.target.files];
    if (files.length) await loadObservationFiles(files);
    e.target.value = '';
  }

  async function loadObservationFiles(files) {
    const nonCsv = files.filter(f => !/\.csv$/i.test(f.name));
    nonCsv.forEach(f => uiController.showToast(`CSV以外は無視: ${f.name}`, 'warn'));

    const csvFiles = files.filter(f => /\.csv$/i.test(f.name));
    if (csvFiles.length === 0) return;

    for (const file of csvFiles) {
      await _loadSingleObsFile(file);
    }

    // 自動仕分け
    _autoAssignUnclassified();
    uiController.updateCounts();
  }

  async function _loadSingleObsFile(file) {
    // 先にパースして観測日時を取得（重複判定に使用）
    let parsed;
    try {
      const text = await fileHandler.readFile(file, 'SJIS');
      parsed = fileHandler.parseObservationCSV(text, file.name);
    } catch (err) {
      uiController.showToast(`読み込みエラー: ${file.name} - ${err.message}`, 'error', 5000);
      return;
    }

    // 同名カードを検索
    const sameNameCards = [...state.cards.values()].filter(c => c.fileName === file.name);

    if (sameNameCards.length > 0) {
      const newDate = parsed.firstDateTime || null;

      // 観測日時まで一致するカードだけを「重複」とみなす
      const conflictCard = sameNameCards.find(c => {
        const existDate = (c.parsed && c.parsed.firstDateTime) || null;
        return existDate === newDate;  // 両方 null でも一致扱い
      });

      if (!conflictCard) {
        // 同名だが観測日時が異なる → 別ファイルとして新規登録
        await _registerParsedCard(file.name, parsed);
        return;
      }

      // 同名かつ同観測日時 → 上書き確認
      await new Promise(resolve => {
        const dateLabel = newDate ? `（${newDate}）` : '（日時不明）';
        uiController.showConfirm(
          '同名・同観測日時ファイル',
          `「${file.name}」${dateLabel} は既に読み込まれています。上書きしますか？`,
          [
            {
              label: '上書き', type: 'danger',
              callback: async () => {
                const savedStationId = conflictCard.stationId;
                _removeCardState(conflictCard.id);
                uiController.removeCard(conflictCard.id);
                const newCard = await _registerParsedCard(file.name, parsed);
                if (newCard && savedStationId !== '') {
                  moveCard(newCard.id, savedStationId);
                }
                resolve();
              },
            },
            { label: 'スキップ', type: 'secondary', callback: () => resolve() },
          ]
        );
      });
      return;
    }

    // 同名なし → 新規登録
    await _registerParsedCard(file.name, parsed);
  }

  async function _registerParsedCard(fileName, parsed) {
    if (parsed.error === 'データ行が0件です') {
      uiController.showToast(`データ行が0件のため除外: ${fileName}`, 'error', 5000);
      return null;
    }

    const cardId = `card_${++cardSeq}`;
    const card = {
      id: cardId,
      fileName,
      parsed,
      stationId: '',
    };

    state.cards.set(cardId, card);
    state.cardOrder.push(cardId);

    const el = uiController.createFileCard(card);
    document.getElementById('unclassified-area').appendChild(el);

    if (!state.assignments.has('')) state.assignments.set('', []);
    state.assignments.get('').push(cardId);

    if (parsed.warningFallback) {
      uiController.showToast(`⚠️ ヘッダーを69行目で検出: ${fileName}`, 'warn', 6000);
    }

    return card;
  }

  // ─── 自動仕分け ───

  function _autoAssignUnclassified() {
    if (state.stations.length === 0) return;

    const unclassIds = state.assignments.get('') || [];
    const unclassCards = unclassIds.map(id => state.cards.get(id)).filter(Boolean);

    const { assigned, unclassified } = dataProcessor.autoAssignFiles(unclassCards, state.stations);

    assigned.forEach((cardIds, stationId) => {
      for (const cardId of cardIds) {
        moveCard(cardId, stationId);
      }
    });

    uiController.updateCounts();
  }

  // ─── カード移動 ───

  /**
   * カードを指定スイムレーンに移動
   * @param {string} cardId
   * @param {string} newStationId  '' = 未分類
   */
  function moveCard(cardId, newStationId) {
    const card = state.cards.get(cardId);
    if (!card) return;

    const oldStationId = card.stationId;
    if (oldStationId === newStationId) return;

    // assignments 更新
    _moveAssignment(cardId, oldStationId, newStationId);
    card.stationId = newStationId;

    // UI 更新
    uiController.moveCardToArea(cardId, newStationId);
    uiController.updateCounts();

    // マーカーポップアップ更新
    if (oldStationId) {
      const st = state.stations.find(s => s.id === oldStationId);
      if (st) mapController.refreshMarkerPopup(oldStationId, st, getFileCounts().get(oldStationId) || 0);
    }
    if (newStationId) {
      const st = state.stations.find(s => s.id === newStationId);
      if (st) mapController.refreshMarkerPopup(newStationId, st, getFileCounts().get(newStationId) || 0);
    }
  }

  function _moveAssignment(cardId, fromId, toId) {
    // from から削除
    if (state.assignments.has(fromId)) {
      const arr = state.assignments.get(fromId);
      const idx = arr.indexOf(cardId);
      if (idx >= 0) arr.splice(idx, 1);
    }
    // to に追加
    if (!state.assignments.has(toId)) state.assignments.set(toId, []);
    state.assignments.get(toId).push(cardId);
  }

  function _removeCardState(cardId) {
    const card = state.cards.get(cardId);
    if (!card) return;
    _moveAssignment(cardId, card.stationId, null);
    state.cards.delete(cardId);
    const idx = state.cardOrder.indexOf(cardId);
    if (idx >= 0) state.cardOrder.splice(idx, 1);
  }

  // ─── 地点CRUD ───

  /**
   * 地点追加（地図クリック）
   */
  function addStationFromMap() {
    const modal = document.getElementById('map-modal');
    const alreadyOpen = !modal.classList.contains('hidden');

    if (!alreadyOpen) {
      // 地図モーダルを開いて初期化
      modal.classList.remove('hidden');
      mapController.initMap();
      setTimeout(() => {
        mapController.displayAllLocations(state.stations, getFileCounts());
        _enableAddPoint();
      }, 200);
    } else {
      // すでに開いている場合はそのまま追加モードへ
      _enableAddPoint();
    }
  }

  function _enableAddPoint() {
    uiController.showToast('地図をクリックして地点を追加', 'info', 4000);
    mapController.enableAddPointMode((lat, lon) => {
      uiController.openStationFormModal(null, lat, lon);
    });
  }

  /**
   * 地点を編集
   * @param {string} stationId
   */
  function editStation(stationId) {
    const st = state.stations.find(s => s.id === stationId);
    if (!st) return;
    uiController.openStationFormModal(st);
  }

  /**
   * フォーム保存
   */
  function saveStationForm() {
    const editingId = document.getElementById('sf-editing-id').value.trim();
    const name     = document.getElementById('sf-name').value.trim();
    const id       = document.getElementById('sf-id').value.trim();
    const category = document.getElementById('sf-category').value;
    const lat      = parseFloat(document.getElementById('sf-lat').value) || null;
    const lon      = parseFloat(document.getElementById('sf-lon').value) || null;
    const keywords = document.getElementById('sf-keywords').value.trim().split('|').map(k=>k.trim()).filter(Boolean);
    const note     = document.getElementById('sf-note').value.trim();

    if (!name || !id) {
      uiController.showToast('地点名と地点IDは必須です', 'error');
      return;
    }

    // ID重複チェック（自分以外）
    const dup = state.stations.find(s => s.id === id && s.id !== editingId);
    if (dup) {
      uiController.showToast(`地点ID "${id}" は既に使われています`, 'error');
      return;
    }

    const stationData = { id, name, category, lat, lon, keywords, note, _invalid: false };

    if (editingId) {
      // 編集
      const idx = state.stations.findIndex(s => s.id === editingId);
      if (idx >= 0) {
        state.stations[idx] = stationData;
        mapController.updateMarker(stationData, getFileCounts().get(id) || 0);
      }
    } else {
      // 追加
      state.stations.push(stationData);
      uiController.createSwimlane(stationData);
      mapController.addMarker(stationData, 0);
    }

    uiController.closeStationFormModal();
    uiController.renderStationList(state.stations, getFileCounts());
    uiController.showToast(`地点を${editingId ? '更新' : '追加'}しました: ${name}`, 'success');
    uiController.showResetButton(true);
  }

  /**
   * 地点を削除（紐付きカードを未分類へ）
   * @param {string} stationId
   */
  function deleteStation(stationId) {
    const st = state.stations.find(s => s.id === stationId);
    if (!st) return;

    uiController.showConfirm(
      '地点を削除',
      `「${st.name}」を削除します。紐付きファイルは未分類へ移動します。`,
      [
        {
          label: '削除', type: 'danger',
          callback: () => {
            // 紐付きカードを未分類へ
            const cardIds = [...(state.assignments.get(stationId) || [])];
            for (const cid of cardIds) {
              moveCard(cid, '');
            }
            mapController.removeMarker(stationId);
            uiController.removeSwimlane(stationId);
            state.stations = state.stations.filter(s => s.id !== stationId);
            state.assignments.delete(stationId);
            uiController.renderStationList(state.stations, getFileCounts());
            uiController.showToast(`地点「${st.name}」を削除しました`, 'success');
          },
        },
        { label: 'キャンセル', type: 'secondary', callback: () => {} },
      ]
    );
  }

  /**
   * スイムレーン削除（地点は残す）
   * @param {string} stationId
   */
  function deleteSwimlane(stationId) {
    deleteStation(stationId);
  }

  /**
   * マスタリセット（全スイムレーン削除・全カード未分類へ）
   */
  function onResetMasterClick() {
    uiController.showConfirm(
      'マスタリセット',
      '全スイムレーンを削除し、全カードを未分類に移動します。よろしいですか？',
      [
        {
          label: 'リセット', type: 'danger',
          callback: () => {
            state.assignments.forEach((cardIds, sid) => {
              if (sid !== '') {
                for (const cid of cardIds) {
                  uiController.moveCardToArea(cid, '');
                  _moveAssignment(cid, sid, '');
                  const card = state.cards.get(cid);
                  if (card) card.stationId = '';
                }
              }
            });
            uiController.clearAllSwimlanes();
            state.stations = [];
            state.assignments.clear();
            uiController.renderStationList([], new Map());
            uiController.showResetButton(false);
            uiController.updateCounts();
            uiController.showToast('マスタリセットしました', 'info');
          },
        },
        { label: 'キャンセル', type: 'secondary', callback: () => {} },
      ]
    );
  }

  // ─── CSV 出力 ───

  async function outputCSV(format) {
    const hasCards = state.cards.size > 0;
    if (!hasCards) {
      uiController.showToast('出力するファイルがありません', 'warn');
      return;
    }

    // 未分類ファイルの確認
    const unclassIds = state.assignments.get('') || [];
    const warnIds    = [];
    for (const [sid, cardIds] of state.assignments) {
      for (const cid of cardIds) {
        const card = state.cards.get(cid);
        if (card && card.parsed && card.parsed.warningFallback) warnIds.push(cid);
      }
    }

    let excludeUnclassified = false;
    let excludeWarning = false;

    // 未分類確認
    if (unclassIds.length > 0) {
      await new Promise(resolve => {
        uiController.showConfirm(
          '未分類ファイルがあります',
          `${unclassIds.length}件のファイルが未分類です。出力に含めますか？`,
          [
            { label: '含める', type: 'primary', callback: () => { excludeUnclassified = false; resolve(); } },
            { label: '除外する', type: 'secondary', callback: () => { excludeUnclassified = true; resolve(); } },
          ]
        );
      });
    }

    // 警告ファイル確認
    const unresolvedWarnIds = warnIds.filter(cid => {
      const card = state.cards.get(cid);
      if (!card) return false;
      if (excludeUnclassified && card.stationId === '') return false;
      return true;
    });
    if (unresolvedWarnIds.length > 0) {
      await new Promise(resolve => {
        uiController.showConfirm(
          '⚠️ ヘッダー検出警告',
          `${unresolvedWarnIds.length}件のファイルでヘッダーを69行目(固定)で検出しました。出力に含めますか？`,
          [
            { label: '含める', type: 'primary', callback: () => { excludeWarning = false; resolve(); } },
            { label: '除外する', type: 'secondary', callback: () => { excludeWarning = true; resolve(); } },
          ]
        );
      });
    }

    // 出力対象のアサインメント構築
    const assignments = _buildOutputAssignments(excludeUnclassified, excludeWarning);
    if (assignments.length === 0) {
      uiController.showToast('出力対象のファイルがありません', 'warn');
      return;
    }

    let result;
    if (format === 'A') {
      result = dataProcessor.mergeAllData(assignments, state.cards);
    } else {
      result = dataProcessor.calculateDepthBinAverages(assignments, state.cards);
    }

    const blob     = dataProcessor.generateCSVBlob(result.headers, result.rows);
    const fileName = dataProcessor.generateOutputFileName(format);
    _downloadBlob(blob, fileName);
    uiController.showToast(`${fileName} をダウンロードしました（${result.rows.length}行）`, 'success');
  }

  function _buildOutputAssignments(excludeUnclassified, excludeWarning) {
    const assignments = [];

    for (const [stationId, cardIds] of state.assignments) {
      if (excludeUnclassified && stationId === '') continue;

      const st = stationId ? state.stations.find(s => s.id === stationId) : null;

      for (const cardId of cardIds) {
        const card = state.cards.get(cardId);
        if (!card) continue;
        if (excludeWarning && card.parsed && card.parsed.warningFallback) continue;
        if (!card.parsed || card.parsed.error === 'データ行が0件です') continue;

        assignments.push({
          stationId:   st ? st.id   : '',
          stationName: st ? st.name : '',
          stationLat:  st ? st.lat  : null,
          stationLon:  st ? st.lon  : null,
          card,
        });
      }
    }
    return assignments;
  }

  function _downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── ユーティリティ ───

  /**
   * 各地点のファイル数マップを返す
   * @returns {Map<string, number>}
   */
  function getFileCounts() {
    const map = new Map();
    for (const [sid, cardIds] of state.assignments) {
      if (sid) map.set(sid, cardIds.length);
    }
    return map;
  }

  // ─── 起動 ───
  document.addEventListener('DOMContentLoaded', init);

  // ─── 公開 API ───
  return {
    state,
    onMasterDrop,
    onMasterFileSelect,
    onObsDrop,
    onObsFileSelect,
    moveCard,
    saveStationForm,
    editStation,
    deleteStation,
    deleteSwimlane,
    addStationFromMap,
    getFileCounts,
  };
})();

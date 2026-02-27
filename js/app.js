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
    swimlaneIds: new Set(),// スイムレーン追加済みの地点ID
  };

  let cardSeq = 0;
  let obsOverwriteAll = false;

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
      el.addEventListener('drop', () => el.classList.remove('drag-over'));
    });

    // ─── ブラウザ更新/終了時の警告 ───
    window.addEventListener('beforeunload', (e) => {
      // 地点マスタが読み込まれているか、または観測データが1つでもある場合に警告を出す
      const hasData = state.stations.length > 0 || state.cards.size > 0;
      if (hasData) {
        e.preventDefault();
        e.returnValue = ''; // ブラウザ標準の警告を表示
      }
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
          { label: 'キャンセル', type: 'secondary', callback: () => { } },
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
        state.swimlaneIds.clear();
        state.assignments = new Map();
      } else {
        // 差分更新
        const existingIds = new Set(state.stations.map(s => s.id));
        const newIds = new Set(stations.map(s => s.id));

        // 削除された地点のスイムレーン → カードを未分類へ
        for (const sid of existingIds) {
          if (!newIds.has(sid)) {
            const cardIds = state.assignments.get(sid) || [];
            for (const cid of cardIds) {
              uiController.moveCardToArea(cid, '');
              _moveAssignment(cid, sid, '');
            }
            uiController.removeSwimlane(sid);
            state.swimlaneIds.delete(sid);
          }
        }

        state.stations = stations;
      }

      uiController.renderStationList(state.stations, getFileCounts());
      uiController.showResetButton(true);
      uiController.showToast(`地点マスタを読み込みました（${stations.filter(s => !s._invalid).length}件）`, 'success');

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

    obsOverwriteAll = false; // バッチごとにリセット

    for (const file of csvFiles) {
      await _loadSingleObsFile(file, csvFiles.length > 1);
    }

    // 自動仕分け
    _autoAssignUnclassified();
    uiController.updateCounts();
  }

  async function _loadSingleObsFile(file, isMultiple = false) {
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
      if (obsOverwriteAll) {
        await _overwriteCard(conflictCard, file.name, parsed);
        return;
      }

      await new Promise(resolve => {
        const dateLabel = newDate ? `（${newDate}）` : '（日時不明）';
        const buttons = [
          {
            label: '上書き', type: 'danger',
            callback: async () => {
              await _overwriteCard(conflictCard, file.name, parsed);
              resolve();
            },
          }
        ];

        if (isMultiple) {
          buttons.push({
            label: 'すべて上書き', type: 'danger',
            callback: async () => {
              obsOverwriteAll = true;
              await _overwriteCard(conflictCard, file.name, parsed);
              resolve();
            }
          });
        }

        buttons.push({ label: 'スキップ', type: 'secondary', callback: () => resolve() });

        uiController.showConfirm(
          '同名・同観測日時ファイル',
          `「${file.name}」${dateLabel} は既に読み込まれています。上書きしますか？`,
          buttons
        );
      });
      return;
    }

    // ─── 同観測開始時刻チェック（ファイル名が違っても同じ観測なら粒度比較）───
    const newMs = _parseDateTimeMs(parsed.firstDateTime);
    if (newMs !== null) {
      const sameDtCard = [...state.cards.values()].find(c => {
        if (c.fileName === file.name) return false; // 同名は上で処理済み
        const existMs = _parseDateTimeMs((c.parsed && c.parsed.firstDateTime) || null);
        return existMs !== null && existMs === newMs;
      });

      if (sameDtCard) {
        const newRes = _calcDepthResolution(parsed);
        const existRes = _calcDepthResolution(sameDtCard.parsed);

        if (newRes < existRes) {
          // 新しいファイルの方が水深粒度が細かい → 既存を置き換え
          const savedStationId = sameDtCard.stationId;
          _removeCardState(sameDtCard.id);
          uiController.removeCard(sameDtCard.id);
          const newCard = await _registerParsedCard(file.name, parsed);
          if (newCard && savedStationId !== '') moveCard(newCard.id, savedStationId);
          uiController.showToast(
            `同観測・高粒度ファイルで置き換え: ${file.name}（${sameDtCard.fileName} を排除）`,
            'info', 5000
          );
        } else {
          // 既存の方が粒度が細かい（または同じ）→ 新しいファイルを排除
          uiController.showToast(
            `同観測・低粒度のため排除: ${file.name}（${sameDtCard.fileName} を優先）`,
            'info', 5000
          );
        }
        return;
      }
    }

    // 同名なし・同観測日時なし → 新規登録
    await _registerParsedCard(file.name, parsed);
  }

  /**
   * 既存のカードを新しいデータで上書き
   */
  async function _overwriteCard(oldCard, fileName, parsed) {
    const savedStationId = oldCard.stationId;
    _removeCardState(oldCard.id);
    uiController.removeCard(oldCard.id);
    const newCard = await _registerParsedCard(fileName, parsed);
    if (newCard && savedStationId !== '') {
      moveCard(newCard.id, savedStationId);
    }
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

  /**
   * 観測ファイルを削除
   * @param {string} cardId
   * @param {Event} e
   */
  function removeFile(cardId, e) {
    if (e) e.stopPropagation(); // カード選択イベントを抑止

    const card = state.cards.get(cardId);
    if (!card) return;

    if (!confirm(`ファイル "${card.fileName}" を削除しますか？`)) return;

    // assignments から削除
    const stationId = card.stationId;
    const cardIds = state.assignments.get(stationId);
    if (cardIds) {
      const idx = cardIds.indexOf(cardId);
      if (idx !== -1) cardIds.splice(idx, 1);
    }

    // cardOrder から削除
    const orderIdx = state.cardOrder.indexOf(cardId);
    if (orderIdx !== -1) state.cardOrder.splice(orderIdx, 1);

    // cards から削除
    state.cards.delete(cardId);

    // UI 更新
    uiController.removeCard(cardId);
    uiController.showToast(`ファイルを削除しました: ${card.fileName}`, 'info');

    // マーカーポップアップ更新
    if (stationId) {
      const st = state.stations.find(s => s.id === stationId);
      if (st) mapController.refreshMarkerPopup(stationId, st, getFileCounts().get(stationId) || 0);
    }
  }

  // ─── 水深粒度チェック用ヘルパー ───

  /**
   * 日時文字列を ms に変換（表記ゆれを吸収）
   * "2018/06/14 8:42:18" / "2018/06/14 08:42:18" などに対応
   * @param {string|null} dtStr
   * @returns {number|null}
   */
  function _parseDateTimeMs(dtStr) {
    if (!dtStr) return null;
    const m = dtStr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return Date.UTC(
      parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
      parseInt(m[4]), parseInt(m[5]), parseInt(m[6])
    );
  }

  /**
   * 水深粒度を計算（maxDepth / データ行数）
   * 値が小さいほど細かい粒度
   * @param {object} parsed
   * @returns {number} Infinity = 計算不可
   */
  function _calcDepthResolution(parsed) {
    if (!parsed || !parsed.maxDepth || !parsed.dataRows || parsed.dataRows.length === 0) return Infinity;
    return parsed.maxDepth / parsed.dataRows.length;
  }

  // ─── 自動仕分け ───

  function _autoAssignUnclassified() {
    if (state.swimlaneIds.size === 0) return;

    const unclassIds = state.assignments.get('') || [];
    const unclassCards = unclassIds.map(id => state.cards.get(id)).filter(Boolean);

    // スイムレーン追加済みの地点のみを対象にマッチング
    const activeStations = state.stations.filter(s => !s._invalid && state.swimlaneIds.has(s.id));
    const { assigned, unclassified } = dataProcessor.autoAssignFiles(unclassCards, activeStations);

    assigned.forEach((cardIds, stationId) => {
      for (const cardId of cardIds) {
        moveCard(cardId, stationId);
      }
    });

    uiController.updateCounts();
  }

  /**
   * 未分類カードを手動で再分類（公開用）
   */
  function autoAssignUnclassified() {
    if (state.swimlaneIds.size === 0) {
      uiController.showToast('スイムレーンがありません。先に地点を追加してください', 'warn');
      return;
    }
    const before = (state.assignments.get('') || []).length;
    _autoAssignUnclassified();
    const after = (state.assignments.get('') || []).length;
    const count = before - after;
    if (count > 0) {
      uiController.showToast(`${count}件を自動仕分けしました`, 'success');
    } else {
      uiController.showToast('自動仕分けできるファイルがありませんでした', 'info');
    }
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

  /**
   * 複数カードを一括移動
   * @param {string[]} cardIds
   * @param {string} newStationId
   */
  function moveCards(cardIds, newStationId) {
    if (!cardIds || cardIds.length === 0) return;

    // 高速化のため、UI更新を一度にまとめる仕組みはないが、
    // 各カードの内部状態を更新しつつ、最後に対象スイムレーンのカウントだけ更新するなどは可能
    const oldStationIds = new Set();

    for (const cardId of cardIds) {
      const card = state.cards.get(cardId);
      if (!card) continue;
      if (card.stationId === newStationId) continue;

      oldStationIds.add(card.stationId);
      _moveAssignment(cardId, card.stationId, newStationId);
      card.stationId = newStationId;

      uiController.moveCardToArea(cardId, newStationId);
    }

    // 関連するスイムレーンのカウント・マップポップアップを一括更新
    uiController.updateCounts();

    oldStationIds.forEach(sid => {
      if (sid) {
        const st = state.stations.find(s => s.id === sid);
        if (st) mapController.refreshMarkerPopup(sid, st, getFileCounts().get(sid) || 0);
      }
    });
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
   * 地図上でドラッグして座標を取得
   * 地点フォームモーダルを一時的に隠し、地図モーダルで座標ピックモードを有効化する
   */
  function openMapForCoordPick() {
    // 現在のフォーム値を初期位置として使用
    const latVal = parseFloat(document.getElementById('sf-lat').value);
    const lonVal = parseFloat(document.getElementById('sf-lon').value);
    const initLat = isNaN(latVal) ? null : latVal;
    const initLon = isNaN(lonVal) ? null : lonVal;

    // 地点フォームモーダルを一時的に隠す
    document.getElementById('station-form-modal').classList.add('hidden');

    // 地図モーダルを開く
    const mapModal = document.getElementById('map-modal');
    mapModal.classList.remove('hidden');
    mapController.initMap();

    setTimeout(() => {
      mapController.displayAllLocations(state.stations, getFileCounts());

      mapController.enableCoordPickMode(initLat, initLon, (lat, lng) => {
        // 座標ピック完了（確定 or キャンセル）
        // 地図モーダルを閉じ、地点フォームを再表示
        document.getElementById('map-modal').classList.add('hidden');
        document.getElementById('station-form-modal').classList.remove('hidden');

        if (lat !== null && lng !== null) {
          // 小数7桁で丸める（GPS精度として十分）
          document.getElementById('sf-lat').value = Math.round(lat * 1e7) / 1e7;
          document.getElementById('sf-lon').value = Math.round(lng * 1e7) / 1e7;
          uiController.showToast('座標を取得しました', 'success');
        }
      });
    }, 200);
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
    const name = document.getElementById('sf-name').value.trim();
    const id = document.getElementById('sf-id').value.trim();
    const category = document.getElementById('sf-category').value;
    const lat = parseFloat(document.getElementById('sf-lat').value) || null;
    const lon = parseFloat(document.getElementById('sf-lon').value) || null;
    const keywords = document.getElementById('sf-keywords').value.trim().split('|').map(k => k.trim()).filter(Boolean);
    const templates = document.getElementById('sf-templates').value.trim().split('/').map(t => t.trim()).filter(Boolean);
    const note = document.getElementById('sf-note').value.trim();

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

    const stationData = { id, name, category, lat, lon, keywords, templates, note, _invalid: false };

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
      state.swimlaneIds.add(stationData.id);
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
            state.swimlaneIds.delete(stationId);
            state.stations = state.stations.filter(s => s.id !== stationId);
            state.assignments.delete(stationId);
            uiController.renderStationList(state.stations, getFileCounts());
            uiController.showToast(`地点「${st.name}」を削除しました`, 'success');
          },
        },
        { label: 'キャンセル', type: 'secondary', callback: () => { } },
      ]
    );
  }

  /**
   * スイムレーン削除（地点は残す）
   * @param {string} stationId
   */
  function deleteSwimlane(stationId) {
    const st = state.stations.find(s => s.id === stationId);
    if (!st) return;
    uiController.showConfirm(
      'スイムレーンを解除',
      `「${st.name}」のスイムレーンを解除します。紐付きファイルは未分類へ移動します。地点はマスタに残ります。`,
      [
        {
          label: '解除', type: 'danger',
          callback: () => {
            const cardIds = [...(state.assignments.get(stationId) || [])];
            for (const cid of cardIds) {
              moveCard(cid, '');
            }
            uiController.removeSwimlane(stationId);
            state.swimlaneIds.delete(stationId);
            state.assignments.delete(stationId);
            uiController.renderStationList(state.stations, getFileCounts());
            uiController.showToast(`「${st.name}」のスイムレーンを解除しました`, 'info');
          },
        },
        { label: 'キャンセル', type: 'secondary', callback: () => { } },
      ]
    );
  }

  /**
   * スイムレーンリセット（全スイムレーン解除・全カード未分類へ・地点一覧は保持）
   */
  function onResetMasterClick() {
    uiController.showConfirm(
      'スイムレーンをリセット',
      '全スイムレーンを解除し、全カードを未分類に移動します。地点一覧は保持されます。',
      [
        {
          label: 'リセット', type: 'danger',
          callback: () => {
            state.assignments.forEach((cardIds, sid) => {
              if (sid !== '') {
                for (const cid of [...cardIds]) {
                  uiController.moveCardToArea(cid, '');
                  _moveAssignment(cid, sid, '');
                  const card = state.cards.get(cid);
                  if (card) card.stationId = '';
                }
              }
            });
            uiController.clearAllSwimlanes();
            state.swimlaneIds.clear();
            for (const sid of [...state.assignments.keys()]) {
              if (sid !== '') state.assignments.delete(sid);
            }
            uiController.renderStationList(state.stations, getFileCounts());
            uiController.updateCounts();
            uiController.showToast('スイムレーンをリセットしました', 'info');
          },
        },
        { label: 'キャンセル', type: 'secondary', callback: () => { } },
      ]
    );
  }

  // ─── スイムレーン追加 ───

  /**
   * 指定地点をスイムレーンに追加
   * @param {string} stationId
   */
  function addSwimlane(stationId) {
    if (state.swimlaneIds.has(stationId)) {
      uiController.showToast('このスイムレーンは既に追加されています', 'info');
      return;
    }
    const st = state.stations.find(s => s.id === stationId && !s._invalid);
    if (!st) return;
    uiController.createSwimlane(st);
    state.swimlaneIds.add(stationId);
    uiController.renderStationList(state.stations, getFileCounts());
    _autoAssignUnclassified();
    uiController.updateCounts();
    uiController.showToast(`「${st.name}」をスイムレーンに追加しました`, 'success');
  }

  /**
   * 指定区分の全地点をスイムレーンに追加
   * @param {string} category
   */
  function addSwimlanesByCategory(category) {
    const targets = state.stations.filter(s => !s._invalid && s.category === category && !state.swimlaneIds.has(s.id));
    if (targets.length === 0) {
      uiController.showToast(`区分「${category}」の地点はすべて追加済みです`, 'info');
      return;
    }
    for (const st of targets) {
      uiController.createSwimlane(st);
      state.swimlaneIds.add(st.id);
    }
    uiController.renderStationList(state.stations, getFileCounts());
    _autoAssignUnclassified();
    uiController.updateCounts();
    uiController.showToast(`「${category}」の${targets.length}件をスイムレーンに追加しました`, 'success');
  }

  /**
   * 指定テンプレートに属する全地点をスイムレーンに追加
   * @param {string} templateName
   */
  function addSwimlanesByTemplate(templateName) {
    const targets = state.stations.filter(s =>
      !s._invalid &&
      s.templates && s.templates.includes(templateName) &&
      !state.swimlaneIds.has(s.id)
    );
    if (targets.length === 0) {
      uiController.showToast(`テンプレート「${templateName}」の地点はすべて追加済みです`, 'info');
      return;
    }
    for (const st of targets) {
      uiController.createSwimlane(st);
      state.swimlaneIds.add(st.id);
    }
    uiController.renderStationList(state.stations, getFileCounts());
    _autoAssignUnclassified();
    uiController.updateCounts();
    uiController.showToast(`「${templateName}」の${targets.length}件をスイムレーンに追加しました`, 'success');
  }

  /**
   * 全地点をスイムレーンに追加
   */
  function addAllSwimlanes() {
    const targets = state.stations.filter(s => !s._invalid && !state.swimlaneIds.has(s.id));
    if (targets.length === 0) {
      uiController.showToast('全地点が既に追加済みです', 'info');
      return;
    }
    for (const st of targets) {
      uiController.createSwimlane(st);
      state.swimlaneIds.add(st.id);
    }
    uiController.renderStationList(state.stations, getFileCounts());
    _autoAssignUnclassified();
    uiController.updateCounts();
    uiController.showToast(`${targets.length}件をスイムレーンに追加しました`, 'success');
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
    const warnIds = [];
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

    const blob = dataProcessor.generateCSVBlob(result.headers, result.rows);
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
          stationId: st ? st.id : '',
          stationName: st ? st.name : '',
          stationLat: st ? st.lat : null,
          stationLon: st ? st.lon : null,
          card,
        });
      }
    }
    return assignments;
  }

  // ─── 地点マスタ CSV ダウンロード ───

  /**
   * 現在の地点マスタ（手動追加・編集分を含む）を UTF-8 BOM CSV でダウンロード
   */
  function downloadMasterCSV() {
    const validStations = state.stations.filter(s => !s._invalid);
    if (validStations.length === 0) {
      uiController.showToast('ダウンロードできる地点データがありません', 'warn');
      return;
    }

    const headers = ['地点ID', '地点名', '地点名_読み', '調査区分', 'テンプレート', '緯度', '経度', 'ファイル名キーワード', '備考'];
    const rows = validStations.map(s => [
      s.id,
      s.name,
      s.name_read || '',
      s.category,
      (s.templates || []).join('/'),
      s.lat !== null ? s.lat : '',
      s.lon !== null ? s.lon : '',
      (s.keywords || []).join('|'),
      s.note || '',
    ]);

    const blob = dataProcessor.generateCSVBlob(headers, rows);
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    _downloadBlob(blob, `地点マスタ_${ts}.csv`);
    uiController.showToast(`地点マスタ_${ts}.csv をダウンロードしました（${validStations.length}件）`, 'success');
  }

  /**
   * 地点マスタの空テンプレートをダウンロード
   */
  function downloadMasterTemplate() {
    const headers = ['地点ID', '地点名', '地点名_読み', '調査区分', 'テンプレート', '緯度', '経度', 'ファイル名キーワード', '備考'];
    const rows = [
      ['ST001', '津久根', 'つくね', '定点', '広島湾調査', '35.6812', '139.7671', 'つくね|tsukune|tukune', '備考を入力'],
      ['ST002', '似島', 'にのしま', '臨時', '広島湾調査/溶存酸素', '35.6812', '139.7671', 'にのしま|ninoshima|ninosima', '備考を入力']
    ];
    const blob = dataProcessor.generateCSVBlob(headers, rows);
    _downloadBlob(blob, '地点マスタ_テンプレート.csv');
    uiController.showToast('テンプレートをダウンロードしました', 'success');
  }

  function _downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
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
    moveCards,
    removeFile,
    saveStationForm,
    editStation,
    deleteStation,
    deleteSwimlane,
    addStationFromMap,
    getFileCounts,
    downloadMasterCSV,
    downloadMasterTemplate,
    addSwimlane,
    addSwimlanesByCategory,
    addSwimlanesByTemplate,
    addAllSwimlanes,
    autoAssignUnclassified,
    openMapForCoordPick,
  };
})();

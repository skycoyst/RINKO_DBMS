/**
 * AAQ-RINKO CSV 仕分け・結合ツール
 * メインアプリケーションロジック
 */

// ==========================================
// 1. State Management (状態管理)
// ==========================================
const AppState = {
    // 地点マスタ配列: { id, name, type, lat, lng, note, keywords }
    sites: [],
    // 読み込み済み観測データ配列: { fileObj, meta, data, matchedSiteId, status }
    files: [],
    // 次に採番される地点IDのカウンター (ST001, ST002...)
    _nextSiteIdCounter: 1
};

// ==========================================
// 2. DOM Elements (DOM要素)
// ==========================================
const DOM = {
    // ヘッダーボタン
    btnLoadMaster: document.getElementById('btnLoadMaster'),
    btnMapAdd: document.getElementById('btnMapAdd'),
    btnExportCSV: document.getElementById('btnExportCSV'),
    btnDownloadMaster: document.getElementById('btnDownloadMaster'),

    // 隠しインプット
    masterFileInput: document.getElementById('masterFileInput'),
    dataFileInput: document.getElementById('dataFileInput'),

    // メインエリア
    dropZoneMain: document.getElementById('dropZoneMain'),
    dropOverlay: document.getElementById('dropOverlay'),
    welcomeMessage: document.getElementById('welcomeMessage'),
    swimlanesContainer: document.getElementById('swimlanesContainer'),
    uncategorizedContainer: document.getElementById('uncategorizedContainer'),
    uncategorizedLane: document.getElementById('uncategorizedLane'),

    // モーダル系
    previewModal: document.getElementById('previewModal'),
    btnClosePreview: document.getElementById('btnClosePreview'),
    btnModalClose: document.getElementById('btnModalClose'),

    addLocationModal: document.getElementById('addLocationModal'),
    btnCloseLocationModal: document.getElementById('btnCloseLocationModal'),
    btnCancelAddLoc: document.getElementById('btnCancelAddLoc'),
    btnConfirmAddLoc: document.getElementById('btnConfirmAddLoc'),

    // マップ追加フォーム
    addLocName: document.getElementById('addLocName'),
    addLocType: document.getElementById('addLocType'),
    addLocLat: document.getElementById('addLocLat'),
    addLocLng: document.getElementById('addLocLng'),
    addLocNote: document.getElementById('addLocNote'),
    addLocKeywords: document.getElementById('addLocKeywords'),

    // テンプレートダウンロード
    btnDownloadTemplate: document.getElementById('btnDownloadTemplate'),
};

// ==========================================
// 3. Initialization (初期化)
// ==========================================
function init() {
    setupEventListeners();
    updateUI();
}

// ==========================================
// 4. Event Listeners Setup
// ==========================================
function setupEventListeners() {
    // --- 地点マスタ読み込み ---
    DOM.btnLoadMaster.addEventListener('click', () => {
        if (AppState.sites.length > 0 || AppState.files.length > 0) {
            if (!confirm("新しい地点マスタを読み込むと、現在のスイムレーンの状態と読み込み済みのファイルがすべてリセットされます。よろしいですか？")) {
                return;
            }
        }
        DOM.masterFileInput.click();
    });

    DOM.masterFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await handleMasterFile(file);
        // Reset input to allow loading the same file again if needed
        DOM.masterFileInput.value = '';
    });

    // テンプレートダウンロード
    if (DOM.btnDownloadTemplate) {
        DOM.btnDownloadTemplate.addEventListener('click', downloadMasterTemplate);
    }

    // --- その他UI表示初期設定 ---
    // btnMapAdd, dropZoneMain, etc..
}

// テンプレートDL処理
function downloadMasterTemplate() {
    const header = ['地点名', '地点ID', '調査区分', '緯度', '経度', '備考', 'ファイル名キーワード'];
    const sampleRows = [
        ['ツクネ', 'ST001', '海域', '35.1234', '139.5678', 'サンプル地点です', 'tukune|つくね|tsukune'],
        ['新町', 'ST002', '河川', '', '', '座標がない地点の例', 'shinmachi|shin']
    ];

    const rowsAsCsvLines = sampleRows.map(row =>
        row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')
    );

    const csvContent = '\uFEFF' + [header.join(','), ...rowsAsCsvLines].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `地点マスタ_テンプレート.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ==========================================
// 5. Site Master Handling
// ==========================================

/**
 * 地点マスタCSVを読み込み、パースする
 */
async function handleMasterFile(file) {
    try {
        const text = await readFileWithEncodingDetect(file);
        const parsedSites = parseMasterCSV(text);

        if (parsedSites.length === 0) {
            alert("有効な地点データが見つかりませんでした。");
            return;
        }

        // 全リセットして新マスタを適用
        resetApp();
        AppState.sites = parsedSites;

        // 最大IDの次のカウンターを設定
        let maxIdNum = 0;
        parsedSites.forEach(s => {
            const match = s.id.match(/^ST(\d+)$/);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxIdNum) maxIdNum = num;
            }
        });
        AppState._nextSiteIdCounter = maxIdNum + 1;

        updateUI();
        alert(`${parsedSites.length} 件の地点マスタを読み込みました。`);
    } catch (err) {
        console.error("Master File Read Error:", err);
        alert(`地点マスタの読み込みに失敗しました。\n${err.message}`);
    }
}

/**
 * ファイルのエンコーディングを判定して文字列として返す
 * @param {File} file 
 * @returns {Promise<string>}
 */
function readFileWithEncodingDetect(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            const buffer = e.target.result;
            const uint8Array = new Uint8Array(buffer);

            // 1. BOM判定 (EF BB BF)
            if (uint8Array.length >= 3 && uint8Array[0] === 0xEF && uint8Array[1] === 0xBB && uint8Array[2] === 0xBF) {
                const decoder = new TextDecoder('utf-8');
                resolve(decoder.decode(uint8Array));
                return;
            }

            // 2. BOMなし -> まず Shift_JIS で試す
            const sjisDecoder = new TextDecoder('shift-jis', { fatal: false });
            const sjisText = sjisDecoder.decode(uint8Array);

            // 3. Shift_JISでデコードされた文字列に置換文字(U+FFFD)が多く含まれていればUTF-8とみなす
            //    (簡易判定: 10個以上、または全体の1%以上が文字化けした場合など)
            const fffdCount = (sjisText.match(/\uFFFD/g) || []).length;
            if (fffdCount > 0 && fffdCount > Math.min(10, sjisText.length * 0.05)) {
                // UTF-8 (BOMなし) で再試行
                const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
                resolve(utf8Decoder.decode(uint8Array));
            } else {
                resolve(sjisText);
            }
        };
        reader.onerror = () => reject(new Error("File read error"));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * マスタCSVのテキストをパースする
 * 1行目: 地点名,地点ID,調査区分,緯度,経度,備考,ファイル名キーワード
 */
function parseMasterCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length <= 1) return [];

    const headers = splitCSVLine(lines[0]);
    // 簡単なヘッダーバリデーション
    if (headers.length < 2 || (!headers[0].includes('地点名') && !headers[1].includes('地点ID'))) {
        throw new Error("CSVのフォーマットが正しくありません。\n想定: 地点名, 地点ID, 調査区分, ...");
    }

    const sites = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = splitCSVLine(lines[i]);
        if (cols.length < 2) continue; // 空行などをスキップ

        // カラム: 0:地点名, 1:地点ID, 2:調査区分, 3:緯度, 4:経度, 5:備考, 6:キーワード
        const site = {
            name: cols[0] || '',
            id: cols[1] || '',
            type: cols[2] || '',
            lat: parseFloat(cols[3]) || null,
            lng: parseFloat(cols[4]) || null,
            note: cols[5] || '',
            keywords: cols[6] ? cols[6].split('|').map(k => k.trim()).filter(k => k) : []
        };

        // IDが未設定の場合は自動採番してあげる（本来はマスタにあるべきだが安全対策）
        if (!site.id) {
            site.id = generateSiteId();
        }
        if (site.name) {
            sites.push(site);
        }
    }
    return sites;
}

/**
 * カンマ区切り行を配列に分割（ダブルクォート対応簡易版）
 */
function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());

    // 外側のダブルクォートを外す
    return result.map(s => s.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

/**
 * 新規の地点IDを生成する
 */
function generateSiteId() {
    const id = `ST${String(AppState._nextSiteIdCounter).padStart(3, '0')}`;
    AppState._nextSiteIdCounter++;
    return id;
}

// ==========================================
// 6. UI Rendering & Swimlane Interactivity
// ==========================================

const laneMaps = {}; // { siteId: { mapInstance, markers: [] } }
const sortables = [];

function resetApp() {
    AppState.sites = [];
    AppState.files = [];
    AppState._nextSiteIdCounter = 1;
    updateUI();
}

function updateUI() {
    if (AppState.sites.length === 0) {
        DOM.welcomeMessage.classList.remove('hidden');
        DOM.swimlanesContainer.classList.add('hidden');
        DOM.uncategorizedContainer.classList.add('hidden');
        DOM.btnExportCSV.classList.add('opacity-50', 'pointer-events-none');
        clearAllMaps();
        return;
    }

    DOM.welcomeMessage.classList.add('hidden');
    DOM.swimlanesContainer.classList.remove('hidden');

    renderSwimlanes();
    renderUncategorized();
    setupSortables();

    // 結合出力ボタンの活性化
    const mappedFiles = AppState.files.filter(f => f.matchedSiteId);
    if (mappedFiles.length > 0) {
        DOM.btnExportCSV.classList.remove('opacity-50', 'pointer-events-none');
    } else {
        DOM.btnExportCSV.classList.add('opacity-50', 'pointer-events-none');
    }
}

function clearAllMaps() {
    Object.keys(laneMaps).forEach(k => {
        if (laneMaps[k].mapInstance) laneMaps[k].mapInstance.remove();
        delete laneMaps[k];
    });
}

function renderSwimlanes() {
    // 既存のマップインスタンスとDOMをクリーンアップ
    clearAllMaps();
    DOM.swimlanesContainer.innerHTML = '';

    AppState.sites.forEach(site => {
        const laneFiles = AppState.files.filter(f => f.matchedSiteId === site.id);

        const laneEl = document.createElement('div');
        laneEl.className = 'swimlane-row';
        laneEl.dataset.siteId = site.id;

        // ヘッダー部
        const headerEl = document.createElement('div');
        headerEl.className = 'swimlane-header';
        headerEl.innerHTML = `
            <div>
                <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs font-mono text-slate-400 bg-slate-200 px-1.5 py-0.5 rounded">${site.id}</span>
                    <h3 class="font-bold text-slate-800 text-base leading-tight">${escapeHTML(site.name)}</h3>
                </div>
                ${site.type ? `<span class="inline-block text-xs text-blue-800 bg-blue-100 px-2 py-1 rounded-full mb-2">${escapeHTML(site.type)}</span>` : ''}
                ${site.note ? `<p class="text-xs text-slate-500 line-clamp-2" title="${escapeHTML(site.note)}">${escapeHTML(site.note)}</p>` : ''}
            </div>
            
            <button class="mt-4 text-xs flex items-center gap-1 text-rose-500 hover:text-rose-700 transition-colors btn-delete-lane" data-site-id="${site.id}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                削除
            </button>
        `;

        // コンテンツ（カード並び）部
        const contentEl = document.createElement('div');
        contentEl.className = 'swimlane-content';
        const scrollerEl = document.createElement('div');
        scrollerEl.className = 'swimlane-scroller h-full sortable-list';
        scrollerEl.dataset.siteId = site.id;

        laneFiles.forEach(f => {
            scrollerEl.appendChild(createCardElement(f));
        });

        // マップ部
        const mapAreaEl = document.createElement('div');
        mapAreaEl.className = 'swimlane-map-area';

        const validGpsFiles = laneFiles.filter(f => f.meta && f.meta.endPosition);
        const mapContainerId = 'map_' + site.id;

        if (validGpsFiles.length > 0) {
            mapAreaEl.innerHTML = `
                <div class="text-xs font-semibold text-slate-500 mb-2">📍 観測位置</div>
                <div id="${mapContainerId}" class="map-container z-0"></div>
            `;
        } else {
            mapAreaEl.innerHTML = `
                <div class="text-xs font-semibold text-slate-500 mb-2">📍 観測位置</div>
                <div class="map-container bg-slate-200 flex items-center justify-center text-slate-400 text-xs text-center p-2">
                    位置情報を持つ<br>ファイルがありません
                </div>
            `;
        }

        contentEl.appendChild(scrollerEl);
        laneEl.appendChild(headerEl);
        laneEl.appendChild(contentEl);
        laneEl.appendChild(mapAreaEl);

        DOM.swimlanesContainer.appendChild(laneEl);

        const btnDelete = headerEl.querySelector('.btn-delete-lane');
        btnDelete.addEventListener('click', () => handleDeleteSwimlane(site.id));

        // Leaflet初期化 (DOM追加後)
        if (validGpsFiles.length > 0) {
            initLaneMap(site.id, mapContainerId, validGpsFiles);
        }
    });
}

function renderUncategorized() {
    const uncatFiles = AppState.files.filter(f => !f.matchedSiteId);
    if (uncatFiles.length > 0 || AppState.files.length > 0) {
        DOM.uncategorizedContainer.classList.remove('hidden');
    } else {
        DOM.uncategorizedContainer.classList.add('hidden');
    }

    DOM.uncategorizedLane.innerHTML = '';
    DOM.uncategorizedLane.dataset.siteId = ''; // 空文字は未分類
    DOM.uncategorizedLane.className = 'uncategorized-area flex flex-wrap gap-2 sortable-list w-full min-h-[120px]';

    if (uncatFiles.length === 0) {
        DOM.uncategorizedLane.innerHTML = `<div class="w-full text-center text-rose-300 text-sm py-8 italic border-2 border-dashed border-rose-200 rounded-md pointer-events-none">判定できなかったファイルがここに表示されます。手動で各地点にドラッグしてください。</div>`;
    } else {
        uncatFiles.forEach(f => {
            DOM.uncategorizedLane.appendChild(createCardElement(f));
        });
    }
}

function createCardElement(fileData) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fileId = fileData.id;

    let statusIcon = '✅';
    let statusColor = 'text-green-500';
    if (fileData.status === 'warning') { statusIcon = '🔶'; statusColor = 'text-yellow-500'; }
    if (fileData.status.startsWith('error')) { statusIcon = '🔴'; statusColor = 'text-red-500'; }

    let locStr = '📍 位置情報なし';
    if (fileData.meta && fileData.meta.endPosition) {
        locStr = `📍 ${fileData.meta.endPosition.lat.toFixed(4)}°N ${fileData.meta.endPosition.lng.toFixed(4)}°E`;
    }

    card.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <span class="text-sm font-semibold truncate flex-grow" title="${fileData.fileObj.name}">${fileData.fileObj.name}</span>
            <span class="${statusColor} text-sm ml-1 flex-shrink-0" title="状態: ${fileData.status}">${statusIcon}</span>
        </div>
        <div class="text-xs text-slate-500 mb-1 flex justify-between">
            <span>${fileData.meta ? fileData.meta.sampleCnt : 0}件</span>
            <span>最大 ${fileData.meta ? fileData.meta.maxDepth.toFixed(1) : 0}m</span>
        </div>
        <div class="text-[10px] text-slate-400 truncate">${locStr}</div>
    `;

    // プレビュー用にクリックイベント
    card.addEventListener('click', () => openPreviewModal(fileData));

    // マップマーカー連携用（ホバー等の追加拡張用）
    card.addEventListener('mouseenter', () => highlightMarker(fileData.id, fileData.matchedSiteId, true));
    card.addEventListener('mouseleave', () => highlightMarker(fileData.id, fileData.matchedSiteId, false));

    return card;
}

function initLaneMap(siteId, containerId, files) {
    const map = L.map(containerId, { zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    const bounds = L.latLngBounds();
    const markers = [];

    files.forEach(f => {
        const p = f.meta.endPosition;
        const marker = L.marker([p.lat, p.lng]).addTo(map);
        marker.bindPopup(`<b>${escapeHTML(f.fileObj.name)}</b><br>最大水深: ${f.meta.maxDepth.toFixed(1)}m`);

        marker.on('click', () => {
            const card = document.querySelector(`.file-card[data-file-id="${f.id}"]`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                card.classList.add('highlight');
                setTimeout(() => card.classList.remove('highlight'), 2000);
            }
        });

        bounds.extend([p.lat, p.lng]);
        markers.push({ fileId: f.id, marker });
    });

    map.fitBounds(bounds, { padding: [10, 10], maxZoom: 15 });

    // 遅延リサイズ対応
    setTimeout(() => map.invalidateSize(), 100);

    laneMaps[siteId] = { mapInstance: map, markers };
}

function highlightMarker(fileId, siteId, isHighlight) {
    if (!siteId || !laneMaps[siteId]) return;
    const item = laneMaps[siteId].markers.find(m => m.fileId === fileId);
    if (!item) return;

    if (isHighlight) {
        item.marker._icon.classList.add('active-marker'); // 簡易ハイライト（CSSにて補強可能）
    } else {
        item.marker._icon.classList.remove('active-marker');
    }
}

function setupSortables() {
    sortables.forEach(s => s.destroy());
    sortables.length = 0;

    const lists = document.querySelectorAll('.sortable-list');
    lists.forEach(listEl => {
        const sortable = new Sortable(listEl, {
            group: 'swimlanes',
            animation: 150,
            ghostClass: 'opacity-50',
            dragClass: 'drag-hover',
            onEnd: function (evt) {
                const itemEl = evt.item;  // ドラッグされた要素
                const toListEl = evt.to;  // ドロップ先のリスト要素
                const fileId = itemEl.dataset.fileId;
                const newSiteId = toListEl.dataset.siteId || null;

                const fileObj = AppState.files.find(f => f.id === fileId);
                if (fileObj && fileObj.matchedSiteId !== newSiteId) {
                    fileObj.matchedSiteId = newSiteId;
                    // 再描画（マップの更新などを含めるため全体再描画）
                    updateUI();
                }
            },
        });
        sortables.push(sortable);
    });
}

// ユーティリティ
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function handleDeleteSwimlane(siteId) {
    const site = AppState.sites.find(s => s.id === siteId);
    if (!site) return;

    const filesInLane = AppState.files.filter(f => f.matchedSiteId === siteId);

    if (filesInLane.length > 0) {
        if (!confirm(`「${site.name}」には ${filesInLane.length} 件のデータが紐付いています。\n削除すると、これらのデータは「未分類」に移動します。よろしいですか？`)) return;
        filesInLane.forEach(f => f.matchedSiteId = null);
    } else {
        if (!confirm(`「${site.name}」を削除してもよろしいですか？`)) return;
    }

    AppState.sites = AppState.sites.filter(s => s.id !== siteId);
    updateUI();
}

// 初期化実行
document.addEventListener('DOMContentLoaded', init);

// ==========================================
// 7. Map / Location Add Logic
// ==========================================
let pickerMapInstance = null;
let pickerMarker = null;

function setupMapModal() {
    DOM.btnMapAdd.addEventListener('click', () => {
        DOM.addLocationModal.classList.remove('hidden');
        DOM.addLocationModal.classList.add('flex');

        // Form初期化
        DOM.addLocName.value = '';
        DOM.addLocType.value = '';
        DOM.addLocLat.value = '';
        DOM.addLocLng.value = '';
        DOM.addLocNote.value = '';
        DOM.addLocKeywords.value = '';

        // Leafletマップの遅延初期化（モーダル表示後でないとサイズ計算が狂うため）
        setTimeout(() => {
            if (!pickerMapInstance) {
                // デフォルトは日本全体が見える座標
                pickerMapInstance = L.map('pickerMap').setView([36.2048, 138.2529], 5);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                }).addTo(pickerMapInstance);

                pickerMapInstance.on('click', function (e) {
                    const lat = e.latlng.lat;
                    const lng = e.latlng.lng;
                    DOM.addLocLat.value = lat.toFixed(6);
                    DOM.addLocLng.value = lng.toFixed(6);

                    if (!pickerMarker) {
                        pickerMarker = L.marker([lat, lng]).addTo(pickerMapInstance);
                    } else {
                        pickerMarker.setLatLng([lat, lng]);
                    }
                });
            } else {
                pickerMapInstance.invalidateSize();
            }
        }, 100);
    });

    const closeMapModal = () => {
        DOM.addLocationModal.classList.add('hidden');
        DOM.addLocationModal.classList.remove('flex');
    };

    DOM.btnCloseLocationModal.addEventListener('click', closeMapModal);
    DOM.btnCancelAddLoc.addEventListener('click', closeMapModal);

    DOM.btnConfirmAddLoc.addEventListener('click', () => {
        const name = DOM.addLocName.value.trim();
        if (!name) {
            alert("地点名を入力してください。");
            return;
        }

        const keywordsStr = DOM.addLocKeywords.value.trim();
        let keywords = [];
        if (keywordsStr) {
            keywords = keywordsStr.split('|').map(k => k.trim()).filter(k => k);
        }

        const newSite = {
            id: generateSiteId(),
            name: name,
            type: DOM.addLocType.value.trim(),
            lat: parseFloat(DOM.addLocLat.value) || null,
            lng: parseFloat(DOM.addLocLng.value) || null,
            note: DOM.addLocNote.value.trim(),
            keywords: keywords
        };

        AppState.sites.push(newSite);
        updateUI();
        closeMapModal();
    });
}

// init関数内でsetupMapModalを呼び出すようにする
const originalInit = init;
init = function () {
    originalInit();
    setupMapModal();
    setupMasterDownload();
};

function setupMasterDownload() {
    DOM.btnDownloadMaster.addEventListener('click', () => {
        if (AppState.sites.length === 0) {
            alert("ダウンロード可能な地点データがありません。");
            return;
        }

        const header = ['地点名', '地点ID', '調査区分', '緯度', '経度', '備考', 'ファイル名キーワード'];
        const rows = AppState.sites.map(site => {
            return [
                site.name,
                site.id,
                site.type,
                site.lat !== null ? site.lat : '',
                site.lng !== null ? site.lng : '',
                site.note,
                site.keywords.join('|')
            ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
        });

        const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.download = `地点マスタ_${dateStr}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

// ==========================================
// 8. Observation Data Handling (D&D and Parsing)
// ==========================================
let dragCount = 0;

function setupDragAndDrop() {
    const preventDefaults = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const container = document.getElementById('dropZoneMain') || document.body;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        container.addEventListener(eventName, preventDefaults, false);
    });

    container.addEventListener('dragenter', (e) => {
        dragCount++;
        DOM.dropOverlay.classList.remove('hidden');
        DOM.dropOverlay.classList.add('flex');
    });

    container.addEventListener('dragleave', (e) => {
        dragCount--;
        if (dragCount === 0) {
            DOM.dropOverlay.classList.add('hidden');
            DOM.dropOverlay.classList.remove('flex');
        }
    });

    container.addEventListener('drop', handleDrop);
}

async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    dragCount = 0;
    DOM.dropOverlay.classList.add('hidden');
    DOM.dropOverlay.classList.remove('flex');

    const dt = e.dataTransfer;
    const files = dt.files;

    if (files && files.length > 0) {
        // 画面の左側1/3にドロップされたか判定
        const isMasterZone = e.clientX < (window.innerWidth / 3);
        await processDroppedFiles(Array.from(files), isMasterZone);
    }
}

async function processDroppedFiles(files, isMasterZone) {
    const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (csvFiles.length === 0) return;

    // 左側のマスタエリアにドロップされた場合
    if (isMasterZone) {
        const masterFile = csvFiles[0];
        if (AppState.sites.length > 0 || AppState.files.length > 0) {
            if (!confirm(`地点マスタ「${masterFile.name}」として読み込みます。\n現在の状態はすべてリセットされます。よろしいですか？`)) {
                return;
            }
        }
        await handleMasterFile(masterFile);

        if (csvFiles.length > 1) {
            showToast("マスタエリアには1ファイルのみ有効です。最初のファイルをマスタとして読み込みました。");
        }
        return;
    }

    // 右側の観測データエリアにドロップされた場合
    if (AppState.sites.length === 0) {
        alert("先に画面左側の領域へ地点マスタCSVをドロップして読み込んでください。");
        return;
    }

    for (const file of csvFiles) {
        if (!file.name.toLowerCase().endsWith('.csv')) continue;

        // 重複チェック
        if (AppState.files.some(f => f.fileObj.name === file.name)) {
            showToast(`${file.name} は既に読み込まれています。`);
            continue;
        }

        if (file.size > 50 * 1024 * 1024) {
            if (!confirm(`${file.name} はサイズが大きいです(50MB超)。読み込みを続行しますか？`)) {
                continue;
            }
        }

        try {
            await parseObservationFile(file);
        } catch (e) {
            console.error(e);
            alert(`${file.name} の読み込みエラー: ${e.message}`);
        }
    }
    updateUI();
}
async function parseObservationFile(file) {
    // 常に Shift_JIS でファイルを読む
    const reader = new FileReader();
    const text = await new Promise((resolve, reject) => {
        reader.onload = e => {
            const sjisDecoder = new TextDecoder('shift-jis');
            resolve(sjisDecoder.decode(new Uint8Array(e.target.result)));
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });

    const lines = text.split(/\r?\n/);

    // マスタCSVの誤ドロップ防止
    if (lines[0] && lines[0].includes('地点名') && lines[0].includes('緯度')) {
        alert(`警告: ${file.name} は地点マスタCSVと認識されました。観測データではありません。`);
        return;
    }

    let headerRowIdx = -1;
    let fallbackStatus = 'normal';

    // 1. [Item] 検出
    for (let i = 0; i < Math.min(200, lines.length); i++) {
        if (lines[i].trim().startsWith('[Item]')) {
            headerRowIdx = i + 1;
            break;
        }
    }

    // 2. キーワード検出 (フォールバック)
    if (headerRowIdx === -1) {
        for (let i = 0; i < Math.min(150, lines.length); i++) {
            if (lines[i].includes('観測日時') || lines[i].toLowerCase().includes('date')) {
                headerRowIdx = i;
                break;
            }
        }
    }

    // 3. 固定行 69行目 (フォールバック2)
    if (headerRowIdx === -1) {
        if (lines.length > 68) {
            headerRowIdx = 68;
            fallbackStatus = 'warning';
        } else {
            fallbackStatus = 'error_no_header';
        }
    }

    if (fallbackStatus === 'error_no_header' || headerRowIdx >= lines.length) {
        addFileToState(file, text, null, null, null, null, 'error_no_header');
        return;
    }

    const headers = splitCSVLine(lines[headerRowIdx]);
    const dataLines = lines.slice(headerRowIdx + 1).filter(l => l.trim() !== '');

    if (dataLines.length === 0) {
        addFileToState(file, text, headers, null, null, null, 'error_no_data');
        return;
    }

    // メタデータ抽出
    let sampleCnt = dataLines.length;
    let maxDepth = 0;
    let endPosition = null;
    let startPosition = null;

    let depthColIdx = headers.findIndex(h => h.includes('深度'));
    if (depthColIdx === -1) depthColIdx = 1;

    for (let i = 0; i < headerRowIdx; i++) {
        const line = lines[i];
        if (line.startsWith('SampleCnt=')) {
            const m = line.match(/\d+/);
            if (m) sampleCnt = parseInt(m[0], 10);
        }
        if (line.startsWith('StartPosition=')) {
            startPosition = parsePosition(line.replace('StartPosition=', '').trim());
        }
        if (line.startsWith('EndPosition=')) {
            endPosition = parsePosition(line.replace('EndPosition=', '').trim());
        }
    }

    dataLines.forEach(line => {
        const cols = splitCSVLine(line);
        if (cols[depthColIdx]) {
            const d = parseFloat(cols[depthColIdx]);
            if (!isNaN(d) && d > maxDepth) maxDepth = d;
        }
    });

    const meta = { sampleCnt, maxDepth, startPosition, endPosition };
    const matchedSiteId = determineSite(file.name);

    addFileToState(file, text, headers, dataLines, meta, matchedSiteId, fallbackStatus);
}

function parsePosition(posStr) {
    if (posStr.includes('-')) return null;
    const parts = posStr.split(',');
    if (parts.length !== 2) return null;

    const parseDegMin = (str) => {
        const val = parseFloat(str.trim());
        if (isNaN(val)) return null;
        const deg = Math.floor(val / 100);
        const min = val % 100;
        return deg + (min / 60);
    };

    const lat = parseDegMin(parts[0]);
    const lng = parseDegMin(parts[1]);

    if (lat !== null && lng !== null) return { lat, lng };
    return null;
}

function determineSite(filename) {
    let cleanName = filename.replace(/\.csv$/i, '');
    cleanName = cleanName.replace(/^\d+[\s_-]*/, '');
    cleanName = cleanName.toLowerCase();

    // マスタからキーワード照合
    for (const site of AppState.sites) {
        if (site.keywords && site.keywords.length > 0) {
            for (const kw of site.keywords) {
                if (cleanName.includes(kw.toLowerCase())) return site.id;
            }
        } else {
            if (cleanName.includes(site.name.toLowerCase())) return site.id;
        }
    }
    return null; // 該当なし（未分類）
}

function addFileToState(fileObj, rawText, headers, dataLines, meta, matchedSiteId, status) {
    AppState.files.push({
        id: 'file_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        fileObj,
        rawText,
        headers,
        dataLines,
        meta,
        matchedSiteId,
        status // 'normal', 'warning', 'error_no_header', 'error_no_data'
    });
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'fixed bottom-4 right-4 bg-slate-800 text-white px-4 py-2 rounded shadow-lg z-50 animate-fade-in-up';
    t.innerText = msg;
    document.body.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transition = 'opacity 0.5s ease';
        setTimeout(() => t.remove(), 500);
    }, 3000);
}

// ==========================================
// 9. Preview Modal Logic
// ==========================================
function openPreviewModal(fileData) {
    if (!fileData) return;

    const titleEl = document.getElementById('previewTitle');
    titleEl.innerHTML = `
        <svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
        ${escapeHTML(fileData.fileObj.name)}
    `;

    let locStr = '位置情報なし';
    if (fileData.meta && fileData.meta.endPosition) {
        locStr = `${fileData.meta.endPosition.lat.toFixed(4)}°N ${fileData.meta.endPosition.lng.toFixed(4)}°E`;
    }
    document.getElementById('previewSubtitle').innerText = `${fileData.meta ? fileData.meta.sampleCnt : 0}件 | 最大 ${fileData.meta ? fileData.meta.maxDepth.toFixed(1) : 0}m | ${locStr}`;

    const tableEl = document.getElementById('previewTable');
    const headerRow = document.getElementById('previewTableHeader');
    const tbody = document.getElementById('previewTableBody');
    const loading = document.getElementById('previewLoading');

    tableEl.classList.add('hidden');
    loading.classList.remove('hidden');
    DOM.previewModal.classList.remove('hidden');

    // UIブロッキングを防ぐため非同期でテーブル構築
    setTimeout(() => {
        headerRow.innerHTML = '';
        if (fileData.headers) {
            fileData.headers.forEach(h => {
                const th = document.createElement('th');
                th.className = 'px-3 py-2 border-r border-slate-200 font-semibold text-slate-700 bg-slate-100';
                th.textContent = h;
                headerRow.appendChild(th);
            });
        }

        tbody.innerHTML = '';
        if (fileData.dataLines) {
            // パフォーマンスのため最大1000行プレビューに制限
            const previewLimit = Math.min(fileData.dataLines.length, 1000);

            // フラグメントを使用して再描画を1回にまとめる
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < previewLimit; i++) {
                const cols = splitCSVLine(fileData.dataLines[i]);
                const tr = document.createElement('tr');
                tr.className = 'hover:bg-slate-50';
                cols.forEach(c => {
                    const td = document.createElement('td');
                    td.className = 'px-3 py-1.5 border-r border-slate-200 text-slate-600';
                    td.textContent = c;
                    tr.appendChild(td);
                });
                fragment.appendChild(tr);
            }

            if (fileData.dataLines.length > previewLimit) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = fileData.headers ? fileData.headers.length : 1;
                td.className = 'px-3 py-2 text-center text-slate-400 italic bg-slate-50';
                td.textContent = `... 他 ${fileData.dataLines.length - previewLimit} 件のデータは省略されています ...`;
                tr.appendChild(td);
                fragment.appendChild(tr);
            }

            tbody.appendChild(fragment);
        }

        loading.classList.add('hidden');
        tableEl.classList.remove('hidden');
    }, 50);
}

function closePreviewModal() {
    DOM.previewModal.classList.add('hidden');
}

// ==========================================
// 10. Data Export Logic
// ==========================================
function setupExport() {
    DOM.btnExportCSV.addEventListener('click', handleExportCSV);
}

async function handleExportCSV() {
    const uncatFiles = AppState.files.filter(f => !f.matchedSiteId);
    const mappedFiles = AppState.files.filter(f => f.matchedSiteId);

    if (mappedFiles.length === 0) {
        alert("出力できるファイルがありません。地点に紐付けられたデータが必要です。");
        return;
    }

    if (uncatFiles.length > 0) {
        if (!confirm(`「未分類・判定不可」エリアに ${uncatFiles.length} 件のファイルが残っています。これらを出力から除外して続行しますか？`)) {
            return;
        }
    }

    const warningFiles = mappedFiles.filter(f => f.status !== 'normal');
    if (warningFiles.length > 0) {
        if (!confirm(`警告やエラーが出ている配置済みファイルが ${warningFiles.length} 件あります。そのまま出力に含めますか？`)) {
            return;
        }
    }

    const baseHeaders = mappedFiles[0].headers || [];
    let newHeaders = [
        '地点ID', '地点名', 'ファイル名',
        '地点緯度(マスタ)', '地点経度(マスタ)',
        '開始位置緯度', '開始位置経度', '終了位置緯度', '終了位置経度',
        '水深区分', 'B-1mフラグ'
    ];

    // カラム名の衝突回避
    const cleanBaseHeaders = baseHeaders.map(h => newHeaders.includes(h) ? `元_${h}` : h);
    newHeaders = newHeaders.concat(cleanBaseHeaders);

    const outputRows = [newHeaders.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')];

    // ファイル名等でソートしておくと出力が綺麗
    mappedFiles.sort((a, b) => a.matchedSiteId.localeCompare(b.matchedSiteId) || a.fileObj.name.localeCompare(b.fileObj.name));

    mappedFiles.forEach(fileData => {
        const site = AppState.sites.find(s => s.id === fileData.matchedSiteId);
        if (!site) return;

        const siteLat = site.lat !== null ? site.lat : '';
        const siteLng = site.lng !== null ? site.lng : '';
        const startLat = (fileData.meta && fileData.meta.startPosition) ? fileData.meta.startPosition.lat : '';
        const startLng = (fileData.meta && fileData.meta.startPosition) ? fileData.meta.startPosition.lng : '';
        const endLat = (fileData.meta && fileData.meta.endPosition) ? fileData.meta.endPosition.lat : '';
        const endLng = (fileData.meta && fileData.meta.endPosition) ? fileData.meta.endPosition.lng : '';

        // 深度列のインデックス特定
        let depthColIdx = -1;
        if (fileData.headers) {
            depthColIdx = fileData.headers.findIndex(h => h.includes('深度'));
        }
        if (depthColIdx === -1) depthColIdx = 1; // フォールバック

        // 1パス目: 最大水深区分の特定 (算出ロジック: Math.round(depth / 0.5) * 0.5)
        let maxSeg = -1;
        const parsedRows = [];

        if (!fileData.dataLines) return;

        fileData.dataLines.forEach(line => {
            const cols = splitCSVLine(line);
            if (!cols || cols.length === 0) return;

            let seg = null;
            if (cols[depthColIdx]) {
                const d = parseFloat(cols[depthColIdx]);
                if (!isNaN(d)) {
                    seg = Math.round(d / 0.5) * 0.5;
                    if (seg > maxSeg) maxSeg = seg;
                }
            }
            parsedRows.push({ cols, seg });
        });

        // B-1mは、最大区分 - 1.0m
        const targetSeg = maxSeg >= 0 ? maxSeg - 1.0 : -1;

        // 2パス目: 出力行の生成
        parsedRows.forEach(rowInfo => {
            let isBminus1 = '0';
            if (rowInfo.seg !== null && Math.abs(rowInfo.seg - targetSeg) < 0.01) {
                isBminus1 = '1';
            }

            const rowData = [
                site.id,
                site.name,
                fileData.fileObj.name,
                siteLat, siteLng,
                startLat, startLng,
                endLat, endLng,
                rowInfo.seg !== null ? rowInfo.seg.toFixed(1) : '',
                isBminus1
            ];

            rowInfo.cols.forEach(c => rowData.push(c));

            // CSV形式にエスケープして追加
            outputRows.push(rowData.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','));
        });
    });

    const csvContent = '\uFEFF' + outputRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const dt = new Date();
    const yyyymmdd = dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, '0') + String(dt.getDate()).padStart(2, '0');
    const hhmm = String(dt.getHours()).padStart(2, '0') + String(dt.getMinutes()).padStart(2, '0');

    let prefix = prompt("出力ファイル名のプレフィックス（調査名など）を入力してください（空でも可）:", "");
    if (prefix === null) return; // キャンセルされた場合

    const dlName = prefix.trim() ? `${prefix.trim()}_結合済み観測データ_${yyyymmdd}_${hhmm}.csv` : `結合済み観測データ_${yyyymmdd}_${hhmm}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = dlName;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`${dlName} を出力しました。`);
}

// init関数に追加
const originalInit3 = init;
init = function () {
    originalInit3();
    DOM.btnClosePreview.addEventListener('click', closePreviewModal);
    DOM.btnModalClose.addEventListener('click', closePreviewModal);
};

// 既存のinitをラップ
const originalInit4 = init;
init = function () {
    originalInit4();
    setupExport();
};

// init()に追加
const originalInit2 = init;
init = function () {
    originalInit2();
    setupDragAndDrop();
};

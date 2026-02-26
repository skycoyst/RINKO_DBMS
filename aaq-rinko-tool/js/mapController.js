/**
 * mapController.js
 * 地図モーダル制御（Leaflet.js使用）
 * v3.2: 常時表示ではなく、地点名リンクからモーダルで起動
 */
'use strict';

const mapController = (() => {

  let map = null;
  let markers = {};      // stationId → L.Marker
  let isInitialized = false;
  let addPointMode = false;
  let addPointCallback = null;

  // ─── 初期化 ───

  /**
   * 地図モーダル初回表示時に初期化（常時表示ではない）
   */
  function initMap() {
    if (isInitialized) return;

    map = L.map('map', {
      center: [35.0, 135.0],
      zoom: 5,
    });

    // 地理院地図レイヤー定義
    const photoLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
      attribution: 'Map data © <a href="https://maps.gsi.go.jp/development/ichiran.html">Geospatial Information Authority of Japan</a>',
      maxZoom: 18,
    });

    const paleLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      attribution: 'Map data © <a href="https://maps.gsi.go.jp/development/ichiran.html">Geospatial Information Authority of Japan</a>',
      maxZoom: 18,
    });

    // デフォルトで写真レイヤーを表示
    photoLayer.addTo(map);

    // レイヤーコントロール追加
    const baseMaps = {
      "シームレス写真": photoLayer,
      "淡色地図": paleLayer
    };
    L.control.layers(baseMaps).addTo(map);

    isInitialized = true;
  }

  // ─── モーダル操作 ───

  /**
   * 地図モーダルを開き、指定地点を中央にズームしポップアップを自動表示
   * @param {string} stationId
   * @param {object[]} stations  全地点配列（app.state.stations）
   * @param {Map<string,number>} fileCounts  stationId → ファイル数
   */
  function openMapModal(stationId, stations, fileCounts) {
    const modal = document.getElementById('map-modal');
    modal.classList.remove('hidden');

    // 初回初期化
    initMap();

    // モーダル表示後にLeafletのタイル描画を正常化（DOM反映を待つ）
    setTimeout(() => {
      map.invalidateSize();

      // 全地点マーカー描画
      displayAllLocations(stations, fileCounts);

      // 指定地点へズーム → ポップアップ
      const marker = markers[stationId];
      if (marker) {
        const latlng = marker.getLatLng();
        map.flyTo(latlng, 13, { duration: 0.8 });
        map.once('moveend', () => {
          marker.openPopup();
        });
      } else if (stations && stations.length > 0) {
        // 対象地点に座標がない場合でも全地点を表示
        map.invalidateSize();
      }
    }, 200);
  }

  /**
   * 地図モーダルを閉じる
   */
  function closeMapModal() {
    document.getElementById('map-modal').classList.add('hidden');
    // 地点追加モード解除
    if (addPointMode) disableAddPointMode();
  }

  // ─── マーカー管理 ───

  /**
   * モーダル起動時に全地点マーカーを描画
   * @param {object[]} stations
   * @param {Map<string,number>} fileCounts
   */
  function displayAllLocations(stations, fileCounts) {
    if (!map) return;

    // 既存マーカーをクリア
    Object.values(markers).forEach(m => map.removeLayer(m));
    markers = {};

    for (const st of stations) {
      if (st._invalid) continue;
      if (st.lat === null || st.lon === null) continue;
      addMarker(st, fileCounts ? (fileCounts.get(st.id) || 0) : 0);
    }
  }

  /**
   * マーカーを追加
   * @param {object} station
   * @param {number} fileCount
   * @returns {L.Marker}
   */
  function addMarker(station, fileCount = 0) {
    if (!map) return null;

    const catColor = { 定期: '#2563EB', 臨時: '#D97706', 未設定: '#6B7280' };
    const color = catColor[station.category] || '#6B7280';

    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:24px;height:24px;border-radius:50%;
        background:${color};border:2px solid white;
        box-shadow:0 1px 4px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        color:white;font-size:9px;font-weight:bold;
      ">${station.id.replace(/ST0*/, '')}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -14],
    });

    const popupContent = _buildPopupContent(station, fileCount);
    const marker = L.marker([station.lat, station.lon], { icon })
      .addTo(map)
      .bindPopup(popupContent, { maxWidth: 280 });

    marker.on('click', () => {
      marker.openPopup();
    });

    markers[station.id] = marker;
    return marker;
  }

  /**
   * マーカー更新（地点情報変更時）
   * @param {object} station
   * @param {number} fileCount
   */
  function updateMarker(station, fileCount = 0) {
    if (markers[station.id]) {
      map.removeLayer(markers[station.id]);
      delete markers[station.id];
    }
    if (station.lat !== null && station.lon !== null) {
      addMarker(station, fileCount);
    }
  }

  /**
   * マーカー削除
   * @param {string} stationId
   */
  function removeMarker(stationId) {
    if (markers[stationId]) {
      map.removeLayer(markers[stationId]);
      delete markers[stationId];
    }
  }

  /**
   * ポップアップ内容を構築
   * @param {object} station
   * @param {number} fileCount
   * @returns {string} HTML
   */
  function _buildPopupContent(station, fileCount) {
    const fmt = (v, unit = '') => (v !== null && v !== undefined && v !== '') ? `${v}${unit}` : '—';
    const latStr = station.lat !== null ? `${station.lat.toFixed(4)}°N` : '—';
    const lonStr = station.lon !== null ? `${station.lon.toFixed(4)}°E` : '—';

    let html = `
      <div style="font-size:13px;line-height:1.6;min-width:200px;">
        <div style="font-weight:bold;font-size:14px;margin-bottom:4px;">${_esc(station.name)}</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="color:#666;padding-right:8px;">地点ID</td><td>${_esc(station.id)}</td></tr>
          <tr><td style="color:#666;">調査区分</td><td>${_esc(station.category)}</td></tr>
          <tr><td style="color:#666;">緯度・経度</td><td>${latStr}, ${lonStr}</td></tr>
          <tr><td style="color:#666;">紐付きファイル数</td><td>${fileCount} 件</td></tr>
          ${station.note ? `<tr><td style="color:#666;">備考</td><td>${_esc(station.note)}</td></tr>` : ''}
        </table>
        <div style="margin-top:8px;display:flex;gap:4px;">
          <button onclick="app.editStation('${station.id}')"
            style="background:#2563EB;color:white;border:none;border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer;">
            編集
          </button>
          <button onclick="app.deleteStation('${station.id}')"
            style="background:#DC2626;color:white;border:none;border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer;">
            削除
          </button>
        </div>
      </div>
    `;
    return html;
  }

  // ─── 地点追加モード ───

  /**
   * 地図クリックで地点追加モードを有効化
   * @param {function} callback  (lat, lon) => void
   */
  function enableAddPointMode(callback) {
    if (!map) return;
    addPointMode = true;
    addPointCallback = callback;
    map.getContainer().style.cursor = 'crosshair';
    map.once('click', _onMapClick);
  }

  function disableAddPointMode() {
    addPointMode = false;
    addPointCallback = null;
    if (map) {
      map.getContainer().style.cursor = '';
      map.off('click', _onMapClick);
    }
  }

  function _onMapClick(e) {
    addPointMode = false;
    if (map) map.getContainer().style.cursor = '';
    if (addPointCallback) {
      addPointCallback(e.latlng.lat, e.latlng.lng);
      addPointCallback = null;
    }
  }

  // ─── ユーティリティ ───

  function _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * マーカーのポップアップ内容を更新（ファイル数変化時）
   * @param {string} stationId
   * @param {object} station
   * @param {number} fileCount
   */
  function refreshMarkerPopup(stationId, station, fileCount) {
    const marker = markers[stationId];
    if (!marker) return;
    marker.setPopupContent(_buildPopupContent(station, fileCount));
  }

  // ─── 公開 API ───
  return {
    initMap,
    openMapModal,
    closeMapModal,
    displayAllLocations,
    addMarker,
    updateMarker,
    removeMarker,
    refreshMarkerPopup,
    enableAddPointMode,
    disableAddPointMode,
  };
})();

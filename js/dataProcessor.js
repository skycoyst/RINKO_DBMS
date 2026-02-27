/**
 * dataProcessor.js
 * データ変換・仕分け・結合・水深区分別平均値計算
 */
'use strict';

const dataProcessor = (() => {

  /**
   * ファイル名を正規化（自動仕分けキーワード照合用）
   * - 先頭の数字・記号を除去
   * - アンダースコアをスペースに変換
   * - 小文字化
   * @param {string} fileName
   * @returns {string}
   */
  function normalizeFileName(fileName) {
    // 拡張子を除く
    let name = fileName.replace(/\.csv$/i, '');
    // 先頭の数字のみ除去（記号で止まる）
    name = name.replace(/^\d+/, '');
    // 先頭に残った記号を除去
    name = name.replace(/^[\s\-_#.()[\]]+/, '');
    // アンダースコア → スペース
    name = name.replace(/_/g, ' ');
    return name.toLowerCase();
  }

  /**
   * 自動仕分けエンジン
   * @param {object[]} cardList  観測データカード配列
   * @param {object[]} stations  地点マスタ配列
   * @returns {{ assigned: Map<string,string[]>, unclassified: string[] }}
   *   assigned: { stationId => [cardId, ...] }
   *   unclassified: [cardId, ...]
   */
  /**
   * キーワードと正規化済みファイル名のマッチング
   * - 半角英数のみのキーワード: スペース区切りワードの完全一致
   *   例) "eta" は "etanaka" にマッチしないが "eta" にはマッチする
   * - 日本語等を含むキーワード: 部分一致（従来通り）
   *   例) "放水路" は "放水路観測" にマッチする
   * @param {string} normalizedName 正規化済みファイル名（小文字）
   * @param {string} kw キーワード
   * @returns {boolean}
   */
  function _matchKeyword(normalizedName, kw) {
    const kwLower = kw.toLowerCase();
    if (/^[a-zA-Z0-9]+$/.test(kwLower)) {
      // 半角英数キーワード: スペース区切りのワード単位で完全一致
      return normalizedName.split(/\s+/).some(w => w === kwLower);
    }
    // 日本語等: 部分一致
    return normalizedName.includes(kwLower);
  }

  function autoAssignFiles(cardList, stations) {
    const assigned = new Map();   // stationId → cardId[]
    const unclassified = [];

    for (const card of cardList) {
      const normalizedName = normalizeFileName(card.fileName);
      const matches = [];

      for (const st of stations) {
        if (st._invalid) continue;
        const kws = st.keywords && st.keywords.length > 0
          ? st.keywords
          : [st.name.toLowerCase()];

        for (const kw of kws) {
          if (kw && _matchKeyword(normalizedName, kw)) {
            matches.push(st.id);
            break;
          }
        }
      }

      if (matches.length === 1) {
        // 一意マッチ
        const sid = matches[0];
        if (!assigned.has(sid)) assigned.set(sid, []);
        assigned.get(sid).push(card.id);
      } else {
        // 0件または競合 → 未分類
        unclassified.push(card.id);
      }
    }

    return { assigned, unclassified };
  }

  /**
   * 水深区分計算（切り捨て方式）
   * @param {number} depth
   * @returns {number}
   */
  function calculateDepthBin(depth) {
    return Math.floor(depth / 0.5) * 0.5;
  }

  /**
   * 2点間の距離を計算（メートル）
   * @param {number} lat1
   * @param {number} lon1
   * @param {number} lat2
   * @param {number} lon2
   * @returns {number|null}
   */
  function calculateDistance(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
    const R = 6371000; // 地球の半径 (m)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * B-1mフラグ付与
   * ファイルごとに最大水深区分を算出し、「最大水深区分 - 1.0m」の行のみ 1
   * 最大水深が 1.0m 未満のファイルは全行 0
   * @param {object[]} rows  { _depthBin: number, ... }
   * @param {string} fileId  ファイル識別子
   * @returns {object[]}  _b1mFlag が付与された rows
   */
  function applyB1mFlag(rows) {
    // ファイル内最大水深区分
    let maxBin = -Infinity;
    for (const row of rows) {
      if (row._depthBin !== null && row._depthBin > maxBin) {
        maxBin = row._depthBin;
      }
    }
    // 最大水深（元の深度値）を取得して 1m 未満チェック
    let maxDepthVal = -Infinity;
    for (const row of rows) {
      const d = parseFloat(row._rawDepth);
      if (!isNaN(d) && d > maxDepthVal) maxDepthVal = d;
    }

    const flagBin = (maxDepthVal >= 1.0) ? (maxBin - 1.0) : null;

    for (const row of rows) {
      if (flagBin === null) {
        row._b1mFlag = 0;
      } else {
        row._b1mFlag = (Math.abs(row._depthBin - flagBin) < 1e-9) ? 1 : 0;
      }
    }
    return rows;
  }

  /**
   * 全データ結合 - 形式A（生データ）
   * @param {object[]} assignments  [{ stationId, stationName, stationLat, stationLon, card }]
   * @param {object}   stateCards   cardId → card オブジェクト
   * @returns {{ headers: string[], rows: string[][] }}
   */
  function mergeAllData(assignments, stateCards) {
    // 固定ヘッダー
    const fixedHeaders = [
      '地点ID', '地点名', 'ファイル名',
      '地点緯度(マスタ)', '地点経度(マスタ)',
      '開始位置緯度', '開始位置経度',
      '水深区分', 'B-1mフラグ',
    ];

    // 全ファイルの元データ列をユニオン
    const unionCols = _buildUnionColumns(assignments, stateCards);
    const allHeaders = [...fixedHeaders, ...unionCols];

    const allRows = [];
    for (const { stationId, stationName, stationLat, stationLon, card } of assignments) {
      const parsed = card.parsed;
      if (!parsed || parsed.error) continue;

      const headers = parsed.headerRow;
      const depthIdx = headers.findIndex(h => h.includes('深度') || h.toLowerCase().includes('depth'));

      // 行ごとに処理
      const fileRows = [];
      for (const dataRow of parsed.dataRows) {
        const rowObj = {};
        headers.forEach((h, i) => { rowObj[h] = dataRow[i] !== undefined ? dataRow[i] : ''; });

        const rawDepth = depthIdx >= 0 ? parseFloat(dataRow[depthIdx]) : NaN;
        rowObj._rawDepth = isNaN(rawDepth) ? null : rawDepth;
        rowObj._depthBin = isNaN(rawDepth) ? null : calculateDepthBin(rawDepth);
        fileRows.push(rowObj);
      }

      applyB1mFlag(fileRows);

      for (const rowObj of fileRows) {
        const gps = card.parsed.gpsCoord;
        const fixedPart = [
          stationId || '',
          stationName || '',
          card.fileName,
          stationLat !== null && stationLat !== undefined ? stationLat : '',
          stationLon !== null && stationLon !== undefined ? stationLon : '',
          gps ? gps.lat : '',
          gps ? gps.lon : '',
          rowObj._depthBin !== null ? rowObj._depthBin : '',
          rowObj._b1mFlag,
        ];

        const dataPart = unionCols.map(col => {
          const v = rowObj[col];
          return v !== undefined && v !== null ? v : '';
        });

        allRows.push([...fixedPart, ...dataPart]);
      }
    }

    return { headers: allHeaders, rows: allRows };
  }

  /**
   * 形式B: 水深区分別平均値算出
   * @param {object[]} assignments
   * @param {object}   stateCards
   * @returns {{ headers: string[], rows: string[][] }}
   */
  function calculateDepthBinAverages(assignments, stateCards) {
    const fixedHeaders = [
      '地点ID', '地点名', 'ファイル名',
      '地点緯度(マスタ)', '地点経度(マスタ)',
      '開始位置緯度', '開始位置経度',
      '水深区分', 'B-1mフラグ',
    ];

    const unionCols = _buildUnionColumns(assignments, stateCards);
    const allHeaders = [...fixedHeaders, ...unionCols, 'データ件数'];

    // 数値列かどうか判定キャッシュ
    const numericCache = {};

    const allRows = [];

    for (const { stationId, stationName, stationLat, stationLon, card } of assignments) {
      const parsed = card.parsed;
      if (!parsed || parsed.error) continue;

      const headers = parsed.headerRow;
      const depthIdx = headers.findIndex(h => h.includes('深度') || h.toLowerCase().includes('depth'));
      const dtIdx = headers.findIndex(h => h.includes('観測日時') || h.toLowerCase().includes('date'));

      // GPS 座標列インデックス検索（緯度経度含む列名）
      const gpsLatIdx = headers.findIndex(h => /緯度|lat/i.test(h));
      const gpsLonIdx = headers.findIndex(h => /経度|lon/i.test(h));

      // 行ごとのオブジェクト化 + 水深区分付与
      const fileRows = [];
      for (const dataRow of parsed.dataRows) {
        const rowObj = {};
        headers.forEach((h, i) => { rowObj[h] = dataRow[i] !== undefined ? dataRow[i] : ''; });
        const rawDepth = depthIdx >= 0 ? parseFloat(dataRow[depthIdx]) : NaN;
        rowObj._rawDepth = isNaN(rawDepth) ? null : rawDepth;
        rowObj._depthBin = isNaN(rawDepth) ? null : calculateDepthBin(rawDepth);
        fileRows.push(rowObj);
      }
      applyB1mFlag(fileRows);

      // 水深区分でグループ化
      const groups = new Map(); // binKey → rows[]
      for (const row of fileRows) {
        const key = row._depthBin !== null ? row._depthBin : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const gps = parsed.gpsCoord;

      for (const [binKey, groupRows] of groups) {
        const firstRow = groupRows[0];
        const dataCnt = groupRows.length;

        // B-1m フラグ: 論理 OR
        const b1m = groupRows.some(r => r._b1mFlag === 1) ? 1 : 0;

        const dataPart = unionCols.map(col => {
          const isDateLike = headers.indexOf(col) === dtIdx;
          const isGpsLike = headers.indexOf(col) === gpsLatIdx || headers.indexOf(col) === gpsLonIdx;

          if (isDateLike || isGpsLike) {
            // 先頭値
            return firstRow[col] !== undefined ? firstRow[col] : '';
          }

          // 数値列かチェック
          const isNum = _isNumericColumn(col, groupRows, numericCache);
          if (isNum) {
            // 数値平均（空白除外）
            const vals = groupRows
              .map(r => parseFloat(r[col]))
              .filter(v => !isNaN(v));
            if (vals.length === 0) return '';
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
            return String(Math.round(avg * 1e6) / 1e6);
          }
          // テキスト列: 先頭値
          return firstRow[col] !== undefined ? firstRow[col] : '';
        });

        const fixedPart = [
          stationId || '',
          stationName || '',
          card.fileName,
          stationLat !== null && stationLat !== undefined ? stationLat : '',
          stationLon !== null && stationLon !== undefined ? stationLon : '',
          gps ? gps.lat : '',
          gps ? gps.lon : '',
          binKey !== '' ? binKey : '',
          b1m,
        ];

        allRows.push([...fixedPart, ...dataPart, dataCnt]);
      }
    }

    return { headers: allHeaders, rows: allRows };
  }

  /**
   * 全ファイルの列をユニオン
   * 最初のファイルの列順を基準とし、他ファイル固有列は末尾追加
   */
  function _buildUnionColumns(assignments, stateCards) {
    const seen = new Set();
    const ordered = [];
    for (const { card } of assignments) {
      if (!card.parsed || card.parsed.error) continue;
      for (const h of card.parsed.headerRow) {
        if (!seen.has(h)) {
          seen.add(h);
          ordered.push(h);
        }
      }
    }
    return ordered;
  }

  /**
   * 列が数値かどうか判定（サンプル行でチェック）
   */
  function _isNumericColumn(col, rows, cache) {
    if (cache[col] !== undefined) return cache[col];
    let numCount = 0, totalCount = 0;
    for (const r of rows.slice(0, 20)) {
      const v = r[col];
      if (v !== undefined && v !== '') {
        totalCount++;
        if (!isNaN(parseFloat(v))) numCount++;
      }
    }
    const result = totalCount > 0 && numCount / totalCount >= 0.8;
    cache[col] = result;
    return result;
  }

  /**
   * CSV 文字列生成（BOM付きUTF-8）
   * @param {string[]} headers
   * @param {string[][]} rows
   * @returns {Blob}
   */
  function generateCSVBlob(headers, rows) {
    const escape = (v) => {
      const s = String(v === null || v === undefined ? '' : v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const lines = [
      headers.map(escape).join(','),
      ...rows.map(row => row.map(escape).join(',')),
    ];
    const text = lines.join('\r\n');
    // BOM付き UTF-8
    const bom = '\uFEFF';
    return new Blob([bom + text], { type: 'text/csv;charset=utf-8;' });
  }

  /**
   * 出力ファイル名生成
   * @param {'A'|'B'} format
   * @returns {string}
   */
  function generateOutputFileName(format) {
    const now = new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    if (format === 'A') return `結合_生データ_${ts}.csv`;
    return `結合_水深平均_${ts}.csv`;
  }

  // ─── 公開 API ───
  return {
    normalizeFileName,
    autoAssignFiles,
    calculateDepthBin,
    calculateDistance,
    applyB1mFlag,
    mergeAllData,
    calculateDepthBinAverages,
    generateCSVBlob,
    generateOutputFileName,
  };
})();

/**
 * fileHandler.js
 * ファイル読み込み・エンコード処理・CSVパース
 */
'use strict';

const fileHandler = (() => {

  /**
   * BOM / エンコーディング検出
   * @param {Uint8Array} bytes
   * @returns {string} 'UTF-8' | 'SJIS'
   */
  function detectEncoding(bytes) {
    // BOM チェック (UTF-8 BOM: EF BB BF)
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return 'UTF-8';
    }
    // encoding.js による自動判定
    const detected = Encoding.detect(bytes);
    if (detected === 'SJIS' || detected === 'UTF8' || detected === 'UNICODE') {
      return detected === 'UTF8' ? 'UTF-8' : 'SJIS';
    }
    // 判定できなければ Shift_JIS とみなす（観測データは常に SJIS）
    return 'SJIS';
  }

  /**
   * ArrayBuffer → 文字列変換
   * @param {ArrayBuffer} buffer
   * @param {string} encoding 'UTF-8' | 'SJIS'
   * @returns {string}
   */
  function decodeBuffer(buffer, encoding) {
    const bytes = new Uint8Array(buffer);
    if (encoding === 'UTF-8') {
      // BOM がある場合はスキップ
      const start = (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) ? 3 : 0;
      return new TextDecoder('utf-8').decode(bytes.slice(start));
    }
    // Shift_JIS → UTF-16 → 文字列
    const unicodeArray = Encoding.convert(bytes, { to: 'UNICODE', from: 'SJIS' });
    return Encoding.codeToString(unicodeArray);
  }

  /**
   * File を読み込み、エンコード判定し文字列を返す
   * @param {File} file
   * @param {string|null} forceEncoding 強制エンコード ('SJIS'|'UTF-8'|null=自動)
   * @returns {Promise<string>}
   */
  function readFile(file, forceEncoding = null) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target.result;
        const bytes = new Uint8Array(buffer);
        const enc = forceEncoding || detectEncoding(bytes);
        try {
          const text = decodeBuffer(buffer, enc);
          resolve(text);
        } catch (err) {
          reject(new Error(`デコードエラー: ${file.name} (${enc})`));
        }
      };
      reader.onerror = () => reject(new Error(`ファイル読み込みエラー: ${file.name}`));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * CSV テキストを行配列に分割（CRLF / LF 対応）
   * @param {string} text
   * @returns {string[]}
   */
  function splitLines(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  /**
   * CSV 1行をフィールド配列に分割（ダブルクォート対応）
   * @param {string} line
   * @returns {string[]}
   */
  function parseCsvLine(line) {
    const result = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuote = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === ',') { result.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
    }
    result.push(cur.trim());
    return result;
  }

  /**
   * 地点マスタ CSV をパースし、地点オブジェクト配列を返す
   * @param {string} text CSV テキスト
   * @returns {{ stations: object[], errors: string[] }}
   */
  function parseMasterCSV(text) {
    const lines = splitLines(text).filter(l => l.trim() !== '');
    if (lines.length < 2) {
      return { stations: [], errors: ['ヘッダー行が見つかりません'] };
    }

    const headers = parseCsvLine(lines[0]);
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h.trim()] = i; });

    const requiredCols = ['地点名', '地点ID', '調査区分'];
    const missingCols = requiredCols.filter(c => colIdx[c] === undefined);
    if (missingCols.length > 0) {
      return { stations: [], errors: [`必須カラムが不足: ${missingCols.join(', ')}`] };
    }

    const stations = [];
    const errors = [];
    const idSet = {};

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const get = (name) => (colIdx[name] !== undefined ? (fields[colIdx[name]] || '').trim() : '');

      const name = get('地点名');
      const nameRead = get('地点名_読み');
      const stationId = get('地点ID');
      const category = get('調査区分') || '未設定';
      const lat = parseFloat(get('緯度')) || null;
      const lon = parseFloat(get('経度')) || null;
      const note = get('備考');
      const keywords = get('ファイル名キーワード');
      const template = get('テンプレート');

      if (!name || !stationId) continue;

      // 地点ID 重複チェック
      if (idSet[stationId] !== undefined) {
        errors.push(`地点ID重複: ${stationId}（行${idSet[stationId] + 2} と 行${i + 1}）`);
        // 両方を無効化
        if (stations[idSet[stationId]]) stations[idSet[stationId]]._invalid = true;
        continue;
      }
      idSet[stationId] = stations.length;

      stations.push({
        id: stationId,
        name,
        name_read: nameRead,
        category,
        lat,
        lon,
        note,
        keywords: keywords ? keywords.split('|').map(k => k.trim()).filter(Boolean) : [],
        templates: template ? template.split('/').map(t => t.trim()).filter(Boolean) : [],
        _invalid: false,
      });
    }

    return { stations, errors };
  }

  /**
   * 観測データ CSV をパースし、カード情報 + 行データを返す
   * @param {string} text  Shift_JIS デコード済みテキスト
   * @param {string} fileName
   * @returns {object} カード情報
   */
  function parseObservationCSV(text, fileName) {
    const lines = splitLines(text);
    const result = {
      fileName,
      headerRowIndex: -1,
      headerRow: [],
      dataRows: [],
      metadata: {
        sampleCnt: null,
        startPosition: null,   // { lat, lon } 十進数
        endPosition: null,
      },
      firstDateTime: null,
      maxDepth: null,
      gpsCoord: null,
      warningFallback: false,   // true = 69行目固定フォールバック
      error: null,
    };

    // ─── メタデータ抽出 ───
    for (let i = 0; i < Math.min(lines.length, 200); i++) {
      const line = lines[i];
      // SampleCnt=
      const scMatch = line.match(/^SampleCnt=(\d+)/i);
      if (scMatch) result.metadata.sampleCnt = parseInt(scMatch[1], 10);

      // StartPosition=3419.09130,N,13226.93637,E
      const spMatch = line.match(/^StartPosition=(.+)/i);
      if (spMatch) {
        result.metadata.startPosition = convertGPSCoordinate(spMatch[1]);
      }
    }

    // ─── ヘッダー行の動的検出 ───
    let headerIdx = -1;

    // 優先1: [Item] の直後の行
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '[Item]') {
        headerIdx = i + 1;
        break;
      }
    }

    // フォールバック: 先頭150行から「観測日時」または「Date」を含む行
    if (headerIdx === -1) {
      for (let i = 0; i < Math.min(lines.length, 150); i++) {
        if (lines[i].includes('観測日時') || lines[i].includes('Date')) {
          headerIdx = i;
          break;
        }
      }
    }

    // 最終手段: 69行目固定（0-indexed: 68）
    if (headerIdx === -1) {
      headerIdx = 68;
      result.warningFallback = true;
    }

    if (headerIdx >= lines.length) {
      result.error = 'ヘッダー行が見つかりません';
      return result;
    }

    result.headerRowIndex = headerIdx;
    result.headerRow = parseCsvLine(lines[headerIdx]);

    // ─── データ行収集 ───
    const dataRows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      dataRows.push(parseCsvLine(lines[i]));
    }

    if (dataRows.length === 0) {
      result.error = 'データ行が0件です';
      return result;
    }

    result.dataRows = dataRows;

    // ─── 派生情報の抽出 ───
    const headers = result.headerRow;
    const dtIdx = headers.findIndex(h => h.includes('観測日時') || h.toLowerCase().includes('date'));
    const depthIdx = headers.findIndex(h => h.includes('深度') || h.includes('depth'));

    // 観測日時（先頭行）
    if (dtIdx >= 0 && dataRows[0][dtIdx]) {
      result.firstDateTime = dataRows[0][dtIdx];
    }

    // 最大水深
    if (depthIdx >= 0) {
      let maxD = -Infinity;
      for (const row of dataRows) {
        const v = parseFloat(row[depthIdx]);
        if (!isNaN(v) && v > maxD) maxD = v;
      }
      if (maxD > -Infinity) result.maxDepth = maxD;
    }

    // GPS 座標
    if (result.metadata.startPosition) {
      result.gpsCoord = result.metadata.startPosition;
    }

    return result;
  }

  /**
   * GPS 座標文字列をパース（DDMM.MMMM,N,DDDMM.MMMM,E 形式）
   * @param {string} posStr
   * @returns {{ lat: number, lon: number } | null}
   */
  function convertGPSCoordinate(posStr) {
    if (!posStr) return null;
    const parts = posStr.trim().split(',');
    if (parts.length < 4) return null;

    const [latValStr, latDir, lonValStr, lonDir] = parts.map(p => p.trim());
    const latVal = parseFloat(latValStr);
    const lonVal = parseFloat(lonValStr);
    if (isNaN(latVal) || isNaN(lonVal)) return null;

    const latDeg = Math.floor(latVal / 100);
    const latMin = latVal % 100;
    let lat = latDeg + latMin / 60;
    if (latDir === 'S') lat = -lat;

    const lonDeg = Math.floor(lonVal / 100);
    const lonMin = lonVal % 100;
    let lon = lonDeg + lonMin / 60;
    if (lonDir === 'W') lon = -lon;

    return { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7 };
  }

  // ─── 公開 API ───
  return {
    readFile,
    detectEncoding,
    parseMasterCSV,
    parseObservationCSV,
    convertGPSCoordinate,
    parseCsvLine,
    splitLines,
  };
})();

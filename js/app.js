/* =====================================================================
 * 台東縣建築火災隱患風險地圖儀表板 – 主程式
 * ---------------------------------------------------------------------
 * 流程：
 *   1. 讀取 CSV：
 *      - 全縣宏觀：taitung_age.csv（屋齡）、taitung_structure.csv（構造）
 *      - 臺東市微觀：taitung_buildings.csv（指標建築消防與環境特徵）
 *      （支援 fetch 與 file:// 模式下的內嵌備份）
 *   2. 宏觀：依期別+鄉鎮整合計算各鄉鎮綜合火災風險指數
 *   3. 微觀：依建築屬性（構造耐火、樓層、使用類型、住警器、消防栓距）
 *      動態計算每棟建築物的火災危險等級（高/中/低），並動態繪製 Markers
 *   4. GIS 互動：
 *      - 單擊鄉鎮：選取並更新鄉鎮結構與屋齡資訊
 *      - 雙擊鄉鎮（臺東市）：下鑽進入微觀建築風險圖層，浮現「返回全縣概況」按鈕
 * ===================================================================== */
(() => {
  'use strict';

  /* ---------------- 1. 基本設定 ---------------- */
  const CONFIG = {
    csv: {
      age: 'data/taitung_age.csv',
      structure: 'data/taitung_structure.csv',
      buildings: 'data/taitung_buildings.csv'
    },
    geojson: 'data/taitung_towns.geojson',
    mapCenter: [22.75, 121.15],
    countyPrefixes: ['台東縣', '臺東縣']
  };

  /* 屋齡分組欄位 → 老舊風險係數 (0~1) */
  const AGE_BANDS = [
    { key: '1（含）年以下(宅)',   label: '≤1年',    w: 0.00, group: '10年以下' },
    { key: '1~5（含）年(宅)',     label: '1-5年',   w: 0.05, group: '10年以下' },
    { key: '5~10（含）年(宅)',    label: '5-10年',  w: 0.10, group: '10年以下' },
    { key: '10~15（含）年(宅)',   label: '10-15年', w: 0.20, group: '10-20年' },
    { key: '15~20（含）年(宅)',   label: '15-20年', w: 0.30, group: '10-20年' },
    { key: '20~25（含）年(宅)',   label: '20-25年', w: 0.45, group: '20-30年' },
    { key: '25~30（含）年(宅)',   label: '25-30年', w: 0.60, group: '20-30年' },
    { key: '30~40（含）年(宅)',   label: '30-40年', w: 0.75, group: '30-40年' },
    { key: '40~50（含）年(宅)',   label: '40-50年', w: 0.90, group: '40-50年' },
    { key: '50年以上(宅)',        label: '50年以上', w: 1.00, group: '50年以上' }
  ];
  const AGE_GROUPS = ['10年以下', '10-20年', '20-30年', '30-40年', '40-50年', '50年以上'];
  const AGE_GROUP_COLORS = ['#a5d6a7', '#c5e1a5', '#fff59d', '#ffcc80', '#ff8a65', '#c62828'];

  /* 構造欄位 → 易燃 / 低耐火風險係數 (0~1) */
  const STRUCT_TYPES = [
    { key: '磚、木、石造(宅)',     label: '磚木石造',   w: 1.00, color: '#8d6e63' },
    { key: '其他(宅)',             label: '其他(含鐵皮)', w: 0.80, color: '#b0bec5' },
    { key: '加強磚造(宅)',         label: '加強磚造',   w: 0.60, color: '#ffb74d' },
    { key: '鋼筋混凝土(宅)',       label: '鋼筋混凝土', w: 0.25, color: '#64b5f6' },
    { key: '鋼骨混凝土(宅)',       label: '鋼骨混凝土', w: 0.10, color: '#5c6bc0' },
    { key: '鋼骨鋼筋混凝土(宅)',   label: '鋼骨鋼筋混凝土', w: 0.10, color: '#283593' }
  ];

  const RISK_LEVELS = [
    { name: '低風險',   color: '#43a047' },
    { name: '中風險',   color: '#fdd835' },
    { name: '中高風險', color: '#fb8c00' },
    { name: '高風險',   color: '#e53935' }
  ];

  /* ---------------- 2. 狀態管理 ---------------- */
  const state = {
    periods: [],
    byPeriod: {},         // period -> { town -> merged record }
    period: null,
    wAge: 0.5,
    classMode: 'quantile',
    breaks: [],
    results: [],          // 當期計算結果（依風險排序）
    selected: null,       // 選取的鄉鎮名稱 (null = 全縣)
    geo: null,
    map: null,
    geoLayer: null,
    layerByTown: {},
    charts: {},
    dataSource: '',
    viewMode: 'macro',    // 'macro' (全縣宏觀) | 'micro' (臺東市微觀)
    buildings: [],        // 讀取自 data/taitung_buildings.csv 的建築物資料
    microLayer: null,     // Leaflet layerGroup
    microMarkers: {},
    selectedBuildingId: null
  };

  /* ---------------- 3. 工具函式 ---------------- */
  const $ = (id) => document.getElementById(id);
  const toNum = (v) => {
    if (v === null || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  };
  const fmt = (n, d = 0) => Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;

  /** 「台東縣台東市」→「臺東市」，統一使用「臺」以對應圖資；縣總計回傳 '__COUNTY__' */
  const normTown = (raw) => {
    let s = String(raw || '').trim();
    CONFIG.countyPrefixes.forEach((p) => { if (s.startsWith(p)) s = s.slice(p.length); });
    s = s.replace(/台/g, '臺');
    return s === '' ? '__COUNTY__' : s;
  };
  const displayName = (t) => (t === '__COUNTY__' ? '台東縣全縣' : t);
  const periodLabel = (p) => {
    const m = /^(\d+)Q(\d)$/.exec(p);
    return m ? `民國 ${m[1]} 年第 ${m[2]} 季` : p;
  };

  /* ---------------- 4. 讀取 CSV ---------------- */
  function parseCsvText(text) {
    const res = Papa.parse(text.replace(/^\uFEFF/, ''), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim()
    });
    if (res.errors.length) console.warn('CSV 解析警告', res.errors);
    return res.data;
  }

  async function fetchCsv(url) {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    if (head[0] === 0x50 && head[1] === 0x4b) {
      throw new Error(`${url} 實際上是 Excel (xlsx) 檔，請另存為 CSV (UTF-8)`);
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  async function loadCsvs() {
    // 若在 file:// 模式下且已載入內嵌備援資料，直接使用內嵌資料避免瀏覽器 CORS 阻擋
    if (window.location.protocol === 'file:' && window.EMBEDDED_CSV) {
      state.dataSource = 'embedded';
      return {
        age: parseCsvText(window.EMBEDDED_CSV.age),
        structure: parseCsvText(window.EMBEDDED_CSV.structure),
        buildings: parseCsvText(window.EMBEDDED_CSV.buildings || '')
      };
    }

    try {
      const [ageText, structText, bldText] = await Promise.all([
        fetchCsv(CONFIG.csv.age),
        fetchCsv(CONFIG.csv.structure),
        fetchCsv(CONFIG.csv.buildings)
      ]);
      state.dataSource = 'fetch';
      return {
        age: parseCsvText(ageText),
        structure: parseCsvText(structText),
        buildings: parseCsvText(bldText)
      };
    } catch (err) {
      // 網路請求失敗時，改用 data/csv_embedded.js 中的備援資料
      if (window.EMBEDDED_CSV) {
        console.info('fetch 失敗，改用內嵌 CSV 備援：', err.message);
        state.dataSource = 'embedded';
        return {
          age: parseCsvText(window.EMBEDDED_CSV.age),
          structure: parseCsvText(window.EMBEDDED_CSV.structure),
          buildings: parseCsvText(window.EMBEDDED_CSV.buildings || '')
        };
      }
      throw err;
    }
  }

  async function loadGeo() {
    // 若在 file:// 模式下且已載入內嵌 GeoJSON，直接使用
    if (window.location.protocol === 'file:' && window.TAITUNG_GEOJSON) {
      return window.TAITUNG_GEOJSON;
    }

    try {
      const resp = await fetch(CONFIG.geojson);
      if (!resp.ok) throw new Error(resp.status);
      return await resp.json();
    } catch (e) {
      if (window.TAITUNG_GEOJSON) return window.TAITUNG_GEOJSON;
      throw new Error('無法載入台東縣行政區界線 GeoJSON：' + e.message);
    }
  }

  /* ---------------- 5. 全縣宏觀資料整合 ---------------- */
  function mergeData(ageRows, structRows) {
    const byPeriod = {};
    const ensure = (p, t) => {
      byPeriod[p] = byPeriod[p] || {};
      byPeriod[p][t] = byPeriod[p][t] || { town: t, period: p };
      return byPeriod[p][t];
    };

    ageRows.forEach((r) => {
      const p = String(r['資料期別'] || '').trim();
      if (!p) return;
      const rec = ensure(p, normTown(r['縣市/地區']));
      rec.ageTotal = toNum(r['房屋稅籍住宅類數量(宅)']);
      rec.avgAge = toNum(r['住宅平均屋齡(歲)']);
      rec.ageBands = AGE_BANDS.map((b) => toNum(r[b.key]));
    });

    structRows.forEach((r) => {
      const p = String(r['資料期別'] || '').trim();
      if (!p) return;
      const rec = ensure(p, normTown(r['縣市/地區']));
      rec.structTotal = toNum(r['房屋稅籍住宅類數量(宅)']);
      rec.structs = STRUCT_TYPES.map((s) => toNum(r[s.key]));
    });

    // 只保留兩份資料都有的紀錄
    Object.keys(byPeriod).forEach((p) => {
      Object.keys(byPeriod[p]).forEach((t) => {
        const r = byPeriod[p][t];
        if (!r.ageBands || !r.structs) {
          console.warn(`資料不完整，略過：${p} ${t}`);
          delete byPeriod[p][t];
        }
      });
    });
    return byPeriod;
  }

  /* ---------------- 6. 微觀建築資料處理與動態危險度計算 ---------------- */
  /**
   * 依據 CSV 中的 structure、floors、usage_type、smoke_detector、fire_hydrant_dist_m
   * 計算該建築物的微觀火災危險等級（高/中/低）與具體改善建議
   */
  function calculateBuildingRisk(b) {
    // 1. structure 結構耐火性權重 (30%)
    let structScore = 20;
    const s = String(b.structure || '');
    if (s.includes('木') || s.includes('鐵皮') || s.includes('茅') || s.includes('草')) {
      structScore = 95;
    } else if (s.includes('加強磚造')) {
      structScore = 75;
    } else if (s.includes('輕鋼') || s.includes('鋼構')) {
      structScore = 55;
    } else if (s.includes('SRC') || s.includes('鋼骨鋼筋')) {
      structScore = 15;
    } else if (s.includes('RC') || s.includes('鋼筋混凝土')) {
      structScore = 25;
    } else {
      structScore = 50;
    }

    // 2. floors 樓層高度垂直疏散難度 (20%)
    const fl = parseInt(b.floors, 10) || 1;
    let floorScore = 20;
    if (fl >= 6) floorScore = 85;
    else if (fl >= 4) floorScore = 70;
    else if (fl === 3) floorScore = 50;
    else if (fl === 2) floorScore = 30;
    else floorScore = 15;

    // 3. usage_type 人流與火災載荷 (25%)
    const ut = String(b.usage_type || '');
    let usageScore = 25;
    if (ut.includes('住商') || ut.includes('餐飲') || ut.includes('市場') || ut.includes('攤商')) {
      usageScore = 95;
    } else if (ut.includes('影城') || ut.includes('商業複合') || ut.includes('商場')) {
      usageScore = 80;
    } else if (ut.includes('觀光') || ut.includes('交通') || ut.includes('轉運')) {
      usageScore = 50;
    } else if (ut.includes('文教') || ut.includes('學校')) {
      usageScore = 30;
    } else if (ut.includes('休閒') || ut.includes('綠地') || ut.includes('公園')) {
      usageScore = 15;
    } else {
      usageScore = 40;
    }

    // 4. smoke_detector 住警器狀況 (15%)
    const sd = String(b.smoke_detector || '').trim();
    const hasSmokeDetector = (sd === '是' || sd === '有' || sd.toLowerCase() === 'yes' || sd === 'true');
    const detectorScore = hasSmokeDetector ? 10 : 95;

    // 5. fire_hydrant_dist_m 消防栓水源距離 (10%)
    const dist = parseFloat(b.fire_hydrant_dist_m) || 30;
    let hydrantScore = 20;
    if (dist > 80) hydrantScore = 90;
    else if (dist > 50) hydrantScore = 65;
    else if (dist > 30) hydrantScore = 40;
    else hydrantScore = 15;

    // 綜合微觀危險分數計算 (0~100)
    let score = Math.round(
      structScore * 0.30 +
      floorScore * 0.20 +
      usageScore * 0.25 +
      detectorScore * 0.15 +
      hydrantScore * 0.10
    );

    // 未安裝住警器視為極重大安全隱患，最低拉升至高風險門檻
    if (!hasSmokeDetector && score < 70) {
      score = Math.max(score, 72);
    }

    // 危險等級劃分
    let level = '低風險';
    let levelClass = 'low';
    let color = '#43a047'; // 綠色
    let badgeClass = 'lv0';

    if (score >= 68 || !hasSmokeDetector) {
      level = '高風險';
      levelClass = 'high';
      color = '#e53935'; // 紅色
      badgeClass = 'lv3';
    } else if (score >= 42) {
      level = '中風險';
      levelClass = 'med';
      color = '#fb8c00'; // 橘色
      badgeClass = 'lv2';
    } else {
      level = '低風險';
      levelClass = 'low';
      color = '#43a047'; // 綠色
      badgeClass = 'lv0';
    }

    // 動態具體改善建議 (綜合 CSV 現況與屬性特徵)
    const adviceList = [];
    if (!hasSmokeDetector) {
      adviceList.push('【極高急迫性】此處尚未安裝住警器，強烈建議專案列管補助全面安裝連動型住宅用火災警報器，以確保早期警報與爭取避難時間。');
    }
    if (structScore >= 65) {
      adviceList.push('【結構與電路】耐火性較低（加強磚造/鐵皮），建議專案輔導老舊電線全面重拉汰換，加裝漏電斷路器。');
    }
    if (usageScore >= 75) {
      adviceList.push('【逃生動線管理】屬高人流/高火載場所，落實防火鐵捲門常時通暢，安全梯間嚴禁堆積雜物，每半年實施自衛消防編組演練。');
    }
    if (dist > 50) {
      adviceList.push(`【水源防護強化】鄰近消防栓距 ${dist}m 較遠，建議增設窄巷專用機巡滅火器或加裝移動式小型消防水箱。`);
    }
    if (b.notes && b.notes.trim()) {
      adviceList.push(`【現地備註】${b.notes.trim()}`);
    }

    return {
      score,
      level,
      levelClass,
      color,
      badgeClass,
      hasSmokeDetector,
      dist,
      adviceList
    };
  }

  function getBuildingIcon(usage) {
    const u = String(usage || '');
    if (u.includes('文教') || u.includes('學')) return 'bi-mortarboard-fill';
    if (u.includes('影城') || u.includes('商場') || u.includes('複合')) return 'bi-film';
    if (u.includes('市場') || u.includes('攤商') || u.includes('住商')) return 'bi-exclamation-triangle-fill';
    if (u.includes('交通') || u.includes('觀光') || u.includes('轉運')) return 'bi-music-note-beamed';
    if (u.includes('公園') || u.includes('綠地') || u.includes('休閒')) return 'bi-tree-fill';
    return 'bi-building-fill';
  }

  function processBuildings(rawRows) {
    if (!Array.isArray(rawRows)) return [];
    return rawRows
      .filter((r) => r.name && r.lat && r.lng)
      .map((r, idx) => {
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lng);
        const calc = calculateBuildingRisk(r);
        const icon = getBuildingIcon(r.usage_type);
        return {
          id: r.id || `TT-${String(idx + 1).padStart(3, '0')}`,
          name: String(r.name).trim(),
          address: String(r.address || '').trim(),
          lat,
          lng,
          coords: [lat, lng],
          structure: String(r.structure || '').trim(),
          floors: String(r.floors || '').trim(),
          age: r.age ? String(r.age).trim() : '-',
          usage_type: String(r.usage_type || '').trim(),
          smoke_detector: String(r.smoke_detector || '').trim(),
          fire_hydrant_dist_m: parseFloat(r.fire_hydrant_dist_m) || 0,
          fire_extinguisher: String(r.fire_extinguisher || '').trim(),
          notes: String(r.notes || '').trim(),
          icon,
          calc
        };
      });
  }

  /* ---------------- 7. 宏觀風險指數計算 ---------------- */
  function computeRecord(r, wAge) {
    const ageSum = r.ageBands.reduce((a, b) => a + b, 0) || 1;
    const structSum = r.structs.reduce((a, b) => a + b, 0) || 1;

    const ageShares = r.ageBands.map((v) => v / ageSum);
    const structShares = r.structs.map((v) => v / structSum);

    // 屋齡老舊分數：Σ(各屋齡組比例 × 老舊係數) × 100
    const ageScore = ageShares.reduce((a, s, i) => a + s * AGE_BANDS[i].w, 0) * 100;
    // 結構風險分數：Σ(各構造比例 × 易燃係數) × 100
    const structScore = structShares.reduce((a, s, i) => a + s * STRUCT_TYPES[i].w, 0) * 100;
    // 綜合火災風險指數
    const risk = wAge * ageScore + (1 - wAge) * structScore;

    const ageGroupShares = AGE_GROUPS.map((g) =>
      ageShares.reduce((a, s, i) => a + (AGE_BANDS[i].group === g ? s : 0), 0)
    );

    return {
      ...r,
      total: r.ageTotal || r.structTotal,
      ageShares,
      structShares,
      ageGroupShares,
      over30: ageShares.slice(7).reduce((a, b) => a + b, 0),
      brickWood: structShares[0],
      reinforcedBrick: structShares[2],
      rcSteel: structShares[3] + structShares[4] + structShares[5],
      ageScore,
      structScore,
      risk
    };
  }

  function computeBreaks(values, mode) {
    const sorted = [...values].sort((a, b) => a - b);
    if (mode === 'equal') {
      const min = sorted[0], max = sorted[sorted.length - 1], step = (max - min) / 4;
      return [min + step, min + 2 * step, min + 3 * step];
    }
    const q = (p) => {
      const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };
    return [q(0.25), q(0.5), q(0.75)];
  }

  const levelOf = (v) => {
    const b = state.breaks;
    return v > b[2] ? 3 : v > b[1] ? 2 : v > b[0] ? 1 : 0;
  };

  function recalc() {
    const recs = state.byPeriod[state.period] || {};
    const towns = Object.values(recs)
      .filter((r) => r.town !== '__COUNTY__')
      .map((r) => computeRecord(r, state.wAge));
    state.breaks = computeBreaks(towns.map((t) => t.risk), state.classMode);
    towns.forEach((t) => { t.level = levelOf(t.risk); });
    towns.sort((a, b) => b.risk - a.risk);
    towns.forEach((t, i) => { t.rank = i + 1; });
    state.results = towns;
    state.county = recs.__COUNTY__ ? computeRecord(recs.__COUNTY__, state.wAge) : null;
  }
  const resultOf = (town) => state.results.find((r) => r.town === town);

  /* ---------------- 8. 地圖與 GIS 下鑽 ---------------- */
  function initMap() {
    const small = window.innerWidth < 576;
    const map = L.map('map', {
      zoomSnap: 0.25,
      scrollWheelZoom: true,
      doubleClickZoom: false // 停用地圖原生的雙擊放大，避免與鄉鎮雙擊下鑽衝突
    }).setView(CONFIG.mapCenter, small ? 8.25 : 9);
    state.map = map;

    // Esri 淺灰底圖：不需 API Key，相容 file:// 模式
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri ｜ 界線：內政部國土測繪中心',
      maxZoom: 16
    }).addTo(map);

    // 鄉鎮行政區界線圖層
    state.geoLayer = L.geoJSON(state.geo, {
      style: featureStyle,
      onEachFeature: (feature, layer) => {
        const town = normTown(feature.properties.TOWNNAME);
        state.layerByTown[town] = layer;
        layer.bindTooltip(town, { permanent: true, direction: 'center', className: 'town-label' });
        layer.bindPopup(() => popupHtml(town), { maxWidth: 300 });

        let clickTimer = null;

        layer.on({
          mouseover: (e) => {
            if (state.viewMode === 'micro') return;
            e.target.setStyle({ weight: 3, color: '#263238', fillOpacity: 0.85 });
            e.target.bringToFront();
            infoCtl.update(town);
          },
          mouseout: (e) => {
            if (state.viewMode === 'micro') return;
            state.geoLayer.resetStyle(e.target);
            highlightSelected();
            infoCtl.update();
          },
          click: (e) => {
            if (state.viewMode === 'micro') return;
            L.DomEvent.stopPropagation(e);

            // 單擊延遲 250ms 防衝突：若在 250ms 內觸發 dblclick 則取消單擊
            if (clickTimer) {
              clearTimeout(clickTimer);
              clickTimer = null;
            }
            clickTimer = setTimeout(() => {
              selectTown(town, false);
              clickTimer = null;
            }, 250);
          },
          dblclick: (e) => {
            L.DomEvent.stopPropagation(e);
            if (clickTimer) {
              clearTimeout(clickTimer);
              clickTimer = null;
            }

            // 雙擊下鑽互動：若該鄉鎮有微觀資料（目前為臺東市）
            if (town === '臺東市') {
              enterMicroView();
            } else {
              showTownToast(`「${town}」目前尚無微觀建築資料。請雙擊「臺東市」下鑽微觀建築風險圖層！`);
              selectTown(town, false);
            }
          }
        });
      }
    }).addTo(map);

    // 建立臺東市區微觀建築 Markers 圖層 (讀自 taitung_buildings.csv)
    state.microLayer = L.layerGroup();
    state.buildings.forEach((b) => {
      const marker = createBuildingMarker(b);
      state.microMarkers[b.id] = marker;
      state.microLayer.addLayer(marker);
    });

    initMicroBuildingsUI();

    // 地圖右上方資訊框
    const infoCtl = L.control({ position: 'topright' });
    infoCtl.onAdd = function () { this._div = L.DomUtil.create('div', 'map-info'); this.update(); return this._div; };
    infoCtl.update = function (town) {
      if (state.viewMode === 'micro') {
        this._div.innerHTML = '<span class="text-danger fw-bold"><i class="bi bi-buildings-fill"></i> 臺東市微觀圖層</span><br><span class="small text-muted">點擊建築標記查看細部指標</span>';
        return;
      }
      const r = town && resultOf(town);
      this._div.innerHTML = r
        ? `<b>${r.town}</b><br>風險指數 <b>${r.risk.toFixed(1)}</b> <span class="risk-badge lv${r.level}">${RISK_LEVELS[r.level].name}</span><br>平均屋齡 ${r.avgAge.toFixed(1)} 歲`
        : '<span class="text-muted">將滑鼠移至鄉鎮上<br>單擊查看概況 ｜ 雙擊臺東市下鑽</span>';
    };
    infoCtl.addTo(map);
    state.infoCtl = infoCtl;

    // 圖例
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () { this._div = L.DomUtil.create('div', 'map-legend'); return this._div; };
    legend.addTo(map);
    state.legend = legend;

    // 縮放過小時隱藏標籤，避免手機上擠在一起
    const toggleLabels = () => {
      const show = map.getZoom() >= 8.5 && state.viewMode !== 'micro';
      document.querySelectorAll('.town-label').forEach((el) => { el.style.display = show ? '' : 'none'; });
    };
    map.on('zoomend', toggleLabels);
    toggleLabels();

    window.addEventListener('resize', () => map.invalidateSize());

    // 監聽地圖容器大小自適應延伸，杜絕任何白邊空白
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (state.map) state.map.invalidateSize();
      });
      const mapEl = document.getElementById('map');
      if (mapEl) ro.observe(mapEl);
      const cardBody = mapEl ? mapEl.parentElement : null;
      if (cardBody) ro.observe(cardBody);
    }
  }

  /* 建立微觀建築圖標 Pin (依計算之危險等級給予顏色與脈衝動畫) */
  function createBuildingMarker(b) {
    const iconHtml = `
      <div class="micro-pin pin-${b.calc.levelClass}" id="pin-${b.id}">
        <div class="pin-icon"><i class="${b.icon}"></i></div>
      </div>
    `;
    const icon = L.divIcon({
      className: 'micro-marker',
      html: iconHtml,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -36]
    });
    const marker = L.marker(b.coords, { icon });
    marker.bindPopup(() => buildingPopupHtml(b), { maxWidth: 320 });
    marker.on('click', () => {
      selectBuilding(b.id, false);
    });
    return marker;
  }

  /* 建築物 Popup 詳細視窗 */
  function buildingPopupHtml(b) {
    const sdBadge = b.calc.hasSmokeDetector
      ? '<span class="badge bg-success"><i class="bi bi-check-circle"></i> 已安裝 (是)</span>'
      : '<span class="badge bg-danger"><i class="bi bi-x-circle"></i> 未安裝 (急需加裝)</span>';
    const distBadge = b.calc.dist > 50
      ? `<span class="badge bg-warning text-dark">${b.calc.dist} m (偏遠)</span>`
      : `<span class="badge bg-info">${b.calc.dist} m</span>`;

    return `
      <div class="risk-popup">
        <div class="d-flex align-items-center justify-content-between mb-1">
          <h6 class="mb-0 fw-bold">${b.name}</h6>
          <span class="risk-badge ${b.calc.badgeClass}">${b.calc.level}</span>
        </div>
        <div class="text-muted small mb-2"><i class="bi bi-geo-alt"></i> ${b.address}</div>
        <table class="table table-sm small mb-2">
          <tr><td class="text-muted">使用類型</td><td class="fw-semibold">${b.usage_type}</td></tr>
          <tr><td class="text-muted">建築結構</td><td>${b.structure}（${b.floors}F / 屋齡${b.age}年）</td></tr>
          <tr><td class="text-muted">住警器狀態</td><td>${sdBadge}</td></tr>
          <tr><td class="text-muted">周邊消防栓距</td><td>${distBadge}</td></tr>
          <tr><td class="text-muted">滅火器狀態</td><td>${b.fire_extinguisher || '充足'}</td></tr>
          <tr><td class="text-muted">微觀火災危險評估</td><td><b class="${b.calc.levelClass === 'high' ? 'text-danger' : (b.calc.levelClass === 'med' ? 'text-warning-emphasis' : 'text-success')}">${b.calc.level} (${b.calc.score}分)</b></td></tr>
        </table>
        <div class="mt-2 pt-2 border-top d-flex justify-content-between align-items-center">
          <span class="small text-muted">臺東市微觀圖層</span>
          <button class="btn btn-sm btn-danger py-0 px-2" style="font-size: .75rem" onclick="window.viewBuildingAdvice('${b.id}')">
            <i class="bi bi-arrow-right-circle"></i> 查看改善建議
          </button>
        </div>
      </div>
    `;
  }

  /* 地圖樣式（微觀模式下隱藏其他鄉鎮填色，僅保留臺東市） */
  function featureStyle(feature) {
    const town = normTown(feature.properties.TOWNNAME);
    const r = resultOf(town);
    const isMicro = state.viewMode === 'micro';
    const isTaitungCity = town === '臺東市';

    if (isMicro) {
      return {
        fillColor: isTaitungCity ? '#fb8c00' : 'transparent',
        fillOpacity: isTaitungCity ? 0.20 : 0,
        color: isTaitungCity ? '#e53935' : '#cfd8dc',
        weight: isTaitungCity ? 2.5 : 0.8,
        dashArray: isTaitungCity ? '4, 4' : null,
        opacity: isTaitungCity ? 1 : 0.25
      };
    }

    return {
      fillColor: r ? RISK_LEVELS[r.level].color : '#cfd8dc',
      fillOpacity: 0.72,
      color: '#ffffff',
      weight: 1.5,
      opacity: 1
    };
  }

  function highlightSelected() {
    if (!state.selected) return;
    const layer = state.layerByTown[state.selected];
    if (layer) { layer.setStyle({ weight: 3.5, color: '#1f2a3c' }); layer.bringToFront(); }
  }

  function updateMap() {
    state.geoLayer.setStyle(featureStyle);
    highlightSelected();
    const b = state.breaks;
    const rng = [
      `≤ ${b[0].toFixed(1)}`, `${b[0].toFixed(1)} – ${b[1].toFixed(1)}`,
      `${b[1].toFixed(1)} – ${b[2].toFixed(1)}`, `> ${b[2].toFixed(1)}`
    ];
    state.legend._div.innerHTML = '<b>綜合火災風險指數</b><br>' +
      RISK_LEVELS.map((l, i) => `<span class="swatch" style="background:${l.color}"></span>${l.name}　${rng[i]}`).reverse().join('<br>') +
      `<div class="text-muted mt-1" style="font-size:.7rem">${state.classMode === 'quantile' ? '四分位數' : '等距'}分級｜${state.period}</div>`;
  }

  function popupHtml(town) {
    const r = resultOf(town);
    if (!r) return `<b>${town}</b><br>查無資料`;
    const bar = r.structShares.map((s, i) => `<span style="width:${(s * 100).toFixed(2)}%;background:${STRUCT_TYPES[i].color}" title="${STRUCT_TYPES[i].label} ${pct(s)}"></span>`).join('');
    const check = Math.abs(r.ageTotal - r.structTotal) > 0
      ? `<div class="text-warning small mt-1"><i class="bi bi-exclamation-circle"></i> 兩份資料住宅數差異 ${fmt(Math.abs(r.ageTotal - r.structTotal))} 宅</div>` : '';
    const dblHint = (town === '臺東市')
      ? `<div class="mt-2 pt-1 border-top text-center"><small class="text-danger fw-bold"><i class="bi bi-cursor-fill"></i> 雙擊此區可下鑽微觀圖層</small></div>`
      : '';

    return `
      <div class="risk-popup">
        <h6>${r.town} <span class="risk-badge lv${r.level}">${RISK_LEVELS[r.level].name}</span></h6>
        <div class="d-flex align-items-end gap-2 mb-2">
          <div class="score-big" style="color:${RISK_LEVELS[r.level].color === '#fdd835' ? '#c8a600' : RISK_LEVELS[r.level].color}">${r.risk.toFixed(1)}</div>
          <div class="small text-muted">綜合風險指數<br>全縣第 ${r.rank} / ${state.results.length} 名</div>
        </div>
        <table>
          <tr><td>住宅總數</td><td>${fmt(r.total)} 宅</td></tr>
          <tr><td>平均屋齡</td><td>${r.avgAge.toFixed(1)} 歲</td></tr>
          <tr><td>屋齡 30 年以上</td><td>${pct(r.over30)}</td></tr>
          <tr><td>磚、木、石造</td><td>${pct(r.brickWood)}</td></tr>
          <tr><td>加強磚造</td><td>${pct(r.reinforcedBrick)}</td></tr>
          <tr><td>鋼筋混凝土 / 鋼構</td><td>${pct(r.rcSteel)}</td></tr>
          <tr><td>其他 (含鐵皮)</td><td>${pct(r.structShares[1])}</td></tr>
        </table>
        <div class="bar">${bar}</div>
        <div class="small text-muted">屋齡分數 ${r.ageScore.toFixed(1)} ｜ 結構分數 ${r.structScore.toFixed(1)}</div>
        ${check}
        <div class="small text-muted mt-1">資料期別：${periodLabel(r.period)}</div>
        ${dblHint}
      </div>`;
  }

  /* 浮動提示 Toast */
  function showTownToast(msg) {
    let toast = $('mapToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mapToast';
      toast.className = 'map-toast';
      $('mapSection').querySelector('.card-body').appendChild(toast);
    }
    toast.innerHTML = `<i class="bi bi-info-circle-fill text-warning me-1"></i> ${msg}`;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  /* ---------------- 9. GIS 下鑽與返回全縣 ---------------- */
  /** 進入微觀下鑽視角（雙擊臺東市觸發） */
  function enterMicroView() {
    state.viewMode = 'micro';

    // 浮現地圖左上角「返回全縣概況」懸浮按鈕
    $('btnBackToCounty').classList.remove('d-none');
    $('drillHintBadge').classList.add('d-none');

    const hint = $('mapModeHint');
    if (hint) hint.innerHTML = '<span class="text-danger fw-bold"><i class="bi bi-buildings"></i> 臺東市微觀建築圖層</span>（點擊建築標記查看消防指標）';

    const bar = $('microLandmarkBar');
    if (bar) bar.classList.remove('d-none');

    // 載入微觀建築點位 Markers
    if (!state.map.hasLayer(state.microLayer)) {
      state.map.addLayer(state.microLayer);
    }

    // 自動隱藏其他鄉鎮填色，僅保留臺東市
    state.geoLayer.setStyle(featureStyle);

    // 平滑移動縮放至臺東市區涵蓋所有指標建築
    state.map.flyTo([22.756, 121.142], 14, { duration: 1.2 });

    // 自動切換右側「微觀建築」Tab
    const microTabBtn = $('tabMicroBtn');
    if (microTabBtn) {
      const bsTab = bootstrap.Tab.getOrCreateInstance(microTabBtn);
      bsTab.show();
    }

    // 預設選中高風險焦點建築（中央市場）以突顯展示效益
    const highRiskBuilding = state.buildings.find((b) => b.calc.levelClass === 'high') || state.buildings[0];
    if (highRiskBuilding) {
      setTimeout(() => {
        selectBuilding(highRiskBuilding.id, false);
      }, 500);
    }
  }

  /** 返回全縣概況視野（點擊懸浮按鈕或返回鈕） */
  function exitMicroView() {
    state.viewMode = 'macro';

    // 隱藏「返回全縣概況」懸浮按鈕
    $('btnBackToCounty').classList.add('d-none');
    $('drillHintBadge').classList.remove('d-none');

    const hint = $('mapModeHint');
    if (hint) hint.textContent = '單擊查看鄉鎮概況 ｜ 雙擊臺東市下鑽';

    const bar = $('microLandmarkBar');
    if (bar) bar.classList.add('d-none');

    if (state.map.hasLayer(state.microLayer)) {
      state.map.removeLayer(state.microLayer);
    }

    // 恢復全縣鄉鎮填色
    state.geoLayer.setStyle(featureStyle);

    // 飛回全縣視角
    state.map.flyTo(CONFIG.mapCenter, window.innerWidth < 576 ? 8.25 : 9, { duration: 1.2 });

    // 側邊欄切換回鄉鎮結構資訊
    $('townDetailBlock').classList.remove('d-none');
    $('landmarkDetailBlock').classList.add('d-none');
    $('btnBackToTown').classList.add('d-none');
    $('detailCardTitle').innerHTML = `<i class="bi bi-pie-chart-fill text-primary"></i> <span class="selected-name">${state.selected || '全縣'}</span> 結構組成`;
    if (state.selected) $('resetSel').classList.remove('d-none');

    // 切換回「風險排名」Tab
    const riskTabBtn = document.querySelector('button[data-bs-target="#tabRisk"]');
    if (riskTabBtn) {
      const bsTab = bootstrap.Tab.getOrCreateInstance(riskTabBtn);
      bsTab.show();
    }
  }

  /* ---------------- 10. 選取與聯動互動 ---------------- */
  function selectTown(town, flyTo) {
    if (town && !resultOf(town)) return;
    state.selected = town;
    state.geoLayer.setStyle(featureStyle);
    highlightSelected();
    updateCharts();
    updateTable();
    if (town && flyTo) {
      const layer = state.layerByTown[town];
      if (layer) {
        if (window.innerWidth < 992) $('mapSection').scrollIntoView({ behavior: 'smooth' });
        state.map.fitBounds(layer.getBounds(), { maxZoom: 11, padding: [20, 20] });
        layer.openPopup(layer.getBounds().getCenter());
      }
    }
  }

  /* 選取建築物 Marker（連動右側儀表板動態顯示 CSV 資訊與改善建議） */
  function selectBuilding(id, flyTo) {
    const b = state.buildings.find((item) => item.id === id);
    if (!b) return;
    state.selectedBuildingId = id;

    // 1. 快捷 Pills 啟用高亮
    document.querySelectorAll('.landmark-pill-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.bldid === id);
    });

    // 2. 清單項目高亮
    document.querySelectorAll('.micro-list-item').forEach((item) => {
      item.classList.toggle('border-danger', item.dataset.bldid === id && b.calc.levelClass === 'high');
      item.classList.toggle('border-primary', item.dataset.bldid === id && b.calc.levelClass !== 'high');
      item.classList.toggle('bg-light', item.dataset.bldid === id);
    });

    // 3. 地圖圖釘 active 高亮
    document.querySelectorAll('.micro-pin').forEach((pin) => pin.classList.remove('active'));
    const activePin = document.getElementById(`pin-${id}`);
    if (activePin) activePin.classList.add('active');

    // 4. 側邊欄聯動：切換到建築細部指標與改善建議
    $('townDetailBlock').classList.add('d-none');
    $('landmarkDetailBlock').classList.remove('d-none');
    $('btnBackToTown').classList.remove('d-none');
    $('resetSel').classList.add('d-none');
    $('detailCardTitle').innerHTML = `<i class="bi bi-building-check text-danger"></i> <span class="text-truncate">${b.name}</span>`;

    // 填入 CSV 屬性
    $('lmTitle').innerHTML = `<i class="${b.icon} me-1 text-primary"></i> ${b.name}`;
    $('lmAddress').innerHTML = `<i class="bi bi-geo-alt text-danger"></i> ${b.address}`;
    $('lmMeta').textContent = `${b.usage_type} ｜ ${b.structure} ｜ 樓層：${b.floors}F ｜ 屋齡：${b.age}年`;

    const riskBadge = $('lmRiskBadge');
    riskBadge.className = `risk-badge ${b.calc.badgeClass}`;
    riskBadge.textContent = `${b.calc.level} (${b.calc.score}分)`;

    // 住警器狀態
    $('lmDetectorText').textContent = b.calc.hasSmokeDetector ? '已安裝 (是)' : '未安裝 (否)';
    const detBar = $('lmDetectorBar');
    detBar.style.width = b.calc.hasSmokeDetector ? '100%' : '20%';
    detBar.className = `progress-bar ${b.calc.hasSmokeDetector ? 'bg-success' : 'bg-danger'}`;
    $('lmDetectorStatus').textContent = b.calc.hasSmokeDetector ? '防護健全' : '急需輔導加裝';
    $('lmDetectorStatus').className = `fw-semibold ${b.calc.hasSmokeDetector ? 'text-success' : 'text-danger'}`;

    // 消防栓距離
    $('lmHydrantText').textContent = `${b.fire_hydrant_dist_m} m`;
    const hydBar = $('lmHydrantBar');
    const hydPercent = Math.min(100, Math.max(15, 100 - (b.fire_hydrant_dist_m / 120) * 85));
    hydBar.style.width = `${hydPercent}%`;
    hydBar.className = `progress-bar ${b.fire_hydrant_dist_m <= 30 ? 'bg-info' : (b.fire_hydrant_dist_m <= 50 ? 'bg-primary' : 'bg-warning')}`;
    $('lmHydrantStatus').textContent = b.fire_hydrant_dist_m <= 30 ? '充足近鄰' : (b.fire_hydrant_dist_m <= 50 ? '中等' : '距離較遠');

    // 滅火器配置
    $('lmExtinguisherText').textContent = b.fire_extinguisher || '充足';

    // 防災具體改善建議
    const advBox = $('lmAdviceBox');
    advBox.className = `advice-box risk-${b.calc.levelClass}`;
    $('lmAdviceTitle').innerHTML = `<i class="bi bi-shield-exclamation text-danger fs-6"></i> <strong>防災與消防改善建議（${b.name}）</strong>`;
    $('lmAdviceContent').innerHTML = `<ul class="mb-0 ps-3 small">${b.calc.adviceList.map((a) => `<li class="mb-1">${a}</li>`).join('')}</ul>`;

    // 5. 地圖平滑定位與開啟 Popup
    if (flyTo) {
      if (window.innerWidth < 992) $('mapSection').scrollIntoView({ behavior: 'smooth' });
      state.map.flyTo(b.coords, 16, { duration: 0.8 });
      const marker = state.microMarkers[id];
      if (marker) {
        setTimeout(() => marker.openPopup(), 650);
      }
    }

    updateMicroChartHighlight();
  }

  window.viewBuildingAdvice = (id) => {
    selectBuilding(id, true);
  };

  /* ---------------- 11. 圖表系統 (Chart.js) ---------------- */
  Chart.defaults.font.family = '"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif';
  Chart.defaults.color = '#546e7a';

  const pctTick = { callback: (v) => `${v}%` };
  const pctTooltip = { callbacks: { label: (c) => `${c.dataset.label}：${c.parsed.x.toFixed(1)}%` } };

  function initCharts() {
    const onBarClick = (evt, els, chart) => {
      if (!els.length) return;
      selectTown(chart.data.labels[els[0].index], true);
    };

    state.charts.risk = new Chart($('riskChart'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: '綜合風險指數', data: [], backgroundColor: [], borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, onClick: onBarClick,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { afterLabel: (c) => { const r = state.results[c.dataIndex]; return `屋齡分數 ${r.ageScore.toFixed(1)}｜結構分數 ${r.structScore.toFixed(1)}\n等級：${RISK_LEVELS[r.level].name}`; } } }
        },
        scales: { x: { beginAtZero: true, title: { display: true, text: '指數 (0–100)' } } }
      }
    });

    state.charts.struct = new Chart($('structChart'), {
      type: 'bar',
      data: { labels: [], datasets: STRUCT_TYPES.map((s) => ({ label: s.label, data: [], backgroundColor: s.color })) },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, onClick: onBarClick,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: pctTooltip },
        scales: { x: { stacked: true, max: 100, ticks: pctTick }, y: { stacked: true } }
      }
    });

    state.charts.age = new Chart($('ageChart'), {
      type: 'bar',
      data: { labels: [], datasets: AGE_GROUPS.map((g, i) => ({ label: g, data: [], backgroundColor: AGE_GROUP_COLORS[i] })) },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, onClick: onBarClick,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: pctTooltip },
        scales: { x: { stacked: true, max: 100, ticks: pctTick }, y: { stacked: true } }
      }
    });

    state.charts.trend = new Chart($('trendChart'), {
      type: 'line',
      data: {
        labels: [], datasets: [
          { label: '平均屋齡 (歲)', data: [], borderColor: '#fb8c00', backgroundColor: 'rgba(251,140,0,.15)', yAxisID: 'y', tension: .3, fill: true },
          { label: '綜合風險指數', data: [], borderColor: '#e53935', backgroundColor: '#e53935', yAxisID: 'y1', tension: .3, borderDash: [5, 4] }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y: { position: 'left', title: { display: true, text: '平均屋齡 (歲)' } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '風險指數' } }
        }
      }
    });

    state.charts.pie = new Chart($('pieChart'), {
      type: 'doughnut',
      data: { labels: STRUCT_TYPES.map((s) => s.label), datasets: [{ data: [], backgroundColor: STRUCT_TYPES.map((s) => s.color), borderWidth: 1 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (c) => { const tot = c.dataset.data.reduce((a, b) => a + b, 0); return `${c.label}：${fmt(c.parsed)} 宅 (${pct(c.parsed / tot)})`; } } }
        }
      }
    });

    // 臺東市微觀建築火災危險等級長條圖 (CSV 動態計算)
    state.charts.micro = new Chart($('microChart'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: '微觀危險分數',
          data: [],
          backgroundColor: [],
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, els) => {
          if (!els.length) return;
          const idx = els[0].index;
          if (state.buildings[idx]) {
            selectBuilding(state.buildings[idx].id, true);
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (c) => {
                const b = state.buildings[c.dataIndex];
                return `結構：${b.structure}（${b.floors}F）\n住警器：${b.smoke_detector} ｜ 栓距：${b.fire_hydrant_dist_m}m\n等級：${b.calc.level}`;
              }
            }
          }
        },
        scales: {
          x: { beginAtZero: true, max: 100, title: { display: true, text: '危險度分數 (0-100)' } }
        }
      }
    });

    document.querySelectorAll('button[data-bs-toggle="pill"]').forEach((btn) =>
      btn.addEventListener('shown.bs.tab', () => Object.values(state.charts).forEach((c) => c.resize())));
  }

  function updateCharts() {
    const res = state.results;
    const labels = res.map((r) => r.town);

    const rc = state.charts.risk;
    rc.data.labels = labels;
    rc.data.datasets[0].data = res.map((r) => +r.risk.toFixed(2));
    rc.data.datasets[0].backgroundColor = res.map((r) => RISK_LEVELS[r.level].color);
    rc.data.datasets[0].borderColor = res.map((r) => (r.town === state.selected ? '#1f2a3c' : 'transparent'));
    rc.data.datasets[0].borderWidth = 2;
    rc.update();

    const byBrick = [...res].sort((a, b) => b.brickWood - a.brickWood);
    const sc = state.charts.struct;
    sc.data.labels = byBrick.map((r) => r.town);
    STRUCT_TYPES.forEach((_, i) => { sc.data.datasets[i].data = byBrick.map((r) => +(r.structShares[i] * 100).toFixed(2)); });
    sc.update();

    const byOld = [...res].sort((a, b) => b.over30 - a.over30);
    const ac = state.charts.age;
    ac.data.labels = byOld.map((r) => r.town);
    AGE_GROUPS.forEach((_, i) => { ac.data.datasets[i].data = byOld.map((r) => +(r.ageGroupShares[i] * 100).toFixed(2)); });
    ac.update();

    updateSelectionCharts();
    updateMicroChart();
  }

  function updateSelectionCharts() {
    const town = state.selected;
    const rec = town ? resultOf(town) : state.county;
    const name = town || '全縣';
    document.querySelectorAll('.selected-name').forEach((el) => { el.textContent = name; });
    $('resetSel').classList.toggle('d-none', !town);

    if (rec) {
      state.charts.pie.data.datasets[0].data = rec.structs;
      state.charts.pie.update();
      $('selSummary').innerHTML = `
        <div class="sum-item">住宅數</div><div class="sum-val">${fmt(rec.total)}</div>
        <div class="sum-item">平均屋齡</div><div class="sum-val">${rec.avgAge.toFixed(1)} 歲</div>
        <div class="sum-item">綜合風險指數</div>
        <div class="sum-val">${rec.risk.toFixed(1)} ${town ? `<span class="risk-badge lv${rec.level}">${RISK_LEVELS[rec.level].name}</span>` : ''}</div>
        ${town === '臺東市' ? '<div class="mt-2"><span class="badge bg-danger-subtle text-danger border" style="cursor:pointer;" onclick="window.enterTaitungMicro()"><i class="bi bi-cursor-fill"></i> 雙擊下鑽微觀圖層</span></div>' : ''}
      `;
    }

    const key = town || '__COUNTY__';
    const series = state.periods.map((p) => {
      const r = state.byPeriod[p][key];
      return r ? computeRecord(r, state.wAge) : null;
    });
    const tc = state.charts.trend;
    tc.data.labels = state.periods;
    tc.data.datasets[0].data = series.map((s) => (s ? +s.avgAge.toFixed(2) : null));
    tc.data.datasets[1].data = series.map((s) => (s ? +s.risk.toFixed(2) : null));
    tc.update();
  }

  function updateMicroChart() {
    if (!state.charts.micro || !state.buildings.length) return;
    const mc = state.charts.micro;
    mc.data.labels = state.buildings.map((b) => b.name);
    mc.data.datasets[0].data = state.buildings.map((b) => b.calc.score);
    mc.data.datasets[0].backgroundColor = state.buildings.map((b) => b.calc.color);
    mc.data.datasets[0].borderColor = state.buildings.map((b) => (b.id === state.selectedBuildingId ? '#1f2a3c' : 'transparent'));
    mc.data.datasets[0].borderWidth = 2;
    mc.update();
  }

  function updateMicroChartHighlight() {
    if (!state.charts.micro) return;
    const mc = state.charts.micro;
    mc.data.datasets[0].borderColor = state.buildings.map((b) => (b.id === state.selectedBuildingId ? '#1f2a3c' : 'transparent'));
    mc.update();
  }

  /* ---------------- 12. 微觀導覽列 UI ---------------- */
  function initMicroBuildingsUI() {
    const container = $('landmarkPillContainer');
    if (container) {
      container.innerHTML = state.buildings.map((b) => {
        const riskIconClass = b.calc.levelClass === 'high' ? 'text-danger' : (b.calc.levelClass === 'med' ? 'text-warning-emphasis' : 'text-success');
        const shortName = b.name.length > 8 ? b.name.substring(0, 7) + '…' : b.name;
        return `
          <button type="button" class="landmark-pill-btn ${b.calc.levelClass === 'high' ? 'pill-high' : ''}" data-bldid="${b.id}" title="${b.name}">
            <i class="${b.icon} ${riskIconClass}"></i>
            <span>${shortName}</span>
          </button>
        `;
      }).join('');

      container.addEventListener('click', (e) => {
        const btn = e.target.closest('.landmark-pill-btn');
        if (btn && btn.dataset.bldid) {
          selectBuilding(btn.dataset.bldid, true);
        }
      });
    }

    const badge = $('microBldCountBadge');
    if (badge) {
      badge.textContent = `${state.buildings.length} 棟指標建築 (CSV)`;
    }

    const listEl = $('microLandmarksList');
    if (listEl) {
      listEl.innerHTML = state.buildings.map((b) => {
        const badgeColor = b.calc.levelClass === 'high' ? 'bg-danger' : (b.calc.levelClass === 'med' ? 'bg-warning text-dark' : 'bg-success');
        const sdTag = b.calc.hasSmokeDetector
          ? '<span class="badge bg-success-subtle text-success border">住警器：是</span>'
          : '<span class="badge bg-danger-subtle text-danger border">住警器：否 (待改善)</span>';
        return `
          <div class="card mb-2 p-2 border micro-list-item" style="cursor: pointer;" data-bldid="${b.id}">
            <div class="d-flex align-items-center justify-content-between">
              <div class="fw-bold small"><i class="${b.icon} me-1 text-primary"></i> ${b.name}</div>
              <span class="badge ${badgeColor}">${b.calc.level} (${b.calc.score}分)</span>
            </div>
            <div class="small text-muted mt-1 d-flex justify-content-between align-items-center flex-wrap gap-1">
              <span>${b.usage_type} ｜ ${b.structure}</span>
              <div>
                ${sdTag}
                <span class="badge bg-light text-secondary border">栓距 ${b.fire_hydrant_dist_m}m</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.micro-list-item');
        if (item && item.dataset.bldid) {
          selectBuilding(item.dataset.bldid, true);
        }
      });
    }
  }

  window.enterTaitungMicro = () => enterMicroView();

  /* ---------------- 13. KPI 與表格 ---------------- */
  function updateKpis() {
    const c = state.county;
    const top = state.results[0];
    if (c) {
      $('kpiTotal').textContent = `${fmt(c.total)} 宅`;
      $('kpiAge').textContent = `${c.avgAge.toFixed(1)} 歲`;
      $('kpiBrick').textContent = pct(c.brickWood);
    }
    if (top) $('kpiTop').innerHTML = `${top.town} <small class="text-danger">${top.risk.toFixed(1)}</small>`;
  }

  function updateTable() {
    $('tablePeriod').textContent = periodLabel(state.period);
    $('dataTableBody').innerHTML = state.results.map((r) => `
      <tr data-town="${r.town}" class="${r.town === state.selected ? 'active-row' : ''}">
        <td>${r.rank}</td>
        <td class="fw-semibold">${r.town}</td>
        <td class="text-end">${fmt(r.total)}</td>
        <td class="text-end">${r.avgAge.toFixed(1)}</td>
        <td class="text-end">${pct(r.over30)}</td>
        <td class="text-end">${pct(r.brickWood)}</td>
        <td class="text-end">${pct(r.reinforcedBrick)}</td>
        <td class="text-end">${pct(r.rcSteel)}</td>
        <td class="text-end">${r.ageScore.toFixed(1)}</td>
        <td class="text-end">${r.structScore.toFixed(1)}</td>
        <td class="text-end fw-bold">${r.risk.toFixed(1)}</td>
        <td class="text-center"><span class="risk-badge lv${r.level}">${RISK_LEVELS[r.level].name}</span></td>
      </tr>`).join('');
  }

  function refreshAll() {
    recalc();
    updateMap();
    updateCharts();
    updateKpis();
    updateTable();
    state.map.closePopup();
  }

  /* ---------------- 14. 控制事件綁定 ---------------- */
  function bindControls() {
    const ps = $('periodSelect');
    ps.innerHTML = [...state.periods].reverse().map((p) => `<option value="${p}">${p}（${periodLabel(p)}）</option>`).join('');
    ps.value = state.period;
    ps.addEventListener('change', () => { state.period = ps.value; refreshAll(); });

    $('classSelect').addEventListener('change', (e) => { state.classMode = e.target.value; refreshAll(); });

    const wr = $('weightRange');
    wr.addEventListener('input', () => {
      state.wAge = wr.value / 100;
      $('wAgeLabel').textContent = wr.value;
      $('wStructLabel').textContent = 100 - wr.value;
      refreshAll();
    });

    $('resetSel').addEventListener('click', () => {
      selectTown(null, false);
      state.map.setView(CONFIG.mapCenter, window.innerWidth < 576 ? 8.25 : 9);
    });

    $('dataTableBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-town]');
      if (tr) selectTown(tr.dataset.town, true);
    });

    $('downloadBtn').addEventListener('click', downloadCsv);

    // 懸浮返回全縣概況按鈕
    $('btnBackToCounty').addEventListener('click', exitMicroView);

    // 側邊欄返回鄉鎮結構按鈕
    $('btnBackToTown').addEventListener('click', () => {
      $('townDetailBlock').classList.remove('d-none');
      $('landmarkDetailBlock').classList.add('d-none');
      $('btnBackToTown').classList.add('d-none');
      $('detailCardTitle').innerHTML = `<i class="bi bi-pie-chart-fill text-primary"></i> <span class="selected-name">${state.selected || '全縣'}</span> 結構組成`;
      if (state.selected) $('resetSel').classList.remove('d-none');
    });
  }

  function downloadCsv() {
    const head = ['資料期別', '鄉鎮市區', '住宅數', '平均屋齡', '30年以上比例', '磚木石造比例', '加強磚造比例', 'RC鋼構比例', '屋齡分數', '結構分數', '綜合風險指數', '風險等級', '排名'];
    const rows = state.results.map((r) => [
      r.period, r.town, r.total, r.avgAge.toFixed(2), (r.over30 * 100).toFixed(2), (r.brickWood * 100).toFixed(2),
      (r.reinforcedBrick * 100).toFixed(2), (r.rcSteel * 100).toFixed(2), r.ageScore.toFixed(2), r.structScore.toFixed(2),
      r.risk.toFixed(2), RISK_LEVELS[r.level].name, r.rank
    ]);
    const csv = '\uFEFF' + Papa.unparse({ fields: head, data: rows });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `taitung_fire_risk_${state.period}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderMethod() {
    $('methodBody').innerHTML = `
      <h6 class="fw-bold">1. 資料來源與整合</h6>
      <p class="small">讀取 <code>data/taitung_age.csv</code>（住宅屋齡分組）、<code>data/taitung_structure.csv</code>（住宅構造）與 <code>data/taitung_buildings.csv</code>（臺東市微觀指標建築消防調查），
      將全縣鄉鎮資料依 <b>資料期別 + 鄉鎮市區</b> 為鍵進行對應整合。
      ${state.dataSource === 'embedded' ? '<br><span class="text-warning">※ 目前以 file:// 開啟，已改用 data/csv_embedded.js 內嵌的相同 CSV 內容。</span>' : ''}</p>
      <h6 class="fw-bold">2. 宏觀綜合火災風險指數</h6>
      <p class="small mb-1">綜合指數 = w × 屋齡老舊分數 + (1 − w) × 結構易燃分數（預設 w = 0.5，可由上方滑桿調整）。</p>
      <h6 class="fw-bold">3. GIS 雙擊下鑽與微觀危險等級評估</h6>
      <p class="small mb-0">於地圖上雙擊「臺東市」可下鑽至微觀建築風險圖層。系統根據 CSV 內每棟建築之<b>構造耐火性 (30%)、樓層疏散垂直難度 (20%)、使用類型火災載荷 (25%)、是否安裝住警器 (15%) 與鄰近消防栓距離 (10%)</b> 動態加權計分，分為高、中、低三個危險等級並給予具體消防改善建議。</p>`;
  }

  function showError(msg) {
    $('alertBox').innerHTML = `<div class="alert alert-danger"><i class="bi bi-x-octagon"></i> ${msg}</div>`;
  }

  /* ---------------- 15. 系統啟動 ---------------- */
  async function init() {
    try {
      if (typeof Papa === 'undefined' || typeof L === 'undefined' || typeof Chart === 'undefined') {
        throw new Error('CDN 套件載入失敗，請確認網路連線。');
      }
      const [csv, geo] = await Promise.all([loadCsvs(), loadGeo()]);
      state.geo = geo;
      state.buildings = processBuildings(csv.buildings);
      state.byPeriod = mergeData(csv.age, csv.structure);
      state.periods = Object.keys(state.byPeriod).sort((a, b) => {
        const [ya, qa] = a.split('Q').map(Number), [yb, qb] = b.split('Q').map(Number);
        return ya - yb || qa - qb;
      });
      if (!state.periods.length) throw new Error('CSV 中沒有可用的資料');
      state.period = state.periods[state.periods.length - 1];

      initMap();
      initCharts();
      bindControls();
      renderMethod();
      refreshAll();
      setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 150);
      setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 600);
    } catch (err) {
      console.error(err);
      showError(`資料載入失敗：${err.message}`);
    } finally {
      $('loadingOverlay').classList.add('hide');
      setTimeout(() => {
        $('loadingOverlay').style.display = 'none';
        if (state.map) state.map.invalidateSize();
      }, 450);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

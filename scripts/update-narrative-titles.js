#!/usr/bin/env node
/**
 * update-narrative-titles.js
 *
 * Produces combined_with_narratives_update.pdf with:
 *   • Reformatted titles: "Gulf Coast (Strategy 1)" / "Economic Hardship (Strategy 1)"
 *   • Equal-size subtitle lines on title pages
 *   • Per-target narrative pages that include:
 *       - Circled attack number (1–5)
 *       - Attack composition + penetrator counts (from results.xlsx cell values)
 *       - Damage narrative text
 *       - THAAD / Patriot / SM-2 / SM-3 / SM-6 interceptors expended (US vs. Allied)
 *       - Small SVG map showing all attack locations for the combination
 *   • Total interceptors expended summary after all narratives
 *   • 3-level bookmarks matching the reformatted titles
 *
 * Usage:
 *   node scripts/update-narrative-titles.js <output-dir> <damage-levels.xlsx>
 *
 * <output-dir> must contain the individual PDFs and sim_data.json produced by
 * batch-sim.js.  <damage-levels.xlsx> is the colored results spreadsheet.
 */

import { execSync }                         from 'child_process';
import { mkdtempSync, readFileSync,
         writeFileSync, existsSync }        from 'fs';
import { tmpdir }                           from 'os';
import path                                 from 'path';
import { fileURLToPath }                    from 'url';
import { chromium }                         from 'playwright';
import { PDFDocument, PDFName,
         PDFString, PDFNumber }             from 'pdf-lib';
import XLSXModule                           from 'xlsx';
const XLSX = XLSXModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ── Tracked interceptor systems ───────────────────────────────────────────────

const TRACKED   = ['thaad', 'patriot', 'aegis_sm2', 'aegis_sm3', 'aegis_sm6'];
const SYS_LABEL = { thaad: 'THAAD', patriot: 'Patriot', aegis_sm2: 'SM-2', aegis_sm3: 'SM-3', aegis_sm6: 'SM-6' };

// ── Name formatting ───────────────────────────────────────────────────────────

function formatLaydownName(stem) {
  const m = stem.match(/^strategy_(\d+)_(.+?)(?:_merged)?$/i);
  if (!m) return stem;
  const num  = m[1];
  const nice = m[2]
    .split('_')
    .map(w => w.toLowerCase() === 'us' ? 'U.S.' : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${nice} (Strategy ${num})`;
}

const ATTACK_STRATEGY_NUM = {
  'Economic Hardship':       1,
  'Double Tap':              2,
  'Attacking the Aggressor': 3,
  'U.S. Military Targets':   4,
  'Commercial Shipping':     5,
};
function formatAttackName(name) {
  const n = ATTACK_STRATEGY_NUM[name];
  return n != null ? `${name} (Strategy ${n})` : name;
}

// ── Static mappings ───────────────────────────────────────────────────────────

const ARGB_TO_LEVEL = {
  'FF00B050': 'None',
  'FFFFFF00': 'Mild',
  'FFFFC000': 'Moderate',
  'FFFF0000': 'Severe',
};

const ATTACK_FILE_STEMS = {
  'Economic Hardship':       'strategy_1_economic_hardship',
  'Double Tap':              'strategy_2_double_tap',
  'Attacking the Aggressor': 'strategy_3_attacking_aggressor',
  'U.S. Military Targets':   'strategy_4_us_military_targets',
  'Commercial Shipping':     'strategy_5_commercial_shipping',
};

const COLUMN_TO_TARGET = {
  'Dubai':                      'dubai',
  'Riyadh':                     'riyadh',
  'ARAMCO — Riyadh':            'aramco_riyadh',
  'Fujairah Port':              'fujairah_port',
  'Jebel Ali Port':             'jebel_ali_port',
  'Al Dhafra Air Base':         'al_dhafra_ab',
  'Ruwais Refinery':            'ruwais_refinery',
  'Al Udeid Air Base':          'al_udeid_ab',
  'Hamad Port':                 'hamad_port',
  'Doha':                       'doha',
  'Tel Nof Air Base':           'tel_nof_ab',
  'Tel Aviv':                   'tel_aviv',
  'Haifa':                      'haifa',
  'Ramat David Air Base':       'ramat_david_ab',
  "Be'er Sheva":                'beer_sheva',
  'Muwaffaq al-Salti Air Base': 'muwaffaq_al_salti_ab',
  'Prince Sultan Air Base':     'prince_sultan_ab',
  'U.S. Fifth Fleet':           'us_fifth_fleet',
  'Isa Air Base':               'isa_ab',
  'Port of Salalah':            'port_of_salalah',
  'Shuaiba Port':               'shuaiba_port',
};

const TARGET_DISPLAY = {
  dubai:                 'Dubai',
  riyadh:                'Riyadh — International Airport',
  aramco_riyadh:         'ARAMCO — Riyadh',
  fujairah_port:         'Fujairah Port',
  jebel_ali_port:        'Jebel Ali Port',
  al_dhafra_ab:          'Al Dhafra Air Base',
  ruwais_refinery:       'Ruwais Refinery',
  al_udeid_ab:           'Al Udeid Air Base',
  hamad_port:            'Hamad Port',
  doha:                  'Doha — International Airport',
  tel_nof_ab:            'Tel Nof Air Base',
  tel_aviv:              'Tel Aviv',
  haifa:                 'Haifa',
  ramat_david_ab:        'Ramat David Air Base',
  beer_sheva:            "Be'er Sheva",
  muwaffaq_al_salti_ab:  'Muwaffaq al-Salti Air Base',
  prince_sultan_ab:      'Prince Sultan Air Base',
  us_fifth_fleet:        'U.S. Fifth Fleet',
  isa_ab:                'Isa Air Base',
  port_of_salalah:       'Port of Salalah',
  shuaiba_port:          'Shuaiba Port',
};

// ── Color extraction ──────────────────────────────────────────────────────────

function extractCellLevels(xlsxPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'upd-narratives-'));
  execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}"`, { stdio: 'ignore' });

  const stylesXml = readFileSync(path.join(tmpDir, 'xl', 'styles.xml'), 'utf8');

  const fills = [];
  const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
  let fm;
  while ((fm = fillRe.exec(stylesXml)) !== null) {
    const fg = fm[1].match(/fgColor rgb="([A-Fa-f0-9]{8})"/);
    fills.push(fg ? fg[1].toUpperCase() : null);
  }

  const xfs = [];
  const cxMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cxMatch) {
    const xfRe = /fillId="(\d+)"/g;
    let xm;
    while ((xm = xfRe.exec(cxMatch[1])) !== null) xfs.push(parseInt(xm[1], 10));
  }

  const sheetXml = readFileSync(
    path.join(tmpDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  const cellLevels = new Map();
  const cellRe = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*\bs="(\d+)"[^>]*>/g;
  let cm;
  while ((cm = cellRe.exec(sheetXml)) !== null) {
    const level = ARGB_TO_LEVEL[fills[xfs[parseInt(cm[2], 10)]]];
    if (level) cellLevels.set(cm[1], level);
  }
  return cellLevels;
}

function colLetters(idx) {
  let n = idx + 1, result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result    = String.fromCharCode(65 + rem) + result;
    n         = Math.floor((n - 1) / 26);
  }
  return result;
}

// ── Simplified country polygons for the Middle East / Gulf region ─────────────
// Each polygon: array of [lon, lat] pairs (geographic coordinates, WGS84 approx)
const COUNTRY_POLYS = [
  { name: 'Egypt', pts: [[25.0,31.2],[34.0,31.2],[34.9,30.0],[34.9,29.5],[33.6,27.5],[32.0,23.5],[29.0,22.0],[25.0,22.0]] },
  { name: 'Israel/Palestine', pts: [[34.2,31.0],[34.5,31.5],[35.0,33.0],[35.5,33.3],[35.9,32.6],[35.5,32.3],[35.0,31.0],[34.9,29.5],[34.2,29.5]] },
  { name: 'Lebanon', pts: [[35.1,33.1],[35.6,33.1],[36.6,34.2],[36.2,33.5],[35.9,33.7],[35.5,33.3],[35.1,33.1]] },
  { name: 'Jordan', pts: [[34.9,29.5],[38.0,29.5],[39.0,32.4],[38.5,33.4],[36.8,32.5],[35.9,32.6],[35.5,32.3],[34.9,29.5]] },
  { name: 'Syria', pts: [[35.7,36.5],[36.6,36.8],[38.0,37.1],[40.5,37.5],[42.5,37.2],[42.0,36.5],[40.7,34.0],[38.5,33.4],[38.0,32.9],[36.5,32.5],[35.5,33.3],[35.1,33.1],[35.7,36.5]] },
  { name: 'Iraq', pts: [[38.8,33.4],[40.0,34.5],[44.0,37.5],[45.5,37.0],[46.2,35.5],[48.5,34.0],[48.5,30.5],[47.5,30.0],[47.0,29.5],[46.5,29.5],[44.5,30.0],[40.0,32.0],[38.8,33.4]] },
  { name: 'Iran', pts: [[44.0,37.5],[50.0,38.7],[53.5,37.5],[60.5,37.2],[63.0,36.5],[63.0,26.5],[61.0,25.0],[57.5,25.5],[56.5,27.5],[55.0,27.0],[54.5,26.0],[53.0,26.5],[50.5,29.5],[48.5,30.0],[47.5,30.0],[46.5,29.5],[46.0,35.5],[45.5,37.0],[44.0,37.5]] },
  { name: 'Kuwait', pts: [[46.5,29.5],[47.0,29.0],[48.5,29.5],[48.5,28.5],[47.5,28.5],[47.0,29.0],[46.5,29.5]] },
  { name: 'Saudi Arabia', pts: [[35.0,29.2],[37.0,28.0],[39.5,22.5],[40.5,20.0],[42.5,16.5],[45.0,15.0],[46.5,14.5],[50.0,17.5],[52.0,19.0],[55.5,22.5],[55.0,24.0],[51.5,24.0],[51.0,26.0],[50.5,26.5],[48.5,28.5],[47.0,29.0],[46.5,29.5],[44.5,30.0],[40.0,32.0],[38.0,32.0],[36.5,32.5],[35.0,29.2]] },
  { name: 'Qatar', pts: [[50.5,24.8],[51.5,25.0],[51.6,25.8],[51.2,26.2],[50.8,26.2],[50.5,25.5],[50.5,24.8]] },
  { name: 'Bahrain', pts: [[50.4,26.2],[50.7,26.2],[50.7,26.0],[50.4,26.0],[50.4,26.2]] },
  { name: 'UAE', pts: [[51.5,24.0],[54.5,24.0],[56.3,24.1],[56.0,25.3],[55.7,25.8],[54.0,24.5],[52.5,24.3],[51.5,24.0]] },
  { name: 'Oman', pts: [[56.4,24.5],[59.5,22.5],[59.0,21.0],[57.5,20.5],[57.0,19.5],[56.0,17.5],[54.0,17.0],[52.5,19.0],[52.0,20.0],[54.5,23.5],[55.5,24.0],[56.0,24.2],[56.4,24.5]] },
  { name: 'Yemen', pts: [[42.5,16.5],[43.0,15.0],[44.5,14.5],[46.5,13.8],[48.5,14.0],[50.5,15.5],[52.0,19.0],[50.0,17.5],[46.5,14.5],[45.0,15.0],[42.5,16.5]] },
];

// ── Map SVG ───────────────────────────────────────────────────────────────────

function buildMapSvg(points) {
  // points: [{ num, lat, lon }]
  if (!points.length) return '';

  const lats = points.map(p => p.lat);
  const lons = points.map(p => p.lon);

  let latMin = Math.min(...lats), latMax = Math.max(...lats);
  let lonMin = Math.min(...lons), lonMax = Math.max(...lons);

  // Enforce minimum geographic span so clustered combos don't collapse
  if (latMax - latMin < 4) { const c = (latMax + latMin) / 2; latMin = c - 2; latMax = c + 2; }
  if (lonMax - lonMin < 4) { const c = (lonMax + lonMin) / 2; lonMin = c - 2; lonMax = c + 2; }

  // Padding
  const padLat = (latMax - latMin) * 0.22;
  const padLon = (lonMax - lonMin) * 0.22;
  latMin -= padLat; latMax += padLat;
  lonMin -= padLon; lonMax += padLon;

  const W = 230, H = 185;
  const mx = 14; // inner margin
  const R  = 12; // circle radius

  const toX = lon => ((lon - lonMin) / (lonMax - lonMin)) * (W - 2*mx) + mx;
  const toY = lat => H - mx - ((lat - latMin) / (latMax - latMin)) * (H - 2*mx);

  // ── Geographic positions (true pixel coords) ──────────────────────────────
  const geo = points.map(p => ({ num: p.num, gx: toX(p.lon), gy: toY(p.lat) }));

  // ── Force-deconfliction: push overlapping circles apart ───────────────────
  const pos = geo.map(p => ({ num: p.num, x: p.gx, y: p.gy }));
  const MIN_DIST = R * 2 + 3;
  const CLAMP_X = [mx + R, W - mx - R];
  const CLAMP_Y = [mx + R, H - mx - R];

  for (let iter = 0; iter < 80; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MIN_DIST) {
          if (dist < 0.01) { dx = MIN_DIST; dy = 0; dist = MIN_DIST; }
          const push = (MIN_DIST - dist) / 2 + 0.5;
          const nx = dx / dist, ny = dy / dist;
          pos[i].x -= nx * push;  pos[i].y -= ny * push;
          pos[j].x += nx * push;  pos[j].y += ny * push;
          moved = true;
        }
      }
    }
    // Clamp to inner map area
    for (const p of pos) {
      p.x = Math.max(CLAMP_X[0], Math.min(CLAMP_X[1], p.x));
      p.y = Math.max(CLAMP_Y[0], Math.min(CLAMP_Y[1], p.y));
    }
    if (!moved) break;
  }

  // ── Country polygons ─────────────────────────────────────────────────────
  const countryPaths = COUNTRY_POLYS.map(c => {
    const pts = c.pts
      .map(([lon, lat]) => `${toX(lon).toFixed(1)},${toY(lat).toFixed(1)}`)
      .join(' ');
    return `<polygon points="${pts}" fill="#e8dfc8" stroke="#c8b88a" stroke-width="0.6" stroke-linejoin="round"/>`;
  }).join('\n  ');

  // ── Grid lines every 5° ───────────────────────────────────────────────────
  const grid = [];
  const lat0 = Math.ceil(latMin / 5) * 5;
  const lon0 = Math.ceil(lonMin / 5) * 5;
  for (let lat = lat0; lat <= latMax; lat += 5) {
    const y = toY(lat);
    grid.push(`<line x1="${mx}" y1="${y.toFixed(1)}" x2="${W-mx}" y2="${y.toFixed(1)}" stroke="#b0cfe0" stroke-width="0.6"/>`);
    grid.push(`<text x="${(mx+1).toFixed(1)}" y="${(y-1.5).toFixed(1)}" font-size="6.5" fill="#7aacc4" font-family="sans-serif">${lat}°N</text>`);
  }
  for (let lon = lon0; lon <= lonMax; lon += 5) {
    const x = toX(lon);
    grid.push(`<line x1="${x.toFixed(1)}" y1="${mx}" x2="${x.toFixed(1)}" y2="${H-mx}" stroke="#b0cfe0" stroke-width="0.6"/>`);
    grid.push(`<text x="${(x+1).toFixed(1)}" y="${(H-mx-2).toFixed(1)}" font-size="6.5" fill="#7aacc4" font-family="sans-serif">${lon}°E</text>`);
  }

  // ── Leader lines from deconflicted dot → true geographic position ─────────
  const leaders = [];
  for (let i = 0; i < pos.length; i++) {
    const dx = pos[i].x - geo[i].gx;
    const dy = pos[i].y - geo[i].gy;
    const moved = Math.sqrt(dx*dx + dy*dy);
    if (moved > 4) {
      // Small anchor dot at true position
      leaders.push(`<circle cx="${geo[i].gx.toFixed(1)}" cy="${geo[i].gy.toFixed(1)}" r="3" fill="#b52b2b" opacity="0.55"/>`);
      // Line from true position to deconflicted circle edge
      const angle = Math.atan2(pos[i].y - geo[i].gy, pos[i].x - geo[i].gx);
      const ex = pos[i].x - Math.cos(angle) * R;
      const ey = pos[i].y - Math.sin(angle) * R;
      leaders.push(`<line x1="${geo[i].gx.toFixed(1)}" y1="${geo[i].gy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#b52b2b" stroke-width="0.9" opacity="0.55" stroke-dasharray="2,2"/>`);
    }
  }

  // ── Dots (draw in reverse so #1 is on top) ────────────────────────────────
  const dots = [...pos].reverse().map(p => {
    const x = p.x.toFixed(1);
    const y = p.y.toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="${R}" fill="#b52b2b" opacity="0.93"/>
<text x="${x}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="bold" fill="white" font-family="sans-serif">${p.num}</text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#c8dfee" rx="4"/>
  <rect x="${mx}" y="${mx}" width="${W-2*mx}" height="${H-2*mx}" fill="#d8eaf6" rx="2"/>
  <clipPath id="mapclip"><rect x="${mx}" y="${mx}" width="${W-2*mx}" height="${H-2*mx}"/></clipPath>
  <g clip-path="url(#mapclip)">
  ${countryPaths}
  </g>
  ${grid.join('\n  ')}
  ${leaders.join('\n  ')}
  ${dots}
</svg>`;
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function buildTitlePageHtml(laydownFormatted, attackFormatted) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100vh; background: #fff; }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: Georgia, 'Times New Roman', serif;
    color: #1a1a2e;
    position: relative;
  }
  .supertitle {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #999;
    margin-bottom: 40px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .rule { width: 48px; height: 3px; background: #b52b2b; margin-bottom: 40px; }
  .section-label {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #bbb;
    margin-bottom: 8px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .laydown {
    font-size: 24px;
    font-weight: bold;
    text-align: center;
    max-width: 500px;
    line-height: 1.25;
    margin-bottom: 36px;
  }
  .attack {
    font-size: 24px;
    font-weight: bold;
    font-style: italic;
    color: #555;
    text-align: center;
    max-width: 500px;
    line-height: 1.25;
  }
  .footer {
    position: absolute;
    bottom: 28px;
    font-size: 10px;
    color: #ccc;
    letter-spacing: 0.06em;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
</style>
</head>
<body>
  <div class="supertitle">Strike Assessment Tool &nbsp;·&nbsp; Layered Air Defense Adjudicator</div>
  <div class="rule"></div>
  <div class="section-label">Defensive Laydown</div>
  <div class="laydown">${esc(laydownFormatted)}</div>
  <div class="section-label">Attack Strategy</div>
  <div class="attack">${esc(attackFormatted)}</div>
  <div class="footer">Middle East &nbsp;·&nbsp; Simulation Report</div>
</body>
</html>`;
}

function buildNarrativeHtml(laydownFormatted, attackFormatted, items) {
  // items: { displayName, level, text, attackComposition, penetrators,
  //          interceptors: { us:{}, allied:{} }, lat, lon }
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Totals across all targets
  const totals = { us: {}, allied: {} };
  for (const item of items) {
    for (const [sys, cnt] of Object.entries(item.interceptors?.us    || {}))
      totals.us[sys]     = (totals.us[sys]     || 0) + cnt;
    for (const [sys, cnt] of Object.entries(item.interceptors?.allied || {}))
      totals.allied[sys] = (totals.allied[sys] || 0) + cnt;
  }

  // Map SVG
  const mapSvg = buildMapSvg(
    items.map((item, i) => ({ num: i + 1, lat: item.lat ?? 0, lon: item.lon ?? 0 }))
  );

  // Interceptor table for a single item
  function intTable(interceptors) {
    const hasAny = TRACKED.some(s =>
      (interceptors?.us?.[s] || 0) + (interceptors?.allied?.[s] || 0) > 0);
    if (!hasAny) return '';
    return `<div class="int-wrap">
      <div class="int-label">Interceptors Expended</div>
      <table class="int-tbl">
        <thead><tr><th></th>${TRACKED.map(s => `<th>${esc(SYS_LABEL[s])}</th>`).join('')}</tr></thead>
        <tbody>
          <tr>
            <td class="row-hdr">U.S.</td>
            ${TRACKED.map(s => `<td>${interceptors?.us?.[s] || 0}</td>`).join('')}
          </tr>
          <tr>
            <td class="row-hdr">Allied</td>
            ${TRACKED.map(s => `<td>${interceptors?.allied?.[s] || 0}</td>`).join('')}
          </tr>
        </tbody>
      </table>
    </div>`;
  }

  // Totals table
  const totalsHtml = `<div class="totals-block">
    <div class="totals-hdr">Total Interceptors Expended — All Attacks</div>
    <table class="int-tbl">
      <thead><tr><th></th>${TRACKED.map(s => `<th>${esc(SYS_LABEL[s])}</th>`).join('')}</tr></thead>
      <tbody>
        <tr>
          <td class="row-hdr">U.S.</td>
          ${TRACKED.map(s => `<td>${totals.us[s] || 0}</td>`).join('')}
        </tr>
        <tr>
          <td class="row-hdr">Allied</td>
          ${TRACKED.map(s => `<td>${totals.allied[s] || 0}</td>`).join('')}
        </tr>
      </tbody>
    </table>
  </div>`;

  // Per-target sections
  const sections = items.map((item, i) => `
  <div class="tgt">
    <div class="tgt-head">
      <span class="atk-num">${i + 1}</span>
      <span class="tgt-name">${esc(item.displayName)}</span>
      <span class="badge lvl-${item.level.toLowerCase()}">${esc(item.level)}</span>
    </div>
    <div class="comp-line">${esc(item.attackComposition)} &rarr; ${esc(item.penetrators)}</div>
    <p class="narrative">${esc(item.text)}</p>
    ${intTable(item.interceptors)}
  </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @page { size: letter; margin: 0.75in 0.9in; }
  body  { font-family: 'Times New Roman', serif; font-size: 10.5pt; color: #111; margin: 0; }
  h1    { font-size: 13.5pt; margin: 0 0 2px; line-height: 1.3; }
  .sub  { font-size: 10pt; font-style: italic; color: #555; margin: 0 0 12px;
          padding-bottom: 7px; border-bottom: 1.5px solid #777; }

  /* Map floated to the right of the first few narratives */
  .map-float { float: right; margin: 2px 0 10px 14px; }
  .map-float svg { display: block; }
  .map-cap  { font-size: 7pt; color: #888; text-align: center; margin-top: 3px;
              font-family: 'Helvetica Neue', sans-serif; }

  /* Individual target block */
  .tgt { padding: 9px 0 6px; border-top: 1px solid #d0d0d0; }
  .tgt:first-of-type { border-top: none; padding-top: 0; }

  .tgt-head { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }

  .atk-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; min-width: 18px;
    border-radius: 50%; background: #1a1a2e; color: #fff;
    font-size: 8.5pt; font-weight: bold; font-family: 'Helvetica Neue', sans-serif;
    flex-shrink: 0; line-height: 1;
  }
  .tgt-name { font-weight: bold; font-size: 10.5pt; }
  .badge {
    font-size: 7.5pt; padding: 1px 6px; border-radius: 3px;
    white-space: nowrap; font-family: 'Helvetica Neue', sans-serif;
  }
  .lvl-none     { background: #00B050; color: #fff; }
  .lvl-mild     { background: #FFFF00; color: #000; border: 1px solid #ccc; }
  .lvl-moderate { background: #FFC000; color: #000; }
  .lvl-severe   { background: #FF0000; color: #fff; }

  .comp-line {
    font-size: 8pt; color: #444; margin-bottom: 4px;
    font-family: 'Courier New', monospace;
  }
  p.narrative { margin: 0 0 5px; line-height: 1.5; }

  /* Interceptor table */
  .int-wrap  { margin-top: 5px; }
  .int-label { font-size: 7.5pt; font-weight: bold; color: #666; text-transform: uppercase;
               letter-spacing: 0.04em; font-family: 'Helvetica Neue', sans-serif;
               margin-bottom: 2px; }
  .int-tbl   { border-collapse: collapse; font-size: 8pt;
               font-family: 'Helvetica Neue', sans-serif; }
  .int-tbl th { padding: 1px 9px; text-align: center; background: #f0f0f0;
                border: 1px solid #ccc; font-weight: 600; }
  .int-tbl td { padding: 1px 9px; text-align: center; border: 1px solid #ccc; }
  .row-hdr   { text-align: left !important; font-weight: bold; min-width: 46px; }

  /* Totals block */
  .totals-block { margin-top: 16px; padding-top: 10px;
                  border-top: 2px solid #555; clear: both; }
  .totals-hdr   { font-size: 9pt; font-weight: bold;
                  font-family: 'Helvetica Neue', sans-serif; margin-bottom: 5px; }

  .clearfix::after { content: ''; display: table; clear: both; }
</style></head><body>
  <h1>${esc(laydownFormatted)} / ${esc(attackFormatted)}</h1>
  <p class="sub">Damage Assessment Narratives</p>
  <div class="clearfix">
    <div class="map-float">
      ${mapSvg}
      <div class="map-cap">Attack locations</div>
    </div>
    ${sections}
  </div>
  ${totalsHtml}
</body></html>`;
}

// ── PDF bookmarks (3 levels: laydown > attack > Damage Narratives) ────────────

function addOutlines(pdfDoc, groups) {
  const ctx   = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const dest  = idx => ctx.obj([pages[idx].ref, PDFName.of('Fit')]);

  const laydownRefs = groups.map(group => {
    const attackEntries = group.attacks.map(atk => {
      const narRef = ctx.nextRef();
      ctx.assign(narRef, ctx.obj({
        Title:  PDFString.of('Damage Narratives'),
        Parent: null,
        Dest:   dest(atk.narrativePageIdx),
        Count:  PDFNumber.of(0),
      }));
      const atkRef = ctx.nextRef();
      ctx.assign(atkRef, ctx.obj({
        Title:  PDFString.of(atk.attackLabel),
        Parent: null,
        Dest:   dest(atk.titlePageIdx),
        First:  narRef,
        Last:   narRef,
        Count:  PDFNumber.of(-1),
      }));
      ctx.lookup(narRef).set(PDFName.of('Parent'), atkRef);
      return { atkRef, narRef };
    });

    for (let i = 0; i < attackEntries.length; i++) {
      const cur = attackEntries[i].atkRef;
      if (i > 0) ctx.lookup(cur).set(PDFName.of('Prev'), attackEntries[i-1].atkRef);
      if (i < attackEntries.length-1)
        ctx.lookup(cur).set(PDFName.of('Next'), attackEntries[i+1].atkRef);
    }

    const ldRef = ctx.nextRef();
    ctx.assign(ldRef, ctx.obj({
      Title:  PDFString.of(group.laydownLabel),
      Parent: null,
      Dest:   dest(group.attacks[0].titlePageIdx),
      First:  attackEntries[0].atkRef,
      Last:   attackEntries[attackEntries.length-1].atkRef,
      Count:  PDFNumber.of(-1),
    }));
    attackEntries.forEach(({ atkRef }) =>
      ctx.lookup(atkRef).set(PDFName.of('Parent'), ldRef));
    return ldRef;
  });

  for (let i = 0; i < laydownRefs.length; i++) {
    if (i > 0) ctx.lookup(laydownRefs[i]).set(PDFName.of('Prev'), laydownRefs[i-1]);
    if (i < laydownRefs.length-1)
      ctx.lookup(laydownRefs[i]).set(PDFName.of('Next'), laydownRefs[i+1]);
  }

  const rootRef = ctx.nextRef();
  ctx.assign(rootRef, ctx.obj({
    Type:  PDFName.of('Outlines'),
    First: laydownRefs[0],
    Last:  laydownRefs[laydownRefs.length-1],
    Count: PDFNumber.of(laydownRefs.length),
  }));
  laydownRefs.forEach(r => ctx.lookup(r).set(PDFName.of('Parent'), rootRef));

  pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [,, outDir, xlsxPath] = process.argv;
  if (!outDir || !xlsxPath) {
    console.error('Usage: node scripts/update-narrative-titles.js <output-dir> <damage-levels.xlsx>');
    process.exit(1);
  }
  if (!existsSync(outDir))   { console.error('Output dir not found:', outDir);  process.exit(1); }
  if (!existsSync(xlsxPath)) { console.error('xlsx not found:', xlsxPath);      process.exit(1); }

  // 1. Parse damage levels from colored xlsx ─────────────────────────────────
  console.log(`[update] Parsing damage levels…`);
  const cellLevels = extractCellLevels(xlsxPath);
  console.log(`[update] ${cellLevels.size} colored cells\n`);

  const wb      = XLSX.readFile(xlsxPath);
  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0];
  const colTargetIds = headers.map(h => COLUMN_TO_TARGET[h] ?? null);

  // 2. Load attack JSONs ──────────────────────────────────────────────────────
  const attackJsons = {};
  for (const [name, stem] of Object.entries(ATTACK_FILE_STEMS)) {
    const p = path.join(ROOT, 'data', 'batch', 'attacks', `${stem}.json`);
    attackJsons[name] = JSON.parse(readFileSync(p, 'utf8'));
  }

  // 3. Load sim data (interceptors) ──────────────────────────────────────────
  const simDataPath = path.join(outDir, 'sim_data.json');
  if (!existsSync(simDataPath)) {
    console.error(`[update] sim_data.json not found in ${outDir}. Re-run batch-sim.js first.`);
    process.exit(1);
  }
  const simData = JSON.parse(readFileSync(simDataPath, 'utf8'));

  // 4. Load target coordinates ────────────────────────────────────────────────
  const targetsRaw = JSON.parse(readFileSync(path.join(ROOT, 'data', 'targets.json'), 'utf8'));
  const targetsList = Array.isArray(targetsRaw) ? targetsRaw : (targetsRaw.targets || []);
  const targetCoords = {};  // targetId → { lat, lon }
  for (const t of targetsList) {
    if (t.id && Array.isArray(t.location) && t.location.length === 2) {
      targetCoords[t.id] = { lat: t.location[0], lon: t.location[1] };
    }
  }

  // 5. Build combination list ─────────────────────────────────────────────────
  const combinations = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const label = String(rows[ri][0] || '').trim();
    const sep   = label.indexOf(' / ');
    if (sep === -1) continue;

    const laydownStem  = label.slice(0, sep);
    const attackName   = label.slice(sep + 3);
    const attackStem   = ATTACK_FILE_STEMS[attackName];
    if (!attackStem) continue;

    const laydownLabel = formatLaydownName(laydownStem);
    const attackLabel  = formatAttackName(attackName);
    const attackJson   = attackJsons[attackName];
    const rowNum       = ri + 1;

    // Sim data for this combination (keyed by targetId)
    const comboKey  = `${laydownStem}__${attackStem}`;
    const comboSims = simData[comboKey] || [];
    const simByTarget = {};
    for (const s of comboSims) simByTarget[s.targetId] = s;

    const narrativeItems = [];
    for (const entry of attackJson.attacks) {
      const colIdx = colTargetIds.indexOf(entry.targetId);
      if (colIdx === -1) continue;

      const cellAddr = `${colLetters(colIdx)}${rowNum}`;
      const level    = cellLevels.get(cellAddr);
      if (!level) continue;

      const text = entry.narratives?.[level];
      if (!text) continue;

      // Parse attack composition + penetrators from cell value
      const cellValue = String(rows[ri][colIdx] || '');
      let attackComposition = '', penetrators = '';
      if (cellValue.includes('→')) {
        const parts = cellValue.split('→');
        attackComposition = parts[0].trim();
        penetrators       = parts[1].trim();
      } else {
        attackComposition = cellValue;
      }

      // Interceptors from sim data
      const simEntry   = simByTarget[entry.targetId] || {};
      const interceptors = simEntry.interceptors || { us: {}, allied: {} };

      // Coordinates
      const coords = targetCoords[entry.targetId] || {};

      narrativeItems.push({
        displayName: TARGET_DISPLAY[entry.targetId] || entry.targetId,
        level,
        text,
        attackComposition,
        penetrators,
        interceptors,
        lat: coords.lat ?? null,
        lon: coords.lon ?? null,
      });
    }

    combinations.push({
      laydownStem, laydownLabel,
      attackName,  attackLabel, attackStem,
      narrativeItems,
    });
  }

  console.log(`[update] ${combinations.length} combinations\n`);

  // 6. Launch Playwright ──────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const page    = await (await browser.newContext()).newPage();

  // 7. Build combined PDF ─────────────────────────────────────────────────────
  const combined      = await PDFDocument.create();
  const outlineGroups = [];
  let   curStem       = null;
  let   curGroup      = null;

  for (const combo of combinations) {
    if (combo.laydownStem !== curStem) {
      curStem  = combo.laydownStem;
      curGroup = { laydownLabel: combo.laydownLabel, attacks: [] };
      outlineGroups.push(curGroup);
    }

    const contentFile = path.join(outDir,
      `${combo.laydownStem}__${combo.attackStem}.pdf`);
    if (!existsSync(contentFile)) {
      console.warn(`  [SKIP] Missing: ${path.basename(contentFile)}`); continue;
    }

    // ── New title page ─────────────────────────────────────────────────────
    const titlePageIdx = combined.getPageCount();
    await page.setContent(
      buildTitlePageHtml(combo.laydownLabel, combo.attackLabel),
      { waitUntil: 'load' }
    );
    const titleBytes = await page.pdf({ format: 'Letter', printBackground: true });
    const titleDoc   = await PDFDocument.load(titleBytes);
    for (const p of await combined.copyPages(titleDoc, titleDoc.getPageIndices()))
      combined.addPage(p);

    // ── Existing content pages (unchanged) ──────────────────────────────
    const contentDoc = await PDFDocument.load(readFileSync(contentFile));
    for (const p of await combined.copyPages(contentDoc, contentDoc.getPageIndices()))
      combined.addPage(p);

    // ── New narrative page ───────────────────────────────────────────────
    const narrativePageIdx = combined.getPageCount();
    if (combo.narrativeItems.length > 0) {
      await page.setContent(
        buildNarrativeHtml(combo.laydownLabel, combo.attackLabel, combo.narrativeItems),
        { waitUntil: 'load' }
      );
      const narBytes = await page.pdf({ format: 'Letter', printBackground: true });
      const narDoc   = await PDFDocument.load(narBytes);
      for (const p of await combined.copyPages(narDoc, narDoc.getPageIndices()))
        combined.addPage(p);
    }

    // ── Duplex padding ───────────────────────────────────────────────────
    if (combined.getPageCount() % 2 !== 0) {
      const last           = combined.getPage(combined.getPageCount() - 1);
      const { width, height } = last.getSize();
      combined.addPage([width, height]);
    }

    curGroup.attacks.push({
      attackLabel: combo.attackLabel, titlePageIdx, narrativePageIdx,
    });

    console.log(`  ✓ ${combo.laydownLabel} / ${combo.attackLabel}`);
  }

  await browser.close();

  // 8. Add bookmarks ──────────────────────────────────────────────────────────
  addOutlines(combined, outlineGroups);

  // 9. Write output ───────────────────────────────────────────────────────────
  const outPath = path.join(outDir, 'combined_with_narratives_update.pdf');
  writeFileSync(outPath, await combined.save());
  console.log(`\n[update] Written: ${outPath}`);
  console.log(`[update] Total pages: ${combined.getPageCount()}`);
}

main().catch(err => {
  console.error('[update] Fatal:', err);
  process.exit(1);
});

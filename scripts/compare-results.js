#!/usr/bin/env node
/**
 * compare-results.js — Compare cell highlight colors between two results xlsx files.
 *
 * For every cell that is colored in either file, checks whether both files
 * agree on the color. Reports any disagreements with the column name, cell
 * value, and the two colors (indicating which file each came from).
 *
 * Usage:
 *   node scripts/compare-results.js <file-a.xlsx> <file-b.xlsx>
 */

import XLSXModule from 'xlsx';
const XLSX = XLSXModule;
import * as fs   from 'fs';
import * as path from 'path';

const WHITE = new Set(['FFFFFF', 'ffffff', '']);

function getRgb(cell) {
  const fg = cell?.s?.fgColor?.rgb;
  if (!fg || WHITE.has(fg)) return null;
  return fg.toUpperCase();
}

function colorLabel(rgb) {
  const map = {
    'FF0000': 'Red (Severe)',
    'FFC000': 'Orange (Moderate)',
    'FFFF00': 'Yellow (Mild)',
    '00B050': 'Green (None)',
    '92D050': 'Green (None)',
  };
  return map[rgb] ? `${map[rgb]} [#${rgb}]` : `#${rgb}`;
}

function parseSheet(filePath) {
  const wb = XLSX.readFile(filePath, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0]; // row 0: ["Combination", "Dubai", ...]

  // Build map: addr → { row, col, colName, value, rgb }
  const cells = new Map();
  for (const [addr, cell] of Object.entries(ws)) {
    if (addr.startsWith('!')) continue;
    const rgb = getRgb(cell);
    if (!rgb) continue;
    // Decode col/row from address
    const match = addr.match(/^([A-Z]+)(\d+)$/);
    if (!match) continue;
    const colLetters = match[1];
    const rowNum     = parseInt(match[2], 10);
    // Convert column letters to 0-based index
    let colIdx = 0;
    for (const ch of colLetters) colIdx = colIdx * 26 + (ch.charCodeAt(0) - 64);
    colIdx -= 1; // 0-based

    const colName = headers[colIdx] || colLetters;
    const rowLabel = rows[rowNum - 1]?.[0] || `Row ${rowNum}`; // "Combination" column value

    cells.set(addr, { addr, rowLabel, colName, value: cell.v ?? '', rgb });
  }
  return cells;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error('Usage: node scripts/compare-results.js <file-a.xlsx> <file-b.xlsx>');
  process.exit(1);
}

console.log(`File A: ${path.basename(fileA)}`);
console.log(`File B: ${path.basename(fileB)}\n`);

const cellsA = parseSheet(fileA);
const cellsB = parseSheet(fileB);

const allAddrs = new Set([...cellsA.keys(), ...cellsB.keys()]);
const disagreements = [];

for (const addr of [...allAddrs].sort()) {
  const a = cellsA.get(addr);
  const b = cellsB.get(addr);
  const rgbA = a?.rgb ?? null;
  const rgbB = b?.rgb ?? null;

  if (rgbA === rgbB) continue; // both null (uncolored) or same color

  disagreements.push({ addr, a, b, rgbA, rgbB });
}

if (disagreements.length === 0) {
  console.log('✓ All colored cells agree between the two files.');
  process.exit(0);
}

console.log(`${disagreements.length} disagreement(s) found:\n`);
console.log(`${'Address'.padEnd(6)}  ${'Column'.padEnd(28)}  ${'Combination (Row)'.padEnd(40)}  File A  →  File B`);
console.log('─'.repeat(140));

for (const { addr, a, b, rgbA, rgbB } of disagreements) {
  const colName  = (a?.colName  || b?.colName  || '?').slice(0, 27).padEnd(28);
  const rowLabel = (a?.rowLabel || b?.rowLabel || '?').slice(0, 39).padEnd(40);
  const colorA   = rgbA ? colorLabel(rgbA) : '(uncolored)';
  const colorB   = rgbB ? colorLabel(rgbB) : '(uncolored)';
  const value    = (a?.value || b?.value || '').toString().slice(0, 80);

  console.log(`${addr.padEnd(6)}  ${colName}  ${rowLabel}  ${colorA}  →  ${colorB}`);
  console.log(`        Value: ${value}`);
  console.log();
}

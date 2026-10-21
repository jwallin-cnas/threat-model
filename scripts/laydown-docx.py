#!/usr/bin/env python3
"""
laydown-docx.py — Render a laydown JSON file as a Word document.

Self-contained: uses only the Python standard library. The .docx is written
directly as WordprocessingML inside a zip archive, so no python-docx or
other package is needed.

Document layout (all Times New Roman):
  • Title: the laydown's "name" in ALL CAPS — 14 pt, bold, centered.
  • "Generated at: <date, time>" — 12 pt, centered, timestamp of the run.
  • Locations grouped by country (targets.json "country"). Countries appear
    in the order they first occur in the laydown file; locations keep their
    file order within a country. Each group is:
      – country name — 12 pt, bold, left.
      – one block per location in that country:
          · location display name (targets.json "name") — 12 pt, bold, left.
          · one line per system at that location — 12 pt, left:
                "<System> (<Operator>) -- Quantity: <n>, Chips: <n>"
    A target id that is not in targets.json goes under "Other", last.

Quantity is the file value (file units, not batteries). Chips is the file's
`chips` field; a legacy `reloads` field is read when `chips` is absent, and
a missing value means 1 (the initial load only).

Output file: "<laydown name>_<YYYY-MM-DD>_<HHMM>.docx" next to the input
file (or in --out-dir). The name is sanitised for the filesystem.

Usage:
  python3 scripts/laydown-docx.py <laydown.json> [--out-dir DIR]
                                  [--targets data/targets.json]
                                  [--defenses data/defenses.json]

Display names default to the repo's data files, located relative to this
script. Unknown target or system ids fall back to a title-cased id and are
reported on stderr.
"""

import argparse
import datetime as _dt
import json
import pathlib
import re
import sys
import zipfile
from xml.sax.saxutils import escape

ROOT          = pathlib.Path(__file__).resolve().parent.parent
TARGETS_PATH  = ROOT / 'data' / 'targets.json'
DEFENSES_PATH = ROOT / 'data' / 'defenses.json'

OTHER_COUNTRY = 'Other'   # heading for target ids missing from targets.json

FONT      = 'Times New Roman'
TITLE_PT  = 14
BODY_PT   = 12


# ── Display-name lookups ──────────────────────────────────────────────────────

def load_targets(path: pathlib.Path) -> dict:
    """{ target id: (display name, country) } from targets.json."""
    data = json.loads(path.read_text(encoding='utf-8'))
    items = data.get('targets', data) if isinstance(data, dict) else data
    return {t['id']: (t.get('name', t['id']), t.get('country') or OTHER_COUNTRY)
            for t in items if 'id' in t}


def load_system_names(path: pathlib.Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    items = data.get('systems', data) if isinstance(data, dict) else data
    return {s['id']: s.get('name', s['id']) for s in items if 'id' in s}


def fallback_name(raw_id: str) -> str:
    """'gulf_of_oman_place_point' → 'Gulf Of Oman Place Point' (last resort)."""
    return ' '.join(w.capitalize() for w in raw_id.split('_'))


def chips_of(entry: dict) -> int:
    raw = entry.get('chips', entry.get('reloads'))
    if raw is None or raw == '':
        return 1
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return 1
    n = max(0.0, n)
    return int(n) if n.is_integer() else n


def fmt_num(n) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


# ── WordprocessingML ──────────────────────────────────────────────────────────

def run_props(size_pt: int, bold: bool) -> str:
    half_points = size_pt * 2
    return (
        '<w:rPr>'
        f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}" w:eastAsia="{FONT}"/>'
        + ('<w:b/><w:bCs/>' if bold else '')
        + f'<w:sz w:val="{half_points}"/><w:szCs w:val="{half_points}"/>'
        '</w:rPr>'
    )


def paragraph(text: str, size_pt: int, bold: bool = False, center: bool = False,
              space_after_twips: int = 0) -> str:
    jc = '<w:jc w:val="center"/>' if center else ''
    spacing = f'<w:spacing w:after="{space_after_twips}"/>'
    return (
        '<w:p>'
        f'<w:pPr>{spacing}{jc}</w:pPr>'
        f'<w:r>{run_props(size_pt, bold)}'
        f'<w:t xml:space="preserve">{escape(text)}</w:t>'
        '</w:r>'
        '</w:p>'
    )


def empty_paragraph() -> str:
    return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'


def build_document_xml(title: str, generated_line: str, groups: list) -> str:
    """groups: list of (country, [(location_name, [system_line, ...]), ...]).

    The country heading sits directly above its first location. A blank
    line separates consecutive locations, within a country and across
    countries alike.
    """
    body = [
        paragraph(title, TITLE_PT, bold=True, center=True),
        paragraph(generated_line, BODY_PT, center=True),
        empty_paragraph(),
    ]
    first = True
    for country, blocks in groups:
        for j, (loc, lines) in enumerate(blocks):
            if not first:
                body.append(empty_paragraph())
            first = False
            if j == 0:
                body.append(paragraph(country, BODY_PT, bold=True))
            body.append(paragraph(loc, BODY_PT, bold=True))
            for line in lines:
                body.append(paragraph(line, BODY_PT))
    body.append(
        '<w:sectPr>'
        '<w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
        'w:header="720" w:footer="720" w:gutter="0"/>'
        '</w:sectPr>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>' + ''.join(body) + '</w:body>'
        '</w:document>'
    )


CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    '<Override PartName="/docProps/core.xml" '
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    '<Override PartName="/docProps/app.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    '</Types>'
)

ROOT_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '<Relationship Id="rId2" '
    'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
    'Target="docProps/core.xml"/>'
    '<Relationship Id="rId3" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
    'Target="docProps/app.xml"/>'
    '</Relationships>'
)

DOCUMENT_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/>'
    '</Relationships>'
)

# Document defaults also set Times New Roman 12 pt so any paragraph without
# explicit run properties still renders in the right face.
STYLES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:docDefaults>'
    '<w:rPrDefault><w:rPr>'
    f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:cs="{FONT}" w:eastAsia="{FONT}"/>'
    f'<w:sz w:val="{BODY_PT * 2}"/><w:szCs w:val="{BODY_PT * 2}"/>'
    '</w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    '</w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    '</w:styles>'
)


def core_xml(title: str, now_utc: _dt.datetime) -> str:
    stamp = now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties '
        'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>{escape(title)}</dc:title>'
        '<dc:creator>laydown-docx.py</dc:creator>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{stamp}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{stamp}</dcterms:modified>'
        '</cp:coreProperties>'
    )


APP_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    '<Application>laydown-docx.py</Application>'
    '</Properties>'
)


def write_docx(path: pathlib.Path, document_xml: str, title: str, now_utc: _dt.datetime) -> None:
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
        z.writestr('_rels/.rels', ROOT_RELS_XML)
        z.writestr('word/document.xml', document_xml)
        z.writestr('word/_rels/document.xml.rels', DOCUMENT_RELS_XML)
        z.writestr('word/styles.xml', STYLES_XML)
        z.writestr('docProps/core.xml', core_xml(title, now_utc))
        z.writestr('docProps/app.xml', APP_XML)


# ── Main ──────────────────────────────────────────────────────────────────────

def safe_filename(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', ' ', name).strip().rstrip('.')
    cleaned = re.sub(r'\s+', '_', cleaned)
    return cleaned or 'laydown'


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Render a laydown JSON file as a .docx.')
    ap.add_argument('laydown', type=pathlib.Path, help='laydown JSON file (defaults.json shape)')
    ap.add_argument('--out-dir', type=pathlib.Path, default=None,
                    help='directory for the .docx (default: next to the input file)')
    ap.add_argument('--targets', type=pathlib.Path, default=TARGETS_PATH,
                    help=f'targets catalog for location names and countries (default: {TARGETS_PATH})')
    ap.add_argument('--defenses', type=pathlib.Path, default=DEFENSES_PATH,
                    help=f'defenses catalog for system display names (default: {DEFENSES_PATH})')
    args = ap.parse_args(argv)

    try:
        data = json.loads(args.laydown.read_text(encoding='utf-8'))
    except (OSError, ValueError) as err:
        print(f'[laydown-docx] Cannot read laydown: {err}', file=sys.stderr)
        return 1
    defaults = data.get('defaults') if isinstance(data, dict) else None
    if not isinstance(defaults, dict):
        print('[laydown-docx] Laydown has no "defaults" object.', file=sys.stderr)
        return 1

    try:
        targets      = load_targets(args.targets)
        system_names = load_system_names(args.defenses)
    except (OSError, ValueError, KeyError) as err:
        print(f'[laydown-docx] Cannot read catalog: {err}', file=sys.stderr)
        return 1

    name = (data.get('name') or '').strip() if isinstance(data.get('name'), str) else ''
    if not name:
        name = args.laydown.stem.replace('_', ' ')

    now = _dt.datetime.now()
    generated_line = f'Generated at: {now.strftime("%H:%M, %B %-d, %Y")}'

    unknown_targets, unknown_systems = [], []
    by_country = {}   # country → [(location, lines)], insertion order = first occurrence
    for target_id, entries in defaults.items():
        if not isinstance(entries, list) or not entries:
            continue
        if target_id in targets:
            loc, country = targets[target_id]
        else:
            unknown_targets.append(target_id)
            loc, country = fallback_name(target_id), OTHER_COUNTRY
        lines = []
        for e in entries:
            if not isinstance(e, dict) or not e.get('system'):
                continue
            sys_id = e['system']
            sys_name = system_names.get(sys_id)
            if sys_name is None:
                unknown_systems.append(sys_id)
                sys_name = fallback_name(sys_id)
            operator = e.get('operator') or ''
            qty = e.get('quantity', 1)
            label = f'{sys_name} ({operator})' if operator else sys_name
            lines.append(f'{label} -- Quantity: {fmt_num(qty)}, Chips: {fmt_num(chips_of(e))}')
        if lines:
            by_country.setdefault(country, []).append((loc, lines))

    # "Other" (ids missing from targets.json) always goes last.
    groups = [(c, b) for c, b in by_country.items() if c != OTHER_COUNTRY]
    if OTHER_COUNTRY in by_country:
        groups.append((OTHER_COUNTRY, by_country[OTHER_COUNTRY]))
    n_locations = sum(len(b) for _, b in groups)

    out_dir = args.out_dir or args.laydown.resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f'{safe_filename(name)}_{now.strftime("%Y-%m-%d_%H%M")}.docx'

    document_xml = build_document_xml(name.upper(), generated_line, groups)
    write_docx(out_path, document_xml, name, _dt.datetime.utcnow())

    for t in sorted(set(unknown_targets)):
        print(f'[laydown-docx] Unknown target id "{t}" — used "{fallback_name(t)}"', file=sys.stderr)
    for s in sorted(set(unknown_systems)):
        print(f'[laydown-docx] Unknown system id "{s}" — used "{fallback_name(s)}"', file=sys.stderr)
    print(f'[laydown-docx] {n_locations} location(s) in {len(groups)} country group(s) → {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

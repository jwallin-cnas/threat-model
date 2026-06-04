#!/usr/bin/env python3
"""
merge-laydowns.py — Re-merge defaults.json with each standalone laydown file.

Merge rules (additive):
  1. Start with every entry in defaults.json for every target.
  2. For each target in the standalone file:
       a. If the target already has an entry with the SAME system in defaults:
            → add the standalone quantity to the existing entry (keep defaults id/operator/notes).
       b. If the system is new for that target:
            → append the standalone entry unchanged.
       c. If the target does not exist in defaults at all:
            → include all standalone entries for it as-is.
  3. The merged file carries the standalone's "name" field.

Output: data/batch/laydowns/<stem>_merged.json  (overwrites existing files)
"""

import json
import pathlib
import sys
import copy

ROOT         = pathlib.Path(__file__).resolve().parent.parent
DEFAULTS_PATH = ROOT / 'data' / 'defaults.json'
STANDALONE_DIR = ROOT / 'data' / 'batch' / 'laydowns' / 'standalone'
MERGED_DIR     = ROOT / 'data' / 'batch' / 'laydowns'


def merge(defaults: dict, standalone: dict) -> dict:
    """
    Both arguments are 'defaults' dicts: { targetId: [entry, ...] }.
    Returns the merged dict following the rules above.
    """
    # Deep-copy defaults as starting point so we don't mutate the original
    result = copy.deepcopy(defaults)

    for target_id, sa_entries in standalone.items():
        if target_id not in result:
            # Target is only in standalone — include as-is
            result[target_id] = copy.deepcopy(sa_entries)
            continue

        # Target exists in both — merge entry-by-entry by system id
        existing = result[target_id]
        existing_by_system = {e['system']: e for e in existing}

        for sa_entry in sa_entries:
            system = sa_entry['system']
            if system in existing_by_system:
                # Same system — add quantities
                existing_by_system[system]['quantity'] += sa_entry['quantity']
            else:
                # New system for this target — append
                existing.append(copy.deepcopy(sa_entry))

    return result


def main():
    defaults_data = json.loads(DEFAULTS_PATH.read_text())
    defaults      = defaults_data['defaults']

    standalone_files = sorted(STANDALONE_DIR.glob('*.json'))
    if not standalone_files:
        print(f'No standalone files found in {STANDALONE_DIR}')
        sys.exit(1)

    for sa_path in standalone_files:
        sa_data = json.loads(sa_path.read_text())
        sa_defaults = sa_data['defaults']
        sa_name     = sa_data.get('name')          # preserve strategy name
        sa_version  = sa_data.get('version', '1.0')

        merged_defaults = merge(defaults, sa_defaults)

        # Derive output filename: strip trailing .json, append _merged.json
        stem = sa_path.stem                        # e.g. "strategy_1_gulf_coast"
        if stem.endswith('_merged'):
            stem = stem[:-len('_merged')]
        out_path = MERGED_DIR / f'{stem}_merged.json'

        out_data = {'version': sa_version}
        if sa_name:
            out_data['name'] = sa_name
        out_data['defaults'] = merged_defaults

        out_path.write_text(json.dumps(out_data, indent=2) + '\n')

        n_targets = len(merged_defaults)
        n_entries = sum(len(v) for v in merged_defaults.values())
        print(f'  {sa_path.name} → {out_path.name}  '
              f'({n_targets} targets, {n_entries} total entries)')

    print('Done.')


if __name__ == '__main__':
    main()

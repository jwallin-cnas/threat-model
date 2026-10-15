# Engagement configuration: Pk table and doctrine

The simulation engine (`js/engine.js`) is driven by two JSON files instead of
code. Both ship with defaults in `data/`, both can be built in a browser page,
and both can be imported into the tool from its header.

| File | Says | Builder page | Tool button | Storage key |
|---|---|---|---|---|
| `data/pk-table.json` | How well each defense system engages each attack platform | `pk/` | Import Pk Table | `threatmodel_pk_v1` |
| `data/doctrine.json` | Which systems engage each threat type, and in what order | `doctrine/` | Import Doctrine | `threatmodel_doctrine_v1` |

An imported file overrides the default in that browser until **Reset to
Default**. The header badges show which pair is active. Every history snapshot
records the name and a hash of the pair that produced it; when a displayed
result was made under a different pair, a notice says so.

## Pk table

```json
{
  "version": "1.0",
  "name": "Baseline",
  "tiers": { "low": 1.0, "medium": 1.0, "high": 1.0 },
  "cells": {
    "patriot": { "geran_2": { "pk": 0.4687, "shots": 3 }, "fateh_110": { "pk": 0.6127, "shots": 2 } }
  }
}
```

- `cells[systemId][platformId]` holds `pk`, the **per-shot** probability of
  kill (0 to 1), and `shots`, the interceptors fired at one threat.
- `pk = 0` means the system cannot engage that platform. The engine records a
  "Cannot engage" row and spends nothing. A missing cell is treated as 0 and
  reported as a warning on import.
- `tiers` are multipliers applied to `pk` after a random roll (u ≥ 0.67 high,
  u ≥ 0.33 medium, else low). With all three at 1.0 no roll happens and the
  result is deterministic. The legacy spread was 0.70 / 0.85 / 1.00 per
  engagement; the equivalent here is roughly 0.82 / 1.0 / 1.18.
- The shipped defaults are the legacy per-engagement values converted to per
  shot with `p = 1 − (1 − P)^(1/shots)`, so expected outcomes are unchanged:
  Patriot's 0.85 at 3 shots against a drone becomes 0.4687.

Schema: `data/schemas/pk-table.schema.json`.

## Doctrine

```json
{
  "version": "1.0",
  "name": "Baseline",
  "typeOrder": ["mrbm", "srbm", "cruise_missile", "drone_jet", "drone", "fpv"],
  "engage": { "mrbm": ["aegis_sm3", "thaad", "arrow", "patriot"], "drone": ["f15e_patrol", "patriot"] }
}
```

- `typeOrder` is the order threat types are processed. Magazine spent on an
  earlier type carries into later ones.
- `engage[type]` lists the systems allowed to engage that type, outermost
  first. A system absent from a list never engages that type, whatever the Pk
  table says.
- The doctrine is the only statement of capability: the capability chips on
  defense cards and the cross-target range filter are derived from it.
  Range (`range_km`, `threat_range_overrides`) still decides, per battery and
  per case, whether an engagement can happen.

Schema: `data/schemas/doctrine.schema.json`.

## Engagement models

Each system names a model in its `engagement` block in `data/defenses.json`.
The model turns a cell into the probability `P` that one engaged threat is
killed and the magazine cost per threat (`js/engagement-models.js`).

| Model | P for one threat | Magazine | Parameters |
|---|---|---|---|
| `kinetic` | 1 − (1 − pk)^shots | `shots` per threat | `shotRoll[type] = { chance, shots }` replaces the shot count on a roll (THAAD: 10 % chance of 1.5 against MRBM) |
| `directed_energy` | pk, scaled so kills per pass stay under `killCapPerPass` | none | `killCapPerPass` (lasers 10, jammer 5) |
| `gun` | pk per burst, `burstsPerPass` bursts per pass | `shots` rounds per burst | `burstsPerPass` (Phalanx 1, 150 rounds) |
| `patrol` | pk for the first `cap` threats, `pLow` beyond, folded into one P | `shots` per threat | `cap`, `pLow` (F-15E: 20, 0.5) |

Caps apply per threat type per run and are shared across the platforms of
that type, in attack-manifest order.

## Processing order

```
for type in doctrine.typeOrder
  for platform of that type, in manifest order
    for systemId in doctrine.engage[type]
      for every deployed battery of that system (in range, not excluded)
        P, cost ← model(cell, remaining)
        kills   ← round(engaged × P)        # engaged = min(remaining, floor(magazine / cost))
```

Results are grouped `byThreatType[].platforms[].engagements[]`. Manual
overrides in the tool are keyed by type, platform and battery.

## Regenerating and checking the defaults

```bash
npm run defaults   # rebuild pk-table.json, doctrine.json and the engagement blocks from the legacy code at git ref 9bded9b
npm run parity     # compare the engine against the legacy engine on every batch combination
npm run e2e        # browser checks of the tool and both builders
npm run batch -- --pk my-table.json --doctrine my-doctrine.json   # batch with a custom pair
```

Parity passes in two stages: both engines pinned to the medium tier must agree
within ±2 (fixed-Pk systems exactly), and both averaged over 50 seeds within
±5 (interceptors judged in units of one engagement).

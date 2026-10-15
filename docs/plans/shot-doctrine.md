# Plan: Shot doctrine (firing patterns) in the Doctrine Builder

Status: design agreed on 2026-10-15, not yet built.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Ownership | The doctrine owns the shot count as a firing pattern per system × threat type. The Pk table keeps `pk` only; its `shots` field and the Pk builder's shots input are removed. |
| 2 | Vocabulary | Fixed menu of six patterns: `S`, `S-S`, `S-S-S`, `S-L-S`, `S-S-L-S`, `S-L-S-L-S`. |
| 3 | THAAD | The random 1.5-shot roll is removed. THAAD vs MRBM becomes `S-L-S`; vs SRBM `S-S`. The engine has no random element left. |

## Semantics

A pattern is salvos separated by looks. With per-shot Pk `p` and salvo sizes
a₁, a₂, …:

- Kill probability for one threat: `P = 1 − (1 − p)^(a₁ + a₂ + …)`.
  Looks never change P; they only avoid wasted shots.
- Expected interceptors per threat: `E[s] = a₁ + (1−p)^a₁·a₂ + (1−p)^(a₁+a₂)·a₃ + …`.
- Magazine cost is the expected value (fractional, like THAAD's 1.5 today).
  Kills remain `round(engaged × P)`, consistent with the current model.
- Partial final engagement: the leftover rounds fire the longest prefix of
  the pattern they can afford (counting expected cost salvo by salvo);
  the reduced P uses the shots in that prefix.

| Pattern | Total shots | E[s] at p = 0.47 | E[s] at p = 0.61 | E[s] at p = 1.0 |
|---|---|---|---|---|
| S | 1 | 1.00 | 1.00 | 1.00 |
| S-S | 2 | 2.00 | 2.00 | 2.00 |
| S-S-S | 3 | 3.00 | 3.00 | 3.00 |
| S-L-S | 2 | 1.53 | 1.39 | 1.00 |
| S-S-L-S | 3 | 2.28 | 2.15 | 2.00 |
| S-L-S-L-S | 3 | 1.81 | 1.54 | 1.00 |

Models: only `kinetic` uses a pattern. `patrol` stays one shot per threat
(pattern S), `gun` keeps bursts, `directed_energy` has no magazine.

## File formats

### doctrine.json

```json
{
  "version": "1.1",
  "name": "Baseline",
  "typeOrder": ["mrbm", "srbm", "cruise_missile", "drone_jet", "drone", "fpv"],
  "locked": ["f15i_patrol"],
  "engage": { "mrbm": ["aegis_sm3", "thaad", "..."], "...": [] },
  "fire":   { "mrbm": { "thaad": "S-L-S", "patriot": "S-S" }, "drone": { "patriot": "S-S-S" } }
}
```

- `fire[type][systemId]` is one of the six patterns. A missing entry means
  `S`. Entries for systems not in `engage[type]` are dropped with a warning.
- `normalizeDoctrine()` validates patterns against the menu.
- Version bumps to 1.1; a 1.0 file without `fire` imports with every kinetic
  system at `S` and a warning that says so (the legacy shot counts are
  gone from the Pk table, so the importer cannot invent them).

### pk-table.json

Cells become `{ "pk": 0.4687 }`. The importer accepts the old `{ pk, shots }`
shape and ignores `shots` with one warning per file. Version bumps to 1.1.

### defenses.json

`engagement.shotRoll` is removed from THAAD and from the schema.

### Generated defaults

`generate-engagement-defaults.js` writes `fire` from the legacy shot counts:
shots 1 → `S`, 2 → `S-S`, 3 → `S-S-S`; THAAD mrbm → `S-L-S` (decision 3).
Pk cells drop `shots`. `--clone` copies the source's patterns too.

## Engine

- `runSimulationCore()` resolves the pattern for (systemId, threatType) from
  `doctrine.fire`, parses it once into salvo sizes, and passes `pattern` in
  the model context instead of `shots`.
- `kinetic.probability(ctx)` → `1 − (1 − pk)^totalShots`;
  `kinetic.shotsPerThreat(ctx)` → `E[s]`; `partialProbability` → prefix rule.
- Records gain `pattern` and keep `shotsPerEngagement` = E[s]
  (`cellShots` goes away). The override re-walk reads `pattern` from the record.
- `shotsPerEngagementTier` and the THAAD roll are removed.

## Builder pages

- Doctrine Builder: each kinetic card gets a compact `<select>` of the six
  patterns beside the tier line; non-kinetic cards show their fixed rule as
  text ("1 shot", "burst", "no magazine"). Changing a pattern persists the
  draft. Locked cards keep their pattern editable (the lock is about position).
  Import/export carry `fire`. A column header menu "set all to …" is optional
  and left out of the first cut.
- Pk Builder: the shots input is removed; cells show pk only; the legend and
  summary text are updated; import tolerates the old shape.

## Tool

- Results rows: tooltip "S-L-S · 1.53 expected per drone"; prose names the
  pattern ("fired shoot-look-shoot at a per-shot Pk of 0.47, 1.53 interceptors
  expected per drone, an engagement Pk of 0.72").
- Print document: Shots column shows `S-L-S (1.53)`.
- Nothing else changes: imports, badges, hashes, snapshots all work on the
  doctrine object as before.

## Scripts and checks

- Parity: with the generated defaults every pattern is no-look except THAAD
  vs MRBM, which becomes deterministic `S-L-S`; its legacy counterpart rolled
  1.5 shots 10 % of the time. Stage 1 (both pinned) is unaffected; stage 2
  loses that noise. The `--full-doctrine` flag keeps working.
- Unit tests: pattern parsing, P and E[s] for each menu entry, partial prefix
  rule, normalizer validation, THAAD default.
- e2e: card select changes the export; Pk builder without shots; tool
  tooltip shows the pattern.
- docs/ENGAGEMENT.md: pattern section and the updated table.

## Phases

| Phase | Work | Size |
|---|---|---|
| 1 | Formats, schemas, generator, regenerated defaults | S |
| 2 | Engine + kinetic model + tests | M |
| 3 | Doctrine Builder select; Pk Builder shots removal | M |
| 4 | Tool display, print, override re-walk | S |
| 5 | Parity, e2e, docs | S |

## Assumptions

- Expected-value magazine accounting (fractional) rather than sampling
  whether each look happened. This keeps the engine deterministic and
  matches how kills are already computed.
- Looks are free: no time or detection penalty is modelled.
- A pattern applies to every platform of the type; per-platform differences
  are not supported (none exist in today's data).

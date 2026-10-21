# Plan: Type-ahead system and platform search in the Blue and Red builders

Status: design agreed 2026-10-21. Not built. All decisions are recorded
under "Decided" at the end.

## Goal

In the Blue Builder's "Add Defense System" form and the Red Builder's
attack columns, the user types part of a name, sees the matching entries,
and presses Enter to choose one. Enter then moves focus to the next field,
because the user picks the system first and the other values after it.
Example: in Blue, type `Pat`, press Enter, and Patriot is chosen with focus
in Quantity; type `4`, Enter, type `Bah` for Bahrain, Enter, and so on.

## Where it applies

| Page | Today | After |
|---|---|---|
| Blue Builder, each target card | `<select class="tc-system">` with Presets and Systems groups | Type-ahead box over the same list |
| Blue Builder, each target card | `<select class="tc-operator">` of operator nations | Type-ahead box over the same list |
| Red Builder, each attack column | `<select class="rc-platform">` grouped by threat type | Type-ahead box over the same list |

Out of scope (decided): the Red "Target" select, and the main tool's own
Add Defense and Platform selects.

## Approach

One shared component in `js/builder-common.js`, used by both pages. No new
library and no build step, in line with the rest of the app.

```js
attachTypeAhead(input, {
  items,        // [{ id, label, group, keywords }]
  onPick,       // (item, how) => void   how = 'enter' | 'click' | 'tab'
  placeholder,  // "Type to search systems…"
});
```

- `items` is built from the same sources the selects use today:
  `DEFENSE_CATALOG` plus `BUILDER_DATA.presets` for the Blue system box,
  `operatorOptions()` for the Blue operator box (no groups), and
  `PLATFORM_CATALOG` grouped by `PLATFORM_GROUP_LABELS` for Red. `fillSystemSelect()` and
  `fillPlatformSelect()` are refactored to build this item list so the
  grouping and sort order stay in one place.
- The markup follows the WAI-ARIA combobox pattern: a text input with
  `role="combobox"`, a popup `role="listbox"`, `aria-activedescendant` for
  the highlighted row. Group headings are shown in the popup as they are in
  the select today.
- The native `<datalist>` was considered and rejected. It cannot show
  group headings, its matching rules differ between Chrome and Safari, and
  it gives no control over what Enter does.

## Matching and ranking

Case-insensitive. Each item is searched on its display name, its id, and the
abbreviation in parentheses at the end of the name (THAAD, NASAMS, IFPC-2,
FS-LIDS). Results are ranked, then kept in catalog order within a rank:

1. Name starts with the query (`Pat` → Patriot).
2. A word in the name starts with the query (`dome` → Iron Dome,
   `SM` → Aegis SM2, SM3, SM6).
3. Abbreviation or id starts with the query (`thaad`, `nasams`, `hpm`).
4. Query appears anywhere in the name (`atr` → Patriot, Patrol entries).

So `Pat` lists Patriot first, then the three Patrol entries. Enter takes the
first row unless the user moved the highlight.

Operators use the same ranking. Their keywords add the usual
abbreviations: `US` and `U.S.` for United States, `UAE` and `U.A.E.` for
United Arab Emirates, `KSA` for Saudi Arabia. `Arab` lists Saudi Arabia and
United Arab Emirates by word match. The abbreviation table moves from
`js/app.js` into `js/builder-common.js` only if the tool also needs it;
otherwise the builders keep their own short copy.

## Keyboard and mouse

| Input | Popup closed | Popup open |
|---|---|---|
| Typing | Opens the popup, filters | Filters; highlight resets to the first row |
| ↓ / ↑ | Opens the popup | Moves the highlight, wrapping at the ends |
| Enter | Moves to the next field if a valid value is chosen | Picks the highlighted row and moves to the next field |
| Tab | Normal focus move | Picks the highlighted row, then the normal focus move |
| Escape | Clears the box | Closes the popup, keeps the text |
| Click on a row | — | Picks that row |
| Focus or click on the empty box | Shows the full grouped list | — |

No match shows "No matching systems" in the popup. Enter then does nothing
and the box keeps the text. A type-ahead box only accepts values from its
list: on blur with text that is not a valid choice, it reverts to the last
valid value (or to empty for the system and platform boxes).

## Page wiring

**Blue.** The form is filled top to bottom with Enter:

| Field | On Enter |
|---|---|
| System (type-ahead) | Choose the highlighted system, then focus Quantity with its text selected. For a preset or patrol asset, Quantity is locked at 1, so focus skips to Operator. |
| Quantity | Focus Operator. |
| Operator (type-ahead) | Choose the highlighted operator, then focus Chips. |
| Chips | Focus Notes. The chips field stays a dropdown; Enter is intercepted so it advances instead of opening the menu, and typing a digit still picks a value. |
| Notes | Add the system (today's behaviour). |

The Add System button still adds from any field. The system pick feeds the
same logic as today's `change` handler: presets and patrol assets lock
quantity to 1, and the magazine hint refreshes. After an add, the system box
clears and takes focus, Quantity resets to 1 and Chips to 1, Notes clears,
and Operator keeps its value, because consecutive systems at one target
usually share an operator. The operator box opens with "United States",
as the dropdown does today; on focus its text is selected, so typing
replaces it. `openForm()` focuses the system box; `closeForm()` resets
every field.

**Red.**

| Field | On Enter |
|---|---|
| Platform (type-ahead) | Choose the highlighted platform, seed Salvo with its first salvo size, then focus Salvo with the text selected so typing replaces it. |
| Salvo | Add the platform at that salvo (today's behaviour), then clear both fields and focus the platform box for the next entry. |

## Checks

- `npm run e2e` gains builder checks for both pages:
  - Blue, keyboard only: `Pat` Enter, `4` Enter, `Bah` Enter, `6` Enter,
    Enter adds Patriot × 4, Bahrain, 6 chips, and focus returns to the
    system box with Operator still Bahrain.
  - `Pat` + ↓ + Enter chooses the first Patrol entry and focus skips to
    Operator, since quantity is locked.
  - `thaad` and `sm` match by abbreviation and by word; `uae` and `us`
    match operators.
  - A preset is found and locks quantity to 1.
  - No-match text, then Enter, does nothing; blur reverts invalid operator
    text to the last valid operator.
  - Escape closes the popup; a click on a row picks it.
  - Red, keyboard only: `Fat` Enter focuses Salvo seeded with Fateh-110's
    first salvo size; `12` Enter adds 12 and focus returns to the platform
    box.
  - Export after type-ahead adds is identical to export after select adds.
- Manual pass in Safari and Chrome, plus a 375 px viewport for the popup.

## Phases

| Phase | Work | Size |
|---|---|---|
| 1 | `attachTypeAhead()`, item builders, matching, CSS for the popup | M |
| 2 | Blue wiring: system and operator boxes, Enter-advances field order | S |
| 3 | Red wiring: platform box, Enter to Salvo, Salvo Enter adds | S |
| 4 | e2e checks, browser pass | S |

The change touches only the two builder pages and their shared helper. The
tool, the engine, file formats and batch scripts are unaffected, so it can
ship during the live test without changing any results.

## Decided

- **Enter moves focus forward** (2026-10-21). In the system or platform box,
  Enter chooses and moves to Quantity or Salvo. The operator also gets a
  type-ahead box. Only the last field (Notes in Blue, Salvo in Red) adds.
- **Search boxes replace the dropdowns** (2026-10-21). Focusing or clicking
  an empty box shows the full grouped list, so browsing still works.
- **Scope is the builders' System, Operator and Platform fields**
  (2026-10-21). The Red Target field and the main tool's Add Defense and
  Platform fields keep their dropdowns.

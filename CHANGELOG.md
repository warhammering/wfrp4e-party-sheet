# Changelog

All notable changes to this module are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-21

### Added

- Member cards now show the member's **current career and social status** beside the name, e.g.
  `Bertelis d'Charleux    Knight Errant - Gold 1`. Only the career flagged **Current** on the
  actor's career list is used — an untagged or completed career is never shown. If there is no
  current career the status shows alone; if there is no status the career shows alone; if there
  is neither, nothing is shown. Hidden entirely on cards whose "Show stats" is off.
- **GMs can set a coin stack's quantity inline** on the money rows, the same quick-edit the
  trapping rows use. (Coins still move between actors through Deposit / Withdraw Coins, which
  works on total value.)
- **The party pool now follows your Item Piles currency setup.** If you have replaced the core
  Gold Crown / Silver Shilling / Brass Penny with your own denominations — Golden Thaler,
  Silbergold Nobel, whatever your Empire runs on — the money summary, the Deposit / Withdraw
  dialog, Consolidate and the seeded coin rows all use them, with your own abbreviations.
  Worlds without Item Piles, or with the stock three, behave exactly as before.
- **Secondary currencies get their own row.** Item Piles currencies with no exchange rate are
  shown separately and moved as whole units. They are deliberately left out of the pool grand
  total and out of Consolidate — there is no defensible rate at which to add or split something
  that has no rate.
- Editing your currencies in the Item Piles Currencies Editor updates the sheet without a world
  reload.

### Changed

- The GM tag dropdown (Companion / Henchman) and the remove-member ✕ moved off the name line
  into the space **under the portrait**, freeing the name line for career/status. The "Show
  stats" toggle joins them in that column, and the card is roomier to fit it.
- Member cards survive a narrowed sheet: career/status drops to its own line under the name
  instead of being clipped, and Fortune / Resolve / Movement wrap inside their own column
  instead of bleeding across the divider. Each label+number stays together when they wrap.
- **Value column hides empty denominations.** A 5-brass item now reads `5d` instead of
  `0GC 0SS 5BP`; a free item shows a dash. The grand-total row uses the same short form. The money
  summary at the top is unchanged.
- The member tag dropdown now reads **Companion** / **Henchman** (singular — you tag one member).
  The section headings stay **Companions** / **Henchmen** (a group).
- Inventory column headers enlarged and all cells (header + rows) vertically centred, so
  Qty. / Enc. / Value line up with the column name. Rows tightened to the item icon's height —
  no extra space below the row and the icon sits flush to the left edge.
- The Deposit / Withdraw Coins dialog now shows one field per configured denomination instead
  of a fixed three, and the Value column widens to fit longer coin strings rather than clipping
  them.

### Fixed

- **Worn items deposited into the pool now show their true weight.** A worn Leather Jack (and
  other clothing/armour/containers that weigh less while equipped) was carrying its reduced
  encumbrance into the shared pool — reading 0 instead of 1, and undercounting the pool's total
  load. Items are now un-equipped on deposit, so their encumbrance reflects the unworn value.
  Withdraw an item and re-equip it as normal.
- Capacity now displays a clean 2-decimal number (e.g. `18.18 / 27`) instead of a floating-point
  tail like `18.180000000000003`. Also tidies the number in the capacity-limit warning.
- `download` in `module.json` was still pinned to the v0.2.3 release zip, so v0.2.4–v0.2.6
  installs and updates silently fetched v0.2.3. Now tracks the current release.
- **Consolidate no longer mishandles coins outside your currency setup.** A stray coin from a
  previous configuration used to be counted toward the total but never redistributed, so
  Consolidate failed its own safety check and refused to run. Such coins are now left alone as
  their own stack and excluded from the maths.
- Consolidate refuses to run, with a warning, if your denominations cannot make exact change
  (each larger coin must divide evenly into the next, down to a base unit of 1). Deposits and
  withdrawals of whole coins keep working.
- A failed coin transfer can no longer leave money on the receiver that the payer was never
  charged for. Found during validation of the currency work.

### Note

- If the sheet looks broken after updating, the client is running cached code — reload with
  **Ctrl+F5**.

## [0.2.0] — 2026-07-20

Four requested features, plus the fixes that surfaced while validating them.

### Added

- **Quest Items.** A GM-only section of the shared pool with its own drop zone. Flagged items
  leave their normal category and are excluded from the grand total. Every UI path that could
  remove or alter a pooled item — withdraw, delete, set-quantity, move, set-party-quantity —
  refuses a non-GM request touching a quest item. Protection is UI-level by design; console
  access is not restricted.
- **Value column.** Each row shows its stack value (unit price × quantity), with a grand total
  beneath the list. Money and quest items are excluded — the total answers "what could we
  liquidate". Items with no price contribute nothing rather than erroring.
- **Member tags.** Members can be grouped as Companions or Henchmen regardless of their actor
  type, so a `character` built as a hireling no longer sits among the PCs.
- **Per-member "Show stats" toggle.** GM-only, on every member card, controlling whether players
  see that member's stats. Defaults preserve existing behaviour — player characters shown, NPCs
  redacted — so no party changes on upgrade. Redaction is structural: a hidden card is built
  without the stat fields rather than populated and hidden in the template.
- **Inventory ordering.** GM drag-to-reorder, plus a personal A-Z view toggle. The toggle is
  client-scope, so each user's choice is their own and it never rewrites the stored order.

### Notes

- No migration is required. New fields default empty, and untouched parties behave exactly as
  before.

## [0.1.0]

Initial release.

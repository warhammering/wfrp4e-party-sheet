# Changelog

All notable changes to this module are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# Changelog

All notable changes to this module are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-07-23

### Added

- **Inventory log.** The shared pool now keeps a running history of who deposited or withdrew
  what. A new **Log** tab lists every deposit and withdrawal — date, who, D/W (with a legend
  beneath), the item (or "Money"), and the amount — newest first, 10 rows per page.
- **Quest item binding.** Quest items can now be tagged with which character they belong to. A
  compact dropdown in the open space between Encumbrance and Value (GM only) lets you pick a
  party member by their full character name; everyone then sees that full name on the row.

### Changed

- **Coin abbreviations** on the party sheet now read as `2GC 24ss 2bp` — gold capitalised, silver
  and brass lowercase.

### Notes

- **GM activity is logged too.** When you (the GM) move an item or coins between a character and
  the pool — including by dragging an item out to a character — it's recorded just like a player's
  move. Only compendium drops (a brand-new item dropped straight onto the pool) stay unlogged.
- **Withdraw by dragging** an item from the pool onto a character now asks "how many?" — the same
  prompt depositing already showed.
- **Deleting log entries** — each row has its own trash-icon delete (GM only), plus a **Clear Log**
  button to wipe the whole log at once.
- **Binding is display-only.** It doesn't change who can withdraw a quest item — that's still
  GM-only, exactly as before.
- If the sheet looks off after updating, the client is running cached code — reload with **Ctrl+F5**.

## [1.2.0] — 2026-07-23

### Added

- **Request group rolls from players.** Group rolls (the `Group Rolls: …` buttons and the custom
  skill/characteristic picker) now have an opt-in **"Request from players"** checkbox. Tick it and
  each online player-character gets a private prompt to roll **their own** test — a public roll on
  their own sheet, with your difficulty and modifier already baked in (no configuration window for
  them). They can spend Fortune to reroll like any other roll, and the kept result is what lands in
  the summary.

### Notes

- **Default off.** Leave the box unticked and group rolls behave exactly as before — everyone
  rolled hidden, one GM-only summary.
- **Only online player-characters are asked.** NPCs and any offline PCs still roll blind in the
  background, so the summary is always the whole party.
- **You stay in control.** An "Awaiting Rolls" window shows who has rolled, live; you can roll for
  a stuck player yourself, or cancel to call the whole thing off with no summary posted. The
  request cards are hidden from your own chat log — the Awaiting window is your view.
- **The summary is still GM-only**, and now marks which rolls the players made themselves versus
  the ones you rolled for them.
- If the sheet looks broken after updating, the client is running cached code — reload with
  **Ctrl+F5**.

## [1.1.0] — 2026-07-21

### Added

- **Drag to reorder party members.** Members can now be dragged into whatever order you want,
  the same way the inventory pool already worked. The order is stored on the party and is
  **shared** — you arrange the roster once and every player sees it that way, so the marching
  order on the sheet can match the marching order at the table.
- **Drag to tag.** Dropping a member into the **Companions** or **Henchmen** section tags them
  and moves them there; dragging them back out to their own section clears the tag. The
  dropdown on each card still does the same job — this is just the quicker way. The two tag
  sections now stay visible (with a "Drag a member here" placeholder) so the first Companion
  can be made by dragging.

### Notes

- Ordering is **GM only**. Player cards aren't draggable at all, and each section sorts
  independently — a Companion is ordered among the Companions, never against the PCs.
- **PC and NPC are not interchangeable.** Those two sections follow the actor's own type, so
  a player character can't be dropped into the NPC list or vice versa; you'll get a warning
  instead. Companion and Henchman are tags, and anyone may wear one.
- No migration required. The new order field defaults empty, so a party you never drag renders
  in exactly the order it does today.
- If the sheet looks broken after updating, the client is running cached code — reload with
  **Ctrl+F5**.

## [1.0.0] — 2026-07-21

First stable release.

### Added

- **Collapsible member cards.** A chevron in the portrait column folds a member down to a small
  portrait and their name. Built for big parties — once the companions and henchmen pile up you
  rarely need every stat block on screen at once. Collapsing affects **only your own view**, is
  remembered between sessions, and changes nothing else: the member stays in the party, in group
  rolls, and in every total. Players can collapse their own view too.
- **Change Token Art.** Right-click a member's portrait (GM only) to pick a different image for
  that member **on the party sheet alone**. Tokenizer-style token art with a baked-in ring reads
  badly inside the sheet's round frame; this lets you point the card at a cleaner portrait. The
  actor's own artwork and canvas token are never touched, and **Reset to Original** puts the card
  back on the actor's own art.
- **Copy URL** on the same right-click menu, for grabbing an image path.
- **Image Context integration.** If you own theripper93's *Image Context*, its **Show** and **Send
  to Chat** appear in that same menu, running its code. Without that module the two entries simply
  aren't offered — nothing is reimplemented here.
- **Quest items now show their value**, with a **Quest Items Total** beneath the section, matching
  the main list. Kept separate from the pool's Grand Total. Players can see the values; they still
  cannot sell quest items or drop items into the quest area.

### Changed

- The remove-member ✕ moved to the **top-right corner** of the member card, and the collapse
  chevron sits beside the Companion / Henchman dropdown.
- **Simple mode is quieter.** The Journey notice is now one line, and is **shown only to the GM** —
  players no longer see their GM told to buy a module. The weather field reads just **Weather**, and
  the Navigation/Lore stage-reduction hint (an *Enemy in Shadows* rule) no longer appears when that
  module is inactive.

### Notes

- No migration required. The new per-member art override defaults to empty, so every card keeps
  using the actor's token art exactly as before.
- If the sheet looks broken after updating, the client is running cached code — reload with
  **Ctrl+F5**.

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

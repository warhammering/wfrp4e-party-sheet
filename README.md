# WFRP4e Party Sheet

A **Party** actor for **Foundry VTT** (Warhammer Fantasy Roleplay 4e): one shared sheet that
tracks who's in the group, what they're carrying, and where they're headed — so the GM isn't
juggling a spreadsheet, a pile actor, and a paper travel log on top of five character sheets.

Drop PCs (and NPCs) onto it to form a party. From there it gives you an at-a-glance roster with
quick group tests, a shared/pooled inventory with transactional item and coin transfers, and a
Journey tab that runs Stage-by-stage travel: weather, the 8 Travel Endeavours, random encounters,
and Arrival.

## What it does

- **Membership** — drag PCs and NPCs onto the sheet to add them (NPC stat blocks are redacted for
  players — name and portrait only). A summary strip shows the party's slowest Move, how many
  members are Fatigued, and total/zero Wounds at a glance.
- **Quick rolls** — one-click Perception, Cool, Endurance, Intuition, and Outdoor Survival tests
  per member (falls back to the raw characteristic if nobody has the skill), plus GM-only **group
  tests** — including a custom skill/characteristic picker — that roll the same test for every
  member at once.
- **Rest & recovery** — per-member or whole-party Rest & Recover (delegates the actual healing
  maths to the WFRP4e system itself), a **Recuperate** marker for "taking it easy" between
  Stages, and **Make Camp**: everyone rolls a hidden camp test, the successes pool into a shared
  SL pool the GM spends to clear Fatigued or heal Wounds across the party.
- **Shared inventory & money** — drag items onto the sheet to deposit them into a pooled
  inventory; withdraw back to any owned member. Transfers are transactional (they roll back
  cleanly if a step fails, so nothing is ever silently duplicated or lost) and capacity-gated — the
  pool can only hold so much Encumbrance. Coins can be deposited/withdrawn/consolidated to the
  fewest gold/silver/brass pieces.
- **Capacity & vehicles** — the pool's carrying capacity is 1 Encumbrance per member, plus any
  connected Vehicle's Carries value, plus a flat GM-set bonus (saddlebags, a hired porter, …).
  Connect as many vehicles as you like by dragging them onto the sheet.
- **Journey engine** — set a destination, Stage count, and season, then run travel Stage by Stage:
  roll weather and see its mechanical effects, assign each member one of 8 Endeavours (Forage,
  Gather Information, Keep Watch, Practice a Skill, Woodcraft, Map the Route, Make Camp,
  Recuperate) and resolve them all in one batch, draw random encounters, and handle Arrival
  (Fellowship penalties for anyone who arrives Fatigued, plus Lore/Gossip rolls). An optional
  Exposure rule can auto-apply the Common Cold on a failed test in Winter/Spring. The whole
  journey is logged, with GM-sensitive entries hidden from players; post a summary to chat or
  reset the log at any time.

## Requirements

- Foundry VTT **v13**
- System: **wfrp4e**

**Optional:** the full Travel rules (weather rolls + effects, all 8 Endeavours, Arrival, and
Enemy-in-Shadows content in the encounter tables) need the **"WFRP4e - Enemy in Shadows"**
(`wfrp4e-eis`) module active, since that content comes from a paid rulebook this module can't
reproduce. Without it, the Journey tab runs in **simple mode**: setup, a manual weather label, the
module's own homebrew encounter tables, and Make Camp / Rest & Recover still work.

## Installation

In Foundry, open **Add-on Modules → Install Module**, paste this manifest URL, and click
**Install**:

    https://github.com/warhammering/wfrp4e-party-sheet/releases/latest/download/module.json

Then enable it in your world's **Manage Modules**.

## Quick start

1. Create a new Actor and set its type to **Party**.
2. Drag your players' character sheets onto it — they show up under **Members**. Drag an NPC to
   add it too (players only see the NPC's name and portrait).
3. Drag items and coins from a member's sheet onto the **Inventory** tab to pool them; anyone who
   owns a member can withdraw from there.
4. Optionally drag a Vehicle actor onto the sheet to connect it and add its Carries value to the
   pool's capacity.
5. On the **Journey** tab, set a destination and Stage count and click **Start Journey** to begin
   tracking travel Stage by Stage.

## Notes

- A Party actor is a pooling/travel hub, not a combatant — it can't be added to combat.
- Player-facing controls are self-service only: a player may roll or rest **their own** character
  from the party sheet and withdraw items to a character they own, but group tests, pool item
  edits/deletes, capacity settings, and vehicle connections stay GM-only.
- Run the offline regression suite after source changes: `npm test`. After reloading the Foundry
  world, `macros/phase6-smoke.js` and `macros/phase7-smoke.js` provide the live data-layer smoke
  passes.

## Acknowledgements

Original idea and design: **Kingmaker**.

## License

[MIT](LICENSE) © GMD

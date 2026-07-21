<p align="center">
  <img src="./assets/party.webp" alt="WFRP4e Party Sheet emblem" width="260">
</p>

<h1 align="center">WFRP4e Party Sheet</h1>

<p align="center"><strong>One party. One purse. One road through the mud.</strong></p>

<p align="center">
  <a href="https://foundryvtt.com/"><img alt="Foundry VTT v13" src="https://img.shields.io/badge/Foundry_VTT-v13-5b2024?style=flat-square"></a>
  <a href="https://github.com/moo-man/WFRP4e-FoundryVTT"><img alt="WFRP4e system" src="https://img.shields.io/badge/System-WFRP4e-a98949?style=flat-square"></a>
  <a href="https://github.com/warhammering/wfrp4e-party-sheet/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/warhammering/wfrp4e-party-sheet?style=flat-square&color=5b2024"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-51473b?style=flat-square"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#what-lives-on-the-sheet">Features</a> ·
  <a href="#journeys-simple-or-full">Journeys</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#support">Support</a>
</p>

By the third session, the party's coin is scattered across five character sheets, someone is
certain the mule has the rope, and nobody remembers who was meant to keep watch.

**WFRP4e Party Sheet** gives that shared part of the game a proper home. It adds a dedicated Party
actor to Foundry VTT: a single sheet for the party roster, group tests, communal gear and money,
carrying capacity, camp and recovery, and the long road between one bad decision and the next.

> **Original concept and direction: Kingmaker · Development: GMD**
>
> This module began with Kingmaker's idea. He shaped what it needed to be at the table and kept
> pushing it forward until it became a real project. GMD handled the development and implementation
> that brought that direction into Foundry.

## Installation

1. From Foundry's **Setup** screen, open **Add-on Modules**.
2. Click **Install Module**.
3. Paste the manifest URL below into **Manifest URL**, then click **Install**.

```text
https://github.com/warhammering/wfrp4e-party-sheet/releases/latest/download/module.json
```

Launch your WFRP4e world, open **Manage Modules**, and enable **WFRP4e Party Sheet**.

### Compatibility

| Component | Requirement |
|---|---|
| Foundry Virtual Tabletop | **v13** — minimum and verified version |
| Game system | **WFRP4e** |
| Mandatory add-on modules | None |
| Current release | **v1.0.0** |
| Language | English |

The optional integrations described below add to the sheet, but the core party, inventory, recovery,
and simple Journey tools work without them.

## What lives on the sheet

### The party

Drag `character` and `npc` actors onto a Party sheet and they join the party. The
header keeps the facts that matter during play in view: the slowest Move, Fatigued members, combined
Wounds, pooled carrying capacity, and current Journey Stage.

Each member card shows the details you reach for most often:

- Current career and social status
- Wounds, Fortune, Resolve, Movement, Conditions, and Characteristics
- One-click Perception, Cool, Endurance, Intuition, and Outdoor Survival tests
- Rest and Recuperate controls
- Separate sections for PCs, NPCs, Companions, and Henchmen

Large retinues stay usable. Cards can be collapsed to portrait and name, and that choice belongs only
to the viewer who made it—one player tidying their screen never folds the GM's sheet.

GMs decide whose statistics players may see. Hidden cards are genuinely redacted before they reach
the player-facing template, rather than merely covered with CSS. A GM can also right-click a portrait
to use different art on the Party sheet without changing the actor portrait or canvas token.

### Rolls, rest, and camp

The Party sheet is built for the moments when “everyone make a test” would otherwise mean opening a
row of character sheets.

- Run the five common group tests, or choose any skill or characteristic with the custom picker.
- Roll a test from an individual member card.
- Use **Rest & Recover** for one member or the whole party. The individual action delegates to
  WFRP4e's own recovery card; the party action applies the same SL + Toughness Bonus formula in
  bulk.
- Mark characters as **Recuperating** between Journey Stages.
- Use **Make Camp** to roll each camper's better Outdoor Survival or Heal test. Successful SL become
  a shared pool the GM can spend to remove Fatigued Conditions or restore Wounds anywhere in the
  party.

### The shared pack

The Inventory tab is a communal store, not a second character inventory pretending to be one.

- Drag gear from a member onto the Party sheet to deposit it.
- Withdraw pooled gear to an owned member through the item menu.
- Deposit and withdraw coins by denomination, or let the GM consolidate the purse into the fewest
  possible coins.
- Search the pool, keep a manual GM order, or turn on a personal A–Z view.
- Track quantity, Encumbrance, stack value, and the total value of ordinary pooled goods.
- Keep protected **Quest Items** in their own section with a separate subtotal.
- Connect any number of Vehicle actors and count their **Carries** value toward the pool.

Moves between actors are verified on both sides. If part of a transfer fails, the module attempts to
roll back the completed side instead of quietly accepting a duplicate or half-finished move.

#### Carrying capacity

The pool may carry:

```text
1 Encumbrance per live party member
+ connected Vehicles' Carries values
+ a flat GM-set bonus
```

Use the bonus for saddlebags, porters, carts that are not represented by a Vehicle actor, or whatever
else makes sense in your campaign. The Party pool's capacity does not alter a member's personal
Encumbrance.

### Currency that follows your world

With the stock WFRP4e setup, the purse uses Gold Crowns, Silver Shillings, and Brass Pennies.

If **Item Piles** is active, the sheet reads its configured item-based currencies instead. Renamed or
entirely custom denominations appear throughout the money summary and transfer dialogs. Secondary
currencies with no exchange rate receive their own row and move as whole units; they are not folded
into the main total or consolidation maths.

If Item Piles is absent, inactive, or unreadable, the sheet falls back cleanly to the core three
coins.

## Journeys: simple or full

Travel remains useful whether or not the paid **WFRP4e – Enemy in Shadows** module is installed.

| | Simple mode | Full Enemy in Shadows mode |
|---|---|---|
| Journey setup and Stage tracking | Yes | Yes |
| Manual weather label | Yes | — |
| Seasonal weather rolls and mechanical effects | — | Yes |
| Homebrew and custom encounter tables | Yes | Yes |
| Enemy in Shadows encounter results | — | Yes |
| Eight Travel Endeavours | — | Yes |
| Make Camp and Rest & Recover | Yes | Yes |
| Arrival tests and Fatigued penalties | — | Yes |
| Optional Exposure test support | — | Yes |
| Filtered Journey log and chat summary | Yes | Yes |

Full mode activates automatically when `wfrp4e-eis` and its table pack are available. It adds
seasonal weather, mechanical weather consequences, all eight Travel Endeavours, encounter guidance,
and Arrival procedures. The module does not copy or replace paid Enemy in Shadows content.

The eight Endeavours are **Forage, Gather Information, Keep Watch, Practice a Skill, Woodcraft, Map
the Route, Make Camp,** and **Recuperate**. Members can choose their own eligible assignment; the GM
can apply situational modifiers and resolve the Stage as a batch.

Every Journey writes to a Stage-stamped log. GM-sensitive results stay out of the player view, and
the GM can post either the complete or public-only summary to chat.

## Quick start

1. Open the **Actors** sidebar and create an actor of type **Party**.
2. Give players at least **Observer** access through **Configure Ownership** so they can open the
   sheet. Their actual controls are still limited by ownership of their own characters.
3. Drag player characters and NPCs onto the sheet.
4. As GM, use the category control to move retainers into **Companions** or **Henchmen**, and decide
   whether players can see each member's statistics.
5. Drag shared equipment into **Inventory**. Use **Deposit Coins** for money rather than dragging
   individual coin stacks.
6. If the party has transport, drag its Vehicle actor onto the Party sheet.
7. Open **Journey**, enter the destination and number of Stages, then click **Start Journey**.

A Party actor is a campaign hub, not a combatant. Foundry will refuse to add it to Combat.

## Who can do what?

| Action | GM | Player |
|---|:---:|:---:|
| View the Party sheet and public Journey information | Yes | With Party actor access |
| Collapse member cards or use the A–Z inventory view | Yes | Yes—personal view only |
| Roll from a member card or rest a member | Yes | Owned members only |
| Choose a Travel Endeavour | Yes | Owned members only |
| Deposit or withdraw gear and coins | Yes | Between members they own and the pool |
| Run group tests or resolve a Journey Stage | Yes | No |
| Start/end Journeys, roll weather, or draw encounters | Yes | No |
| Edit pool quantities, delete items, or reorder the shared list | Yes | No |
| Manage Quest Items, capacity bonuses, Vehicles, categories, visibility, or portrait art | Yes | No |

Permission checks are enforced by the handlers and transfer queue, not only by whether a button is
visible.

## Optional integrations

### WFRP4e – Enemy in Shadows (`wfrp4e-eis`)

Unlocks the full Journey engine. Without it, the sheet deliberately uses simple mode and the
module's own fallback encounter tables.

### Item Piles (`item-piles`)

Supplies custom primary and secondary currency definitions. The Party sheet supports Item Piles
currencies stored as items; attribute-path currencies are outside its item-based pool model.

### Image Context (`image-context`)

When active, its **Show** and **Send to Chat** actions appear in the GM's member-portrait context
menu. The built-in **Change Token Art**, **Reset to Original**, and **Copy URL** actions do not
require Image Context.

## Module settings

Foundry exposes two world settings under **Configure Settings → Module Settings**:

- **Enable Exposure Rule (Journey)** — off by default. In full Journey mode, qualifying weather
  enables a hidden group Endurance test. Failed members automatically contract the Common Cold in
  Winter or Spring; shelter exemptions, re-exposure, and longer-term consequences remain with the
  GM.
- **Include Homebrew Tables in Encounter Draws (Journey)** — on by default. In full mode, encounter
  draws combine this module's fallback results with Enemy in Shadows results. Turn it off for
  Enemy in Shadows-only draws.

Each Party sheet also accepts custom Positive, Coincidental, and Harmful RollTable references in the
Journey tab.

## Troubleshooting

### The sheet looks broken after an update

Foundry is probably still using cached JavaScript or CSS. Reload the client with **Ctrl+F5**.

### An actor will not join the party

The roster accepts WFRP4e `character` and `npc` actors. `creature` actors are not currently
supported. Dropping a `vehicle` connects it to capacity instead and is GM-only.

### A player cannot move an item or coin

The player must own the source or destination member. Deposits are also refused when the pool would
exceed capacity, and Quest Items remain GM-managed.

### Journey only shows manual weather and no Endeavours

That is simple mode. Activate **WFRP4e – Enemy in Shadows** and ensure its tables are available to
unlock the full Journey engine.

### Consolidate is unavailable

Custom denominations must form an exact exchange chain. If a larger coin cannot divide evenly into
the next denomination, consolidation is disabled rather than risk producing the wrong amount.

## Credits

**Kingmaker — original concept and direction**

Kingmaker is not here as a courtesy credit. The module started with his idea; he shaped what the
Party sheet needed to do at the table and kept pushing it forward. It would not exist in this form
without that direction.

**GMD — development and implementation**

GMD built the Foundry module, turning that direction into the actor model, sheet, transfer safety,
Journey engine, integrations, styling, and release.

## Support

- Read the [changelog](CHANGELOG.md) for release notes and upgrade information.
- Download the [latest release](https://github.com/warhammering/wfrp4e-party-sheet/releases/latest).
- Report reproducible problems through [GitHub Issues](https://github.com/warhammering/wfrp4e-party-sheet/issues).

When reporting a problem, include your Foundry version, WFRP4e system version, module version, active
optional integrations, and the steps that reproduce it.

For source changes, run the offline validation suite before submitting work:

```bash
npm test
```

## License and disclaimer

The source is released under the [MIT License](LICENSE).

This is an independent, unofficial module for Foundry Virtual Tabletop and WFRP4e. It is not
affiliated with or endorsed by Foundry Gaming LLC, Games Workshop, or Cubicle 7. Warhammer Fantasy
Roleplay and related names and marks belong to their respective owners.

import * as currency from "./currency.js";

const MODULE_ID = "wfrp4e-party-sheet";

function primaryItemData(denom, quantity) {
  return {
    name: denom.label,
    type: "money",
    img: denom.img || "icons/svg/coins.svg",
    system: {
      quantity: { value: quantity },
      encumbrance: { value: denom.encumbrance },
      coinValue: { value: denom.coinValue },
    },
  };
}

// Secondary currencies (no exchange rate, Design Decisions row 3) materialize as ordinary money
// items with coinValue 0, matched by the module's own secondaryId flag rather than a value —
// see transfer.js's findSecondaryStack / stackIdentity for the read side of this identity.
function secondaryItemData(sec, quantity) {
  const data = primaryItemData({ ...sec, coinValue: 0 }, quantity);
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.secondaryId`, sec.id);
  return data;
}

export class PartyModel extends BaseActorModel
{
  static preventItemTypes = [
    "career",
    "critical",
    "disease",
    "injury",
    "mutation",
    "prayer",
    "psychology",
    "talent",
    "skill",
    "spell",
    "trait",
    "extendedTest",
    "vehicleMod",
    "vehicleRole",
    "vehicleTest",
  ]

  static defineSchema() {
    let schema = super.defineSchema();

    schema.members = new fields.EmbeddedDataField(DocumentReferenceListModel);
    // Phase 8 (003) — additive, keyed actor id -> "" | "companion" | "henchman". A parallel
    // field rather than an extension of DocumentReferenceModel: that model is owned by
    // warhammer-lib and its members.add() hardcodes a 3-field write shape that would
    // silently drop a 4th field (plan Design Decisions row 4). Defaults empty so existing
    // parties need no backfill/migration — this module has zero migration code.
    schema.memberCategory = new fields.ObjectField({ initial: {} });
    // Phase 8 (005) — per-member GM opt-in to show an NPC's stats to players. Same parallel-field
    // shape and same reasoning as memberCategory above; keyed actor id -> true. Absent/false ==
    // redacted, so the default (and any un-migrated party) is the private state.
    schema.memberRevealStats = new fields.ObjectField({ initial: {} });
    // Phase 7 — GM-editable capacity headroom (R7.4) and any number of connected vehicles
    // (R7.2, revised 2026-07-19 — a party may carry more than one vehicle). `vehicles`
    // mirrors `members` exactly: EmbeddedDataField(DocumentReferenceListModel), the same
    // stale-`_document`-cache trap, guarded by the same deleteActor hook
    // (party-sheet.js _onFirstRender).
    schema.capacityBonus = new fields.NumberField({integer: true, min: 0, initial: 0});
    schema.vehicles = new fields.EmbeddedDataField(DocumentReferenceListModel);
    // Phase 6 journey state (D13).
    // journey.config = GM-editable journey setup (destination/stage count/season/status).
    // journey.stages = per-Stage journey records (weather/endeavours/encounters).
    // journey.log = the journey's chronological event log.
    // journey.stages elements are NOT dot-path addressable.
    // journey writes are whole-array: deepClone -> mutate -> one actor.update() call.
    // See scripts/journey.js (JourneyEngine) for the journey engine logic itself.
    schema.journey = new fields.SchemaField({
      config: new fields.SchemaField({
        destination: new fields.StringField({initial: ""}),
        totalStages: new fields.NumberField({min: 1, integer: true, initial: 1}),
        currentStage: new fields.NumberField({min: 0, integer: true, initial: 0}),
        season: new fields.StringField({choices: ["spring", "summer", "autumn", "winter"], initial: "spring"}),
        status: new fields.StringField({choices: ["idle", "travelling", "arrived"], initial: "idle"}),
        nextWeatherModifier: new fields.NumberField({integer: true, initial: 0}),
        customTables: new fields.SchemaField({
          positive: new fields.StringField({initial: ""}),
          coincidental: new fields.StringField({initial: ""}),
          harmful: new fields.StringField({initial: ""}),
        }),
      }),
      stages: new fields.ArrayField(new fields.SchemaField({
        weather: new fields.StringField({initial: ""}),
        // Persisted alongside the band so the Stage panel can keep showing the mechanical
        // effects text (RAW summary) after the one-off GM chat whisper scrolls away.
        weatherEffects: new fields.HTMLField({initial: ""}),
        endeavours: new fields.ArrayField(new fields.SchemaField({
          memberId: new fields.StringField({initial: ""}),
          name: new fields.StringField({initial: ""}),
          // Per-assignment skill pick for the two skillName:null endeavours (Practice a
          // Skill / Map the Route, D.2) — a skill document NAME, set via the assignment
          // row's skill <select>. Blank means "not chosen yet"; resolution refuses (loud)
          // rather than rolling nothing.
          skillChoice: new fields.StringField({initial: ""}),
          success: new fields.BooleanField({initial: null, nullable: true}),
          sl: new fields.StringField({initial: ""}),
          resolved: new fields.BooleanField({initial: false}),
          // GM-set manual modifier (e.g. a narrative encounter bonus like "+10 to next
          // Forage") applied on top of any computed modifier (Woodcraft's weather-ladder
          // penalty) when this assignment resolves. Narrative bonuses are never auto-applied
          // (D15) — this is the place the GM dials one in by hand.
          modifier: new fields.NumberField({integer: true, initial: 0}),
        })),
        encounters: new fields.ArrayField(new fields.SchemaField({
          category: new fields.StringField({initial: ""}),
          name: new fields.StringField({initial: ""}),
          text: new fields.StringField({initial: ""}),
        })),
        keepWatch: new fields.BooleanField({initial: false}),
        exposureWaived: new fields.BooleanField({initial: false}),
        fatiguedMemberIds: new fields.ArrayField(new fields.StringField()),
        // Set once Make Camp has run for this Stage via ANY path (endeavour-assignment or
        // the standalone GM-strip button). Guards against a double-roll: once true, the
        // standalone button refuses to re-run Make Camp for the rest of this Stage.
        campResolved: new fields.BooleanField({initial: false}),
      })),
      log: new fields.ArrayField(new fields.SchemaField({
        stage: new fields.NumberField({integer: true, initial: 0}),
        text: new fields.StringField({initial: ""}),
        // GM-sensitive entries (encounter draws, disease contraction, endeavour results)
        // are hidden from the player-visible log render (user ruling 2026-07-19).
        gmOnly: new fields.BooleanField({initial: false}),
      })),
    });
    schema.details = new fields.SchemaField({
      public: new fields.HTMLField(),
      gm: new fields.HTMLField(),
    });
    // Field retained defensively: live wfrp4e.js:6071 reads actor.system.autoCalc?.size
    // optional-chained ONLY via the user's local system patch (re-applied after every
    // system update, see MEMORY reference_wfrp4e_vehiclemodel_checksize_patch). Unpatched
    // vanilla lacks the guard and every party.update() would throw without this field.
    schema.autoCalc = new fields.SchemaField({
      size: new fields.BooleanField({initial: false}),
    });

    return schema;
  }

  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);

    const defaultArt = "modules/wfrp4e-party-sheet/assets/party.webp";
    let preCreateData = {};
    if (!data.prototypeToken?.texture?.src) {
      foundry.utils.mergeObject(preCreateData, {
        "prototypeToken.texture.src": defaultArt
      });
    }

    if (!data.img || data.img == "icons/svg/mystery-man.svg") {
      preCreateData.img = defaultArt;
    }

    this.parent.updateSource(preCreateData);
  }

  addMember(actor) {
    if (this.members.has({id: actor.id, uuid: actor.uuid})) {
      return {};
    }
    return this.members.add(actor);
  }

  removeMember(id) {
    // Phase 8 (003) — a removed member leaves no stale memberCategory entry behind. Deletion
    // MUST use the `-=` token: `update()` deep-merges ObjectField contents (recursive: true),
    // so writing a pruned object back would silently restore the key. Same idiom as
    // `flags.<scope>.-=<key>` (wfrp4e.js:28306).
    return foundry.utils.mergeObject(this.members.removeId(id), {
      [`system.memberCategory.-=${id}`]: null,
      [`system.memberRevealStats.-=${id}`]: null
    });
  }

  // Phase 8 (005) — stores an EXPLICIT boolean, not a presence-flag. `false` is a meaningful
  // stored value (a GM hiding a PC's stats), distinct from "unset", which falls back to the
  // per-type default in _prepareContext: PCs visible, NPCs redacted — i.e. today's behavior for
  // any party that never touches this control. Stale keys are cleaned by removeMember's `-=`.
  setMemberRevealStats(id, reveal) {
    return { [`system.memberRevealStats.${id}`]: !!reveal };
  }

  // Phase 8 (003) — mirrors addMember/removeMember's update-payload shape (a plain object
  // suitable for `actor.update()`, not an in-place write). Untagging deletes the key rather
  // than writing "" — see removeMember above for why omission alone does not persist.
  setMemberCategory(id, category) {
    return category
      ? { [`system.memberCategory.${id}`]: category }
      : { [`system.memberCategory.-=${id}`]: null };
  }

  // Phase 7 (R7.2/R7.4/R7.5) — head-count capacity, NOT a member-data read. `memberAllowance`
  // is a live-ref COUNT only (1 per resolvable PC or NPC, vacant refs contribute 0) — the
  // getter must never dereference a member's own system.* data, so an over-encumbered member
  // can never affect the pool's cap and vice versa (R7.5 both directions, smoke case
  // invariantMemberEncIndependence). Vehicle contribution sums the live-verified SOURCE field
  // system.status.carries.max (memo §System facts) across every connected vehicle; a
  // deleted/unresolvable vehicle ref silently contributes 0 rather than throwing (Risk 7.A
  // tolerance) instead of breaking the whole sum.
  get capacity() {
    const memberAllowance = this.members.list.filter(ref => ref.document && game.actors.get(ref.id)).length;
    const liveVehicles = this.vehicles.list.filter(ref => ref.document && game.actors.get(ref.id));
    const vehicle = liveVehicles.reduce((sum, ref) => sum + Number(ref.document.system.status?.carries?.max ?? 0), 0);
    const bonus = this.capacityBonus ?? 0;
    // Round to 2 dp — summing fractional encumbrances (coins carry a fractional weight) accrues
    // float error, which otherwise renders as "18.180000000000003" in the header and leaks into
    // the capacity-check shortfall messages. Encumbrance granularity is coarse, so 2 dp is ample.
    const rawCurrent = this.parent.items.reduce((sum, i) => sum + Number(i.system.encumbrance?.total ?? 0), 0);
    const current = Math.round(rawCurrent * 100) / 100;
    return { memberAllowance, vehicle, bonus, current, max: memberAllowance + vehicle + bonus };
  }

  // This module never calls vehicle.update() (Risk 7.A — read-only connection).
  addVehicle(actor) {
    if (this.vehicles.has({id: actor.id, uuid: actor.uuid})) {
      return {};
    }
    return this.vehicles.add(actor);
  }

  removeVehicle(id) {
    return this.vehicles.removeId(id);
  }

  // Phase 7 (R7.8) — money parity. Rides the exact `_preCreate` seeding path characters use
  // (ActorWFRP4e._preCreate calls system.getInitialItems(...) for every non-vehicle type
  // absent options.skipItems, wfrp4e.js:13291-13292); BaseActorModel.getInitialItems()
  // returns [] today (wfrp4e.js:6059-6061), which is why party actors seed nothing. This
  // override seeds money ONLY — no basic skills, no confirm prompt (the `prompt` arg the
  // system passes is intentionally ignored). Fail-soft: allMoneyItems() resolves to [] without
  // wfrp4e-core installed (HC6 — the sheet must still render; money section shows zeros).
  // Phase 9 (Item Piles currencies, task 4.2) — union the system's own money compendium items
  // with the live Item Piles currency config: a party now seeds a row for every configured
  // primary AND secondary denomination at quantity 0, not just whatever wfrp4e-core ships.
  // Under the stock core-three config this is a no-op union (every configured coinValue is
  // already covered by the system list) — regression-safe.
  async getInitialItems() {
    const systemItems = (await game.wfrp4e.utility.allMoneyItems()) ?? [];
    const seeded = systemItems.map(m => {
      const clone = foundry.utils.deepClone(m);
      clone.system.quantity.value = 0;
      return clone;
    });
    const knownPrimary = new Set(seeded.map(m => m.system.coinValue?.value ?? 0).filter(v => v > 0));
    for (const denom of currency.getDenominations()) {
      if (knownPrimary.has(denom.coinValue)) continue;
      seeded.push(primaryItemData(denom, 0));
      knownPrimary.add(denom.coinValue);
    }
    for (const sec of currency.getSecondaryDenominations()) {
      seeded.push(secondaryItemData(sec, 0));
    }
    return seeded.sort((a, b) => (b.system.coinValue?.value ?? 0) - (a.system.coinValue?.value ?? 0));
  }
}

Hooks.on("init", () => {
  Object.assign(CONFIG.Actor.dataModels, {
    "wfrp4e-party-sheet.party": PartyModel
  });

  // D8 — Exposure optional rule, default OFF (Q&A A3). When ON (and full/EiS mode),
  // qualifying weather bands show a reminder + hidden group Endurance test button;
  // consequences stay GM-narrated (no automation — the Core Exposure passage was not
  // retrievable at research time, memo F6).
  game.settings.register("wfrp4e-party-sheet", "exposureRule", {
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    name: "WFRP4EPARTY.ExposureRuleSetting",
    hint: "WFRP4EPARTY.ExposureRuleSettingHint",
  });

  // D4/ruling 8 — when wfrp4e-eis is active, encounter draws merge EiS's own results with
  // this module's homebrew fallback tables into one combined pool (flat d20). This toggle
  // (default ON) lets a GM who doesn't want homebrew content mixed into an EiS-owned pool
  // switch to an EiS-only draw instead. Never affects simple mode (no EiS) — the fallback
  // tables are the ONLY pool there regardless of this setting.
  game.settings.register("wfrp4e-party-sheet", "useFallbackTables", {
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    name: "WFRP4EPARTY.UseFallbackTablesSetting",
    hint: "WFRP4EPARTY.UseFallbackTablesSettingHint",
  });

  // Phase 8 (004) — personal view preference, NOT world-shared (the other two settings
  // above are both scope: "world" — deliberately not copied here: each user's alphabetical
  // toggle must be independent, since it only reorders their own render and never writes
  // item.sort).
  game.settings.register("wfrp4e-party-sheet", "inventorySortAlpha", {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  // v0.4.0 — per-member card collapse. Client scope for the same reason as the sort toggle
  // above: collapsing is a personal view preference, so one viewer folding a card away must
  // not change what anyone else sees, and a player needs no write permission on the party
  // actor to use it. Flat `${partyId}:${memberId}` keys (NOT a nested path — `game.settings`
  // stores this verbatim and dotted keys would be read back as a path by getProperty callers).
  // Only collapsed members are stored; expanding deletes the key.
  game.settings.register("wfrp4e-party-sheet", "collapsedMembers", {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
})

// Phase 7 (R7.8) — idempotent backfill for party actors created before this phase shipped
// (or created with options.skipItems), matched by system.coinValue.value only (never by
// name — the system's own name-keyed helpers throw/no-op on renamed coins). Never
// duplicates: re-running finds nothing missing once the three canonical denominations
// exist. Exported (not inlined in the ready hook) so the smoke harness can re-run it
// directly against a single disposable party without waiting on a world reload.
// Phase 9 (task 4.2) — extended to also backfill any configured primary/secondary denomination
// not covered by the system's money compendium (a GM-defined currency that isn't a wfrp4e-core
// item, or a secondary currency, which the system never knows about at all). Idempotent by the
// same rule as before: primaries matched by coinValue, secondaries by the module's secondaryId
// flag — never duplicates on repeat runs.
export async function backfillPartyCoins(party) {
  const itemsData = [];

  const templates = await game.wfrp4e.utility.allMoneyItems();
  if (templates?.length) {
    const missing = templates.filter(t => !party.items.some(i => i.type === "money" && i.system.coinValue?.value === t.system.coinValue?.value));
    for (const t of missing) {
      const data = foundry.utils.deepClone(t);
      data.system.quantity.value = 0;
      itemsData.push(data);
    }
  }

  const havePrimary = new Set(party.items.filter(i => i.type === "money").map(i => i.system.coinValue?.value ?? 0).filter(v => v > 0));
  itemsData.forEach(d => { if ((d.system.coinValue?.value ?? 0) > 0) havePrimary.add(d.system.coinValue.value); });
  for (const denom of currency.getDenominations()) {
    if (havePrimary.has(denom.coinValue)) continue;
    itemsData.push(primaryItemData(denom, 0));
    havePrimary.add(denom.coinValue);
  }

  const haveSecondary = new Set(party.items.filter(i => i.type === "money").map(i => i.getFlag(MODULE_ID, "secondaryId")).filter(Boolean));
  for (const sec of currency.getSecondaryDenominations()) {
    if (haveSecondary.has(sec.id)) continue;
    itemsData.push(secondaryItemData(sec, 0));
  }

  if (!itemsData.length) return;
  await party.createEmbeddedDocuments("Item", itemsData);
}

Hooks.on("ready", async () => {
  if (!game.user.isGM) return;

  const parties = game.actors.filter(a => a.type === "wfrp4e-party-sheet.party");
  for (const party of parties) await backfillPartyCoins(party);
})

Hooks.on("preCreateCombatant", (combatant) => {
  if (combatant.actor?.type === "wfrp4e-party-sheet.party") {
    ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.NoCombat"));
    return false;
  }
})

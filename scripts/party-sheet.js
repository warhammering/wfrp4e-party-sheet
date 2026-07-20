import * as transfer from "./transfer.js";
import { JourneyEngine } from "./journey.js";
import { registerMutationHandler, requestMutation } from "./mutation-queue.js";

const MODULE_ID = "wfrp4e-party-sheet";
const PARTY_ACTOR_TYPE = "wfrp4e-party-sheet.party";
const CHARACTERISTIC_KEYS = ["ws", "bs", "s", "t", "i", "ag", "dex", "int", "wp", "fel"];
const PHYSICAL_CATEGORY_TYPES = ["weapon", "armour", "ammunition", "trapping", "container"];
const COIN_VALUES = { gc: 240, ss: 12, bp: 1 };
// Phase 8 (004) — marker rides in the drag payload's `options` bag, which the receiving sheet
// forwards verbatim into createEmbeddedDocuments (warhammer-lib.js:10845). The createItem hook
// at the bottom of this file consumes it to turn the stock COPY into a MOVE.
const POOL_MOVE_FLAG = "wfrp4ePartyPoolMove";
const journeyStageLocks = new Set();
// Phase 8 (003) — the two GM-assignable member tags; order drives both the sheet's
// Companions-then-Henchmen section order and the GM tag-control's option order.
const MEMBER_CATEGORY_GROUPS = [
  // Dropdown labels are SINGULAR (you tag one member AS a Companion). The section HEADINGS stay
  // plural (a group OF Companions) via their own *Heading keys in the template — do not merge.
  { key: "companion", labelKey: "WFRP4EPARTY.MemberCategoryCompanion" },
  { key: "henchman", labelKey: "WFRP4EPARTY.MemberCategoryHenchman" },
];

const TEST_TARGET_SKILLS = [
  { nameKey: "NAME.Perception", characteristic: "i", icon: "fa-eye" },
  { nameKey: "NAME.Cool", characteristic: "wp", icon: "fa-brain" },
  { nameKey: "NAME.Endurance", characteristic: "t", icon: "fa-heart-pulse" },
  { nameKey: "NAME.Intuition", characteristic: "i", icon: "fa-lightbulb" },
  { nameKey: "NAME.OutdoorSurvival", characteristic: "int", icon: "fa-campground", shortKey: "WFRP4EPARTY.OutdoorSurvivalShort" },
];

function userOwnsActor(user, actor) {
  return user?.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

// Phase 8 (001) — shared brass<->coins math, extracted from the money summary so the new
// per-row/grand-total value math (task 2.2) doesn't duplicate the floor/modulo logic.
function brassToCoins(totalBrass) {
  const remainderAfterGc = totalBrass % COIN_VALUES.gc;
  return {
    gc: Math.floor(totalBrass / COIN_VALUES.gc),
    ss: Math.floor(remainderAfterGc / COIN_VALUES.ss),
    bp: remainderAfterGc % COIN_VALUES.ss,
  };
}

function coinsToBrass(price) {
  return (price?.gc ?? 0) * COIN_VALUES.gc + (price?.ss ?? 0) * COIN_VALUES.ss + (price?.bp ?? 0) * COIN_VALUES.bp;
}

// Phase 8 (001, v0.2.1) — a coin-value label that omits zero denominations: 5 brass reads "5d",
// 2 shillings "2/-", not "0GC 0SS 5BP". An all-zero value renders as a single dash. Built here
// rather than in the template so the abbreviations localize once and the zero-suppression logic
// lives in one place (item value cells + the grand-total row both use it).
function formatCoinLabel(coins) {
  const parts = [];
  if (coins.gc) parts.push(`${coins.gc}${game.i18n.localize("MARKET.Abbrev.GC")}`);
  if (coins.ss) parts.push(`${coins.ss}${game.i18n.localize("MARKET.Abbrev.SS")}`);
  if (coins.bp) parts.push(`${coins.bp}${game.i18n.localize("MARKET.Abbrev.BP")}`);
  return parts.length ? parts.join(" ") : "—";
}

function currentPartyMember(partyActor, memberId) {
  const ref = partyActor.system.members.list.find(candidate => candidate.id === memberId && game.actors.get(candidate.id));
  return ref ? game.actors.get(ref.id) : null;
}

function journeyMutationWarning(reason) {
  const keys = {
    "member-not-party": "WFRP4EPARTY.JourneyMemberNotInParty",
    "not-owner": "WFRP4EPARTY.GMOnly",
    "invalid-endeavour": "WFRP4EPARTY.JourneyInvalidEndeavour",
    "invalid-skill-choice": "WFRP4EPARTY.JourneyInvalidSkillChoice",
    "stage-busy": "WFRP4EPARTY.JourneyStageBusy",
    "already-resolved": "WFRP4EPARTY.JourneyEndeavourAlreadyResolved",
    "map-skill-missing": "WFRP4EPARTY.JourneyMapTheRouteNoSkill",
    "recuperate-blocked": "WFRP4EPARTY.RecuperateBlockedFatigued",
  };
  const key = keys[reason];
  if (key) return ui.notifications.warn(game.i18n.localize(key));
  if (!["not-travelling", "stage-missing", "assignment-missing"].includes(reason)) {
    return ui.notifications.error(game.i18n.localize("WFRP4EPARTY.JourneyMutationFailed"));
  }
}

function changedValue(changes, path, fallback) {
  if (Object.hasOwn(changes, path)) return changes[path];
  const value = foundry.utils.getProperty(changes, path);
  return value === undefined ? fallback : value;
}

function physicalItemLoad(item, changes = {}) {
  const encumbrance = Number(changedValue(changes, "system.encumbrance.value", item.system.encumbrance?.value) ?? 0);
  if (item.type === "cargo") return encumbrance;
  const quantity = Number(changedValue(changes, "system.quantity.value", item.system.quantity?.value) ?? 0);
  return encumbrance * quantity;
}

function trustedCapacityWrite(options) {
  return options?.[MODULE_ID]?.capacityChecked === true;
}

function rejectCapacityWrite(partyActor, incomingEnc, userId) {
  const capacity = partyActor.system.capacity;
  if (capacity.current + incomingEnc <= capacity.max) return true;
  if (game.user.id === userId) {
    ui.notifications.warn(game.i18n.format("WFRP4EPARTY.TransferCapacityExceeded", {
      shortfall: (capacity.current + incomingEnc) - capacity.max,
    }));
  }
  return false;
}

async function assignEndeavourMutation(payload, { requester }) {
  const partyActor = game.actors.get(payload.partyActorId);
  if (!partyActor || partyActor.type !== "wfrp4e-party-sheet.party") return { ok: false, reason: "actor-missing" };
  const journey = partyActor.system.journey;
  if (journey.config.status !== "travelling") return { ok: false, reason: "not-travelling" };

  const member = currentPartyMember(partyActor, payload.memberId);
  if (!member) return { ok: false, reason: "member-not-party" };
  if (!userOwnsActor(requester, member)) return { ok: false, reason: "not-owner" };

  const name = payload.name;
  if (name && !Object.hasOwn(JourneyEngine.ENDEAVOUR_SPECS, name)) return { ok: false, reason: "invalid-endeavour" };

  const idx = journey.config.currentStage - 1;
  const lockKey = `${partyActor.id}:${journey.config.currentStage}`;
  if (journeyStageLocks.has(lockKey)) return { ok: false, reason: "stage-busy" };
  const stages = foundry.utils.deepClone(journey.stages);
  const stage = stages[idx];
  if (!stage) return { ok: false, reason: "stage-missing" };

  const existing = stage.endeavours.find(e => e.memberId === member.id);
  if (existing?.resolved && !requester.isGM) return { ok: false, reason: "already-resolved" };

  if (!requester.isGM && name === "mapTheRoute") {
    const skills = member.itemTags?.["skill"] ?? member.items.filter(i => i.type === "skill");
    if (!JourneyEngine.MAP_THE_ROUTE_SKILLS.some(skillName => skills.some(skill => skill.name === skillName))) {
      return { ok: false, reason: "map-skill-missing" };
    }
  }
  if (!requester.isGM && name === "recuperate" && member.hasCondition("fatigued")) {
    return { ok: false, reason: "recuperate-blocked" };
  }

  stage.endeavours = stage.endeavours.filter(e => e.memberId !== member.id);
  if (name) stage.endeavours.push({ memberId: member.id, name, skillChoice: "", success: null, sl: "", resolved: false, modifier: 0 });
  await partyActor.update({ "system.journey.stages": stages });
  return { ok: true };
}

async function setEndeavourSkillMutation(payload, { requester }) {
  const partyActor = game.actors.get(payload.partyActorId);
  if (!partyActor || partyActor.type !== "wfrp4e-party-sheet.party") return { ok: false, reason: "actor-missing" };
  const journey = partyActor.system.journey;
  if (journey.config.status !== "travelling") return { ok: false, reason: "not-travelling" };

  const member = currentPartyMember(partyActor, payload.memberId);
  if (!member) return { ok: false, reason: "member-not-party" };
  if (!userOwnsActor(requester, member)) return { ok: false, reason: "not-owner" };

  const idx = journey.config.currentStage - 1;
  const lockKey = `${partyActor.id}:${journey.config.currentStage}`;
  if (journeyStageLocks.has(lockKey)) return { ok: false, reason: "stage-busy" };
  const stages = foundry.utils.deepClone(journey.stages);
  const stage = stages[idx];
  if (!stage) return { ok: false, reason: "stage-missing" };
  const record = stage.endeavours.find(e => e.memberId === member.id);
  if (!record) return { ok: false, reason: "assignment-missing" };
  if (record.resolved && !requester.isGM) return { ok: false, reason: "already-resolved" };

  const skillChoice = payload.skillChoice;
  const allowedSkills = JourneyEngine.skillChoiceOptions(record.name, member);
  if (skillChoice && (!allowedSkills || !allowedSkills.includes(skillChoice))) {
    return { ok: false, reason: "invalid-skill-choice" };
  }

  record.skillChoice = skillChoice;
  await partyActor.update({ "system.journey.stages": stages });
  return { ok: true };
}

export class PartySheet extends BaseWFRP4eActorSheet {

  static DEFAULT_OPTIONS = {
    classes: ["party-sheet"],
    actions: {
      removeMember: PartySheet._onRemoveMember,
      openMemberSheet: PartySheet._openMemberSheet,
      rollTestTarget: PartySheet._rollTestTarget,
      rollGroupTest: PartySheet._rollGroupTest,
      openGroupTestPicker: PartySheet._onOpenGroupTestPicker,
      withdrawItem: PartySheet._onWithdrawItem,
      depositCoins: PartySheet._onDepositCoins,
      withdrawCoins: PartySheet._onWithdrawCoins,
      restMember: PartySheet._onRestMember,
      restParty: PartySheet._onRestParty,
      makeCamp: PartySheet._onMakeCamp,
      toggleRecuperate: PartySheet._onToggleRecuperate,
      startJourney: PartySheet._onStartJourney,
      advanceStage: PartySheet._onAdvanceStage,
      endJourney: PartySheet._onEndJourney,
      rollNavigationReduction: PartySheet._onRollNavigationReduction,
      rollWeather: PartySheet._onRollWeather,
      rollWeatherEndurance: PartySheet._onRollWeatherEndurance,
      rollExposureTest: PartySheet._onRollExposureTest,
      drawEncounter: PartySheet._onDrawEncounter,
      drawEncounterRandom: PartySheet._onDrawEncounterRandom,
      resolveEndeavours: PartySheet._onResolveEndeavours,
      assignEndeavour: PartySheet._onAssignEndeavour,
      setEndeavourSkill: PartySheet._onSetEndeavourSkill,
      setEndeavourModifier: PartySheet._onSetEndeavourModifier,
      setWeatherLabel: PartySheet._onSetWeatherLabel,
      postLogSummary: PartySheet._onPostLogSummary,
      resetLogSummary: PartySheet._onResetLogSummary,
      rollArrivalLore: PartySheet._onRollArrivalLore,
      rollArrivalGossip: PartySheet._onRollArrivalGossip,
      removeVehicle: PartySheet._onRemoveVehicle,
      editItem: PartySheet._onEditItem,
      deleteItem: PartySheet._onDeleteItem,
      consolidateMoney: PartySheet._onConsolidateMoney,
      setItemQuantity: PartySheet._onSetItemQuantity,
      setCapacityBonus: PartySheet._onSetCapacityBonus,
      setMemberCategory: PartySheet._onSetMemberCategory,
    toggleRevealStats: PartySheet._onToggleRevealStats,
      toggleInventorySortAlpha: PartySheet._onToggleInventorySortAlpha,
    },
    position: {
      width: 800,
      height: 1000
    },
    defaultTab: "members"
  }

  static TABS = {
    members: {
      id: "members",
      group: "primary",
      label: "WFRP4EPARTY.TabMembers",
    },
    inventory: {
      id: "inventory",
      group: "primary",
      label: "WFRP4EPARTY.TabInventory",
    },
    journey: {
      id: "journey",
      group: "primary",
      label: "WFRP4EPARTY.TabJourney",
    }
  }

  static PARTS = {
    header: { scrollable: [""], template: "modules/wfrp4e-party-sheet/templates/party-header.hbs", classes: ["sheet-header"] },
    tabs: { scrollable: [""], template: "systems/wfrp4e/templates/sheets/actor/actor-tabs.hbs" },
    members: { scrollable: [""], template: "modules/wfrp4e-party-sheet/templates/party-members.hbs" },
    inventory: { scrollable: [""], template: "modules/wfrp4e-party-sheet/templates/party-inventory.hbs" },
    journey: { scrollable: [""], template: "modules/wfrp4e-party-sheet/templates/party-journey.hbs" },
  }

  async _handleEnrichment() {
    let enrichment = {};
    enrichment["system.details.public"] = await foundry.applications.ux.TextEditor.implementation.enrichHTML(this.actor.system.details.public, { async: true, secrets: this.actor.isOwner, relativeTo: this.actor });
    enrichment["system.details.gm"] = await foundry.applications.ux.TextEditor.implementation.enrichHTML(this.actor.system.details.gm, { async: true, secrets: this.actor.isOwner, relativeTo: this.actor });
    return foundry.utils.expandObject(enrichment);
  }

  async _prepareContext(options) {
    let context = await super._prepareContext(options);

    const isGM = game.user.isGM;

    // members.list (NOT the dead-ref-filtering .documents getter) so a deleted
    // member's ref still pairs with a vacancy card instead of silently vanishing.
    const refs = this.document.system.members.list;
    // Phase 7 (R7.6/R7.7) — full (unredacted) cards drive the summary aggregates (lowest
    // Move, fatigued count, wounds total) for EVERY client: those are numbers, not an
    // attributed per-NPC stat card, so aggregating over the Actor documents the client
    // already has resident (Foundry syncs the full document either way) does not violate
    // Risk 7.B. Redaction happens only when building the DISPLAY cards below.
    const fullCards = refs.map(ref => {
      const category = this.document.system.memberCategory?.[ref.id] ?? "";
      const actor = ref.document;
      if (!actor) {
        return { vacant: true, name: ref.name, id: ref.id, category };
      }
      const isNpc = actor.type === "npc";
      // Phase 8 (005) — per-member GM control over whether players see this member's stats.
      // UNSET falls back to the per-type default (PCs shown, NPCs redacted), so a party that
      // never touches the control behaves exactly as before. An explicit stored `false` lets a
      // GM hide a PC too; an explicit `true` reveals an NPC.
      const stored = this.document.system.memberRevealStats?.[ref.id];
      const revealStats = stored === undefined ? !isNpc : stored === true;
      return { id: ref.id, vacant: false, isNpc, category, revealStats, ...this._prepareMemberCard(actor) };
    });

    this._memberIds = new Set(refs.map(ref => ref.id));
    // Phase 7 — connected-vehicle ids join the same stale-cache-clear + debounced-render
    // guard as members (see the deleteActor hook in _onFirstRender).
    this._vehicleIds = new Set(this.document.system.vehicles.list.map(ref => ref.id));

    // Risk 7.B — structural (context-absent) redaction: an NPC card delivered to a non-GM
    // client never carries wounds/characteristics/testTargets/etc, mirroring the shipped
    // journey-log filter (`log.filter(e => isGM || !e.gmOnly)` below). This is NOT a
    // template `{{#if}}` gate over a fully-populated card (Risk 7.B explicitly bans that).
    // Phase 8 (003) — the redacted branch keeps `category` so a tagged NPC-backed card still
    // routes to its tag group instead of leaking back into the untagged NPC section.
    // Phase 8 (005) — `revealStats` is the ONLY way a non-GM receives a populated NPC card, and
    // it is opt-in per member. The redaction is still structural: an un-revealed card is built
    // without the fields, never populated-then-hidden (Risk 7.B).
    const displayCards = fullCards.map(c => {
      if (!c.vacant && !isGM && !c.revealStats) {
        return { id: c.id, vacant: false, isNpc: c.isNpc, npcRedacted: true, name: c.name, img: c.img, category: c.category, revealStats: false };
      }
      return c;
    });

    // Phase 8 (003) — tagged members (untagged keep today's PC/NPC placement) move to a
    // Companions/Henchmen group regardless of underlying actor.type (plan Design row 4).
    // Vacant refs are never tagged (fullCards never assigns one a real category value that
    // survives — a vacancy card's ref.id has no live actor to tag from the sheet control
    // anyway) so they always fall into the untagged bucket alongside the PC list.
    const untagged = displayCards.filter(c => c.vacant || !c.category);
    const categorized = displayCards.filter(c => !c.vacant && c.category);

    // context.memberCards (PCs, incl. vacancy cards as today) / context.npcCards (own
    // subsection, party-members.hbs) — the PRD-ruled split (R7.6/R7.7).
    context.memberCards = untagged.filter(c => c.vacant || !c.isNpc);
    context.npcCards = untagged.filter(c => !c.vacant && c.isNpc);
    context.companionCards = categorized.filter(c => c.category === "companion");
    context.henchmenCards = categorized.filter(c => c.category === "henchman");
    context.memberCategoryOptions = [
      { key: "", label: game.i18n.localize("WFRP4EPARTY.MemberCategoryNone") },
      ...MEMBER_CATEGORY_GROUPS.map(g => ({ key: g.key, label: game.i18n.localize(g.labelKey) }))
    ];
    context.summary = this._prepareSummary(fullCards);
    context.isGM = isGM;
    context.inventory = this._prepareInventory();
    // Phase 7 (R7.2/R7.4) — capacity gauge. Breakdown/bonus-input/vehicle list are GM-only
    // (Player-perspective table) — gated in the template, not stripped from context here,
    // since the numeric fields themselves carry no secret data (only the controls do).
    const liveVehicleRefs = this.document.system.vehicles.list.filter(r => r.document && game.actors.get(r.id));
    context.capacity = {
      ...this.document.system.capacity,
      vehicles: liveVehicleRefs.map(r => ({
        id: r.id,
        name: r.document.name,
        img: r.document.prototypeToken?.texture?.src || r.document.img,
        carries: Number(r.document.system.status?.carries?.max ?? 0)
      }))
    };
    context.groupTests = TEST_TARGET_SKILLS.map(({ nameKey, icon, shortKey }) => {
      const label = game.i18n.localize(nameKey);
      return {
        icon,
        label: shortKey ? game.i18n.localize(shortKey) : label,
        tooltip: game.i18n.format("WFRP4EPARTY.GroupRollTooltip", { test: label })
      };
    });
    // Journey tab is visible to players too (players may see Setup/weather/self-assign an
    // Endeavour); per-element GM-only gating happens in the template + is enforced again in
    // every handler (CCR-2) — this context object itself carries no secret data (encounter
    // results aren't hidden-roll secrets in the WFRP sense, just GM pacing information).
    context.journey = this._prepareJourneyContext(context);
    return context;
  }

  _prepareJourneyContext(context) {
    const journey = this.document.system.journey;
    const config = journey.config;
    const eisActive = JourneyEngine.eisActive();
    const isGM = context.isGM;
    const currentStage = config.currentStage;
    const stageRecord = config.status === "travelling" ? journey.stages[currentStage - 1] : null;

    // D1 — RAW Stage-count modifiers render as ADVISORY hint text only; never write totalStages.
    const lowestMove = context.summary.lowestMove;
    const hintParts = [];
    if (lowestMove && lowestMove <= 3) hintParts.push(game.i18n.localize("WFRP4EPARTY.JourneyHintLowMove"));
    if (lowestMove && lowestMove >= 6) hintParts.push(game.i18n.localize("WFRP4EPARTY.JourneyHintMounted"));
    hintParts.push(game.i18n.localize("WFRP4EPARTY.JourneyHintNavigation"));

    // Hoisted so _prepareStageContext can derive per-member option availability from it.
    const endeavourOptions = Object.keys(JourneyEngine.ENDEAVOUR_SPECS).map(key => ({
      key,
      label: game.i18n.localize(`WFRP4EPARTY.Endeavour${key.charAt(0).toUpperCase()}${key.slice(1)}`),
      description: game.i18n.localize(`WFRP4EPARTY.Endeavour${key.charAt(0).toUpperCase()}${key.slice(1)}Desc`)
    }));

    return {
      isGM,
      eisActive,
      config,
      statusLabel: game.i18n.localize(`WFRP4EPARTY.JourneyStatus${config.status.charAt(0).toUpperCase()}${config.status.slice(1)}`),
      seasonOptions: ["spring", "summer", "autumn", "winter"].map(key => ({
        key, label: game.i18n.localize(`WFRP4EPARTY.Season${key.charAt(0).toUpperCase()}${key.slice(1)}`), selected: key === config.season
      })),
      canStart: isGM && config.status === "idle",
      canAdvance: isGM && config.status === "travelling",
      canEnd: isGM && config.status !== "idle",
      showCurrentStage: config.status !== "idle",
      hintText: hintParts.join(" "),
      stageRecord: stageRecord ? this._prepareStageContext(stageRecord, currentStage, isGM, endeavourOptions) : null,
      exposureRuleOn: game.settings.get("wfrp4e-party-sheet", "exposureRule"),
      arrival: isGM && config.status === "arrived" ? this._prepareArrivalContext() : null,
      // gmOnly entries (encounter draws, disease contraction, endeavour results — user
      // ruling 2026-07-19) never reach a player's render.
      log: journey.log.filter(e => isGM || !e.gmOnly).reverse(),
      endeavourOptions,
    };
  }

  _prepareStageContext(stageRecord, currentStage, isGM, endeavourOptions) {
    const refs = this.document.system.members.list.filter(ref => ref.document && game.actors.get(ref.id));
    const assignments = refs.map(ref => {
      const existing = stageRecord.endeavours.find(e => e.memberId === ref.id);
      const endeavour = existing?.name ?? "";
      // Per-member option availability (user rulings 2026-07-19): Map the Route needs one
      // of its two RAW skills owned; Recuperate is gated on the LIVE Fatigued condition
      // (any source — combat, spells, journey) and re-opens the moment it's removed
      // (fatiguedMemberIds stays written as an audit record, but no longer holds the
      // block after healing). Players get disabled options; the GM keeps them selectable
      // but flagged with a colour + an explicit "(no skill)"/"(Fatigued)" suffix.
      const memberSkills = ref.document.itemTags?.["skill"] ?? ref.document.items.filter(i => i.type === "skill");
      const ownsMapSkill = JourneyEngine.MAP_THE_ROUTE_SKILLS.some(n => memberSkills.some(s => s.name === n));
      const fatiguedNow = !!ref.document.hasCondition("fatigued");
      const options = endeavourOptions.map(eo => {
        const noSkill = eo.key === "mapTheRoute" && !ownsMapSkill;
        const fatigued = eo.key === "recuperate" && fatiguedNow;
        const unavailable = noSkill || fatigued;
        const warn = unavailable && isGM;
        const suffix = warn
          ? " " + game.i18n.localize(noSkill ? "WFRP4EPARTY.JourneyOptionNoSkillSuffix" : "WFRP4EPARTY.JourneyOptionFatiguedSuffix")
          : "";
        return { ...eo, label: eo.label + suffix, selected: eo.key === endeavour, disabled: unavailable && !isGM, warn };
      });
      return {
        options,
        memberId: ref.id,
        name: ref.document.name,
        endeavour,
        endeavourLabel: endeavour ? game.i18n.localize(`WFRP4EPARTY.Endeavour${endeavour.charAt(0).toUpperCase()}${endeavour.slice(1)}`) : "",
        resolved: existing?.resolved ?? false,
        success: existing?.success ?? null,
        sl: existing?.sl ?? "",
        modifier: existing?.modifier ?? 0,
        skillChoice: existing?.skillChoice ?? "",
        // Non-null only for the two skillName:null endeavours (D.2) — drives the extra
        // per-row skill <select> in the template.
        skillOptions: endeavour ? JourneyEngine.skillChoiceOptions(endeavour, ref.document) : null,
        // Self-service (ADR-013 precedent): a player may assign THEIR OWN character's
        // Endeavour, never another member's. Modifier/resolve stay GM-only regardless.
        canAssign: isGM || ref.document.isOwner,
      };
    });
    return {
      stageNumber: currentStage,
      stageIndex: currentStage - 1,
      weather: stageRecord.weather,
      weatherEffects: stageRecord.weatherEffects,
      keepWatch: stageRecord.keepWatch,
      exposureWaived: stageRecord.exposureWaived,
      assignments,
      encounters: stageRecord.encounters,
      weatherLadder: JourneyEngine.WEATHER_LADDER,
      exposureQualifies: JourneyEngine.EXPOSURE_QUALIFYING_BANDS.includes(stageRecord.weather),
      // D5 — hint only: highlights the suggested encounter button; nothing auto-draws.
      suggestedCategory: isGM ? JourneyEngine.suggestCategory(stageRecord.endeavours) : null,
    };
  }

  _prepareArrivalContext() {
    const refs = this.document.system.members.list.filter(ref => ref.document && game.actors.get(ref.id));
    const penalties = refs.map(ref => {
      const actor = ref.document;
      if (!actor.hasCondition("fatigued")) return null;
      // Social status lives at system.details.status (wfrp4e.js:5123 _getIncome idiom;
      // NOT system.status, which is the fate/fortune/resolve pool block). .tier/.standing
      // are NEVER read numerically (memo §System facts — NPCs carry tier:0/standing:""
      // unpopulated; only CharacterModel's computeCareer keeps .tier meaningful) — always
      // parse the display .value. Phase 7 (Phase 3.3) — a career-less member (PC or NPC)
      // has status.value === "", which the system's OWN sibling idiom (_getIncome,
      // wfrp4e.js:5122: `findKey(status[0], ...)[0]`) hard-throws on; this guard renders a
      // "no status" placeholder instead of propagating that crash into the arrival panel.
      const statusValue = actor.system.details?.status?.value ?? "";
      const tierKey = statusValue ? warhammer.utility.findKey(statusValue.split(" ")[0], game.wfrp4e.config.statusTiers) : undefined;
      if (!statusValue || !tierKey) {
        return { name: actor.name, tier: game.i18n.localize("WFRP4EPARTY.JourneyArrivalNoStatus"), penalty: 0 };
      }
      const penalty = JourneyEngine.ARRIVAL_FELLOWSHIP_PENALTY[tierKey] ?? 0;
      return { name: actor.name, tier: game.wfrp4e.config.statusTiers[tierKey], penalty };
    }).filter(Boolean);
    return { penalties };
  }

  _prepareMemberCard(actor) {
    const testTargets = TEST_TARGET_SKILLS.map(({ nameKey, characteristic, icon }) => {
      const label = game.i18n.localize(nameKey);
      const skills = actor.itemTags?.["skill"] ?? actor.items.filter(i => i.type === "skill");
      const skill = skills.find(i => i.name === label);
      const base = { label, icon, tooltip: game.i18n.format("WFRP4EPARTY.RollTestTooltip", { test: label }) };
      if (skill) {
        return { ...base, value: skill.system.total.value, source: "skill", isFallback: false };
      }
      return { ...base, value: actor.system.characteristics[characteristic].value, source: "char", isFallback: true };
    });

    const conditions = actor.effects
      .filter(e => e.isCondition)
      .map(e => ({
        key: e.conditionId,
        label: e.name,
        icon: e.img,
        stackable: e.isNumberedCondition,
        count: e.conditionValue
      }));

    const wounds = {
      value: actor.system.status.wounds.value,
      max: actor.system.status.wounds.max
    };

    return {
      actor,
      name: actor.name,
      canRoll: game.user.isGM || actor.isOwner,
      canRest: game.user.isGM || actor.isOwner,
      recuperating: !!actor.getFlag("wfrp4e-party-sheet", "recuperate"),
      img: actor.prototypeToken?.texture?.src || actor.img,
      move: actor.system.details.move.value,
      // Phase 7 NPC-compatibility fix — Fortune/Resolve are CharacterStatusModel-only
      // fields (wfrp4e.js:6488-6503); StandardStatusModel (shared by NPCModel) has
      // neither, so an unguarded read throws the first time an NPC reaches this card
      // builder (live-smoke-caught, task 3.3). NPCs display 0 for both pools.
      fortune: actor.system.status.fortune?.value ?? 0,
      resolve: actor.system.status.resolve?.value ?? 0,
      wounds,
      characteristics: CHARACTERISTIC_KEYS.map(key => ({
        key,
        abbrevKey: key,
        value: actor.system.characteristics[key].value
      })),
      testTargets,
      conditions,
      zeroWounds: wounds.value === 0
    };
  }

  _prepareSummary(cards) {
    const resolved = cards.filter(c => !c.vacant);

    return {
      lowestMove: resolved.length ? Math.min(...resolved.map(c => c.move)) : 0,
      fatiguedCount: resolved.filter(c => c.actor.hasCondition("fatigued")).length,
      woundsTotal: {
        value: resolved.reduce((sum, c) => sum + c.wounds.value, 0),
        max: resolved.reduce((sum, c) => sum + c.wounds.max, 0)
      },
      zeroWoundsNames: resolved.filter(c => c.zeroWounds).map(c => c.name)
    };
  }

  _ownedMemberRefs() {
    const refs = this.document.system.members.list;
    return game.user.isGM ? refs : refs.filter(ref => ref.document?.isOwner);
  }

  _prepareInventory() {
    const partyItems = this.document.items;
    const canWithdraw = game.user.isGM || this._ownedMemberRefs().length > 0;
    // Phase 7 (R7.1) — GM-only row CRUD, context-gated (absent from player DOM per the
    // Player-perspective inventory table, not just template-hidden).
    const canEdit = game.user.isGM;
    const canDelete = game.user.isGM;

    // Phase 8 (002) — quest-flagged items leave their normal category entirely and render
    // only in the Quest Items bucket below; GM-only regardless of member ownership, since
    // withdrawal/edit/delete of a quest item is a GM-only action by design (UI-level
    // protection only — see plan Design Decisions row 1).
    const questFlagged = partyItems.filter(i => PHYSICAL_CATEGORY_TYPES.includes(i.type) && i.getFlag(MODULE_ID, "questItem") === true);
    const questIds = new Set(questFlagged.map(i => i.id));

    // Phase 8 (001) — grand total accumulates stack value (unit price x qty) across
    // category rows only; money has its own summary above and quest items are excluded by
    // design (Design Decisions row 3).
    let grandTotalBrass = 0;
    // Phase 8 (004) — a client-scope personal view preference (Design Decisions row 5); when
    // off, collection order reflects manual `sort` (task 4.2). Never rewrites `item.sort`.
    const alphaSort = game.settings.get(MODULE_ID, "inventorySortAlpha");
    const categories = {};
    for (const type of PHYSICAL_CATEGORY_TYPES) {
      let categoryItems = partyItems.filter(i => i.type === type && !questIds.has(i.id));
      if (!categoryItems.length) continue;
      // Phase 8 (004) — `partyItems` is the raw EmbeddedCollection, iterated in insertion order;
      // Foundry never re-derives order from the `sort` field. Without an explicit sort here the
      // GM's drag-reorder writes correct `sort` values that the render then ignores — the rows
      // never move and nothing errors. Both the base sheet (warhammer-lib.js:10878) and the
      // system's own itemTags getter (wfrp4e.js:14474) treat this as a mandatory explicit step.
      categoryItems = alphaSort
        ? [...categoryItems].sort((a, b) => a.name.localeCompare(b.name))
        : [...categoryItems].sort((a, b) => a.sort - b.sort);
      categories[type] = {
        label: game.i18n.localize(`TYPES.Item.${type}`),
        items: categoryItems.map(item => {
          const quantity = item.system.quantity?.value ?? 0;
          const stackBrass = coinsToBrass(item.system.price) * quantity;
          grandTotalBrass += stackBrass;
          return {
            id: item.id,
            uuid: item.uuid,
            name: item.name,
            img: item.img,
            quantity,
            encumbrance: item.system.encumbrance?.total ?? 0,
            value: brassToCoins(stackBrass),
            valueLabel: formatCoinLabel(brassToCoins(stackBrass)),
            canWithdraw,
            canEdit,
            canDelete
          };
        })
      };
    }

    const questItems = questFlagged.map(item => ({
      id: item.id,
      name: item.name,
      img: item.img,
      quantity: item.system.quantity?.value ?? 0,
      encumbrance: item.system.encumbrance?.total ?? 0,
      canWithdraw: game.user.isGM,
      canEdit: game.user.isGM,
      canDelete: game.user.isGM
    }));

    // Money rows share the same drag/drop path as category rows, so they need the same explicit
    // `sort` ordering — see the note above.
    const moneyItems = partyItems.filter(i => i.type === "money").sort((a, b) => a.sort - b.sort);
    const totalBrass = moneyItems.reduce((sum, i) => sum + (i.system.coinValue?.value ?? 0) * (i.system.quantity?.value ?? 0), 0);
    const money = {
      ...brassToCoins(totalBrass),
      total: totalBrass,
      items: moneyItems.map(item => ({
        id: item.id,
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        quantity: item.system.quantity?.value ?? 0,
        encumbrance: item.system.encumbrance?.total ?? 0,
        canWithdraw,
        canEdit  // v0.2.1 — GMs can set a coin stack's quantity inline (same setItemQuantity path)
      }))
    };

    // Informational only (R4.6) — plain sum, not the character `.encumbrance-section` bar, whose
    // max (t.bonus+s.bonus) is meaningless for a pool.
    const encumbrance = partyItems.reduce((sum, i) => sum + Number(i.system.encumbrance?.total ?? 0), 0);

    // `categories` is a plain object, and Handlebars treats `{}` as truthy — so `{{#if
    // inventory.categories}}` would always fire. Hand the template a scalar instead.
    const hasCategories = Object.keys(categories).length > 0;
    // Phase 8 (002) — the quest section carries the only [data-quest-drop] target, so a GM must
    // see it even when empty; otherwise the first quest item can never be created by dragging
    // (the kebab "Mark as Quest Item" path would be the only route in). Players still see
    // nothing until the party actually holds a quest item.
    const showQuestSection = questItems.length > 0 || game.user.isGM;

    const grandTotalCoins = brassToCoins(grandTotalBrass);
    return { categories, hasCategories, questItems, showQuestSection, money, encumbrance, canWithdraw, grandTotal: grandTotalCoins, grandTotalLabel: formatCoinLabel(grandTotalCoins), alphaSort };
  }

  async _promptTransferAmount(fullQty, titleKey) {
    if (fullQty <= 1) return fullQty;
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: `<div class="form-group"><label>${game.i18n.localize("WFRP4EPARTY.TransferAmount")}</label><input type="number" name="amount" value="${fullQty}" min="1" max="${fullQty}"/></div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!result || result === "cancel") return null;
    const amount = Number(result.amount);
    if (!(amount > 0) || amount > fullQty) return null;
    return amount;
  }

  async _promptCoinAmount(titleKey) {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: `
        <div class="form-group"><label>${game.i18n.localize("MARKET.Abbrev.GC")}</label><input type="number" name="gc" value="0" min="0"/></div>
        <div class="form-group"><label>${game.i18n.localize("MARKET.Abbrev.SS")}</label><input type="number" name="ss" value="0" min="0"/></div>
        <div class="form-group"><label>${game.i18n.localize("MARKET.Abbrev.BP")}</label><input type="number" name="bp" value="0" min="0"/></div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!result || result === "cancel") return null;
    const coins = { gc: Number(result.gc) || 0, ss: Number(result.ss) || 0, bp: Number(result.bp) || 0 };
    if (coins.gc + coins.ss + coins.bp <= 0) return null;
    return coins;
  }

  async _pickActorDialog(actors, titleKey) {
    const options = actors.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: `<div class="form-group"><select name="actorId">${options}</select></div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!result || result === "cancel") return null;
    return actors.find(a => a.id === result.actorId) ?? null;
  }

  // Reusable all-pre-ticked checkbox picker (Make Camp's original shape, generalised) — the
  // GM may exclude members who don't apply (e.g. a member with the right gear is exempt
  // from an Exposure Test). Returns the checked Actor[], or null if cancelled/empty.
  async _pickMembersChecklist(actors, titleKey, hintKey) {
    const fields = actors.map(a =>
      `<label class="camp-camper"><input type="checkbox" name="member-${a.id}" checked/><span class="camp-name">${a.name}</span></label>`
    ).join("");
    const config = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: `
        <div class="wfrp4e-party-camp">
          <p class="camp-hint">${game.i18n.localize(hintKey)}</p>
          <div class="camp-campers">${fields}</div>
        </div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!config || config === "cancel") return null;
    const picked = actors.filter(a => config[`member-${a.id}`] === "on" || config[`member-${a.id}`] === true);
    return picked.length ? picked : null;
  }

  // Withdraw target resolution (R2 §Q5 / R3 §Q2): GM sees every member unfiltered; a player sees
  // only members they own. Skip the picker at exactly 1 owned option; hide entirely at 0 (the
  // calling action is itself gated by `canWithdraw` in the template, but this re-resolves
  // independently since the handler must not trust the template).
  async _resolveWithdrawTarget() {
    const refs = this._ownedMemberRefs();
    if (!refs.length) return null;
    if (refs.length === 1) return refs[0].document;

    const preferredId = !game.user.isGM && game.user.character && refs.some(r => r.id === game.user.character.id)
      ? game.user.character.id
      : null;
    const options = refs.map(ref => `<option value="${ref.id}" ${ref.id === preferredId ? "selected" : ""}>${ref.document?.name ?? ref.name}</option>`).join("");
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("WFRP4EPARTY.PickWithdrawTarget") },
      content: `<div class="form-group"><select name="targetId">${options}</select></div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!result || result === "cancel") return null;
    return refs.find(r => r.id === result.targetId)?.document ?? null;
  }

  // Phase 8 (004, revised 2026-07-20) — GM drag serves TWO jobs, and both must work:
  //   1. drop inside this sheet  -> reorder (inherited _onSortItem, via _onDropItem's same-actor
  //      branch below)
  //   2. drop on a member's sheet -> MOVE the item out of the pool
  //
  // Job 2 is the awkward one. The receiving sheet's stock _onDropItem
  // (warhammer-lib.js:10836-10847) does `createEmbeddedDocuments(...)` and never deletes the
  // source, so a plain drag COPIES — the duplication bug. We cannot change another sheet's
  // handler, but that same line forwards `data.options` straight into createEmbeddedDocuments.
  // So we ship a standard Item payload (which every sheet accepts) with a marker riding along in
  // `options`; the module-level `createItem` hook at the bottom of this file sees the marker and
  // removes the pool's source stack, turning the copy into a move. See that hook for the
  // failure handling — it rolls the copy back rather than risk a duplicate.
  async _onDragStart(ev) {
    const row = ev.target?.closest?.(".party-inventory-list .list-row");
    if (!row?.dataset?.uuid) return super._onDragStart(ev);   // member cards etc. keep stock behavior
    if (!game.user.isGM) { ev.preventDefault(); return; }     // template omits data-uuid for players; belt-and-braces
    const item = await fromUuid(row.dataset.uuid);
    if (!item) { ev.preventDefault(); return; }
    const dragData = item.toDragData();
    dragData.options = { [POOL_MOVE_FLAG]: { partyUuid: this.document.uuid, itemId: item.id } };
    ev.dataTransfer.setData("text/plain", JSON.stringify(dragData));
  }

  // Cross-actor deposit route (R2) — the inherited default _onDropItem (warhammer-lib.js:10836 ->
  // wfrp4e.js:3660) creates on the target and never deletes the source, silently duplicating the
  // dropped item. This override routes every drop through the transactional transfer engine.
  async _onDropItem(data, ev) {
    const item = await Item.fromDropData(data);
    if (!item) return;

    // Phase 8 (002) — a drop landing inside the Quest Items box is GM-only regardless of
    // where it came from (CCR-2 re-check here, not just template-hidden per the design
    // decision: UI-level protection only, console bypass accepted).
    const isQuestDrop = !!ev.target?.closest?.("[data-quest-drop]");
    if (isQuestDrop && !game.user.isGM) {
      ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.QuestItemProtected"));
      return;
    }

    // Phase 7 (R7.1) — compendium/world/sidebar drops have no source actor to transfer FROM;
    // stock warhammer-lib's own _onDropItem (warhammer-lib.js:10836-10847) does a bare
    // createEmbeddedDocuments copy-create for exactly this shape. GM-only (CCR-2 recheck here,
    // not just template-hidden), routed through transfer.addItem so the capacity gate applies.
    if (!item.actor) {
      if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
        return;
      }
      const itemData = item.toObject();
      const fullQty = item.type === "cargo" ? (itemData.system.encumbrance?.value ?? 0) : (itemData.system.quantity?.value ?? 1);
      let amount = fullQty;
      if (fullQty > 1) {
        amount = await this._promptTransferAmount(fullQty, "WFRP4EPARTY.AddItemAmountTitle");
        if (amount === null) return;
      }
      foundry.utils.setProperty(itemData, item.type === "cargo" ? "system.encumbrance.value" : "system.quantity.value", amount);
      const result = await transfer.addItem(this.document, itemData);
      if (!result.ok) {
        ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
        return;
      }
      if (isQuestDrop) await this.document.items.get(result.createdId)?.setFlag(MODULE_ID, "questItem", true);
      return;
    }

    if (item.actor.uuid === this.document.uuid) {
      // Phase 8 (002) — an already-pooled item dragged onto the Quest box just gets flagged
      // in place; no transfer engine involvement since it never leaves the party actor.
      // isQuestDrop here implies GM (the top-of-function gate above already bailed non-GM
      // quest drops), so no further isGM check is needed on this branch.
      if (isQuestDrop) {
        await item.setFlag(MODULE_ID, "questItem", true);
        return;
      }
      // Phase 8 (004) — a same-actor drop is a reorder. Route to the inherited drag-sort engine
      // (warhammer-lib.js:10855). GM-only per Design Decisions row 5; a non-GM same-actor drop
      // stays a no-op as it was pre-Phase-8. Note this only became VISIBLE once _prepareInventory
      // started ordering rows by `item.sort` — before that the writes landed and the render
      // ignored them.
      if (game.user.isGM) await this._onSortItem(item, ev);
      return;
    }

    const fullQty = item.type === "cargo" ? (item.system.encumbrance?.value ?? 0) : (item.system.quantity?.value ?? 0);
    let amount = fullQty;
    if (fullQty > 1) {
      amount = await this._promptTransferAmount(fullQty, "WFRP4EPARTY.DepositAmountTitle");
      if (amount === null) return;
    }

    const result = await transfer.deposit(item.actor, this.document, item.id, amount);
    if (!result.ok && result.reason !== "not-owner") {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
      return;
    }
    if (isQuestDrop && result.ok) await this.document.items.get(result.createdId)?.setFlag(MODULE_ID, "questItem", true);
  }

  static async _onWithdrawItem(ev, target) {
    const itemId = target.closest("[data-id]")?.dataset.id;
    if (!itemId) return;
    const item = this.document.items.get(itemId);
    if (!item) return;
    // Phase 8 (002) — quest-flagged items are GM-only to withdraw, regardless of ownership.
    if (!game.user.isGM && item.getFlag(MODULE_ID, "questItem")) {
      ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.QuestItemProtected"));
      return;
    }

    const targetActor = await this._resolveWithdrawTarget();
    if (!targetActor) return;
    // CCR-2: re-check in the handler regardless of what the picker offered or the template hid.
    if (!game.user.isGM && !targetActor.isOwner) return;

    const fullQty = item.type === "cargo" ? (item.system.encumbrance?.value ?? 0) : (item.system.quantity?.value ?? 0);
    let amount = fullQty;
    if (fullQty > 1) {
      amount = await this._promptTransferAmount(fullQty, "WFRP4EPARTY.WithdrawAmountTitle");
      if (amount === null) return;
    }

    const result = await transfer.withdraw(this.document, targetActor, itemId, amount);
    if (!result.ok && result.reason !== "not-owner") {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
    }
  }

  // Phase 7 (R7.1) — GM-only pool item CRUD. System item sheet per Q&A ruling 3 (zero custom
  // item UI, HC4 spirit).
  static async _onEditItem(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const itemId = target.closest("[data-id]")?.dataset.id;
    const item = itemId ? this.document.items.get(itemId) : null;
    if (!item) return;
    item.sheet.render(true);
  }

  static async _onDeleteItem(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const itemId = target.closest("[data-id]")?.dataset.id;
    const item = itemId ? this.document.items.get(itemId) : null;
    if (!item) return;
    // Phase 8 (002) — quest items are already unreachable here for non-GM (isGM-gated
    // above); the flag re-check is kept for symmetry with the other 4 quest-guarded exit
    // paths and documents that GM requests proceed unchanged (design decision row 1).
    if (!game.user.isGM && item.getFlag(MODULE_ID, "questItem")) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.DeleteItemConfirmTitle") },
      content: game.i18n.localize("WFRP4EPARTY.DeleteItemConfirmBody"),
    });
    if (!confirmed) return;

    await this.document.deleteEmbeddedDocuments("Item", [itemId]);
  }

  // Delegated `change` handler (ADR-025 — bound in _onRender, see the selector list there).
  // Quantity DECREASES are never cap-gated (they shrink Enc); increases re-check capacity with
  // the same shortfall message as a deposit. Native item-sheet writes are independently guarded
  // by the preCreateItem/preUpdateItem hooks at the bottom of this module (BUG-833).
  static async _onSetItemQuantity(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const itemId = target.closest("[data-id]")?.dataset.id;
    const item = itemId ? this.document.items.get(itemId) : null;
    if (!item) return;
    // Phase 8 (002) — same symmetry note as _onDeleteItem above.
    if (!game.user.isGM && item.getFlag(MODULE_ID, "questItem")) return;

    const before = item.type === "cargo"
      ? Number(item.system.encumbrance?.value ?? 0)
      : Number(item.system.quantity?.value ?? 0);
    const requested = Math.max(Math.trunc(Number(target.value)) || 0, 0);
    if (requested === before) return;

    const result = await transfer.setPartyItemQuantity(this.document, itemId, requested);
    if (!result.ok) {
      target.value = result.before ?? before;
      if (result.reason !== "capacity-exceeded") {
        ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
      }
    }
  }

  // Phase 7 (R7.8) — Consolidate is available to the GM and any owned member (R7.8 "GM and
  // members alike"), matching the withdraw-availability gate (`canWithdraw`, line 325).
  static async _onConsolidateMoney(ev, target) {
    // Consolidation rewrites the shared pool's denominations for every viewer, so it is GM-only.
    // The previous `isGM || owns-a-member` check let any player with a member trigger it.
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const result = await transfer.consolidateCoins(this.document);
    if (!result.ok) {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
      return;
    }
    const gc = result.breakdown[COIN_VALUES.gc] ?? 0;
    const ss = result.breakdown[COIN_VALUES.ss] ?? 0;
    const bp = result.breakdown[COIN_VALUES.bp] ?? 0;
    ui.notifications.info(game.i18n.format("WFRP4EPARTY.ConsolidateResult", { gc, ss, bp }));
  }

  static async _onDepositCoins(ev, target) {
    const ownedChars = game.actors.filter(a => a.type === "character" && (game.user.isGM || a.isOwner));
    if (!ownedChars.length) return;

    let sourceActor = ownedChars.length === 1 ? ownedChars[0] : null;
    if (!sourceActor) {
      sourceActor = await this._pickActorDialog(ownedChars, "WFRP4EPARTY.PickCoinSource");
      if (!sourceActor) return;
    }
    if (!game.user.isGM && !sourceActor.isOwner) return;

    const coins = await this._promptCoinAmount("WFRP4EPARTY.DepositCoinsTitle");
    if (!coins) return;

    const result = await transfer.depositCoins(sourceActor, this.document, coins);
    if (!result.ok && result.reason !== "not-owner") {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
    }
  }

  static async _onWithdrawCoins(ev, target) {
    const targetActor = await this._resolveWithdrawTarget();
    if (!targetActor) return;
    if (!game.user.isGM && !targetActor.isOwner) return;

    const coins = await this._promptCoinAmount("WFRP4EPARTY.WithdrawCoinsTitle");
    if (!coins) return;

    const result = await transfer.withdrawCoins(this.document, targetActor, coins);
    if (!result.ok && result.reason !== "not-owner") {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferFailed"));
    }
  }

  async _onDropActor(data) {
    let actor = await fromUuid(data.uuid);
    if (!actor) {
      ui.notifications.info(game.i18n.localize("WFRP4EPARTY.DropRejected"));
      return;
    }

    // Phase 7 (R7.2, revised 2026-07-19) — a vehicle drop joins the vehicles list (any
    // number of connected vehicles, idempotent re-drop) rather than a single ref. GM-only
    // (the vehicle bonus/connection is a GM lever, mirroring capacityBonus).
    if (actor.type === "vehicle") {
      if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
        return;
      }
      await this.document.update(this.document.system.addVehicle(actor));
      ui.notifications.info(game.i18n.format("WFRP4EPARTY.VehicleConnectedNotification", { name: actor.name }));
      return;
    }

    // NPCs join alongside characters (Phase 7 R7.6) — creatures still rejected (v2 scope).
    if (actor.type !== "character" && actor.type !== "npc") {
      ui.notifications.info(game.i18n.localize("WFRP4EPARTY.DropRejected"));
      return;
    }
    // Phase 7 fix (live-smoke-caught, task 3.3 NPC-compatibility class): this write was
    // fire-and-forget (missing await) — harmless when nothing read the result synchronously
    // (the pre-Phase-7 PC-only path), but a caller awaiting _onDropActor and immediately
    // re-reading members.list (smoke case npcDropAccepted) raced the update and saw stale
    // state.
    await this.document.update(this.document.system.addMember(actor));
  }

  // Delegated `change` handler (ADR-025) — GM-only inline capacity bonus input beside the
  // header gauge (Q&A ruling 2).
  static async _onSetCapacityBonus(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const value = Math.max(Math.trunc(Number(target.value)) || 0, 0);
    await this.document.update({ "system.capacityBonus": value });
  }

  // Delegated `change` handler (ADR-025) — GM-only per-card tag control (task 3.4).
  static async _onSetMemberCategory(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;
    await this.document.update(this.document.system.setMemberCategory(id, target.value));
  }

  // Phase 8 (005) — GM-only per-member opt-in to reveal an NPC's stats to players. Delegated
  // `change` handler (ADR-025), same shape as _onSetMemberCategory above.
  static async _onToggleRevealStats(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;
    await this.document.update(this.document.system.setMemberRevealStats(id, target.checked));
  }

  // Phase 8 (004) — client-scope, available to every viewer (not GM-only, task 4.4).
  static async _onToggleInventorySortAlpha(ev, target) {
    const current = game.settings.get(MODULE_ID, "inventorySortAlpha");
    await game.settings.set(MODULE_ID, "inventorySortAlpha", !current);
    this.render();
  }

  static async _onRemoveVehicle(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.VehicleDisconnectTitle") },
      content: game.i18n.localize("WFRP4EPARTY.VehicleDisconnectBody"),
    });
    if (!confirmed) return;

    await this.document.update(this.document.system.removeVehicle(id));
  }

  static async _onRemoveMember(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    let id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;

    let confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.RemoveMemberTitle") },
      content: game.i18n.localize("WFRP4EPARTY.RemoveMemberBody"),
    });
    if (!confirmed) return;

    // Pre-existing sibling of the _onDropActor fire-and-forget bug (Phase 7 live-smoke,
    // user-directed fix 2026-07-19) — same missing-await pattern, fixed for consistency.
    await this.document.update(this.document.system.removeMember(id));
  }

  static _openMemberSheet(ev, target) {
    let id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;

    let member = this.document.system.members.list.find(ref => ref.id === id)?.document;
    if (!member) return;

    member.sheet.render(true);
  }

  // R5.1 — verbatim delegate to the system's own Rest & Recover flow
  // (wfrp4e.js:4785-4798). No module healing maths: the system computes
  // woundsHealed = trunc(SL) + tb (wfrp4e.js:8045-8047) and renders its own
  // Apply Healing chat button (onApplyHealing, wfrp4e.js:33486-33502).
  static async _onRestMember(ev, target) {
    let id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;

    let member = this.document.system.members.list.find(ref => ref.id === id)?.document;
    if (!member) return;

    // D4 — owner-or-GM, mirroring _rollTestTarget's ADR-013 gate.
    if (!game.user.isGM && !member.isOwner)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.OwnerOnly"));

    const skill = member.itemTags.skill.find(s => s.name === game.i18n.localize("NAME.Endurance"));
    const options = { rest: true, tb: member.characteristics.t.bonus, skipTargets: true };
    const test = skill ? await member.setupSkill(skill, options)
                       : await member.setupCharacteristic("t", options);
    await test.roll();

    // D2/D8 — the Core "taking it easy" bonus (unconditional +TB) is not part
    // of the system's own woundsHealed formula, so it is applied as a separate
    // delta with its own chat line. The marker self-clears (D8). D6 — no
    // module-side clamp: the system's _preUpdate guard (wfrp4e.js:6915-6924)
    // already caps system.status.wounds.value at .max on every write path.
    if (member.getFlag("wfrp4e-party-sheet", "recuperate")) {
      const tb = member.characteristics.t.bonus;
      await member.modifyWounds(tb);
      await member.unsetFlag("wfrp4e-party-sheet", "recuperate");
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: member }),
        content: game.i18n.format("WFRP4EPARTY.RecuperateBonusLine", { name: member.name, tb })
      });
    }
  }

  // R5.3 — GM-attestation fallback (PRD Risk 5.A) until Phase 6's Stage state
  // exists. D7: the marker lives on the MEMBER PC actor, shaped {partyId, stage},
  // so Phase 6 can adopt the same flag unchanged. Clearing needs no confirm.
  static async _onToggleRecuperate(ev, target) {
    let id = target.closest("[data-id]")?.dataset.id;
    if (!id) return;

    let member = this.document.system.members.list.find(ref => ref.id === id)?.document;
    if (!member) return;

    // A player self-attesting "I wasn't Fatigued" is the wrong trust boundary.
    if (!game.user.isGM)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    if (member.getFlag("wfrp4e-party-sheet", "recuperate")) {
      await member.unsetFlag("wfrp4e-party-sheet", "recuperate");
      return;
    }

    // D12 (amended 2026-07-19) — hard-block while the member is CURRENTLY Fatigued from
    // ANY source (combat, spells, journey); the block lifts as soon as the condition is
    // removed. The per-Stage fatiguedMemberIds tracker remains as an audit record only.
    // The GM-attestation confirm below now only covers the not-currently-Fatigued case.
    const journey = this.document.system.journey.config;
    if (member.hasCondition("fatigued")) {
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.RecuperateBlockedFatigued"));
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.RecuperateConfirmTitle") },
      content: game.i18n.localize("WFRP4EPARTY.RecuperateConfirmBody"),
    });
    if (!confirmed) return;

    await member.setFlag("wfrp4e-party-sheet", "recuperate", { partyId: this.document.id, stage: journey.status === "travelling" ? journey.currentStage : null });
  }

  static async _rollTestTarget(ev, target) {
    let id = target.closest("[data-id]")?.dataset.id;
    let spec = TEST_TARGET_SKILLS[Number(target.dataset.testIndex)];
    if (!id || !spec) return;

    let member = this.document.system.members.list.find(ref => ref.id === id)?.document;
    if (!member) return;

    // CCR-2: group tests are strictly GM-only, but a player may roll their OWN
    // PC from the party sheet (ADR-013) — guard placement is after member
    // resolution so ownership can be checked.
    if (!game.user.isGM && !member.isOwner)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    // Delegate entirely to the system: setupSkill accepts a name and falls back
    // to the base characteristic itself when the actor doesn't own the skill
    // (same idiom as the system's own Dodge roll, wfrp4e.js:4488).
    let test = await member.setupSkill(game.i18n.localize(spec.nameKey), { skipTargets: true });
    await test?.roll();
  }

  // Difficulty defaulting mirrors GM Toolkit's group test (group-test.mjs:55-63)
  static _defaultDifficulty() {
    if (game.settings.get("wfrp4e", "testDefaultDifficulty") && game.combat != null)
      return game.combat.started ? "challenging" : "average";
    if (game.settings.get("wfrp4e", "testDefaultDifficulty"))
      return "average";
    return "challenging";
  }

  // Extracted so the quick-button dialog and the picker dialog (B.2) share one
  // markup builder for the difficulty/modifier controls.
  static _difficultyModifierFields(defaultDifficulty) {
    const difficultyOptions = Object.entries(game.wfrp4e.config.difficultyLabels)
      .map(([key, text]) => `<option value="${key}" ${key === defaultDifficulty ? "selected" : ""}>${text}</option>`)
      .join("");
    return `
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.Difficulty")}</label>
          <select name="difficulty">${difficultyOptions}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.Modifier")}</label>
          <input type="number" name="modifier" value="0" step="10"/>
        </div>`;
  }

  // B.1 — deduped skill-name enumeration for the picker's datalist. Dedup rule
  // mirrors the system's own allBasicSkills() idiom (wfrp4e.js:2087-2113): a
  // grouped blank placeholder ("Melee ()") collapses to its base name once;
  // named specialisations ("Melee (Basic)") stay as distinct entries. Cached
  // for the module's lifetime — skill-tagged compendia don't change mid-session.
  static async _enumerateSkills() {
    if (this._skillEnumerationCache) return this._skillEnumerationCache;

    const packs = game.wfrp4e.tags.getPacksWithTag(["skill"]);
    const names = new Set();
    for (const pack of packs) {
      const index = await pack.getIndex({ fields: ["type"] });
      for (const entry of index) {
        if (entry.type !== "skill") continue;
        names.add(entry.name.replace(/\s*\(\s*\)\s*$/, ""));
      }
    }
    this._skillEnumerationCache = Array.from(names).sort();
    return this._skillEnumerationCache;
  }

  static async _rollGroupTest(ev, target) {
    // CCR-2: group tests are strictly GM-only.
    if (!game.user.isGM)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    let spec = TEST_TARGET_SKILLS[Number(target.dataset.testIndex)];
    if (!spec) return;
    let label = game.i18n.localize(spec.nameKey);

    const defaultDifficulty = PartySheet._defaultDifficulty();
    const config = await foundry.applications.api.DialogV2.wait({
      window: { title: `${game.i18n.localize("WFRP4EPARTY.GroupRolls")}: ${label}` },
      content: `<div>${PartySheet._difficultyModifierFields(defaultDifficulty)}</div>`,
      buttons: [
        {
          action: "roll",
          label: game.i18n.localize("WFRP4EPARTY.Roll"),
          default: true,
          callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
        },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!config || config === "cancel") return;
    const difficulty = config.difficulty;
    const modifier = Number(config.modifier) || 0;

    // Fixed characteristic passed through unchanged (all TEST_TARGET_SKILLS
    // entries are basic, so the fallback is always legal — same as Phase 2).
    await this._runGroupTest({
      label,
      skillName: label,
      characteristic: spec.characteristic,
      difficulty,
      modifier
    });
  }

  static async _onOpenGroupTestPicker(ev, target) {
    // CCR-2: group tests are strictly GM-only.
    if (!game.user.isGM)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    const skillNames = await PartySheet._enumerateSkills();
    const characteristicOptions = CHARACTERISTIC_KEYS
      .map(key => `<option value="${key}">${game.i18n.localize(game.wfrp4e.config.characteristics[key])}</option>`)
      .join("");
    const defaultDifficulty = PartySheet._defaultDifficulty();

    const config = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("WFRP4EPARTY.GroupTestPicker") },
      content: `
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.PickMode")}</label>
          <label><input type="radio" name="mode" value="skill" checked/> ${game.i18n.localize("WFRP4EPARTY.PickSkill")}</label>
          <label><input type="radio" name="mode" value="characteristic"/> ${game.i18n.localize("WFRP4EPARTY.PickCharacteristic")}</label>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.PickSkillName")}</label>
          <input type="text" name="skillName" list="wfrp4eparty-skill-list"/>
          <datalist id="wfrp4eparty-skill-list">
            ${skillNames.map(name => `<option value="${name}">`).join("")}
          </datalist>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.PickCharacteristicName")}</label>
          <select name="characteristic">${characteristicOptions}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WFRP4EPARTY.AllowAdvancedFallback")}</label>
          <input type="checkbox" name="allowAdvancedFallback"/>
        </div>
        ${PartySheet._difficultyModifierFields(defaultDifficulty)}`,
      buttons: [
        {
          action: "roll",
          label: game.i18n.localize("WFRP4EPARTY.Roll"),
          default: true,
          callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
        },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!config || config === "cancel") return;

    const difficulty = config.difficulty;
    const modifier = Number(config.modifier) || 0;
    const allowAdvancedFallback = config.allowAdvancedFallback === "on" || config.allowAdvancedFallback === true;

    if (config.mode === "characteristic") {
      const charKey = config.characteristic;
      const label = game.i18n.localize(game.wfrp4e.config.characteristics[charKey]);
      await this._runGroupTest({ label, characteristic: charKey, difficulty, modifier });
      return;
    }

    const skillName = config.skillName?.trim();
    if (!skillName) return;
    await this._runGroupTest({ label: skillName, skillName, difficulty, modifier, allowAdvancedFallback });
  }

  // R5.2 — Make Camp (EiS Travel Endeavour), RAW pooled variant (Revision R1,
  // user ruling 2026-07-18, superseding D1/D2/D9). Every camper rolls their
  // better camp skill hidden — Outdoor Survival or Heal, whichever they own at
  // the higher total — and all positive SL sum into ONE shared camp pool. The
  // GM then allocates the pool across the whole party: 1 SL removes 1 Fatigued
  // Condition from any member OR heals 1 Wound on any member (the RAW "may be
  // spent to remove SL Fatigued Conditions from a Character, or heal a
  // Character" line; 1 SL = 1 Wound is the table's pinned rate). Campers who
  // FAIL their camp test gain a Fatigued Condition (the EiS endeavour-fail
  // rule). Difficulty stays fixed at Challenging (+0) (D11).
  static async _onMakeCamp(ev, target) {
    // Strict GM-only, mirroring _rollGroupTest.
    if (!game.user.isGM)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    // Anti-double-roll guard: if a journey is travelling and Make Camp already ran for the
    // current Stage (via an Endeavour assignment resolving, or an earlier click of this
    // same button), refuse to run it again — this is exactly the cheese vector where a
    // player could fail their Endeavour-assigned camp roll and then get a second fresh
    // roll from the standalone button. Only the Endeavour path (or a fresh click on a
    // Stage that hasn't camped yet) can run Make Camp.
    const journeyConfig = this.document.system.journey.config;
    if (journeyConfig.status === "travelling") {
      const stage = this.document.system.journey.stages[journeyConfig.currentStage - 1];
      if (stage?.campResolved) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.MakeCampAlreadyResolvedThisStage"));
    }

    const refs = this.document.system.members.list.filter(ref => ref.document && game.actors.get(ref.id));
    if (!refs.length) return;

    const outdoorSurvival = game.i18n.localize("NAME.OutdoorSurvival");
    const heal = game.i18n.localize("NAME.Heal");

    // Camper picker — all pre-ticked. The GM may override which skill each camper rolls:
    // Outdoor Survival is always offered (Basic — always rollable via fallback); Heal is
    // only offered if this specific camper actually owns it. Defaults to the auto-picked
    // better-owned skill (unchanged behavior if the GM doesn't touch the dropdown).
    const camperFields = refs.map(ref => {
      const best = PartySheet._bestCampSkill(ref.document, outdoorSurvival, heal);
      const skills = ref.document.itemTags?.["skill"] ?? ref.document.items.filter(i => i.type === "skill");
      const ownsHeal = skills.some(s => s.name === heal);
      const healOption = ownsHeal ? `<option value="${heal}" ${best.skillName === heal ? "selected" : ""}>${heal}</option>` : "";
      return `<label class="camp-camper"><input type="checkbox" name="camper-${ref.id}" checked/>
        <span class="camp-name">${ref.document.name}</span>
        <select name="skill-${ref.id}" class="camp-skill-select">
          <option value="${outdoorSurvival}" ${best.skillName === outdoorSurvival ? "selected" : ""}>${outdoorSurvival}</option>
          ${healOption}
        </select></label>`;
    }).join("");

    const config = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("WFRP4EPARTY.MakeCampTitle") },
      content: `
        <div class="wfrp4e-party-camp">
          <p class="camp-hint">${game.i18n.localize("WFRP4EPARTY.MakeCampHint")}</p>
          <div class="camp-campers">${camperFields}</div>
        </div>`,
      buttons: [
        {
          action: "roll",
          label: game.i18n.localize("WFRP4EPARTY.Roll"),
          default: true,
          callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
        },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!config || config === "cancel") return;

    const camperRefs = refs.filter(ref => config[`camper-${ref.id}`] === "on" || config[`camper-${ref.id}`] === true);
    if (!camperRefs.length) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.MakeCampNoCampers"));

    const campers = camperRefs.map(ref => ref.document);
    const skillOverrides = {};
    for (const ref of camperRefs) {
      const chosen = config[`skill-${ref.id}`];
      if (chosen) skillOverrides[ref.id] = chosen;
    }

    const campResult = await this._runMakeCamp(campers, skillOverrides);

    // D12 — camp-fail Fatigued lands in the current Stage's fatiguedMemberIds so the
    // same-Stage Recuperate block sees it. Fresh clone read AFTER _runMakeCamp so its own
    // campResolved write is preserved.
    if (campResult?.failedCamperIds?.length && journeyConfig.status === "travelling") {
      const idx = journeyConfig.currentStage - 1;
      const stages = foundry.utils.deepClone(this.document.system.journey.stages);
      if (stages[idx]) {
        const ids = new Set(stages[idx].fatiguedMemberIds);
        for (const id of campResult.failedCamperIds) ids.add(id);
        stages[idx].fatiguedMemberIds = [...ids];
        await this._writeJourneyStages(stages);
      }
    }
  }

  // D.1 (Phase 6) — extracted from _onMakeCamp steps 5-13 (skill-grouping, _rollHidden,
  // fail=>Fatigued, 3 whispers, pool + allocation dialog + verified apply). The pooled-SL
  // core is preserved verbatim from Phase 5 (BINDING ruling 2); the Phase 6 addendum then
  // added the campResolved guard write and the optional skillOverrides param on top.
  // Called by the picker path above (_onMakeCamp) AND by the Phase 6 endeavour engine
  // (_onResolveEndeavours) with the Stage's assigned campers.
  // skillOverrides: optional {memberId: "Outdoor Survival"|"Heal"} — the standalone
  // picker (_onMakeCamp) lets the GM choose per camper; the Endeavour-assignment path
  // (_onResolveEndeavours) passes none and keeps the auto-pick-the-better-skill default.
  // Returns { failedCamperIds } so CALLERS record D12's fatiguedMemberIds on their own
  // stages clone — writing them here would race the callers' later whole-array writes.
  async _runMakeCamp(campers, skillOverrides = {}) {
    const outdoorSurvival = game.i18n.localize("NAME.OutdoorSurvival");
    const heal = game.i18n.localize("NAME.Heal");
    const refs = this.document.system.members.list.filter(ref => ref.document && game.actors.get(ref.id));

    // Mark the current Stage as camped (anti-double-roll guard for _onMakeCamp) — set
    // regardless of outcome, the moment campers actually attempt Make Camp this call.
    const journeyConfig = this.document.system.journey.config;
    if (journeyConfig.status === "travelling") {
      const idx = journeyConfig.currentStage - 1;
      const stages = foundry.utils.deepClone(this.document.system.journey.stages);
      if (stages[idx] && !stages[idx].campResolved) {
        stages[idx].campResolved = true;
        await this._writeJourneyStages(stages);
      }
    }

    // Roll each camper's better skill; group per skill so _rollHidden's
    // one-skill contract holds.
    const groups = new Map();
    for (const m of campers) {
      const skillName = skillOverrides[m.id] || PartySheet._bestCampSkill(m, outdoorSurvival, heal).skillName;
      if (!groups.has(skillName)) groups.set(skillName, []);
      groups.get(skillName).push(m);
    }
    const results = [];
    for (const [skillName, members] of groups) {
      const r = await this._rollHidden(members, {
        label: game.i18n.localize("WFRP4EPARTY.MakeCamp"),
        skillName,
        difficulty: "challenging",
        modifier: 0
      });
      if (r) results.push(...r.map(x => ({ ...x, skillName })));
    }
    if (!results.length) return { failedCamperIds: [] };

    // EiS endeavour-fail rule: a failed test during an Endeavour gives that
    // character a Fatigued Condition.
    const rollLines = [];
    const failedCamperIds = [];
    for (const r of results) {
      if (r.skipped) {
        rollLines.push(`<strong>${r.name}:</strong> — ${game.i18n.localize("WFRP4EPARTY.NoSkill")}</br>`);
        continue;
      }
      let failNote = "";
      if (!r.success) {
        const m = campers.find(c => c.id === r.memberId);
        if (m) {
          await m.addCondition("fatigued");
          failedCamperIds.push(m.id);
          failNote = ` — ${game.i18n.localize("WFRP4EPARTY.MakeCampFailFatigued")}`;
        }
      }
      rollLines.push(`${r.success ? "<i class='fas fa-check'></i> " : "<i class='fas fa-xmark'></i> "}`
        + `<strong>${r.name}</strong> (${r.skillName}): <strong>${r.sl} SL</strong> (${r.roll} v ${r.target})${failNote}</br>`);
    }

    // Three separate GM whispers (user ruling 2026-07-18): rolls, pool, and
    // allocation each land as their own blind message so the GM can reveal
    // any of them to the players independently.
    const gmWhisper = game.users.filter(u => u.isGM).map(u => u.id);
    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.MakeCamp")}</h3>${rollLines.join("")}`,
      whisper: gmWhisper,
      blind: true
    });

    // RAW pool: positive SL only.
    const pool = results.reduce((acc, r) =>
      acc + (r.skipped ? 0 : Math.max(Math.trunc(Number(r.sl) || 0), 0)), 0);

    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.MakeCamp")}</h3>`
        + `<p><strong>${game.i18n.format("WFRP4EPARTY.MakeCampPool", { pool })}</strong></p>`,
      whisper: gmWhisper,
      blind: true
    });

    const spendLines = [];
    if (pool > 0) {
      // Allocation state is read AFTER fail-Fatigue landed, so maxima are live.
      const state = refs.map(ref => ref.document).map(m => ({
        m,
        stacks: m.hasCondition("fatigued")?.conditionValue ?? 0,
        missing: Math.max((m.system.status.wounds.max ?? 0) - (m.system.status.wounds.value ?? 0), 0),
        preFat: 0,
        preHeal: 0
      }));

      // Prefill suggestion: shed Fatigue first (worst first), then heal the
      // most-wounded. The GM can adjust every number before applying.
      let remaining = pool;
      for (const s of [...state].sort((a, b) => b.stacks - a.stacks)) {
        const take = Math.min(s.stacks, remaining);
        s.preFat = take; remaining -= take;
        if (!remaining) break;
      }
      if (remaining) for (const s of [...state].sort((a, b) => b.missing - a.missing)) {
        const take = Math.min(s.missing, remaining);
        s.preHeal = take; remaining -= take;
        if (!remaining) break;
      }

      const rows = state.map(s => `
        <tr>
          <td class="camp-name">${s.m.name}</td>
          <td><input type="number" name="fat-${s.m.id}" value="${s.preFat}" min="0" max="${s.stacks}" step="1" ${s.stacks ? "" : "disabled"}/>
            <span class="camp-max">/ ${s.stacks}</span></td>
          <td><input type="number" name="heal-${s.m.id}" value="${s.preHeal}" min="0" max="${s.missing}" step="1" ${s.missing ? "" : "disabled"}/>
            <span class="camp-max">/ ${s.missing}</span></td>
        </tr>`).join("");

      // Loop until the allocation fits the pool or the GM cancels (a cancel
      // leaves the rolls and any fail-Fatigue standing, spends nothing).
      let allocation = null;
      while (!allocation) {
        const form = await foundry.applications.api.DialogV2.wait({
          window: { title: game.i18n.localize("WFRP4EPARTY.MakeCampAllocateTitle") },
          content: `
            <div class="wfrp4e-party-camp">
              <p class="camp-pool">${game.i18n.format("WFRP4EPARTY.MakeCampPool", { pool })}</p>
              <p class="camp-hint">${game.i18n.localize("WFRP4EPARTY.MakeCampAllocateHint")}</p>
              <table class="camp-alloc">
                <thead><tr><th></th>
                  <th>${game.i18n.localize("WFRP4EPARTY.MakeCampFatiguedCol")}</th>
                  <th>${game.i18n.localize("WFRP4EPARTY.MakeCampHealCol")}</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`,
          buttons: [
            {
              action: "apply",
              label: game.i18n.localize("WFRP4EPARTY.Apply"),
              default: true,
              callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
            },
            { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
          ]
        });
        if (!form || form === "cancel") break;

        let spent = 0;
        const parsed = state.map(s => {
          const fat = Math.min(Math.max(parseInt(form[`fat-${s.m.id}`]) || 0, 0), s.stacks);
          const healed = Math.min(Math.max(parseInt(form[`heal-${s.m.id}`]) || 0, 0), s.missing);
          spent += fat + healed;
          return { ...s, fat, healed };
        });
        if (spent > pool) {
          ui.notifications.warn(game.i18n.format("WFRP4EPARTY.MakeCampOverspent", { spent, pool }));
          continue;
        }
        allocation = parsed;
      }

      if (allocation) for (const a of allocation) {
        if (a.fat > 0) {
          await a.m.removeCondition("fatigued", a.fat);
          // R5.4 — instant re-read verify (conditions regime, no settle-poll).
          const after = a.m.hasCondition("fatigued")?.conditionValue ?? 0;
          if (after !== a.stacks - a.fat)
            ui.notifications.error(game.i18n.format("WFRP4EPARTY.MakeCampVerifyFailed", { name: a.m.name }));
        }
        if (a.healed > 0) {
          const before = a.m.system.status.wounds.value;
          const max = a.m.system.status.wounds.max;
          await a.m.modifyWounds(a.healed);
          const after = game.actors.get(a.m.id).system.status.wounds.value;
          if (after !== Math.min(before + a.healed, max))
            ui.notifications.error(game.i18n.format("WFRP4EPARTY.MakeCampVerifyFailed", { name: a.m.name }));
        }
        if (a.fat > 0 || a.healed > 0)
          spendLines.push(game.i18n.format("WFRP4EPARTY.MakeCampSpendLine", { name: a.m.name, fat: a.fat, heal: a.healed }) + "</br>");
      }

      await ChatMessage.create({
        content: `<h3>${game.i18n.localize("WFRP4EPARTY.MakeCampAllocationTitle")}</h3>`
          + (spendLines.length ? spendLines.join("") : `<p>${game.i18n.localize("WFRP4EPARTY.MakeCampNothingSpent")}</p>`),
        whisper: gmWhisper,
        blind: true
      });
    }

    return { failedCamperIds };
  }

  // Revision R1 — which camp skill does this member contribute with? The
  // better-owned of Outdoor Survival / Heal by prepared total. Outdoor
  // Survival is Basic, so members owning neither still roll it via
  // _rollHidden's characteristic fallback.
  static _bestCampSkill(member, outdoorSurvival, heal) {
    const skills = member.itemTags?.["skill"] ?? member.items.filter(i => i.type === "skill");
    const os = skills.find(i => i.name === outdoorSurvival);
    const hl = skills.find(i => i.name === heal);
    const total = s => s?.system?.total?.value ?? 0;
    if (hl && total(hl) > total(os)) return { skillName: heal, label: heal };
    return {
      skillName: outdoorSurvival,
      label: os ? outdoorSurvival : `${outdoorSurvival} (${game.i18n.localize("WFRP4EPARTY.CharFallback")})`
    };
  }

  // Revision R1 — GM-strip "Rest & Recover": every member makes the Core
  // overnight Average (+20) Endurance Test hidden, and the healing is written
  // straight to the sheet with no Apply Healing click. The healed amount
  // replicates the system's own rest formula verbatim —
  // woundsHealed = max(trunc(SL) + TB, 0) (wfrp4e.js:8045-8047) — because the
  // interactive card cannot be clicked for the whole party at once (user
  // ruling 2026-07-18). Recuperating members heal +TB more and the marker is
  // consumed (D8). The per-member bed icon keeps the system's interactive flow.
  static async _onRestParty(ev, target) {
    if (!game.user.isGM)
      return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));

    const members = this.document.system.members.list
      .filter(ref => ref.document && game.actors.get(ref.id))
      .map(ref => ref.document);
    if (!members.length) return;

    const results = await this._rollHidden(members, {
      label: game.i18n.localize("WFRP4EPARTY.RestParty"),
      skillName: game.i18n.localize("NAME.Endurance"),
      difficulty: "average",
      modifier: 0
    });
    if (!results || !results.length) return;

    const lines = [];
    for (const r of results) {
      if (r.skipped) {
        lines.push(`<strong>${r.name}:</strong> — ${game.i18n.localize("WFRP4EPARTY.NoSkill")}</br>`);
        continue;
      }
      const member = members.find(m => m.id === r.memberId);
      if (!member) continue;

      const tb = member.characteristics.t.bonus;
      const healed = Math.max(Math.trunc(Number(r.sl) || 0) + tb, 0);
      let bonus = 0;
      if (member.getFlag("wfrp4e-party-sheet", "recuperate")) {
        bonus = tb;
        await member.unsetFlag("wfrp4e-party-sheet", "recuperate");
      }

      if (healed + bonus > 0) {
        const before = member.system.status.wounds.value;
        const max = member.system.status.wounds.max;
        await member.modifyWounds(healed + bonus);
        // R5.4 — direct awaited write, immediate re-read (D6: the system's
        // _preUpdate clamp owns the ceiling).
        const after = game.actors.get(member.id).system.status.wounds.value;
        if (after !== Math.min(before + healed + bonus, max))
          ui.notifications.error(game.i18n.format("WFRP4EPARTY.RestVerifyFailed", { name: member.name }));
      }

      lines.push(`${r.success ? "<i class='fas fa-check'></i> " : "<i class='fas fa-xmark'></i> "}`
        + `<strong>${r.name}:</strong> <strong>${r.sl} SL</strong> (${r.roll} v ${r.target}) — `
        + game.i18n.format("WFRP4EPARTY.RestPartyHealedLine", { healed })
        + (bonus ? ` ${game.i18n.format("WFRP4EPARTY.RestPartyRecuperateNote", { tb: bonus })}` : "")
        + `</br>`);
    }

    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.RestParty")}</h3>${lines.join("")}`,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      blind: true
    });
  }

  // === Phase 6 — Journey engine (D-series design decisions) ==============

  static _gmWhisper() {
    return game.users.filter(u => u.isGM).map(u => u.id);
  }

  // Whole-array write helper (D13/F8 — array elements are NOT dot-path addressable).
  async _writeJourneyStages(stages) {
    await this.document.update({ "system.journey.stages": stages });
  }

  async _appendJourneyLog(text, stage = this.document.system.journey.config.currentStage, gmOnly = false) {
    const log = JourneyEngine.appendLog(this.document.system.journey.log, stage, text, gmOnly);
    await this.document.update({ "system.journey.log": log });
  }

  static async _onStartJourney(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const config = this.document.system.journey.config;
    if (config.status !== "idle") return;

    // Destructive when a previous journey's records exist — confirm-gated, matching the
    // (strictly smaller) Reset Log action's convention.
    const journey = this.document.system.journey;
    if (journey.stages.length || journey.log.length) {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("WFRP4EPARTY.StartJourneyConfirmTitle") },
        content: game.i18n.localize("WFRP4EPARTY.StartJourneyConfirmBody"),
      });
      if (!confirmed) return;
    }

    await this.document.update({
      "system.journey.config.status": "travelling",
      "system.journey.config.currentStage": 0,
      "system.journey.config.nextWeatherModifier": 0,
      "system.journey.stages": [],
      "system.journey.log": [],
    });
    await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogStarted", {
      destination: config.destination || game.i18n.localize("WFRP4EPARTY.JourneyDestinationUnset")
    }), 0);
  }

  // Bound to the Journey tab's data-action="advanceStage" button.
  static async _onAdvanceStage(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;

    // The final configured Stage must remain playable. Arrival is the NEXT advance after
    // Stage N, not part of the update that creates Stage N (BUG-825).
    if (config.currentStage >= config.totalStages) {
      await this.document.update({ "system.journey.config.status": "arrived" });
      await this._appendJourneyLog(game.i18n.localize("WFRP4EPARTY.JourneyLogArrived"), config.currentStage);
      // F5 — arrival first-impressions readout as a GM whisper (user request 2026-07-19),
      // snapshotting who is Fatigued AT the arrival moment (the RAW trigger — deliberately
      // the live condition, not journey history: fatigue shed at camp before arrival
      // correctly carries no penalty). EiS-gated like the rest of the Arrival mechanics.
      if (JourneyEngine.eisActive()) {
        const arrival = this._prepareArrivalContext();
        const lines = arrival.penalties.length
          ? arrival.penalties.map(p => game.i18n.format("WFRP4EPARTY.JourneyArrivalFatiguedPenalty", { name: p.name, tier: p.tier, penalty: p.penalty }) + "</br>").join("")
          : `<p>${game.i18n.localize("WFRP4EPARTY.JourneyArrivalNoPenalties")}</p>`;
        await ChatMessage.create({
          content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyArrival")}</h3>${lines}`,
          whisper: PartySheet._gmWhisper(),
          blind: true
        });
      }
      return;
    }

    const newStage = config.currentStage + 1;
    const stages = [...journey.stages, {
      weather: "", endeavours: [], encounters: [], keepWatch: false, exposureWaived: false, fatiguedMemberIds: []
    }];
    await this.document.update({
      "system.journey.config.currentStage": newStage,
      "system.journey.stages": stages,
    });
    await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogAdvanced", { stage: newStage }), newStage);
  }

  static async _onEndJourney(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.EndJourneyTitle") },
      content: game.i18n.localize("WFRP4EPARTY.EndJourneyBody"),
    });
    if (!confirmed) return;
    await this.document.update({ "system.journey.config.status": "idle" });
    await this._appendJourneyLog(game.i18n.localize("WFRP4EPARTY.JourneyLogEnded"));
  }

  // D1 — advisory only: the roll is informational, NEVER writes totalStages.
  static async _onRollNavigationReduction(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return;

    const refs = this._ownedMemberRefsForGM();
    if (!refs.length) return;
    const picked = await this._pickActorDialog(refs.map(r => r.document), "WFRP4EPARTY.PickNavigationTester");
    if (!picked) return;

    // Navigation is a single (Basic) skill — always offered, falls back to the
    // characteristic if unowned. Lore is specialised — only THIS member's actually-owned
    // Lore (X) skills are meaningful options (memo F8; same fix as _onRollArrivalLore).
    const skills = picked.itemTags?.["skill"] ?? picked.items.filter(i => i.type === "skill");
    const loreNames = skills.filter(s => /^Lore \(/i.test(s.name)).map(s => s.name).sort();
    const options = [game.i18n.localize("NAME.Navigation"), ...loreNames];

    const skillName = options.length === 1 ? options[0] : await this._promptFromOptions(options, "WFRP4EPARTY.PickNavigationSkill");
    if (!skillName) return;

    const results = await this._rollHidden([picked], {
      label: game.i18n.localize("WFRP4EPARTY.JourneyNavigationReduction"),
      skillName,
      difficulty: "challenging",
      modifier: 0,
      allowAdvancedFallback: true
    });
    const r = results?.[0];
    if (!r || r.skipped) return;

    const suggestion = r.success
      ? game.i18n.localize("WFRP4EPARTY.JourneyNavigationReductionSuccess")
      : game.i18n.localize("WFRP4EPARTY.JourneyNavigationReductionFail");
    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyNavigationReduction")}</h3>`
        + `<p><strong>${r.name}</strong> (${skillName}): <strong>${r.sl} SL</strong> (${r.roll} v ${r.target})</p><p>${suggestion}</p>`,
      whisper: PartySheet._gmWhisper(),
      blind: true
    });
  }

  _ownedMemberRefsForGM() {
    return this.document.system.members.list.filter(ref => ref.document && game.actors.get(ref.id));
  }

  // Like _promptSkillChoice but over literal option labels (not i18n keys) — used to pick
  // a specific owned Lore specialisation rather than a fixed skill list.
  async _promptFromOptions(labels, titleKey) {
    const options = labels.map(l => `<option value="${l}">${l}</option>`).join("");
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: `<div class="form-group"><select name="choice">${options}</select></div>`,
      buttons: [
        { action: "confirm", label: game.i18n.localize("WFRP4EPARTY.Confirm"), default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
        { action: "cancel", label: game.i18n.localize("WFRP4EPARTY.Cancel") }
      ]
    });
    if (!result || result === "cancel") return null;
    return result.choice;
  }

  // C.3 — weather. Full mode: draw the season's EiS weather band + effects, whisper the
  // paraphrase + journal link, consume nextWeatherModifier. Simple mode: manual label only
  // (handled entirely by the <select> in the template — no roll, D2).
  static async _onRollWeather(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return;

    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;

    const tableId = JourneyEngine.EIS_TABLE_IDS.weather[config.season];
    const table = await fromUuid(`Compendium.wfrp4e-eis.tables.RollTable.${tableId}`);
    if (!table) return ui.notifications.error(game.i18n.localize("WFRP4EPARTY.JourneyEisTableMissing"));

    const modifier = config.nextWeatherModifier || 0;
    const { result } = await JourneyEngine.drawFromTable(table, modifier);
    const band = JourneyEngine.plainLabel(result?.name || result?.text) || game.i18n.localize("WFRP4EPARTY.JourneyWeatherUnknown");
    const effectText = JourneyEngine.WEATHER_EFFECTS[band] ? game.i18n.localize(JourneyEngine.WEATHER_EFFECTS[band]) : "";

    const stages = foundry.utils.deepClone(journey.stages);
    const idx = config.currentStage - 1;
    if (stages[idx]) {
      stages[idx].weather = band;
      stages[idx].weatherEffects = effectText;
    }
    await this.document.update({
      "system.journey.stages": stages,
      "system.journey.config.nextWeatherModifier": 0,
    });

    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyWeather")}</h3>`
        + `<p><strong>${band}</strong></p>${effectText ? `<p>${effectText}</p>` : ""}`
        + `<p>@UUID[${JourneyEngine.WEATHER_JOURNAL_PAGE_UUID}]{${game.i18n.localize("WFRP4EPARTY.JourneyWeatherJournalLink")}}</p>`,
      whisper: PartySheet._gmWhisper(),
      blind: true
    });
    // Weather BAND is public (players see it on the tab + log); only the mechanical
    // effects TEXT is GM-only (user ruling refined 2026-07-19, manual smoke round 2).
    await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogWeather", { band }));
  }

  // Snow/Blizzard offer this button (never auto-fire, D7).
  static async _onRollWeatherEndurance(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return;
    const band = target.dataset.band;
    const difficulty = JourneyEngine.WEATHER_ENDURANCE_DIFFICULTY[band];
    if (!difficulty) return;

    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;

    const members = this._ownedMemberRefsForGM().map(ref => ref.document);
    if (!members.length) return;
    const results = await this._rollHidden(members, {
      label: game.i18n.format("WFRP4EPARTY.JourneyWeatherEndurance", { band }),
      skillName: game.i18n.localize("NAME.Endurance"),
      difficulty,
      modifier: 0
    });
    // D12 — engine Fatigued writes must land in fatiguedMemberIds so Recuperate's
    // same-Stage block can see them (mirror of the endeavour-resolution path).
    const stages = foundry.utils.deepClone(journey.stages);
    await this._resolveFailFatigued(results, members,
      game.i18n.format("WFRP4EPARTY.JourneyWeatherEndurance", { band }), stages, config.currentStage - 1);
  }

  // D8 — Exposure: reminder + hidden group Endurance test, no consequence automation.
  // "Options: Catching a Cold" (verified 2026-07-18): Challenging (+0) Endurance Test at
  // end of Stage for exposed members. Automated: the test itself, and — in Winter/Spring
  // only — Common Cold contraction on failure (the SAME roll IS the contraction test per
  // the RAW text; embeds a copy of the real disease Item, which carries its own symptom
  // Active Effects, e.g. Malaise's own script applies Fatigued — not duplicated here).
  // NOT automated (explicitly out of scope, no reliable data source): the Downpour/
  // Blizzard coat/tent gear penalty (this module tracks no per-character gear-worn state),
  // re-exposure duration extension on an EXISTING Common Cold, and the >14-day Pneumonia
  // escalation (would need cross-session day-count tracking this module doesn't have).
  static async _onRollExposureTest(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!game.settings.get("wfrp4e-party-sheet", "exposureRule")) return;
    if (!JourneyEngine.eisActive()) return;

    const journey = this.document.system.journey;
    if (journey.config.status !== "travelling") return;
    const stage = journey.stages[journey.config.currentStage - 1];
    if (!JourneyEngine.EXPOSURE_QUALIFYING_BANDS.includes(stage?.weather)) return;

    const refs = this._ownedMemberRefsForGM();
    if (!refs.length) return;
    // Not every member is necessarily exposed — some may have a coat + tent/shelter and
    // are exempt outright. All pre-ticked; the GM unchecks anyone who doesn't apply.
    const members = await this._pickMembersChecklist(
      refs.map(ref => ref.document), "WFRP4EPARTY.PickExposureMembersTitle", "WFRP4EPARTY.PickExposureMembersHint"
    );
    if (!members) return;
    const results = await this._rollHidden(members, {
      label: game.i18n.localize("WFRP4EPARTY.JourneyExposureTest"),
      skillName: game.i18n.localize("NAME.Endurance"),
      difficulty: "challenging",
      modifier: 0
    });
    if (!results?.length) return;

    const season = this.document.system.journey.config.season;
    const coldSeason = JourneyEngine.COMMON_COLD_SEASONS.includes(season);
    const coldContracted = [];
    if (coldSeason) {
      const source = await fromUuid(`Compendium.${JourneyEngine.COMMON_COLD_ITEM.packId}.Item.${JourneyEngine.COMMON_COLD_ITEM.itemId}`);
      if (source) {
        for (const r of results) {
          if (r.skipped || r.success) continue;
          const member = members.find(m => m.id === r.memberId);
          if (!member) continue;
          const alreadySick = member.items.some(i => i.type === "disease" && i.name === source.name);
          if (alreadySick) continue; // re-exposure duration-extension not automated (see above)
          await member.createEmbeddedDocuments("Item", [source.toObject()]);
          coldContracted.push(member.name);
        }
      }
    }

    const lines = results.map(r => r.skipped
      ? `<strong>${r.name}:</strong> — ${game.i18n.localize("WFRP4EPARTY.NoSkill")}</br>`
      : `${r.success ? "<i class='fas fa-check'></i> " : "<i class='fas fa-xmark'></i> "}<strong>${r.name}:</strong> <strong>${r.sl} SL</strong> (${r.roll} v ${r.target})</br>`);
    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyExposureTest")}</h3>${lines.join("")}`
        + `<p>${game.i18n.localize("WFRP4EPARTY.JourneyExposureConsequenceNote")}</p>`
        + (coldContracted.length ? `<p>${game.i18n.format("WFRP4EPARTY.JourneyExposureColdContracted", { names: coldContracted.join(", ") })}</p>` : ""),
      whisper: PartySheet._gmWhisper(),
      blind: true
    });
    if (coldContracted.length) {
      await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogColdContracted", { names: coldContracted.join(", ") }), undefined, true);
    }
  }

  // C.4 — 4 encounter buttons: category param (positive/coincidental/harmful) or random.
  static async _onDrawEncounter(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    await this._drawEncounterCategory(target.dataset.category);
  }

  static async _onDrawEncounterRandom(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const categories = ["positive", "coincidental", "harmful"];
    const category = categories[Math.floor(Math.random() * categories.length)];
    await this._drawEncounterCategory(category);
  }

  async _drawEncounterCategory(category) {
    if (!["positive", "coincidental", "harmful"].includes(category)) return;
    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;

    const customUuid = config.customTables?.[category];
    let name, text, resultId;

    if (customUuid) {
      const table = await fromUuid(customUuid);
      if (!table) return ui.notifications.error(game.i18n.localize("WFRP4EPARTY.JourneyCustomTableMissing"));
      const { result } = await JourneyEngine.drawFromTable(table);
      ({ name, text } = JourneyEngine.splitEncounterResult(result));
      resultId = result?._id;
    } else if (JourneyEngine.eisActive()) {
      const useFallback = game.settings.get("wfrp4e-party-sheet", "useFallbackTables");
      const eisTable = await fromUuid(`Compendium.wfrp4e-eis.tables.RollTable.${JourneyEngine.EIS_TABLE_IDS.encounters[category]}`);
      const fallbackTable = useFallback ? await this._fallbackTableFor(category) : null;
      const eisResults = eisTable?.results?.contents ?? [];
      const fallbackResults = fallbackTable?.results?.contents ?? [];
      const pool = [
        ...eisResults.map(r => ({ r, source: "eis" })),
        ...fallbackResults.map(r => ({ r, source: "fallback" })),
      ];
      if (!pool.length) return ui.notifications.error(game.i18n.localize("WFRP4EPARTY.JourneyEisTableMissing"));
      // D4 — flat, uniform d20-equivalent pick across the combined pool (whatever its size).
      const pick = pool[Math.floor(Math.random() * pool.length)];
      ({ name, text } = JourneyEngine.splitEncounterResult(pick.r));
      resultId = pick.source === "eis" ? pick.r._id : undefined;
    } else {
      const fallbackTable = await this._fallbackTableFor(category);
      if (!fallbackTable) return ui.notifications.error(game.i18n.localize("WFRP4EPARTY.JourneyFallbackTableMissing"));
      const { result } = await JourneyEngine.drawFromTable(fallbackTable);
      ({ name, text } = JourneyEngine.splitEncounterResult(result));
    }

    const stages = foundry.utils.deepClone(journey.stages);
    const idx = config.currentStage - 1;
    const update = { "system.journey.stages": stages };
    if (stages[idx]) stages[idx].encounters.push({ category, name, text });

    // D15 — the ONLY automated encounter write-back: Terrible Weather carries +40.
    if (resultId === JourneyEngine.TERRIBLE_WEATHER_RESULT_ID) {
      update["system.journey.config.nextWeatherModifier"] = (config.nextWeatherModifier || 0) + 40;
    }
    await this.document.update(update);

    await ChatMessage.create({
      content: `<h3>${game.i18n.localize(`WFRP4EPARTY.JourneyEncounter${category.charAt(0).toUpperCase()}${category.slice(1)}`)}</h3>`
        + `<p><strong>${name}</strong></p><p>${text}</p>`,
      whisper: PartySheet._gmWhisper(),
      blind: true
    });
    await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogEncounter", { category, name }), undefined, true);
  }

  async _fallbackTableFor(category) {
    const pack = game.packs.get(JourneyEngine.FALLBACK_PACK_ID);
    if (!pack) return null;
    const targetName = JourneyEngine.FALLBACK_TABLE_NAMES[category];
    const index = await pack.getIndex();
    const entry = index.find(e => e.name === targetName);
    if (!entry) return null;
    return pack.getDocument(entry._id);
  }

  // Simple mode — the weather <select> is a plain label write (D2: no roll, no effects
  // text). Whole-array write per D13/F8 (array elements are not dot-path addressable).
  static async _onSetWeatherLabel(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;
    const idx = config.currentStage - 1;
    const stages = foundry.utils.deepClone(journey.stages);
    if (stages[idx]) stages[idx].weather = target.value;
    await this._writeJourneyStages(stages);
  }

  // Per-member self-service assignment. The authoritative GM queue re-reads and validates
  // current party/Stage state before replacing the array (BUG-830/831).
  static async _onAssignEndeavour(ev, target) {
    const result = await requestMutation("assign-endeavour", {
      partyActorId: this.document.id,
      memberId: target.dataset.memberId,
      name: target.value,
    });
    if (!result.ok) journeyMutationWarning(result.reason);
  }

  // D.2 — per-assignment skill pick for Practice a Skill / Map the Route. Both GM and
  // players are constrained to the assignment's computed option list (BUG-830).
  static async _onSetEndeavourSkill(ev, target) {
    const result = await requestMutation("set-endeavour-skill", {
      partyActorId: this.document.id,
      memberId: target.dataset.memberId,
      skillChoice: target.value,
    });
    if (!result.ok) journeyMutationWarning(result.reason);
  }

  // Manual per-endeavour modifier (e.g. an encounter's "+10 to next Forage" narrative
  // bonus) — the GM dials it in here before hitting Resolve Endeavours; D15 keeps
  // narrative bonuses GM-applied rather than auto-detected/auto-attached.
  static async _onSetEndeavourModifier(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;
    const memberId = target.dataset.memberId;
    const modifier = Math.trunc(Number(target.value)) || 0;
    const idx = config.currentStage - 1;
    const stages = foundry.utils.deepClone(journey.stages);
    const stage = stages[idx];
    if (!stage) return;
    const record = stage.endeavours.find(e => e.memberId === memberId);
    if (record) record.modifier = modifier;
    await this._writeJourneyStages(stages);
  }

  // D.2 — resolve every unresolved Stage endeavour assignment.
  static async _onResolveEndeavours(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return;

    // Acquire through the same queue as player assignments: all requests already ahead of this
    // click finish first, and later requests fail visibly while the long-running roll/dialog flow
    // owns this Stage. This prevents the final whole-array write from clobbering a player edit.
    const lock = await requestMutation("begin-journey-stage-work", { partyActorId: this.document.id });
    if (!lock.ok) return journeyMutationWarning(lock.reason);
    try {
    const journey = this.document.system.journey;
    const config = journey.config;
    if (config.status !== "travelling") return;
    const idx = config.currentStage - 1;
    const stage = journey.stages[idx];
    if (!stage) return;

    const unresolved = stage.endeavours.filter(e => !e.resolved && e.name);
    if (!unresolved.length) return ui.notifications.info(game.i18n.localize("WFRP4EPARTY.JourneyNoUnresolvedEndeavours"));

    const stages = foundry.utils.deepClone(journey.stages);
    const targetStage = stages[idx];
    const failedMembers = [];
    const keepWatchSuccess = [];
    const woodcraftSuccess = [];
    const summaryLines = [];
    const pendingSkillChoice = [];

    for (const assignment of unresolved) {
      const member = game.actors.get(assignment.memberId);
      const record = targetStage.endeavours.find(e => e.memberId === assignment.memberId && e.name === assignment.name);
      if (!member || !record) continue;

      if (assignment.name === "recuperate") {
        // F3 — no roll; blocked while the member is CURRENTLY Fatigued (any source —
        // user ruling 2026-07-19; re-opens once the condition is removed).
        if (member.hasCondition("fatigued")) {
          summaryLines.push(`<strong>${member.name}</strong> (${game.i18n.localize("WFRP4EPARTY.EndeavourRecuperate")}): ${game.i18n.localize("WFRP4EPARTY.RecuperateBlockedFatigued")}</br>`);
        } else {
          await member.setFlag("wfrp4e-party-sheet", "recuperate", { partyId: this.document.id, stage: config.currentStage });
          summaryLines.push(`<strong>${member.name}</strong>: ${game.i18n.localize("WFRP4EPARTY.EndeavourRecuperate")}</br>`);
        }
        record.resolved = true;
        continue;
      }

      if (assignment.name === "makeCamp") {
        // D11 — collected campers run through the extracted core, not re-implemented here.
        continue; // handled in bulk below (Make Camp campers gathered from ALL assignments)
      }

      const spec = JourneyEngine.ENDEAVOUR_SPECS[assignment.name];
      if (!spec || spec.special) continue;

      let skillName = spec.skillName ? game.i18n.localize(spec.skillName) : (record.skillChoice || "");
      if (!skillName) {
        // Practice a Skill / Map the Route with no skill picked yet — refuse loud, leave
        // the assignment UNRESOLVED so it rolls once the skill is chosen (never a silent
        // "No skill" that consumes the Stage's assignment).
        pendingSkillChoice.push(member.name);
        continue;
      }
      let modifier = Math.trunc(Number(record.modifier)) || 0;
      if (assignment.name === "woodcraft") {
        modifier += -10 * JourneyEngine.woodcraftStepsFromFair(targetStage.weather || "Fair");
      }

      const results = await this._rollHidden([member], {
        label: game.i18n.localize(`WFRP4EPARTY.Endeavour${assignment.name.charAt(0).toUpperCase()}${assignment.name.slice(1)}`),
        skillName,
        difficulty: spec.difficulty,
        modifier,
        allowAdvancedFallback: !!spec.allowAdvancedFallback
      });
      const r = results?.[0];
      if (!r || r.skipped) {
        summaryLines.push(`<strong>${member.name}:</strong> — ${game.i18n.localize("WFRP4EPARTY.NoSkill")}</br>`);
        record.resolved = true;
        continue;
      }

      record.success = r.success;
      record.sl = String(r.sl);
      record.resolved = true;

      if (!r.success) failedMembers.push(member);
      if (assignment.name === "keepWatch" && r.success) keepWatchSuccess.push(member);
      if (assignment.name === "woodcraft" && r.success) woodcraftSuccess.push(member);
      // Map the Route: cumulative SL against 2x totalStages target (D9 — log only, no tracker item).
      if (assignment.name === "mapTheRoute") {
        summaryLines.push(`<strong>${member.name}</strong> (${game.i18n.localize("WFRP4EPARTY.EndeavourMapTheRoute")}): <strong>${r.sl} SL</strong> (${r.roll} v ${r.target}) — ${game.i18n.format("WFRP4EPARTY.JourneyMapTheRouteTarget", { target: 2 * config.totalStages })}</br>`);
      } else {
        summaryLines.push(`${r.success ? "<i class='fas fa-check'></i> " : "<i class='fas fa-xmark'></i> "}<strong>${member.name}</strong> (${skillName}): <strong>${r.sl} SL</strong> (${r.roll} v ${r.target})</br>`);
      }
    }

    // Make Camp: gather all campers assigned this Stage and run the pooled core once.
    // _runMakeCamp writes+reads the stages array independently (its own deepClone), so
    // re-mark campResolved on THIS function's outer `stages` clone too — otherwise the
    // _writeJourneyStages(stages) below would clobber _runMakeCamp's own write with a stale
    // pre-camp snapshot, silently resetting the anti-double-roll guard back to false.
    const camperIds = unresolved.filter(a => a.name === "makeCamp").map(a => a.memberId);
    if (camperIds.length) {
      const campers = camperIds.map(id => game.actors.get(id)).filter(Boolean);
      const campResult = await this._runMakeCamp(campers);
      for (const a of unresolved.filter(x => x.name === "makeCamp")) {
        const record = targetStage.endeavours.find(e => e.memberId === a.memberId && e.name === "makeCamp");
        if (record) record.resolved = true;
      }
      targetStage.campResolved = true;
      // D12 — camp-fail Fatigued lands in fatiguedMemberIds too (recorded on THIS clone,
      // which is written below — _runMakeCamp itself must not write them or the outer
      // write would clobber it, same race the campResolved comment above describes).
      if (campResult?.failedCamperIds?.length) {
        const ids = new Set(targetStage.fatiguedMemberIds);
        for (const id of campResult.failedCamperIds) ids.add(id);
        targetStage.fatiguedMemberIds = [...ids];
      }
    }

    if (keepWatchSuccess.length) targetStage.keepWatch = true;
    if (woodcraftSuccess.length) targetStage.exposureWaived = true;

    await this._writeJourneyStages(stages);

    if (summaryLines.length) {
      await ChatMessage.create({
        content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyEndeavourResults")}</h3>${summaryLines.join("")}`,
        whisper: PartySheet._gmWhisper(),
        blind: true
      });
    }
    if (pendingSkillChoice.length) {
      ui.notifications.warn(game.i18n.format("WFRP4EPARTY.JourneyEndeavourSkillMissing", { names: pendingSkillChoice.join(", ") }));
    }
    const actuallyResolved = unresolved.filter(a => !pendingSkillChoice.includes(game.actors.get(a.memberId)?.name));
    ui.notifications.info(game.i18n.format("WFRP4EPARTY.JourneyEndeavoursResolvedCount", { count: actuallyResolved.length }));

    const resolvedNames = actuallyResolved.map(a => {
      const member = game.actors.get(a.memberId);
      const label = game.i18n.localize(`WFRP4EPARTY.Endeavour${a.name.charAt(0).toUpperCase()}${a.name.slice(1)}`);
      return `${member?.name ?? "?"} (${label})`;
    }).join(", ");
    if (actuallyResolved.length) {
      await this._appendJourneyLog(game.i18n.format("WFRP4EPARTY.JourneyLogEndeavoursResolved", { members: resolvedNames }), undefined, true);
    }

    await this._resolveFailFatigued(
      failedMembers.map(m => ({ memberId: m.id, name: m.name, success: false })),
      failedMembers,
      game.i18n.localize("WFRP4EPARTY.JourneyEndeavourResults"),
      stages, idx
    );
    } finally {
      await requestMutation("end-journey-stage-work", { lockKey: lock.lockKey });
    }
  }

  // D10 — fail => Fatigued after a GM confirm listing the failed members; writes
  // fatiguedMemberIds onto the current Stage record when stageInfo is provided.
  async _resolveFailFatigued(results, members, label, stagesForWrite = null, stageIdx = null) {
    const failed = (results ?? []).filter(r => !r.skipped && r.success === false)
      .map(r => members.find(m => m.id === r.memberId)).filter(Boolean);
    if (!failed.length) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.format("WFRP4EPARTY.JourneyFailFatiguedTitle", { label }) },
      content: `<p>${game.i18n.localize("WFRP4EPARTY.JourneyFailFatiguedBody")}</p><ul>${failed.map(m => `<li>${m.name}</li>`).join("")}</ul>`,
    });
    if (!confirmed) return;

    for (const m of failed) await m.addCondition("fatigued");

    if (stagesForWrite && stageIdx != null && stagesForWrite[stageIdx]) {
      const ids = new Set(stagesForWrite[stageIdx].fatiguedMemberIds);
      for (const m of failed) ids.add(m.id);
      stagesForWrite[stageIdx].fatiguedMemberIds = [...ids];
      await this._writeJourneyStages(stagesForWrite);
    }
  }

  // E.2 — GM-triggered log summary post to chat (reveal via core "Reveal Message").
  // Phase 7 (Q&A ruling 4, user-directed scope addition) — the publicOnly checkbox filters
  // to !gmOnly entries before posting, so the resulting GM whisper is safely revealable
  // wholesale. Default unchecked posts every entry — byte-identical to pre-Phase-7 behavior.
  static async _onPostLogSummary(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const log = this.document.system.journey.log;
    if (!log.length) return;
    const publicOnly = !!target.closest(".journey-log-buttons")?.querySelector('[name="publicOnly"]')?.checked;
    const entries = publicOnly ? log.filter(e => !e.gmOnly) : log;
    const lines = entries.map(e => `<strong>${game.i18n.format("WFRP4EPARTY.JourneyLogStageLabel", { stage: e.stage })}:</strong> ${e.text}</br>`);
    await ChatMessage.create({
      content: `<h3>${game.i18n.localize("WFRP4EPARTY.JourneyLog")}</h3>${lines.join("")}`,
      whisper: PartySheet._gmWhisper(),
      blind: true
    });
  }

  // Destructive — confirm-gated (matches _onEndJourney/_onRemoveMember convention). Clears
  // the log only; does not touch stages/config/encounters.
  static async _onResetLogSummary(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    const log = this.document.system.journey.log;
    if (!log.length) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("WFRP4EPARTY.ResetLogConfirmTitle") },
      content: game.i18n.localize("WFRP4EPARTY.ResetLogConfirmBody"),
    });
    if (!confirmed) return;
    await this.document.update({ "system.journey.log": [] });
  }

  // E.1 — Arrival tests: Lore (region) Average (+20), Gossip Challenging (+0).
  // Lore (region) is a specialised skill ("Lore (Reikland)", "Lore (the Moot)", ...) — there
  // is no single "Lore" skill to roll. Enumerate every Lore specialisation actually owned by
  // a current party member and let the GM pick which one applies to this arrival (F8: Lore
  // is advanced/specialised, so non-owners of the picked specialisation are skipped).
  static async _onRollArrivalLore(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return; // D2/ADR-024 — Arrival mechanics are EiS-gated
    const refs = this._ownedMemberRefsForGM();
    const loreNames = new Set();
    for (const ref of refs) {
      const skills = ref.document.itemTags?.["skill"] ?? ref.document.items.filter(i => i.type === "skill");
      for (const s of skills) {
        if (/^Lore \(/i.test(s.name)) loreNames.add(s.name);
      }
    }
    if (!loreNames.size) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.JourneyNoLoreSkills"));

    const sorted = [...loreNames].sort();
    const skillName = sorted.length === 1 ? sorted[0] : await this._promptFromOptions(sorted, "WFRP4EPARTY.PickArrivalLore");
    if (!skillName) return;

    await this._runGroupTest({
      label: game.i18n.format("WFRP4EPARTY.JourneyArrivalLoreWithSpec", { lore: skillName }),
      skillName,
      difficulty: "average",
      modifier: 0,
      allowAdvancedFallback: false
    });
  }

  static async _onRollArrivalGossip(ev, target) {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.GMOnly"));
    if (!JourneyEngine.eisActive()) return; // D2/ADR-024 — Arrival mechanics are EiS-gated
    await this._runGroupTest({
      label: game.i18n.localize("WFRP4EPARTY.JourneyArrivalGossip"),
      skillName: game.i18n.localize("NAME.Gossip"),
      difficulty: "challenging",
      modifier: 0,
      allowAdvancedFallback: true
    });
  }

  // Side-effect-free roll loop shared by _runGroupTest (whole party) and
  // Make Camp (a GM-picked subset, Phase 5). No ChatMessage, no writes.
  // rollMode stays hardcoded here — never a parameter (HC3 / leak-vector ban).
  async _rollHidden(members, { label, skillName, characteristic, difficulty, modifier, allowAdvancedFallback = false }) {
    // Dynamic (picker skill-mode) resolution happens ONCE, before any member
    // rolls: an unknown skill name aborts loud with zero rolls (CCR-6).
    //
    // Members first, compendium second. findSkill searches world items + skill-tagged
    // packs (wfrp4e.js:1717/1771) and never looks at actors, so a world without a
    // skill-tagged pack — i.e. no wfrp4e-core — threw here and aborted the whole test
    // even when every member had the skill on their sheet. Reading it off an owner
    // also honours a world's homebrewed characteristic, which the pack lookup can't.
    // NOTE: Item#characteristic (wfrp4e.js:10103) returns the ACTOR's characteristic
    // object for an owned item, not the key — so read system.characteristic.value here.
    // findSkill's return is unowned, where the same getter does yield the key.
    let dynamicResolution = null;
    if (skillName && !characteristic) {
      let owned = null;
      for (const member of members) {
        const skills = member.itemTags?.["skill"] ?? member.items.filter(i => i.type === "skill");
        owned = skills.find(i => i.name === skillName);
        if (owned) break;
      }

      if (owned) {
        dynamicResolution = { characteristic: owned.system.characteristic.value, isBasic: owned.system.isBasic };
      } else {
        try {
          const resolved = await game.wfrp4e.utility.findSkill(skillName);
          dynamicResolution = { characteristic: resolved.characteristic.value, isBasic: resolved.system.isBasic };
        } catch (err) {
          ui.notifications.error(game.i18n.format("WFRP4EPARTY.UnknownSkill", { name: skillName }));
          return null;
        }
      }
    }

    // The system renders one full test card per roll (renderRollCard, wfrp4e.js:8365-8402),
    // so an N-member group test buried the single summary card its callers post under N
    // individual ones. Cancel them for the duration of the loop: returning false from
    // preCreateChatMessage blocks creation outright, so there is no card flash and no
    // delete race. Scoped to type "test" so an incidental non-test message still lands,
    // and released in a finally so a throwing roll cannot leak the hook and silence the
    // GM's chat for the rest of the session.
    //
    // NOT done via context.unopposed (which also skips renderRollCard at wfrp4e.js:7585):
    // that flag additionally alters result computation (wfrp4e.js:7811 automatic-success
    // handling, 7547/7558 pre/post effects), so it would change the rolls, not just the chat.
    //
    // Deliberately scoped to _rollHidden. _onRestMember (:903) rolls outside this method
    // and DEPENDS on the system card's Apply Healing button (onApplyHealing,
    // wfrp4e.js:33486-33502) — it must keep rendering.
    const results = [];
    const suppressCardHook = Hooks.on("preCreateChatMessage", message => {
      if (message.type === "test") return false;
    });

    try {
      for (const member of members) {
        const skills = skillName ? (member.itemTags?.["skill"] ?? member.items.filter(i => i.type === "skill")) : null;
        const skill = skillName ? skills.find(i => i.name === skillName) : null;

        const setupData = {
          skipDialog: true,
          skipTargets: true,
          fields: { rollMode: "blindroll", difficulty, modifier },
          title: `${label}: ${member.name}`
        };

        let test;
        let fallback = false;

        if (skill) {
          test = await member.setupSkill(skill, setupData);
        } else if (characteristic) {
          // Quick-button fixed-characteristic OR picker's direct characteristic-mode pick.
          test = await member.setupCharacteristic(characteristic, setupData);
          fallback = !!skillName;
        } else if (dynamicResolution && (dynamicResolution.isBasic || allowAdvancedFallback)) {
          test = await member.setupCharacteristic(dynamicResolution.characteristic, setupData);
          fallback = true;
        } else {
          // Unowned advanced skill, fallback not allowed — skip per GM Toolkit
          // parity (group-test.mjs:157-187).
          results.push({ memberId: member.id, name: member.name, skipped: true });
          continue;
        }

        if (!test) continue;
        await test.roll();

        const res = test?.result ?? {};
        results.push({
          memberId: member.id,
          name: member.name,
          sl: res.SL,
          roll: res.roll,
          target: test?.target ?? res.target,
          success: res.outcome === "success",
          fallback
        });
      }
    } finally {
      Hooks.off("preCreateChatMessage", suppressCardHook);
    }
    return results;
  }

  // Shared roll runner — the ONE roll path for quick buttons (_rollGroupTest)
  // and the picker (_onOpenGroupTestPicker). Resolves the whole-party member
  // list, delegates the roll loop to _rollHidden, then posts the GM whisper.
  async _runGroupTest({ label, skillName, characteristic, difficulty, modifier, allowAdvancedFallback = false }) {
    const members = [];
    for (const ref of this.document.system.members.list) {
      const member = ref.document;
      // Second clause guards the stale-cache window (member deleted while this
      // sheet was closed — no deleteActor hook ran to clear the cached ref).
      if (!member || !game.actors.get(ref.id)) continue;
      members.push(member);
    }

    const results = await this._rollHidden(members, { label, skillName, characteristic, difficulty, modifier, allowAdvancedFallback });
    if (!results || !results.length) return;

    // GM-whispered summary, GM Toolkit style (group-test.mjs:94-133)
    let content = `<h3>${game.i18n.localize("WFRP4EPARTY.GroupRolls")}: <strong>${label}</strong></h3>`
      + `<p>${game.wfrp4e.config.difficultyLabels[difficulty]}${modifier ? ` · ${game.i18n.localize("WFRP4EPARTY.Modifier")} ${modifier > 0 ? "+" : ""}${modifier}` : ""}</p>`;
    for (const r of results) {
      if (r.skipped) {
        content += `<strong>${r.name}:</strong> — ${game.i18n.localize("WFRP4EPARTY.NoSkill")}</br>`;
        continue;
      }
      content += `${r.success ? "<i class='fas fa-check'></i> " : "<i class='fas fa-xmark'></i> "}`
        + `<strong>${r.name}:</strong> <strong>${r.sl} SL</strong> (${r.roll} v ${r.target})`
        + `${r.fallback ? ` [${game.i18n.localize("WFRP4EPARTY.CharFallback")}]` : ""}</br>`;
    }
    await ChatMessage.create({
      content,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
      blind: true
    });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);

    // NEVER register this sheet on a member actor's registered-application list —
    // document deletion force-closes all registered apps (foundry.mjs #closeApplications).
    // "header" included since the party summary box moved there (2026-07-17) —
    // members-only would leave Speed/Fatigued/Wounds stale on member updates. "inventory"
    // added (Phase 4) so pool changes and member wealth changes both reflect live.
    this._debouncedMemberRender = foundry.utils.debounce(() => this.render({ parts: ["members", "header", "inventory"] }), 100);

    this._inventorySearch = new foundry.applications.ux.SearchFilter({
      inputSelector: ".party-inventory-search input",
      contentSelector: ".party-inventory-list",
      callback: (event, query, rgx, html) => {
        for (const row of html.querySelectorAll(".list-row")) {
          const name = row.querySelector(".list-name .label")?.textContent ?? "";
          row.classList.toggle("hidden", !!query && !foundry.applications.ux.SearchFilter.testQuery(rgx, name));
        }
      }
    });
    this._inventorySearch.bind(this.element);

    const hookNames = [
      "updateActor", "deleteActor",
      "createActiveEffect", "updateActiveEffect", "deleteActiveEffect",
      "createItem", "updateItem", "deleteItem"
    ];

    this._memberHooks = hookNames.map(hookName => {
      const id = Hooks.on(hookName, doc => {
        const actorId = doc.documentName === "Actor" ? doc.id : doc.parent?.id;
        // Phase 7 — connected vehicles join the same stale-cache-clear + debounced-render
        // guard as members (Risk 7.A deleted-vehicle tolerance): the capacity getter's own
        // game.actors.get() double-guard already zeroes a dead ref's contribution, but the
        // cached .document must still be cleared or later reads keep returning the stale Actor.
        const isVehicle = actorId && this._vehicleIds?.has(actorId);
        if (actorId && (this._memberIds?.has(actorId) || isVehicle)) {
          if (hookName === "deleteActor") {
            // warhammer-lib DocumentReferenceModel caches .document (warhammer-lib.js:9985)
            // and never invalidates — without this clear, the deleted member's ref keeps
            // returning the stale Actor, so the vacancy card never renders and
            // _runGroupTest rolls a dead actor (TestWFRP throws on undefined this.actor).
            const ref = this.document.system.members.list.find(r => r.id === actorId);
            if (ref) ref._document = null;
            const vehicleRef = this.document.system.vehicles.list.find(r => r.id === actorId);
            if (vehicleRef) vehicleRef._document = null;
          }
          this._debouncedMemberRender();
        }
      });
      return { hookName, id };
    });

    // Phase 7 (R7.1, user-directed 2026-07-19) — bespoke GM-gated kebab menu for pool item
    // rows, matching the character-sheet trapping list's UX (edit/remove/etc via a single
    // trailing control) WITHOUT reusing the inherited BaseWFRP4eActorSheet
    // _getContextMenuOptions: that stock menu has zero isGM/ownership gating and no delete
    // confirm (memo §Precedents), and the party actor is deliberately player-owned so
    // players can deposit — enabling it as-is would let any player delete pool items. Every
    // condition/callback re-checks permission itself (CCR-2), not just the template. Bound
    // once here (event-delegated against the stable outer container) rather than per-render.
    this._itemContextMenu = new foundry.applications.ux.ContextMenu(this.element, ".party-inventory-list .list-row .party-kebab", [
      {
        name: "WFRP4EPARTY.Withdraw",
        icon: '<i class="fas fa-arrow-right-from-bracket"></i>',
        condition: li => {
          const item = this.document.items.get(li.closest("[data-id]")?.dataset.id);
          return !!item && (game.user.isGM || this._ownedMemberRefs().length > 0);
        },
        callback: li => PartySheet._onWithdrawItem.call(this, {}, li)
      },
      {
        name: "WFRP4EPARTY.EditItem",
        icon: '<i class="fas fa-pen"></i>',
        condition: () => game.user.isGM,
        callback: li => PartySheet._onEditItem.call(this, {}, li)
      },
      {
        name: "WFRP4EPARTY.DeleteItem",
        icon: '<i class="fas fa-trash"></i>',
        condition: () => game.user.isGM,
        callback: li => PartySheet._onDeleteItem.call(this, {}, li)
      },
      {
        // Phase 8 (002) — GM-only quest-item toggle (task 1.4). Two condition-exclusive
        // entries rather than one dynamic-label entry, matching this menu's static-string
        // `name` convention above.
        name: "WFRP4EPARTY.QuestItemMark",
        icon: '<i class="fas fa-star"></i>',
        condition: li => {
          const item = this.document.items.get(li.closest("[data-id]")?.dataset.id);
          return game.user.isGM && !!item && !item.getFlag(MODULE_ID, "questItem");
        },
        callback: li => this.document.items.get(li.closest("[data-id]")?.dataset.id)?.setFlag(MODULE_ID, "questItem", true)
      },
      {
        name: "WFRP4EPARTY.QuestItemUnmark",
        icon: '<i class="fas fa-star-half-stroke"></i>',
        condition: li => {
          const item = this.document.items.get(li.closest("[data-id]")?.dataset.id);
          return game.user.isGM && !!item && !!item.getFlag(MODULE_ID, "questItem");
        },
        callback: li => this.document.items.get(li.closest("[data-id]")?.dataset.id)?.unsetFlag(MODULE_ID, "questItem")
      }
    ], { eventName: "click", jQuery: false, fixed: true });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Partial re-renders replace the "inventory" part's DOM — rebind so the SearchFilter's
    // resolved input/content elements never go stale.
    this._inventorySearch?.bind(this.element);

    // ApplicationV2's data-action framework only dispatches "click" — it never fires for a
    // <select>/<input type="number"> value change. These three journey controls need a
    // real "change" listener wired by hand (delegated, survives partial re-renders since
    // it's rebound every render rather than attached once to a node that gets replaced).
    if (this._journeyChangeListener) this.element.removeEventListener("change", this._journeyChangeListener);
    this._journeyChangeListener = async (event) => {
      const el = event.target.closest('[data-action="assignEndeavour"], [data-action="setEndeavourSkill"], [data-action="setEndeavourModifier"], [data-action="setWeatherLabel"], [data-action="setItemQuantity"], [data-action="setCapacityBonus"], [data-action="setMemberCategory"], [data-action="toggleRevealStats"]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === "assignEndeavour") await PartySheet._onAssignEndeavour.call(this, event, el);
      else if (action === "setEndeavourSkill") await PartySheet._onSetEndeavourSkill.call(this, event, el);
      else if (action === "setEndeavourModifier") await PartySheet._onSetEndeavourModifier.call(this, event, el);
      else if (action === "setWeatherLabel") await PartySheet._onSetWeatherLabel.call(this, event, el);
      else if (action === "setItemQuantity") await PartySheet._onSetItemQuantity.call(this, event, el);
      else if (action === "setCapacityBonus") await PartySheet._onSetCapacityBonus.call(this, event, el);
      else if (action === "setMemberCategory") await PartySheet._onSetMemberCategory.call(this, event, el);
    };
    this.element.addEventListener("change", this._journeyChangeListener);
  }

  async _onClose(options) {
    await super._onClose(options);
    for (const { hookName, id } of this._memberHooks ?? []) {
      Hooks.off(hookName, id);
    }
    this._memberHooks = [];
  }
}

registerMutationHandler("assign-endeavour", assignEndeavourMutation);
registerMutationHandler("set-endeavour-skill", setEndeavourSkillMutation);
registerMutationHandler("begin-journey-stage-work", async (payload, { requester }) => {
  if (!requester.isGM) return { ok: false, reason: "not-owner" };
  const partyActor = game.actors.get(payload.partyActorId);
  if (!partyActor || partyActor.type !== PARTY_ACTOR_TYPE) return { ok: false, reason: "actor-missing" };
  const journey = partyActor.system.journey;
  if (journey.config.status !== "travelling") return { ok: false, reason: "not-travelling" };
  const lockKey = `${partyActor.id}:${journey.config.currentStage}`;
  if (journeyStageLocks.has(lockKey)) return { ok: false, reason: "stage-busy" };
  journeyStageLocks.add(lockKey);
  return { ok: true, lockKey };
});
registerMutationHandler("end-journey-stage-work", async (payload, { requester }) => {
  if (!requester.isGM) return { ok: false, reason: "not-owner" };
  journeyStageLocks.delete(payload.lockKey);
  return { ok: true };
});

Hooks.on("preCreateItem", (item, data, options, userId) => {
  const partyActor = item.parent;
  if (partyActor?.type !== PARTY_ACTOR_TYPE) return true;
  // v0.2.3 — nothing in the communal pool is equipped by anyone. Reset system.equipped.value so
  // the system's DERIVED encumbrance (system.encumbrance.total, which reduceEquippedEncumbrance
  // subtracts 1 from for equipped armour/clothing/containers — wfrp4e.js:27454) reflects the true
  // unworn weight. A worn Leather Jack deposited while equipped otherwise carries its reduced
  // value (0 instead of 1) into the pool's row display AND the load-bearing capacity.current sum
  // (party-model.js). `equipped` is the real live field — `worn` is a deprecated getter alias.
  // This runs BEFORE the trusted-write short-circuit so it also covers the transfer-deposit path,
  // which passes capacityChecked and would otherwise return early. Weapons/ammunition have no
  // equipped field (optional chaining no-ops) and are unaffected.
  if (item.system?.equipped?.value) item.updateSource({ "system.equipped.value": false });
  if (trustedCapacityWrite(options)) return true;
  return rejectCapacityWrite(partyActor, physicalItemLoad(item), userId);
});

Hooks.on("preUpdateItem", (item, changes, options, userId) => {
  const partyActor = item.parent;
  if (partyActor?.type !== PARTY_ACTOR_TYPE || trustedCapacityWrite(options)) return true;
  const touchesQuantity = Object.hasOwn(changes, "system.quantity.value")
    || foundry.utils.hasProperty(changes, "system.quantity.value");
  const touchesEncumbrance = Object.hasOwn(changes, "system.encumbrance.value")
    || foundry.utils.hasProperty(changes, "system.encumbrance.value");
  if (!touchesQuantity && !touchesEncumbrance) return true;

  const incomingEnc = physicalItemLoad(item, changes) - physicalItemLoad(item);
  if (incomingEnc <= 0) return true;
  return rejectCapacityWrite(partyActor, incomingEnc, userId);
});

// Phase 8 (004) — completes a GM drag from the pool onto a member's sheet as a MOVE.
//
// The receiving sheet has already created its copy by the time this fires; all that is left is
// removing the pool's source stack. That ordering is forced on us — we do not control the other
// sheet's handler — so the risk to manage is a copy that lands while the removal fails, i.e. a
// duplicate. We therefore verify the removal actually happened and, if it did not, delete the
// copy we just caused. Losing the drop is recoverable; silently doubling party property is not.
Hooks.on("createItem", async (item, options, userId) => {
  const marker = options?.[POOL_MOVE_FLAG];
  // Only the GM who started the drag completes it — otherwise every connected client would race
  // to remove the same source stack.
  if (!marker || userId !== game.user.id || !game.user.isGM) return;

  const party = await fromUuid(marker.partyUuid);
  const source = party?.items?.get(marker.itemId);
  // Nothing to remove (already gone, or the drop landed back on the party itself) — leave it be.
  if (!party || !source || item.parent?.uuid === party.uuid) return;

  try {
    await party.deleteEmbeddedDocuments("Item", [marker.itemId], { [POOL_MOVE_FLAG]: true });
    // Trust nothing: confirm the source really left the pool before calling this a move.
    if (party.items.get(marker.itemId)) throw new Error("source stack still present after delete");
  } catch (err) {
    console.error("wfrp4e-party-sheet | pool move failed, rolling back the copy", err);
    try {
      await item.delete();
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.PoolMoveFailed"));
    } catch (rollbackErr) {
      // Both halves failed — the item now exists twice. Say so loudly rather than leave the GM
      // to discover it at the table.
      console.error("wfrp4e-party-sheet | rollback ALSO failed", rollbackErr);
      ui.notifications.error(game.i18n.format("WFRP4EPARTY.PoolMoveDuplicate", { name: item.name }));
    }
  }
});

Hooks.on("init", () => {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, "wfrp4e-party-sheet", PartySheet, {
    types: ["wfrp4e-party-sheet.party"],
    makeDefault: true,
    label: "Party Sheet"
  });
})

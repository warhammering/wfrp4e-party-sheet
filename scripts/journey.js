// Phase 6 — JourneyEngine: the EiS-gated journey/travel engine over `system.journey`.
// party-sheet.js keeps thin handlers; all journey mechanics (weather bands, encounter
// pools, endeavour specs) live here so the eisActive() gate seam (D3) has one call site
// per feature branch.

// D2/D3 — the single overridable seam: full engine (weather roll+effects, endeavour
// engine, Arrival mechanics, EiS pool share) requires wfrp4e-eis active + its table pack
// present; simple mode falls back to config/manual-label/fallback-only draws. A plain
// static method (not a closure) so Smoke A can stub it via a cache-busted re-import
// without touching a real world module toggle.
export const JourneyEngine = {

  eisActive() {
    return game.modules.get("wfrp4e-eis")?.active === true && !!game.packs.get("wfrp4e-eis.tables");
  },

  // F2/F4 — live-verified 2026-07-18 (memo phase6_pre_plan.md). Pack `wfrp4e-eis.tables`.
  EIS_TABLE_IDS: {
    weather: {
      spring: "uIGX0DVM0LOPV1sV",
      summer: "nWFIs7NTZba5U4ud",
      autumn: "uaQDh07hphJwKbIc",
      winter: "BXLASUIUfEkbNbAN",
    },
    encounters: {
      positive: "mt2SIbr47G5S7YlZ",
      coincidental: "o8w4yttEZTotQ7jW",
      harmful: "zvHnOQRykqxZQyq2",
    },
  },

  // D15 — the only encounter result that automates a state write-back: Harmful
  // "Terrible Weather" carries +40 onto the next weather roll (matched by result _id,
  // never by text — F4).
  TERRIBLE_WEATHER_RESULT_ID: "oyiXO4RZMgXFrxLk",

  // Journal page for the D7 whisper's @UUID link (Weather chapter).
  WEATHER_JOURNAL_PAGE_UUID: "Compendium.wfrp4e-eis.journals.JournalEntry.1tdhntCNqK83TS94.JournalEntryPage.WHkF67bhn4ZHktqe",

  // "Options: Catching a Cold" (Core p.181-adjacent sidebar, EiS) — verified live 2026-07-18.
  // Contraction: fail a Challenging (+0) Endurance Test when exposed to the elements.
  // In Winter/Spring, a character who suffered Exposure also contracts the Common Cold.
  COMMON_COLD_ITEM: { packId: "wfrp4e-eis.items", itemId: "R4qQc4fnxQzuNg9l" },
  COMMON_COLD_SEASONS: ["winter", "spring"],

  // The module's own fallback pack (C.1/C.2).
  FALLBACK_PACK_ID: "wfrp4e-party-sheet.travel-events",
  FALLBACK_TABLE_NAMES: {
    positive: "Positive Encounters (Fallback)",
    coincidental: "Coincidental Encounters (Fallback)",
    harmful: "Harmful Encounters (Fallback)",
  },

  // D16 — Woodcraft's "−10 per step from Fair" ladder; positional distance, Fair = 0.
  // Band literals are STORAGE/COMPARE KEYS, not display strings — journey.stages[].weather
  // stores them verbatim and WEATHER_ENDURANCE_DIFFICULTY / EXPOSURE_QUALIFYING_BANDS /
  // woodcraftStepsFromFair all compare against them. Localizing the stored band would break
  // every comparison; display-side localization must map key -> label, never rename the key.
  WEATHER_LADDER: ["Dry", "Fair", "Rain", "Downpour", "Snow", "Blizzard"],

  woodcraftStepsFromFair(band) {
    const fairIndex = this.WEATHER_LADDER.indexOf("Fair");
    const idx = this.WEATHER_LADDER.indexOf(band);
    if (idx < 0) return 0;
    return Math.abs(idx - fairIndex);
  },

  // F2 — only these two bands mandate an Endurance test; failure => Fatigued.
  WEATHER_ENDURANCE_DIFFICULTY: {
    Snow: "average",
    Blizzard: "challenging",
  },

  // "Options: Catching a Cold" — Exposure only applies to Rain/Snow/Downpour/Blizzard
  // (never Dry/Fair). The button only shows once weather has actually been rolled for the
  // Stage AND the rolled band qualifies.
  EXPOSURE_QUALIFYING_BANDS: ["Rain", "Snow", "Downpour", "Blizzard"],

  // EiS's own weather-table result fields are themselves just @UUID[...]{Band} links to a
  // journal subsection — there is no separate plain-text effects summary embedded in the
  // table data to extract. These map band key -> i18n key for this module's OWN short
  // paraphrase of the RAW mechanical effects (memo F2; prose lives in en.json per CCR-3),
  // used purely as display text; the band itself is still only ever drawn when eisActive()
  // is true (D2/D3) — this dictionary never substitutes for owning the weather TABLE, only
  // for a result field EiS doesn't actually populate with prose.
  WEATHER_EFFECTS: {
    Dry: "WFRP4EPARTY.WeatherEffectDry",
    Fair: "WFRP4EPARTY.WeatherEffectFair",
    Rain: "WFRP4EPARTY.WeatherEffectRain",
    Downpour: "WFRP4EPARTY.WeatherEffectDownpour",
    Snow: "WFRP4EPARTY.WeatherEffectSnow",
    Blizzard: "WFRP4EPARTY.WeatherEffectBlizzard",
  },

  // F5 — Fatigued-on-arrival Fellowship penalty by Status tier (verbatim). Keyed by the
  // system's statusTiers KEYS ("g"/"s"/"b" — game.wfrp4e.config.statusTiers), which is what
  // details.status.tier holds and what findKey returns; never by the display names.
  ARRIVAL_FELLOWSHIP_PENALTY: {
    g: -20,
    s: -10,
    b: 0,
  },

  // F3 — the 8 Travel Endeavours. `skillName`/`characteristic` feed `_rollHidden` specs
  // directly; `special` keys are handled by resolveEndeavours (D.2) rather than encoded
  // generically here (Recuperate has no roll; Make Camp delegates to `_runMakeCamp`).
  ENDEAVOUR_SPECS: {
    forage: { skillName: "NAME.OutdoorSurvival", difficulty: "challenging" },
    gatherInformation: { skillName: "NAME.Gossip", difficulty: "challenging", allowAdvancedFallback: true },
    keepWatch: { skillName: "NAME.Perception", difficulty: "challenging" },
    practiceASkill: { skillName: null, difficulty: "challenging" }, // per-assignment skillChoice (D.2)
    woodcraft: { skillName: "NAME.OutdoorSurvival", difficulty: "challenging" }, // modifier computed live (D16)
    mapTheRoute: { skillName: null, difficulty: "average" }, // per-assignment skillChoice (D.2)
    makeCamp: { special: "makeCamp" },
    recuperate: { special: "recuperate" },
  },

  // D.2 — Map the Route rolls one of exactly these two (RAW, memo F3). Skill NAMES are
  // document names (matched against owned Items), not i18n keys — same matching rule as
  // the Lore (X) enumeration in party-sheet.js.
  MAP_THE_ROUTE_SKILLS: ["Trade (Cartography)", "Art (Drawing)"],

  // Per-assignment skill options for the two skillName:null endeavours. practiceASkill
  // offers the member's own owned skills (you practice what you have); mapTheRoute offers
  // the two RAW options unfiltered — picking an unowned one skips at roll time via
  // _rollHidden's advanced-skill rule, which is the honest RAW outcome. Returns null for
  // endeavours that need no choice, or when the member has nothing to offer.
  skillChoiceOptions(endeavourKey, actor) {
    if (endeavourKey === "practiceASkill") {
      const skills = actor.itemTags?.["skill"] ?? actor.items.filter(i => i.type === "skill");
      const names = [...new Set(skills.map(s => s.name))].sort();
      return names.length ? names : null;
    }
    if (endeavourKey === "mapTheRoute") return [...this.MAP_THE_ROUTE_SKILLS];
    return null;
  },

  // D5 — endeavour-outcome -> suggested encounter category (hint only; nothing auto-draws).
  // Impressive+ (SL >= 4, success — WFRP4e bands: Impressive is +4/+5, Astounding +6) =>
  // Positive; a fumble (SL <= -4, fail) OR strict majority (>50%) of resolved members
  // failing => Harmful; else Coincidental.
  suggestCategory(stageEndeavours) {
    const resolved = stageEndeavours.filter(e => e.resolved && e.name !== "recuperate");
    if (!resolved.length) return null;
    const impressive = resolved.some(e => e.success === true && Number(e.sl) >= 4);
    const fumble = resolved.some(e => e.success === false && Number(e.sl) <= -4);
    const failedCount = resolved.filter(e => e.success === false).length;
    const majorityFailed = failedCount > resolved.length / 2;
    if (impressive) return "positive";
    if (fumble || majorityFailed) return "harmful";
    return "coincidental";
  },

  // EiS weather-table result names are themselves @UUID[...]{Label} enrichment links (a link
  // to the matching journal subsection). Strip to the plain label for storage/comparison —
  // journey.stages[].weather is compared against plain band names elsewhere (Snow/Blizzard
  // button trigger, D16's woodcraftStepsFromFair ladder lookup) and must never carry markup.
  plainLabel(text) {
    if (!text) return text;
    const match = /@UUID\[[^\]]+\]\{([^}]+)\}/.exec(text);
    return match ? match[1] : text;
  },

  // Both EiS's and this module's own encounter/fallback table results follow the same
  // authoring shape (F4/pack authoring notes): `name` is blank, the title lives at the
  // front of `description` as `<b>Name</b>: text`. Extract {name, text} from a result,
  // preferring an explicit non-blank `result.name` if one is ever present.
  splitEncounterResult(result) {
    const explicitName = result?.name?.trim();
    const description = result?.description || result?.text || "";
    if (explicitName) return { name: explicitName, text: description };
    const match = /^<b>([^<]+)<\/b>:?\s*/.exec(description);
    if (match) return { name: match[1], text: description.slice(match[0].length) };
    return { name: "", text: description };
  },

  // E.2 — append one stage-stamped log entry. Returns the new array (caller writes it).
  // gmOnly entries (encounter draws, disease contraction, endeavour results — user ruling
  // 2026-07-19) are filtered out of the player-visible log render in _prepareJourneyContext.
  appendLog(log, stage, text, gmOnly = false) {
    return [...log, { stage, text, gmOnly }];
  },

  // Manual roll + in-memory range lookup, bypassing RollTable#draw()/#roll(). warhammer-lib
  // wraps RollTable.prototype.roll via libWrapper (warhammer-lib.js:11845) and throws
  // "Cannot read properties of null (reading 'map')" when draw() is called against a
  // compendium-sourced table's results collection — a third-party bug outside this module's
  // control. Reading table.results.contents directly (already this module's house style for
  // the combined-pool draw, C.4) and rolling the table's own formula sidesteps it entirely.
  async drawFromTable(table, modifier = 0) {
    const formula = table.formula || "1d100";
    const roll = await new Roll(`${formula} + ${modifier}`).evaluate();
    const results = table.results?.contents ?? [];
    const total = roll.total;
    // Out-of-range clamp (modifier pushed past the last band): pick the result with the
    // highest range end explicitly — authoring order is NOT guaranteed range-sorted for
    // GM custom tables, so a positional [length-1] fallback would be wrong there.
    const result = results.find(r => Array.isArray(r.range) && total >= r.range[0] && total <= r.range[1])
      ?? results.reduce((best, r) => ((r.range?.[1] ?? -Infinity) > (best?.range?.[1] ?? -Infinity) ? r : best), null);
    return { roll, result };
  },
};

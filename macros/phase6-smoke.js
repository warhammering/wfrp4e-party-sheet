// Phase 6 smoke — MCP-first (top-level await, JSON-string return, try/finally teardown, no
// dialogs, no positional indexing on createDocuments results — phase5 carry-forward lesson).
// party.sheet.constructor is used directly (no cache-busting) — run this against a freshly
// reloaded browser tab so it reflects current source.
//
// Design note: most Phase 6 journey actions (startJourney/advanceStage/rollWeather/
// drawEncounter/resolveEndeavours/etc.) are NOT DialogV2-gated, so they are driven directly
// via PartySheet._onXxx.call(sheetInstance, {}, fakeTarget) — the same call shape Foundry's
// action framework uses. The two genuinely dialog-gated surfaces (_onResolveEndeavours' fail
// => Fatigued confirm; the Make Camp picker) are handled per the Phase 5 precedent:
// DialogV2.confirm is stubbed unconditional-true for the run (restored in finally).
//
// Arrival case (8): social status is derived from a current Career by CharacterModel.computeCareer
// (wfrp4e.js:26361-26372). The fixture therefore embeds a minimal current Silver career; writing
// system.details.status.tier/standing directly on a career-less actor leaves display .value empty.

const results = [];
const record = (name, pass, detail) => { results.push({ case: name, ok: pass, detail }); };

const chatMessages = [];
const originalChatCreate = ChatMessage.create;
ChatMessage.create = async function (data, options) {
  chatMessages.push(data);
  return originalChatCreate.call(ChatMessage, data, options);
};

const originalConfirm = foundry.applications.api.DialogV2.confirm;
foundry.applications.api.DialogV2.confirm = async () => true;

const { JourneyEngine } = await import("/modules/wfrp4e-party-sheet/scripts/journey.js");

// The 13 fallback-only names (positive table) — shared by the fail-open case (3) and the
// combined-pool case (4): membership proves a fallback draw, non-membership an EiS draw.
const FALLBACK_NAMES = ["Sweet Water", "The Abandoned Camp", "The Generous Ford", "The Courier's Purse", "The Travelling Farrier", "The Herbalist's Prize", "The Stray", "The Hedgewise's Charm", "Windfall", "The King's Surveyor", "The Miller's Pond", "Market Day", "The Rat-Catcher"];

let party, pcs = [], outsider, ctx, PartySheet;

try {
  party = await Actor.create({ name: "TestParty-Phase6Smoke", type: "wfrp4e-party-sheet.party" });
  pcs = await Actor.createDocuments([
    { name: "TestPC-Phase6-A", type: "character" },
    { name: "TestPC-Phase6-B", type: "character" },
    { name: "TestPC-Phase6-C", type: "character" },
  ], { skipItems: true });
  for (const pc of pcs) await pc.setFlag("wfrp4e-party-sheet", "phase6smoke", true);
  for (const pc of pcs) await party.update(party.system.addMember(pc));
  outsider = await Actor.create({ name: "TestPC-Phase6-Outsider", type: "character" }, { skipItems: true });
  await outsider.setFlag("wfrp4e-party-sheet", "phase6smoke", true);
  party = game.actors.get(party.id);

  ctx = party.sheet;
  await ctx.render(true);
  PartySheet = ctx.constructor;

  // --- (1) journey lifecycle round-trip ------------------------------------------------
  {
    await party.update({ "system.journey.config.totalStages": 3 });
    await PartySheet._onStartJourney.call(ctx, {}, {});
    await PartySheet._onAdvanceStage.call(ctx, {}, {});
    await PartySheet._onAdvanceStage.call(ctx, {}, {});
    party = game.actors.get(party.id);
    const j = party.system.journey;
    record("journeyLifecycleRoundTrip",
      j.config.currentStage === 2 && j.stages.length === 2 && j.config.status === "travelling",
      { currentStage: j.config.currentStage, stagesLength: j.stages.length, status: j.config.status });

    await PartySheet._onAdvanceStage.call(ctx, {}, {});
    party = game.actors.get(party.id);
    const finalStage = party.system.journey;
    record("finalJourneyStageRemainsPlayable",
      finalStage.config.currentStage === 3 && finalStage.stages.length === 3 && finalStage.config.status === "travelling",
      { currentStage: finalStage.config.currentStage, stagesLength: finalStage.stages.length, status: finalStage.config.status });

    await PartySheet._onAdvanceStage.call(ctx, {}, {});
    party = game.actors.get(party.id);
    const arrived = party.system.journey;
    record("arrivalOccursAfterFinalStage",
      arrived.config.currentStage === 3 && arrived.stages.length === 3 && arrived.config.status === "arrived",
      { currentStage: arrived.config.currentStage, stagesLength: arrived.stages.length, status: arrived.config.status });

    // Restore the Stage-2 fixture used by the remaining Phase 6 smoke cases.
    await party.update({
      "system.journey.config.status": "travelling",
      "system.journey.config.currentStage": 2,
      "system.journey.stages": foundry.utils.deepClone(arrived.stages.slice(0, 2)),
    });
    party = game.actors.get(party.id);
  }

  // --- (1b) crafted journey values fail closed ------------------------------------------
  {
    const stageIndex = party.system.journey.config.currentStage - 1;
    const invalidMemberTarget = { value: "forage", dataset: { memberId: outsider.id } };
    await PartySheet._onAssignEndeavour.call(ctx, {}, invalidMemberTarget);
    const invalidNameTarget = { value: "notARealEndeavour", dataset: { memberId: pcs[0].id } };
    await PartySheet._onAssignEndeavour.call(ctx, {}, invalidNameTarget);
    const validTarget = { value: "practiceASkill", dataset: { memberId: pcs[0].id } };
    await PartySheet._onAssignEndeavour.call(ctx, {}, validTarget);
    const invalidSkillTarget = { value: "Definitely Not Owned", dataset: { memberId: pcs[0].id } };
    await PartySheet._onSetEndeavourSkill.call(ctx, {}, invalidSkillTarget);

    party = game.actors.get(party.id);
    const endeavours = party.system.journey.stages[stageIndex].endeavours;
    const outsiderRecord = endeavours.find(e => e.memberId === outsider.id);
    const memberRecord = endeavours.find(e => e.memberId === pcs[0].id);
    record("craftedJourneyInputsRejected",
      !outsiderRecord && memberRecord?.name === "practiceASkill" && memberRecord.skillChoice === "",
      { outsiderRecord, memberRecord });

    await Promise.all([
      PartySheet._onAssignEndeavour.call(ctx, {}, { value: "forage", dataset: { memberId: pcs[1].id } }),
      PartySheet._onAssignEndeavour.call(ctx, {}, { value: "keepWatch", dataset: { memberId: pcs[2].id } }),
    ]);
    party = game.actors.get(party.id);
    const queuedAssignments = party.system.journey.stages[stageIndex].endeavours;
    record("concurrentJourneyAssignmentsPreserved",
      queuedAssignments.some(e => e.memberId === pcs[0].id && e.name === "practiceASkill")
        && queuedAssignments.some(e => e.memberId === pcs[1].id && e.name === "forage")
        && queuedAssignments.some(e => e.memberId === pcs[2].id && e.name === "keepWatch"),
      { queuedAssignments });
  }

  // --- (2) weather draw (full mode) + modifier consume, band is plain text (no @UUID markup) --
  {
    const eisOn = JourneyEngine.eisActive();
    if (eisOn) {
      await PartySheet._onRollWeather.call(ctx, {}, {});
      party = game.actors.get(party.id);
      const stage = party.system.journey.stages[party.system.journey.config.currentStage - 1];
      record("weatherDrawSetsBand", !!stage.weather && !stage.weather.includes("@UUID"), { weather: stage.weather });

      await party.update({ "system.journey.config.nextWeatherModifier": 40 });
      await PartySheet._onRollWeather.call(ctx, {}, {});
      party = game.actors.get(party.id);
      record("weatherModifierConsumedToZero", party.system.journey.config.nextWeatherModifier === 0,
        { nextWeatherModifier: party.system.journey.config.nextWeatherModifier });
    } else {
      record("weatherDrawSetsBand", true, { skipped: "wfrp4e-eis not active" });
      record("weatherModifierConsumedToZero", true, { skipped: "simple mode" });
    }
  }

  // --- (3) fail-open: eisActive stubbed false, 30 draws all resolve from fallback names ---
  {
    const original = JourneyEngine.eisActive;
    JourneyEngine.eisActive = () => false;
    let allFromFallback = true, threw = false, errMsg = null;
    try {
      for (let i = 0; i < 30; i++) {
        await ctx._drawEncounterCategory("positive");
        party = game.actors.get(party.id);
        const stage = party.system.journey.stages[party.system.journey.config.currentStage - 1];
        const last = stage.encounters[stage.encounters.length - 1];
        if (!last || !FALLBACK_NAMES.includes(last.name)) allFromFallback = false;
      }
    } catch (err) { threw = true; errMsg = err.message; } finally { JourneyEngine.eisActive = original; }
    record("failOpen30DrawsFromFallback", allFromFallback && !threw, { allFromFallback, threw, errMsg });
  }

  // --- (4) combined mode: 30 draws hit both EiS-only AND fallback-only names -------------
  // AND-assertion against the full fallback-name set (criterion 6 as written): a fallback
  // draw = name in FALLBACK_NAMES, an EiS draw = name NOT in it. P(miss either side across
  // 30 uniform draws over the 7+13 pool) < 1e-5.
  {
    if (JourneyEngine.eisActive()) {
      let sawFallback = false, sawEis = false;
      for (let i = 0; i < 30; i++) {
        await ctx._drawEncounterCategory("positive");
        party = game.actors.get(party.id);
        const stage = party.system.journey.stages[party.system.journey.config.currentStage - 1];
        const last = stage.encounters[stage.encounters.length - 1];
        if (last?.name && FALLBACK_NAMES.includes(last.name)) sawFallback = true;
        if (last?.name && !FALLBACK_NAMES.includes(last.name)) sawEis = true;
      }
      record("combinedPoolSample30Draws", sawFallback && sawEis, { sawFallback, sawEis });
    } else {
      record("combinedPoolSample30Draws", true, { skipped: "wfrp4e-eis not active" });
    }
  }

  // --- (5) endeavour resolution: assign + resolve, read back structural state ------------
  // Includes practiceASkill with a preset skillChoice (F01 regression guard): "Perception"
  // is Basic, so the skill-less disposable PC rolls via the characteristic fallback — the
  // record must come back resolved WITH a real SL, proving the skillChoice path rolls.
  {
    if (JourneyEngine.eisActive()) {
      party = game.actors.get(party.id);
      const idx = party.system.journey.config.currentStage - 1;
      const stages = foundry.utils.deepClone(party.system.journey.stages);
      stages[idx].endeavours = [
        { memberId: pcs[0].id, name: "keepWatch", skillChoice: "", success: null, sl: "", resolved: false, modifier: 0 },
        { memberId: pcs[1].id, name: "forage", skillChoice: "", success: null, sl: "", resolved: false, modifier: 10 },
        { memberId: pcs[2].id, name: "practiceASkill", skillChoice: "Perception", success: null, sl: "", resolved: false, modifier: 0 },
      ];
      await party.update({ "system.journey.stages": stages });

      await PartySheet._onResolveEndeavours.call(ctx, {}, {});
      party = game.actors.get(party.id);
      const stage = party.system.journey.stages[idx];
      const allResolved = stage.endeavours.every(e => e.resolved === true);
      const practice = stage.endeavours.find(e => e.name === "practiceASkill");
      const practiceRolled = !!practice && practice.resolved === true && practice.sl !== "";
      record("endeavourResolutionStructural", allResolved && practiceRolled, { practiceRolled, endeavours: stage.endeavours });
    } else {
      record("endeavourResolutionStructural", true, { skipped: "wfrp4e-eis not active" });
    }
  }

  // --- (5b) F01 fail-loud: missing skillChoice leaves the assignment UNRESOLVED ----------
  {
    if (JourneyEngine.eisActive()) {
      party = game.actors.get(party.id);
      const idx = party.system.journey.config.currentStage - 1;
      const stages = foundry.utils.deepClone(party.system.journey.stages);
      stages[idx].endeavours = [
        { memberId: pcs[1].id, name: "mapTheRoute", skillChoice: "", success: null, sl: "", resolved: false, modifier: 0 },
      ];
      await party.update({ "system.journey.stages": stages });

      await PartySheet._onResolveEndeavours.call(ctx, {}, {});
      party = game.actors.get(party.id);
      const rec = party.system.journey.stages[idx].endeavours.find(e => e.name === "mapTheRoute");
      record("missingSkillChoiceBlocksResolve", !!rec && rec.resolved === false, { record: rec });
    } else {
      record("missingSkillChoiceBlocksResolve", true, { skipped: "wfrp4e-eis not active" });
    }
  }

  // --- (6) fail=>Fatigued data-layer proof ------------------------------------------------
  {
    party = game.actors.get(party.id);
    const member = pcs[2];
    const idx = party.system.journey.config.currentStage - 1;
    const stagesBefore = foundry.utils.deepClone(party.system.journey.stages);
    await ctx._resolveFailFatigued(
      [{ memberId: member.id, name: member.name, success: false }],
      [member], "Phase6SmokeFailTest", stagesBefore, idx
    );
    const after = game.actors.get(member.id);
    const stageAfter = game.actors.get(party.id).system.journey.stages[idx];
    record("failFatiguedAppliesAndRecordsStageId",
      !!after.hasCondition("fatigued") && stageAfter.fatiguedMemberIds.includes(member.id),
      { hasFatigued: !!after.hasCondition("fatigued"), fatiguedMemberIds: stageAfter.fatiguedMemberIds });
  }

  // --- (7) Recuperate blocked when member is in fatiguedMemberIds this Stage -------------
  {
    const member = pcs[2];
    const fakeTarget = { closest: () => ({ dataset: { id: member.id } }) };
    let warned = false;
    const originalWarn = ui.notifications.warn;
    ui.notifications.warn = (msg) => { warned = true; return originalWarn.call(ui.notifications, msg); };
    await PartySheet._onToggleRecuperate.call(ctx, {}, fakeTarget);
    ui.notifications.warn = originalWarn;
    const flagAfter = game.actors.get(member.id).getFlag("wfrp4e-party-sheet", "recuperate");
    record("recuperateBlockedByStageFatigue", warned && !flagAfter, { warned, flagAfter });
  }

  // --- (8) arrival readout: Fatigued + Silver status => -10 Fellowship -------------------
  {
    const member = pcs[2];
    await member.createEmbeddedDocuments("Item", [{
      name: "Phase 6 Smoke Silver Career",
      type: "career",
      system: {
        current: { value: true },
        level: { value: 1 },
        status: { tier: "s", standing: 3 },
      },
    }], { renderSheet: false });
    party = game.actors.get(party.id);
    await party.update({ "system.journey.config.status": "arrived" });
    const arrival = ctx._prepareArrivalContext();
    const entry = arrival.penalties.find(p => p.name === member.name);
    record("arrivalFellowshipPenaltyReadout", entry?.penalty === -10, { entry, allPenalties: arrival.penalties });
    await party.update({ "system.journey.config.status": "travelling" });
  }

  // --- (9) HC3: every journey ChatMessage created this run is all-GM whisper + blind -----
  {
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    const journeyMessages = chatMessages.filter(m => typeof m.content === "string" && m.content.includes("h3"));
    const allHc3 = journeyMessages.every(m =>
      Array.isArray(m.whisper) && m.whisper.length > 0 && m.whisper.every(id => gmIds.includes(id)) && m.blind === true);
    record("hc3AllJourneyMessagesGmWhisperBlind", allHc3, { messageCount: journeyMessages.length, sample: journeyMessages[0] });
  }

  // --- (10) gmOnly log filtering (F03/F17): encounter+endeavour entries GM-only; weather
  // BAND entries stay public (ruling refined 2026-07-19 round 2).
  {
    party = game.actors.get(party.id);
    const log = party.system.journey.log;
    const gmOnlyEntries = log.filter(e => e.gmOnly === true);
    const publicEntries = log.filter(e => !e.gmOnly);
    const weatherPublic = publicEntries.some(e => e.text.toLowerCase().includes("weather"));
    record("gmOnlyLogEntriesFlaggedAndFilterable",
      gmOnlyEntries.length > 0 && publicEntries.length > 0 && weatherPublic,
      { total: log.length, gmOnly: gmOnlyEntries.length, publicCount: publicEntries.length, weatherPublic });
  }

} finally {
  ChatMessage.create = originalChatCreate;
  foundry.applications.api.DialogV2.confirm = originalConfirm;
  if (pcs.length) for (const pc of pcs) await game.actors.get(pc.id)?.delete();
  if (outsider) await game.actors.get(outsider.id)?.delete();
  if (party) await game.actors.get(party.id)?.delete();
}

const allPass = results.every(r => r.ok);
return JSON.stringify({ results, allPass }, null, 2);

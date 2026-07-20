// Phase 3 smoke — GM-only. Bundles the deferred Phase 2 probes (round 0) with
// the Phase 3 HC3 leak probes + the DSN config-drift assert (memo §F4).
// Disposable TestCharacter clones only (CCR-7); no world-setting writes.
(async () => {
  if (!game.user.isGM) {
    return ui.notifications.error("Phase 3 smoke must be run as GM.");
  }

  const results = [];
  const record = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`[Phase3Smoke] ${pass ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
  };

  const skillPack = "wfrp4e-core.items";
  const perceptionName = game.i18n.localize("NAME.Perception");

  // --- Round 0: deferred Phase 2 probes (NF1 render budget, NF2 vacancy) ---
  console.log("[Phase3Smoke] Round 0 — deferred Phase 2 probes: creating disposable PCs...");
  const memberData = [];
  for (let i = 1; i <= 6; i++) {
    memberData.push({
      name: `TestPartyMember-${i}`,
      type: "character",
      img: "icons/svg/mystery-man.svg"
    });
  }
  const members = await Actor.createDocuments(memberData);

  const compendium = game.packs.get(skillPack);
  const index = await compendium.getIndex({ fields: ["type", "name"] });
  const perceptionEntry = index.find(e => e.type === "skill" && e.name === perceptionName);
  if (perceptionEntry) {
    const perceptionItem = await compendium.getDocument(perceptionEntry._id);
    await members[0].createEmbeddedDocuments("Item", [perceptionItem.toObject()]);
  }

  let party = await Actor.create({
    name: "TestParty-Phase3Smoke",
    type: "wfrp4e-party-sheet.party"
  });
  for (const member of members) {
    party = game.actors.get(party.id);
    await party.update(party.system.addMember(member));
  }
  party = game.actors.get(party.id);

  const sheet = party.sheet;
  const t0 = performance.now();
  await sheet.render(true);
  const renderMs = performance.now() - t0;
  record("NF1 render < 1000ms (6 members)", renderMs < 1000, `${renderMs.toFixed(1)}ms`);

  await new Promise(resolve => setTimeout(resolve, 200));

  console.log("[Phase3Smoke] Deleting member 6 to probe NF2 vacancy...");
  // Name-lookup, NOT members[5] — Actor.createDocuments does not preserve input
  // order in this world (observed [2,1,3,4,5,6] live, /agent-validate 2026-07-17).
  const memberSix = members.find(m => m.name === "TestPartyMember-6");
  await memberSix.delete();
  await new Promise(resolve => setTimeout(resolve, 300));
  const refreshedParty = game.actors.get(party.id);
  const vacantRef = refreshedParty.system.members.list.find(ref => ref.id === memberSix.id);
  record("NF2 vacancy card (deleted member still paired with a ref)", !!(vacantRef && !vacantRef.document));

  // --- HC3 leak probes: run one real group test through the shared runner ---
  console.log("[Phase3Smoke] Running a group test (Perception) through the shared runner...");
  const beforeIds = new Set(game.messages.contents.map(m => m.id));

  await refreshedParty.sheet._runGroupTest({
    label: perceptionName,
    skillName: perceptionName,
    characteristic: "i",
    difficulty: "challenging",
    modifier: 0
  });
  await new Promise(resolve => setTimeout(resolve, 300));

  const newMessages = game.messages.contents.filter(m => !beforeIds.has(m.id));
  // NEVER filter on rolls.length > 0 — test cards under blindroll carry empty rolls (memo §F4).
  const testMessages = newMessages.filter(m => m.type === "test" && m.system?.testData);
  const summaryMessage = newMessages.find(m => m.content?.includes(perceptionName) && m.content?.includes(game.i18n.localize("WFRP4EPARTY.GroupRolls")));

  record("At least one per-member test message produced", testMessages.length > 0, `${testMessages.length} test message(s)`);

  for (const msg of testMessages) {
    const whisper = msg.whisper ?? [];
    const allGM = whisper.length > 0 && whisper.every(id => game.users.get(id)?.isGM === true);
    record(`Leak probe (1) whisper all-GM — msg ${msg.id}`, allGM, `whisper=[${whisper.join(",")}]`);
    record(`Leak probe (2) blind===true — msg ${msg.id}`, msg.blind === true);
    const authorIsGM = game.users.get(msg.author?.id ?? msg.author)?.isGM === true;
    record(`Leak probe (3) author resolves to GM — msg ${msg.id}`, authorIsGM);
  }

  if (summaryMessage) {
    const whisper = summaryMessage.whisper ?? [];
    const allGM = whisper.length > 0 && whisper.every(id => game.users.get(id)?.isGM === true);
    record("Leak probe (5) summary card whisper all-GM", allGM, `whisper=[${whisper.join(",")}]`);
    record("Summary card blind===true (defense-in-depth parity)", summaryMessage.blind === true);
  } else {
    record("Summary card located", false, "no message matched the summary content/flavor heuristic");
  }

  // Leak probe (4) — player-perspective recompute. Data-layer proxy: no second
  // client is required; recompute isAuthor||whisper.includes(playerId) for
  // every non-GM user against every new message.
  const nonGmUsers = game.users.filter(u => !u.isGM);
  if (nonGmUsers.length === 0) {
    record("Leak probe (4) player-perspective recompute", true, "no non-GM users in this world — N/A, skipped (data-layer proxy has no target)");
  } else {
    let allHidden = true;
    for (const user of nonGmUsers) {
      for (const msg of [...testMessages, ...(summaryMessage ? [summaryMessage] : [])]) {
        const isAuthor = (msg.author?.id ?? msg.author) === user.id;
        const visible = isAuthor || (msg.whisper ?? []).includes(user.id);
        if (visible) allHidden = false;
      }
    }
    record("Leak probe (4) player-perspective recompute (no player sees any group-test message)", allHidden);
  }

  // --- DSN config-drift assert (read-only; memo §F4 §1) ---
  const dsnActive = game.modules.get("dice-so-nice")?.active;
  if (dsnActive) {
    const dsnSetting = game.settings.get("dice-so-nice", "hide3dDiceOnSecretRolls");
    record("DSN hide3dDiceOnSecretRolls === true", dsnSetting === true, `value=${dsnSetting}`);
  } else {
    record("DSN config-drift assert", true, "Dice So Nice not active — N/A");
  }

  // --- Summary table ---
  console.log("=== [Phase3Smoke] Summary ===");
  console.table(results.map(r => ({ Probe: r.name, Result: r.pass ? "PASS" : "FAIL", Detail: r.detail ?? "" })));
  const failCount = results.filter(r => !r.pass).length;
  if (failCount > 0) {
    console.error(`[Phase3Smoke] ${failCount} probe(s) FAILED — see table above.`);
  } else {
    console.log("[Phase3Smoke] All probes PASS.");
  }

  const cleanup = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Phase 3 Smoke Cleanup" },
    content: "Delete all disposable smoke actors (party + remaining members) and the test messages created by this run?"
  });
  if (cleanup) {
    await refreshedParty.delete();
    await Actor.deleteDocuments(members.filter(m => m.id !== memberSix.id).map(m => m.id));
    await ChatMessage.deleteDocuments(newMessages.map(m => m.id));
    console.log("[Phase3Smoke] Cleanup complete.");
  } else {
    console.log("[Phase3Smoke] Cleanup skipped; disposables left in world.");
  }
})();

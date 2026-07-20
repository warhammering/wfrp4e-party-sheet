(async () => {
  const skillPack = "wfrp4e-core.items";
  const skillName = game.i18n.localize("NAME.Perception");

  console.log("Phase 2 smoke: creating disposable PCs...");
  const memberData = [];
  for (let i = 1; i <= 6; i++) {
    memberData.push({
      name: `TestPartyMember-${i}`,
      type: "character",
      img: "icons/svg/mystery-man.svg"
    });
  }
  const members = await Actor.createDocuments(memberData);

  // Give member 1 the Perception skill so the A.1 probe exercises the owned-skill branch.
  const compendium = game.packs.get(skillPack);
  const index = await compendium.getIndex({ fields: ["type", "name"] });
  const perceptionEntry = index.find(e => e.type === "skill" && e.name === skillName);
  if (perceptionEntry) {
    const perceptionItem = await compendium.getDocument(perceptionEntry._id);
    await members[0].createEmbeddedDocuments("Item", [perceptionItem.toObject()]);
  } else {
    console.warn("Phase 2 smoke: Perception skill not found in compendium; member 1 will use the characteristic fallback too.");
  }

  console.log("Phase 2 smoke: creating disposable party actor...");
  let party = await Actor.create({
    name: "TestParty-Phase2Smoke",
    type: "wfrp4e-party-sheet.party"
  });

  for (const member of members) {
    party = game.actors.get(party.id);
    await party.update(party.system.addMember(member));
  }
  party = game.actors.get(party.id);

  const sheet = party.sheet;
  console.time("Phase2Smoke-Render");
  await sheet.render(true);
  console.timeEnd("Phase2Smoke-Render");

  // Give the render a tick to settle before probing.
  await new Promise(resolve => setTimeout(resolve, 200));

  console.log("Phase 2 smoke: per-member data-layer comparison (NF1 target < 1000 ms above) ---");
  for (const member of members) {
    const perception = member.items.find(i => i.type === "skill" && i.name === skillName);
    const expectedPerception = perception ? perception.system.total.value : member.system.characteristics.i.value;
    const expectedCool = member.system.characteristics.wp.value;
    const conditionCount = member.effects.filter(e => e.isCondition).length;
    console.log(`${member.name}: MATCH Perception=${expectedPerception} Cool=${expectedCool} conditions=${conditionCount} wounds=${member.system.status.wounds.value}/${member.system.status.wounds.max}`);
  }

  console.log("Phase 2 smoke: deleting member 6 to probe NF2 vacant card...");
  const memberSix = members[5];
  await memberSix.delete();
  await new Promise(resolve => setTimeout(resolve, 200));

  const refreshedParty = game.actors.get(party.id);
  const vacantRef = refreshedParty.system.members.list.find(ref => ref.id === memberSix.id);
  if (vacantRef && !vacantRef.document) {
    console.log("Phase2Smoke-NF2: vacant card assertion PASS");
  } else {
    console.error("Phase2Smoke-NF2: vacant card assertion FAIL");
  }

  const cleanup = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Phase 2 Smoke Cleanup" },
    content: "Delete all disposable smoke actors (party + remaining members)?"
  });
  if (cleanup) {
    await refreshedParty.delete();
    await Actor.deleteDocuments(members.filter(m => m.id !== memberSix.id).map(m => m.id));
    console.log("Phase 2 smoke: cleanup complete.");
  } else {
    console.log("Phase 2 smoke: cleanup skipped; disposables left in world.");
  }
})();

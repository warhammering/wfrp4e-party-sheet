// Phase 7 smoke — data-layer harness (pattern per macros/phase6-smoke.js: top-level await,
// JSON-string return, DialogV2.confirm stub-and-restore in finally, no positional indexing on
// createDocuments results). Fixture rules (memo §Confirmed facts / task 4.3): disposable actors
// only, flagged "wfrp4e-party-sheet.phase7smoke" for one-sweep teardown; NPC/PC fixtures use
// options.skipItems: true (avoids the getInitialItems confirm-prompt DialogV2 deadlock under
// MCP); vehicle fixtures set system.status.carries.max at CREATE time (never vehicle.update() —
// Risk 7.A); never fake details.status by writing tier/standing directly (Phase 6 F16 lesson) —
// arrivalCareerlessNoThrow uses a genuinely career-less actor instead.
//
// Capacity-boundary cases (2/3/4/11) run against a dedicated capParty/capPC pair (max=1 with a
// single member, no coins) rather than the shared main `party`, so their exact-Enc assertions
// never race the CRUD/NPC/vehicle cases sharing that same party.

const results = [];
const record = (name, pass, detail) => { results.push({ case: name, ok: pass, detail }); };

const originalConfirm = foundry.applications.api.DialogV2.confirm;
foundry.applications.api.DialogV2.confirm = async () => true;

const transfer = await import("/modules/wfrp4e-party-sheet/scripts/transfer.js");
const { backfillPartyCoins } = await import("/modules/wfrp4e-party-sheet/scripts/party-model.js");

let party, pc1, pc2, pc3, npc1, vehicle, vehicle2, vehicle3, freshParty, capParty, capPC;
let queueParty, queuePC1, queuePC2;
let ctx, capCtx, PartySheet;
let exactItemId = null;

try {
  party = await Actor.create({ name: "TestParty-Phase7Smoke", type: "wfrp4e-party-sheet.party" });
  pc1 = await Actor.create({ name: "TestPC-Phase7-A", type: "character" }, { skipItems: true });
  pc2 = await Actor.create({ name: "TestPC-Phase7-B", type: "character" }, { skipItems: true });
  npc1 = await Actor.create({ name: "TestNPC-Phase7-A", type: "npc" }, { skipItems: true });
  vehicle = await Actor.create({ name: "TestVehicle-Phase7-A", type: "vehicle", system: { status: { carries: { max: 50 } } } });
  vehicle2 = await Actor.create({ name: "TestVehicle-Phase7-B", type: "vehicle", system: { status: { carries: { max: 30 } } } });
  vehicle3 = await Actor.create({ name: "TestVehicle-Phase7-C", type: "vehicle", system: { status: { carries: { max: 15 } } } });

  for (const a of [pc1, pc2, npc1, vehicle, vehicle2, vehicle3]) await a.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
  await party.setFlag("wfrp4e-party-sheet", "phase7smoke", true);

  await party.update(party.system.addMember(pc1));
  await party.update(party.system.addMember(pc2));
  party = game.actors.get(party.id);

  ctx = party.sheet;
  await ctx.render(true);
  PartySheet = ctx.constructor;

  // Ample headroom for every non-capacity-boundary case sharing `party` below.
  await party.update({ "system.capacityBonus": 1000 });
  party = game.actors.get(party.id);

  // --- (5) consolidate250bp — canonical coin reshape, conservation verified ---------------
  {
    const bpItem = party.items.find(i => i.type === "money" && i.system.coinValue?.value === 1);
    await party.updateEmbeddedDocuments("Item", [{ _id: bpItem.id, "system.quantity.value": 250 }]);
    party = game.actors.get(party.id);
    const result = await transfer.consolidateCoins(party);
    party = game.actors.get(party.id);
    const gcQty = party.items.find(i => i.type === "money" && i.system.coinValue?.value === 240)?.system.quantity.value ?? 0;
    const ssQty = party.items.find(i => i.type === "money" && i.system.coinValue?.value === 12)?.system.quantity.value ?? 0;
    const bpQty = party.items.find(i => i.type === "money" && i.system.coinValue?.value === 1)?.system.quantity.value ?? 0;
    record("consolidate250bp",
      result.ok && result.beforeBrass === 250 && result.afterBrass === 250 && gcQty === 1 && ssQty === 0 && bpQty === 10,
      { result, gcQty, ssQty, bpQty });
  }

  // --- (6) freshPartySeedsThreeCoinsAtZero — getInitialItems() override rides _preCreate -----
  {
    freshParty = await Actor.create({ name: "TestFreshParty-Phase7Smoke", type: "wfrp4e-party-sheet.party" });
    await freshParty.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
    freshParty = game.actors.get(freshParty.id);
    const moneyItems = freshParty.items.filter(i => i.type === "money");
    const coinValues = moneyItems.map(i => i.system.coinValue?.value).sort((a, b) => a - b);
    const allZero = moneyItems.every(i => i.system.quantity.value === 0);
    record("freshPartySeedsThreeCoinsAtZero",
      coinValues.length === 3 && coinValues.join(",") === "1,12,240" && allZero,
      { coinValues, allZero, count: moneyItems.length });
  }

  // --- (7) backfillAddsMissingCoinOnce — idempotent, matched by coinValue only ---------------
  {
    const ssItem = freshParty.items.find(i => i.type === "money" && i.system.coinValue?.value === 12);
    await freshParty.deleteEmbeddedDocuments("Item", [ssItem.id]);
    freshParty = game.actors.get(freshParty.id);
    await backfillPartyCoins(freshParty);
    await backfillPartyCoins(freshParty); // second run — must not duplicate
    freshParty = game.actors.get(freshParty.id);
    const ssItemsAfter = freshParty.items.filter(i => i.type === "money" && i.system.coinValue?.value === 12);
    record("backfillAddsMissingCoinOnce",
      ssItemsAfter.length === 1 && ssItemsAfter[0]?.system.quantity.value === 0,
      { count: ssItemsAfter.length, qty: ssItemsAfter[0]?.system.quantity.value });
  }

  // --- (21/22) forced verification/partial-write failures roll back completely --------------
  {
    const seeded = await transfer.addItem(party, { name: "RollbackAddItem", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 0 } } });
    party = game.actors.get(party.id);
    const mergeData = party.items.get(seeded.createdId).toObject();
    mergeData.system.quantity.value = 2;
    const originalVerifyTarget = transfer._internals.verifyTargetSettled;
    transfer._internals.verifyTargetSettled = async () => false;
    const mergeFailure = await transfer.addItem(party, mergeData);
    const createFailure = await transfer.addItem(party, { name: "RollbackCreateItem", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 0 } } });
    transfer._internals.verifyTargetSettled = originalVerifyTarget;
    party = game.actors.get(party.id);
    const mergedQty = party.items.get(seeded.createdId)?.system.quantity.value;
    const createdResidue = party.items.filter(i => i.name === "RollbackCreateItem").length;
    record("addItemVerifyFailuresRollback",
      !mergeFailure.ok && mergeFailure.rolledBack === true && mergedQty === 1
        && !createFailure.ok && createFailure.rolledBack === true && createdResidue === 0,
      { mergeFailure, createFailure, mergedQty, createdResidue });

    freshParty = game.actors.get(freshParty.id);
    await freshParty.update({ "system.capacityBonus": 10 });
    freshParty = game.actors.get(freshParty.id);
    const gc = freshParty.items.find(i => i.type === "money" && i.system.coinValue?.value === 240);
    const ss = freshParty.items.find(i => i.type === "money" && i.system.coinValue?.value === 12);
    const bp = freshParty.items.find(i => i.type === "money" && i.system.coinValue?.value === 1);
    await freshParty.updateEmbeddedDocuments("Item", [
      { _id: gc.id, "system.quantity.value": 0 },
      { _id: ss.id, "system.quantity.value": 1 },
      { _id: bp.id, "system.quantity.value": 12 },
    ]);
    const originalUpdateDenomination = transfer._internals.updateDenomination;
    let denominationWrites = 0;
    transfer._internals.updateDenomination = async (...args) => {
      denominationWrites++;
      if (denominationWrites === 2) throw new Error("forced-second-denomination-failure");
      return originalUpdateDenomination(...args);
    };
    const coinFailure = await transfer.consolidateCoins(freshParty);
    transfer._internals.updateDenomination = originalUpdateDenomination;
    freshParty = game.actors.get(freshParty.id);
    const afterDenoms = Object.fromEntries(freshParty.items.filter(i => i.type === "money").map(i => [i.system.coinValue.value, i.system.quantity.value]));
    record("partialCoinReshapeRollsBack",
      !coinFailure.ok && coinFailure.rolledBack === true
        && afterDenoms[240] === 0 && afterDenoms[12] === 1 && afterDenoms[1] === 12,
      { coinFailure, denominationWrites, afterDenoms });
  }

  // --- Capacity-boundary fixtures (isolated from `party`) ------------------------------------
  capParty = await Actor.create({ name: "TestCapParty-Phase7Smoke", type: "wfrp4e-party-sheet.party" }, { skipItems: true });
  await capParty.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
  capPC = await Actor.create({ name: "TestCapPC-Phase7", type: "character" }, { skipItems: true });
  await capPC.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
  await capParty.update(capParty.system.addMember(capPC));
  capParty = game.actors.get(capParty.id);
  capCtx = capParty.sheet;
  await capCtx.render(true);

  // --- (1) capacityFieldsRoundTrip — members-only / +vehicle / +vehicle+bonus ----------------
  {
    const maxMembersOnly = capParty.system.capacity.max;
    await capCtx._onDropActor({ uuid: vehicle.uuid });
    capParty = game.actors.get(capParty.id);
    const maxWithVehicle = capParty.system.capacity.max;
    await capParty.update({ "system.capacityBonus": 20 });
    capParty = game.actors.get(capParty.id);
    const maxWithVehicleAndBonus = capParty.system.capacity.max;

    record("capacityFieldsRoundTrip",
      maxMembersOnly === 1 && maxWithVehicle === 51 && maxWithVehicleAndBonus === 71,
      { maxMembersOnly, maxWithVehicle, maxWithVehicleAndBonus });

    // Reset to a clean max=1 baseline for cases 2/3/4/11.
    await capParty.update({ "system.capacityBonus": 0 });
    await PartySheet._onRemoveVehicle.call(capCtx, {}, { closest: () => ({ dataset: { id: vehicle.id } }) });
    capParty = game.actors.get(capParty.id);
  }

  // --- (2) overCapDepositBlockedPlayerPath — player deposit path, zero-partial-writes --------
  {
    const heavyItem = (await capPC.createEmbeddedDocuments("Item", [{ name: "HeavyItem1", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 5 } } }]))[0];
    const before = capParty.items.size;
    const result = await transfer.deposit(capPC, capParty, heavyItem.id, 1);
    capParty = game.actors.get(capParty.id);
    const after = capParty.items.size;
    record("overCapDepositBlockedPlayerPath",
      !result.ok && result.reason === "capacity-exceeded" && after === before,
      { result, before, after });
    await capPC.deleteEmbeddedDocuments("Item", [heavyItem.id]);
  }

  // --- (3) overCapGmAddBlocked — GM copy-create path, same gate --------------------------------
  {
    const before = capParty.items.size;
    const result = await transfer.addItem(capParty, { name: "HeavyItem2", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 5 } } });
    capParty = game.actors.get(capParty.id);
    const after = capParty.items.size;
    record("overCapGmAddBlocked",
      !result.ok && result.reason === "capacity-exceeded" && after === before,
      { result, before, after });
  }

  // --- (4) exactlyAtCapAllowed — R7.3 boundary wording: exactly-at-cap is allowed ------------
  {
    const exactItem = (await capPC.createEmbeddedDocuments("Item", [{ name: "ExactItem", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 1 } } }]))[0];
    const result = await transfer.deposit(capPC, capParty, exactItem.id, 1);
    capParty = game.actors.get(capParty.id);
    exactItemId = result.createdId;
    record("exactlyAtCapAllowed",
      result.ok === true && capParty.system.capacity.current === capParty.system.capacity.max,
      { result, current: capParty.system.capacity.current, max: capParty.system.capacity.max });
  }

  // --- (11) qtyIncreaseOverCapBlocked — quick-edit increase re-checks the cap ----------------
  {
    const fakeTarget = { value: "2", closest: () => ({ dataset: { id: exactItemId } }) };
    let errored = false;
    const origErr = ui.notifications.error;
    ui.notifications.error = (msg) => { errored = true; return origErr.call(ui.notifications, msg); };
    await PartySheet._onSetItemQuantity.call(capCtx, {}, fakeTarget);
    ui.notifications.error = origErr;
    capParty = game.actors.get(capParty.id);
    const qtyAfter = capParty.items.get(exactItemId)?.system.quantity.value;
    record("qtyIncreaseOverCapBlocked",
      errored && qtyAfter === 1 && fakeTarget.value === 1,
      { errored, qtyAfter, targetValueReset: fakeTarget.value });
  }

  // --- (23) cargo Enc is the amount, not a per-unit value multiplied by itself ---------------
  {
    await capParty.deleteEmbeddedDocuments("Item", [exactItemId]);
    await capParty.update({ "system.capacityBonus": 4 }); // member 1 + bonus 4 = max 5
    const cargoSource = (await capPC.createEmbeddedDocuments("Item", [{ name: "CargoCapacityProbe", type: "cargo", system: { encumbrance: { value: 3 } } }]))[0];
    const moveResult = await transfer.deposit(capPC, capParty, cargoSource.id, 3);
    capParty = game.actors.get(capParty.id);
    const movedCargo = capParty.items.get(moveResult.createdId);
    const cargoData = movedCargo?.toObject();
    const currentAfterMove = capParty.system.capacity.current;

    if (movedCargo) await capParty.deleteEmbeddedDocuments("Item", [movedCargo.id]);
    const addResult = await transfer.addItem(capParty, cargoData);
    capParty = game.actors.get(capParty.id);
    record("cargoCapacityUsesTransferredEncDirectly",
      moveResult.ok && currentAfterMove === 3 && addResult.ok && capParty.system.capacity.current === 3,
      { moveResult, currentAfterMove, addResult, currentAfterAdd: capParty.system.capacity.current, max: capParty.system.capacity.max });

    const cargoTarget = capParty.items.get(addResult.createdId);
    await cargoTarget.update({ "system.encumbrance.value": 6 });
    capParty = game.actors.get(capParty.id);
    const cargoAfterNativeUpdate = capParty.items.get(addResult.createdId)?.system.encumbrance.value;
    const beforeDirectCreate = capParty.items.size;
    await capParty.createEmbeddedDocuments("Item", [{ name: "DirectOverCapCreate", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 3 } } }]);
    capParty = game.actors.get(capParty.id);
    record("nativeItemWritesCannotBypassCapacity",
      cargoAfterNativeUpdate === 3 && capParty.items.size === beforeDirectCreate,
      { cargoAfterNativeUpdate, beforeDirectCreate, afterDirectCreate: capParty.items.size, current: capParty.system.capacity.current, max: capParty.system.capacity.max });
  }

  // --- (19/20) authoritative queue — concurrent stack + capacity decisions ------------------
  {
    queueParty = await Actor.create({ name: "TestQueueParty-Phase7Smoke", type: "wfrp4e-party-sheet.party" }, { skipItems: true });
    queuePC1 = await Actor.create({ name: "TestQueuePC-A", type: "character" }, { skipItems: true });
    queuePC2 = await Actor.create({ name: "TestQueuePC-B", type: "character" }, { skipItems: true });
    for (const a of [queueParty, queuePC1, queuePC2]) await a.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
    await queueParty.update(queueParty.system.addMember(queuePC1));
    await queueParty.update(queueParty.system.addMember(queuePC2));
    queueParty = game.actors.get(queueParty.id);

    const stackA = (await queuePC1.createEmbeddedDocuments("Item", [{ name: "QueueStack", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 0 } } }]))[0];
    const stackB = (await queuePC2.createEmbeddedDocuments("Item", [{ name: "QueueStack", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 0 } } }]))[0];
    const stackResults = await Promise.all([
      transfer.deposit(queuePC1, queueParty, stackA.id, 1),
      transfer.deposit(queuePC2, queueParty, stackB.id, 1),
    ]);
    queueParty = game.actors.get(queueParty.id);
    const queuedStack = queueParty.items.find(i => i.name === "QueueStack");
    record("concurrentDepositsSerializeWithoutLoss",
      stackResults.every(r => r.ok) && queuedStack?.system.quantity.value === 2
        && !game.actors.get(queuePC1.id).items.get(stackA.id) && !game.actors.get(queuePC2.id).items.get(stackB.id),
      { stackResults, targetQty: queuedStack?.system.quantity.value });

    const capA = (await queuePC1.createEmbeddedDocuments("Item", [{ name: "QueueCapA", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 2 } } }]))[0];
    const capB = (await queuePC2.createEmbeddedDocuments("Item", [{ name: "QueueCapB", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 2 } } }]))[0];
    const capResults = await Promise.all([
      transfer.deposit(queuePC1, queueParty, capA.id, 1),
      transfer.deposit(queuePC2, queueParty, capB.id, 1),
    ]);
    queueParty = game.actors.get(queueParty.id);
    const successCount = capResults.filter(r => r.ok).length;
    const blockedCount = capResults.filter(r => r.reason === "capacity-exceeded").length;
    const remainingSources = [
      game.actors.get(queuePC1.id).items.get(capA.id),
      game.actors.get(queuePC2.id).items.get(capB.id),
    ].filter(Boolean).length;
    record("concurrentCapacityCheckAllowsOnlyOne",
      successCount === 1 && blockedCount === 1 && queueParty.system.capacity.current === 2 && remainingSources === 1,
      { capResults, successCount, blockedCount, current: queueParty.system.capacity.current, remainingSources });

    const qualifiedA = (await queuePC1.createEmbeddedDocuments("Item", [{ name: "Qualified Queue Sword", type: "weapon", system: { quantity: { value: 1 }, encumbrance: { value: 0 }, damage: { value: "+4" }, qualities: { value: [{ name: "fine" }, { name: "durable", value: 1 }] }, flaws: { value: [] } } }]))[0];
    const qualifiedB = (await queuePC2.createEmbeddedDocuments("Item", [{ name: "Qualified Queue Sword", type: "weapon", system: { quantity: { value: 1 }, encumbrance: { value: 0 }, damage: { value: "+4" }, qualities: { value: [{ name: "durable", value: 1 }, { name: "fine" }] }, flaws: { value: [] } } }]))[0];
    const qualifiedResults = await Promise.all([
      transfer.deposit(queuePC1, queueParty, qualifiedA.id, 1),
      transfer.deposit(queuePC2, queueParty, qualifiedB.id, 1),
    ]);
    queueParty = game.actors.get(queueParty.id);
    const qualifiedStacks = queueParty.items.filter(i => i.name === "Qualified Queue Sword");
    record("qualifiedItemsUseCanonicalStackIdentity",
      qualifiedResults.every(r => r.ok) && qualifiedStacks.length === 1 && qualifiedStacks[0].system.quantity.value === 2,
      { qualifiedResults, stackCount: qualifiedStacks.length, targetQty: qualifiedStacks[0]?.system.quantity.value });

    const customA = (await queuePC1.createEmbeddedDocuments("Item", [{ name: "Custom Queue Sword", type: "weapon", system: { quantity: { value: 1 }, encumbrance: { value: 0 }, damage: { value: "+4" }, qualities: { value: [] }, flaws: { value: [] } } }]))[0];
    const customB = (await queuePC2.createEmbeddedDocuments("Item", [{ name: "Custom Queue Sword", type: "weapon", system: { quantity: { value: 1 }, encumbrance: { value: 0 }, damage: { value: "+5" }, qualities: { value: [] }, flaws: { value: [] } } }]))[0];
    const customResults = await Promise.all([
      transfer.deposit(queuePC1, queueParty, customA.id, 1),
      transfer.deposit(queuePC2, queueParty, customB.id, 1),
    ]);
    queueParty = game.actors.get(queueParty.id);
    const customStacks = queueParty.items.filter(i => i.name === "Custom Queue Sword");
    record("customizedItemsNeverDestructivelyMerge",
      customResults.every(r => r.ok) && customStacks.length === 2
        && customStacks.map(i => i.system.damage.value).sort().join(",") === "+4,+5",
      { customResults, stackCount: customStacks.length, damages: customStacks.map(i => i.system.damage.value) });
  }

  // --- (8) vehicleConnectRaisesCapacity — connect/disconnect on the main party ---------------
  {
    await ctx._onDropActor({ uuid: vehicle.uuid });
    party = game.actors.get(party.id);
    const vehicleContribConnected = party.system.capacity.vehicle;
    await PartySheet._onRemoveVehicle.call(ctx, {}, { closest: () => ({ dataset: { id: vehicle.id } }) });
    party = game.actors.get(party.id);
    const vehicleContribDisconnected = party.system.capacity.vehicle;
    record("vehicleConnectRaisesCapacity",
      vehicleContribConnected === 50 && vehicleContribDisconnected === 0,
      { vehicleContribConnected, vehicleContribDisconnected });
  }

  // --- (9) deletedVehicleTolerated — deleted vehicle contributes 0, no throw ------------------
  {
    await ctx._onDropActor({ uuid: vehicle2.uuid });
    party = game.actors.get(party.id);
    await vehicle2.delete();
    party = game.actors.get(party.id);
    let threw = false;
    try {
      await ctx.render(true);
    } catch (err) { threw = true; }
    record("deletedVehicleTolerated",
      !threw && party.system.capacity.vehicle === 0,
      { threw, vehicleContrib: party.system.capacity.vehicle });

    // Clean up the now-dangling ref (the deletion-tolerance assertion above is already
    // complete) so it doesn't inflate vehicles.list.length in the multipleVehiclesStack case
    // below — a smoke-harness-only concern; the product itself tolerates dead refs fine.
    await PartySheet._onRemoveVehicle.call(ctx, {}, { closest: () => ({ dataset: { id: vehicle2.id } }) });
    party = game.actors.get(party.id);
  }

  // --- (19) multipleVehiclesStack — a party may connect more than one vehicle at once
  // (revised 2026-07-19); their Carries values sum, and removing one leaves the other intact.
  {
    await ctx._onDropActor({ uuid: vehicle.uuid });
    await ctx._onDropActor({ uuid: vehicle3.uuid });
    party = game.actors.get(party.id);
    const bothConnected = party.system.capacity.vehicle === 65 && party.system.vehicles.list.length === 2;

    await PartySheet._onRemoveVehicle.call(ctx, {}, { closest: () => ({ dataset: { id: vehicle.id } }) });
    party = game.actors.get(party.id);
    const oneRemaining = party.system.capacity.vehicle === 15
      && party.system.vehicles.list.length === 1
      && party.system.vehicles.list[0].id === vehicle3.id;

    record("multipleVehiclesStack", bothConnected && oneRemaining,
      { bothConnected, oneRemaining, vehicleContrib: party.system.capacity.vehicle });

    await PartySheet._onRemoveVehicle.call(ctx, {}, { closest: () => ({ dataset: { id: vehicle3.id } }) });
    party = game.actors.get(party.id);
  }

  // --- (10) gmCrudRoundTrip — add / qty-edit / delete, each read back from the data layer ----
  {
    const added = await transfer.addItem(party, { name: "CrudTestItem", type: "trapping", system: { quantity: { value: 3 }, encumbrance: { value: 1 } } });
    party = game.actors.get(party.id);
    const addOk = added.ok && party.items.get(added.createdId)?.system.quantity.value === 3;

    const fakeQtyTarget = { value: "5", closest: () => ({ dataset: { id: added.createdId } }) };
    await PartySheet._onSetItemQuantity.call(ctx, {}, fakeQtyTarget);
    party = game.actors.get(party.id);
    const qtyOk = party.items.get(added.createdId)?.system.quantity.value === 5;

    // User-reported live bug 2026-07-19: a second GM add of the same item used to always
    // create a NEW qty-1 row instead of stacking. addItem now merges via findMatchingStack.
    const before = party.items.filter(i => i.name === "CrudTestItem").length;
    const restacked = await transfer.addItem(party, { name: "CrudTestItem", type: "trapping", system: { quantity: { value: 2 }, encumbrance: { value: 1 } } });
    party = game.actors.get(party.id);
    const after = party.items.filter(i => i.name === "CrudTestItem").length;
    const stackOk = restacked.ok && restacked.createdId === added.createdId && after === before
      && party.items.get(added.createdId)?.system.quantity.value === 7;

    const fakeDeleteTarget = { closest: () => ({ dataset: { id: added.createdId } }) };
    await PartySheet._onDeleteItem.call(ctx, {}, fakeDeleteTarget);
    party = game.actors.get(party.id);
    const deleteOk = !party.items.get(added.createdId);

    record("gmCrudRoundTrip", addOk && qtyOk && stackOk && deleteOk, { addOk, qtyOk, stackOk, deleteOk, createdId: added.createdId });
  }

  // --- (12) npcDropAccepted — NPC joins, idempotent re-drop, unresolvable drop rejected ------
  {
    await ctx._onDropActor({ uuid: npc1.uuid });
    party = game.actors.get(party.id);
    const hasNpc1 = party.system.members.list.some(r => r.id === npc1.id);

    await ctx._onDropActor({ uuid: npc1.uuid });
    party = game.actors.get(party.id);
    const countAfterRedrop = party.system.members.list.filter(r => r.id === npc1.id).length;

    let rejected = false;
    const origInfo = ui.notifications.info;
    ui.notifications.info = (msg) => { rejected = true; return origInfo.call(ui.notifications, msg); };
    await ctx._onDropActor({ uuid: "Actor.doesnotexist12345" });
    ui.notifications.info = origInfo;

    record("npcDropAccepted",
      hasNpc1 && countAfterRedrop === 1 && rejected,
      { hasNpc1, countAfterRedrop, rejected });
  }

  // --- (13) npcRaisesCapacityByOne — head-count only, R7.5 -----------------------------------
  {
    party = game.actors.get(party.id);
    record("npcRaisesCapacityByOne",
      party.system.capacity.memberAllowance === 3,
      { memberAllowance: party.system.capacity.memberAllowance });
  }

  // --- (14) npcInSummaryLowestMove — NPC drives the party's lowest-Move aggregate ------------
  {
    await npc1.update({ "system.details.move.value": 3 });
    party = game.actors.get(party.id);
    const liveRefs = party.system.members.list.filter(r => r.document && game.actors.get(r.id));
    const cards = liveRefs.map(ref => ({ id: ref.id, vacant: false, isNpc: ref.document.type === "npc", ...ctx._prepareMemberCard(ref.document) }));
    const summary = ctx._prepareSummary(cards);
    record("npcInSummaryLowestMove", summary.lowestMove === 3,
      { lowestMove: summary.lowestMove, moves: cards.map(c => ({ name: c.name, move: c.move })) });
  }

  // --- (15) arrivalCareerlessNoThrow — career-less PC + NPC, no crash on the status idiom ----
  {
    pc3 = await Actor.create({ name: "TestPC-Phase7-Careerless", type: "character" }, { skipItems: true });
    await pc3.setFlag("wfrp4e-party-sheet", "phase7smoke", true);
    await party.update(party.system.addMember(pc3));
    party = game.actors.get(party.id);
    await pc3.addCondition("fatigued");
    await npc1.addCondition("fatigued");

    let threw = false, arrival = null;
    try { arrival = ctx._prepareArrivalContext(); } catch (err) { threw = true; }
    const pc3Entry = arrival?.penalties.find(p => p.name === pc3.name);
    record("arrivalCareerlessNoThrow", !threw && !!pc3Entry, { threw, arrival });
  }

  // --- (16) npcRollHiddenWorks — NPC included in a real group test, HC3 shape re-asserted ----
  {
    const chatMsgs = [];
    const origCreate = ChatMessage.create;
    ChatMessage.create = async function (data, options) { chatMsgs.push(data); return origCreate.call(ChatMessage, data, options); };

    await ctx._runGroupTest({ label: "Phase7SmokeGroupTest", skillName: game.i18n.localize("NAME.Perception"), characteristic: "i", difficulty: "average", modifier: 0 });

    ChatMessage.create = origCreate;
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    // test.roll() posts its OWN per-member chat card as a side effect (blind-roll rollMode
    // still creates a message) — _runGroupTest's own combined summary is the ONLY one wrapped
    // in <h3>, so match on that marker rather than the label substring (which also appears in
    // every individual roll card's title and matched the wrong message — smoke-harness bug,
    // not a product bug, caught live 2026-07-19).
    const msg = chatMsgs.find(m => typeof m.content === "string" && m.content.includes("<h3>") && m.content.includes("Phase7SmokeGroupTest"));
    const npcRowPresent = !!msg && msg.content.includes(npc1.name);
    const hc3Shape = !!msg && Array.isArray(msg.whisper) && msg.whisper.length > 0 && msg.whisper.every(id => gmIds.includes(id)) && msg.blind === true;
    record("npcRollHiddenWorks", npcRowPresent && hc3Shape, { npcRowPresent, hc3Shape });
  }

  // --- (17) logSummaryPublicOnlyFilters — publicOnly checkbox filters !gmOnly entries --------
  {
    await party.update({ "system.journey.log": [
      { stage: 1, text: "Public entry", gmOnly: false },
      { stage: 1, text: "Secret entry", gmOnly: true },
    ] });
    party = game.actors.get(party.id);

    const chatMsgs = [];
    const origCreate = ChatMessage.create;
    ChatMessage.create = async function (data, options) { chatMsgs.push(data); return origCreate.call(ChatMessage, data, options); };

    const fakeCheckedTarget = { closest: () => ({ querySelector: () => ({ checked: true }) }) };
    await PartySheet._onPostLogSummary.call(ctx, {}, fakeCheckedTarget);
    const fakeUncheckedTarget = { closest: () => ({ querySelector: () => null }) };
    await PartySheet._onPostLogSummary.call(ctx, {}, fakeUncheckedTarget);

    ChatMessage.create = origCreate;
    const publicOnlyLines = (chatMsgs[0]?.content.match(/<strong>/g) || []).length;
    const defaultLines = (chatMsgs[1]?.content.match(/<strong>/g) || []).length;
    record("logSummaryPublicOnlyFilters",
      publicOnlyLines === 1 && defaultLines === 2,
      { publicOnlyLines, defaultLines });
  }

  // --- (18) invariantMemberEncIndependence — R7.5, both directions --------------------------
  {
    const maxBefore = party.system.capacity.max;
    const heavyItem = (await pc1.createEmbeddedDocuments("Item", [{ name: "PersonalHeavyItem", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 999 } } }]))[0];
    party = game.actors.get(party.id);
    const maxAfterMemberOverload = party.system.capacity.max;

    const pc1EncBefore = Number(pc1.system.status?.encumbrance?.current ?? 0);
    await transfer.addItem(party, { name: "PoolFiller", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 1 } } });
    const pc1After = game.actors.get(pc1.id);
    const pc1EncAfter = Number(pc1After.system.status?.encumbrance?.current ?? 0);

    await pc1.deleteEmbeddedDocuments("Item", [heavyItem.id]);

    record("invariantMemberEncIndependence",
      maxAfterMemberOverload === maxBefore && pc1EncAfter === pc1EncBefore,
      { maxBefore, maxAfterMemberOverload, pc1EncBefore, pc1EncAfter });
  }

} finally {
  foundry.applications.api.DialogV2.confirm = originalConfirm;
  for (const a of [pc1, pc2, pc3, npc1, vehicle, vehicle2, vehicle3, capPC, queuePC1, queuePC2]) {
    if (a) await game.actors.get(a.id)?.delete();
  }
  for (const p of [party, freshParty, capParty, queueParty]) {
    if (p) await game.actors.get(p.id)?.delete();
  }
}

const allPass = results.every(r => r.ok);
return JSON.stringify({ results, allPass }, null, 2);

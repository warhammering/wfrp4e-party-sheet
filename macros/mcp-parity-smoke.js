// mcp-parity-smoke.js — Phase 8 MCP-parity data-layer harness (plan task 5.2, file-authoring half).
// NOT phase8-smoke.js — that path is the separate, already-shipped "request group rolls from
// players" manual runbook (D15, module-internal v1.2.0 versioning) and is untouched by this file.
//
// Author-only artifact: this file is authored statically by piv-implementer, which holds no
// mcp__foundry-mcp__* tools and cannot execute it. The orchestrator runs it live post
// cc-restart + world-reload via mcp__foundry-mcp__macro execution, the same way phase7-smoke.js
// is invoked, and reports the JSON result this macro returns.
//
// Structure decision (task 5.2 latitude note — "match whichever shape [phase7-smoke.js] already
// uses ... consistency with the existing harness matters more than a new pattern"):
// phase7-smoke.js is ONE top-level-await script with no function-per-case exports (Foundry macros
// are standalone eval closures — nothing persists between separate macro executions, so a
// named-top-level-function shape callable individually by the orchestrator isn't actually
// reachable across runs). This file matches phase7-smoke.js's shape instead: one macro execution,
// one consolidated JSON result, 4 clearly labeled check-category sections mirroring
// phase7-smoke.js's "--- (N) name — description ---" block convention.
//
// Parity design (task 5.2's stated preference, option 1 — direct seam exercise): every write below
// goes through `game.modules.get("wfrp4e-party-sheet").api` (D6, task 2.1's exposed seam) — the
// EXACT object party-pool.ts / party-vehicles.ts call via getPartyApi(). This independently proves
// the data-layer behavior the MCP `party` umbrella tool depends on without a live MCP round-trip
// (which this authoring role cannot perform anyway).
//
// Fixture rules (phase7-smoke.js precedent, memo §Confirmed facts / task 4.3): disposable actors
// only, flagged "wfrp4e-party-sheet.mcpparitysmoke" for one-sweep teardown; PC fixtures use
// options.skipItems: true (avoids the getInitialItems confirm-prompt DialogV2 deadlock); vehicle
// fixtures set system.status.carries.max at CREATE time (never vehicle.update() — Risk 7.A);
// capacity-boundary cases run against a dedicated cap-party/cap-PC pair, isolated from the shared
// `party`, so their exact-Enc assertions never race the conservation/capacity cases sharing it.

const results = [];
const record = (name, pass, detail) => { results.push({ case: name, ok: pass, detail }); };

const originalConfirm = foundry.applications.api.DialogV2.confirm;
foundry.applications.api.DialogV2.confirm = async () => true;

// Chat-residue sweep — mirrors task 2.2's phase7-smoke.js `finally`-block pattern exactly (this is
// a separate macro file; Foundry macros cannot import/call another macro's script, so the shape is
// mirrored rather than duplicated-and-diverged: same capture-on-create / restore-and-delete-in-
// finally structure, same rationale — a stale chat card referencing a deleted fixture actor throws
// on every later world render).
const chatMessageIds = [];
const originalChatMessageCreate = ChatMessage.create;
ChatMessage.create = async function (data, options) {
  const msg = await originalChatMessageCreate.call(ChatMessage, data, options);
  if (msg?.id) chatMessageIds.push(msg.id);
  return msg;
};

const api = game.modules.get("wfrp4e-party-sheet").api;

// D9/party-shared.ts's own total-brass formula, replicated here (no cross-package import — this is
// a plain JS macro, party-shared.ts is TS) so the check can independently confirm the same figure
// the MCP handler's poolSummary()/verification logic reads: coinValue*quantity summed over
// non-secondary money items. (Disclosure: transfer.js's OWN internal ledger, sumCoinBrass(), uses a
// slightly different filter — "coinValue is in the live configured denomination set" rather than
// "not flagged secondaryId" — the two formulas agree whenever every money item is either a
// canonical configured coin or an explicitly-flagged secondary, which is true for every fixture
// this file creates, so the distinction does not affect these checks.)
function totalBrass(actor) {
  return actor.items
    .filter(i => i.type === "money" && !i.getFlag("wfrp4e-party-sheet", "secondaryId"))
    .reduce((sum, i) => sum + (i.system.coinValue?.value ?? 0) * (i.system.quantity?.value ?? 0), 0);
}

let party, pc1, pc2, capParty, capPC1, capPC2, vehicle;

try {
  // === Shared fixtures =======================================================================
  party = await Actor.create({ name: "TestParty-McpParitySmoke", type: "wfrp4e-party-sheet.party" });
  pc1 = await Actor.create({ name: "TestPC-McpParity-A", type: "character" }, { skipItems: true });
  pc2 = await Actor.create({ name: "TestPC-McpParity-B", type: "character" }, { skipItems: true });
  for (const a of [pc1, pc2]) await a.setFlag("wfrp4e-party-sheet", "mcpparitysmoke", true);
  await party.setFlag("wfrp4e-party-sheet", "mcpparitysmoke", true);
  await party.update(party.system.addMember(pc1));
  await party.update(party.system.addMember(pc2));
  party = game.actors.get(party.id);
  // Ample headroom for checks 1 and 3 below (over-cap behavior is exercised in its own isolated
  // fixture pair in check 2, never on this shared `party`).
  await party.update({ "system.capacityBonus": 1000 });
  party = game.actors.get(party.id);

  await pc1.createEmbeddedDocuments("Item", [
    { name: "GC", type: "money", system: { quantity: { value: 5 }, coinValue: { value: 240 } } },
  ]);
  pc1 = game.actors.get(pc1.id);

  // ============================================================================================
  // Check category 1: Σ-conservation — pool-consolidate + deposit/withdraw round-trip
  // (same seams party-pool.ts's handlePoolConsolidate/depositCoinsFromMember/withdrawCoinsToMember
  // call: api.transfer.consolidateCoins / api.transfer.depositCoins / api.transfer.withdrawCoins)
  // ============================================================================================

  // --- (1a) poolConsolidateConservesTotalBrass — total pence before == after -----------------
  // Funds the party's EXISTING canonical Brass Penny stack (seeded at party creation) rather than
  // creating a second coinValue:1 item — applyDenominations/findCoinStack assume exactly one
  // stack per coinValue (task 2.3's own documented invariant); a duplicate stack under this
  // coinValue is not a "homebrew" excluded coin (it matches a configured denomination), so it
  // silently escapes redistribution and trips the module's own conservation guard. Live-confirmed
  // 2026-08-29 — the original two-item version FAILED here with a real internal conservation
  // catch (correctly self-aborting via rollback, no data corruption) that traced to this fixture
  // bug, not the product's Consolidate logic.
  {
    const bpItem = party.items.find(i => i.type === "money" && i.system.coinValue?.value === 1);
    await party.updateEmbeddedDocuments("Item", [
      { _id: bpItem.id, "system.quantity.value": 250 },
    ]);
    party = game.actors.get(party.id);
    const beforeConsolidate = totalBrass(party);
    const consolidateResult = await api.transfer.consolidateCoins(party);
    party = game.actors.get(party.id);
    const afterConsolidate = totalBrass(party);
    record("poolConsolidateConservesTotalBrass",
      consolidateResult.ok && beforeConsolidate === afterConsolidate,
      { beforeConsolidate, afterConsolidate, consolidateResult });
  }

  // --- (1b) depositWithdrawRoundTripConservesCombinedTotal — Σ(PC)+Σ(party) unchanged ---------
  {
    const combinedBefore = totalBrass(pc1) + totalBrass(party);

    const depositResult = await api.transfer.depositCoins(pc1, party, { 240: 5 }, {});
    pc1 = game.actors.get(pc1.id);
    party = game.actors.get(party.id);
    const combinedAfterDeposit = totalBrass(pc1) + totalBrass(party);

    const withdrawResult = await api.transfer.withdrawCoins(party, pc1, { 240: 5 }, {});
    pc1 = game.actors.get(pc1.id);
    party = game.actors.get(party.id);
    const combinedAfterWithdraw = totalBrass(pc1) + totalBrass(party);

    record("depositWithdrawRoundTripConservesCombinedTotal",
      depositResult.ok && withdrawResult.ok
        && combinedBefore === combinedAfterDeposit && combinedAfterDeposit === combinedAfterWithdraw,
      { combinedBefore, combinedAfterDeposit, combinedAfterWithdraw, depositResult, withdrawResult });
  }

  // ============================================================================================
  // Check category 2: over-cap race single-admit re-check
  // (same seam party-pool.ts's depositItemFromMember calls: api.transfer.deposit(member, party,
  // itemId, amount) — isolated fixture pair per phase7-smoke.js's concurrentCapacityCheckAllowsOnlyOne
  // precedent, never the shared `party` above)
  // ============================================================================================
  {
    capParty = await Actor.create({ name: "TestCapParty-McpParitySmoke", type: "wfrp4e-party-sheet.party" }, { skipItems: true });
    await capParty.setFlag("wfrp4e-party-sheet", "mcpparitysmoke", true);
    capPC1 = await Actor.create({ name: "TestCapPC-McpParity-A", type: "character" }, { skipItems: true });
    capPC2 = await Actor.create({ name: "TestCapPC-McpParity-B", type: "character" }, { skipItems: true });
    for (const a of [capPC1, capPC2]) await a.setFlag("wfrp4e-party-sheet", "mcpparitysmoke", true);
    await capParty.update(capParty.system.addMember(capPC1));
    await capParty.update(capParty.system.addMember(capPC2));
    capParty = game.actors.get(capParty.id);
    // max = memberAllowance(2) + vehicle(0) + bonus(0) = 2.
    await capParty.update({ "system.capacityBonus": 0 });
    capParty = game.actors.get(capParty.id);

    const itemA = (await capPC1.createEmbeddedDocuments("Item", [{ name: "RaceItemA", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 2 } } }]))[0];
    const itemB = (await capPC2.createEmbeddedDocuments("Item", [{ name: "RaceItemB", type: "trapping", system: { quantity: { value: 1 }, encumbrance: { value: 2 } } }]))[0];

    const raceResults = await Promise.all([
      api.transfer.deposit(capPC1, capParty, itemA.id, 1),
      api.transfer.deposit(capPC2, capParty, itemB.id, 1),
    ]);
    capParty = game.actors.get(capParty.id);
    const admittedCount = raceResults.filter(r => r.ok).length;
    const blockedCount = raceResults.filter(r => !r.ok && r.reason === "capacity-exceeded").length;

    record("overCapRaceSingleAdmit",
      admittedCount === 1 && blockedCount === 1 && capParty.system.capacity.current === capParty.system.capacity.max,
      { raceResults, admittedCount, blockedCount, current: capParty.system.capacity.current, max: capParty.system.capacity.max });
  }

  // ============================================================================================
  // Check category 3: capacity-breakdown equality vs the sheet's own capacity getter
  // ============================================================================================
  {
    // party.system.capacity IS the sheet's own getter (party-model.js:266-277) — the exact object
    // every write handler forwards verbatim as `capacity: {...fresh.system.capacity}`
    // (party-pool.ts / party-vehicles.ts) and get-party (party-reads.ts) serializes into its
    // response. No live MCP call is available to this authoring role, so this check proves the
    // shape + arithmetic invariant those handlers/response fields depend on directly against the
    // data layer: exact 5-key shape, max === memberAllowance+vehicle+bonus, and a vehicle connect
    // (same seam handleConnectVehicle uses: party.system.addVehicle -> party.update) raises
    // `vehicle` by exactly the connected actor's system.status.carries.max.
    vehicle = await Actor.create({ name: "TestVehicle-McpParitySmoke", type: "vehicle", system: { status: { carries: { max: 40 } } } });
    await vehicle.setFlag("wfrp4e-party-sheet", "mcpparitysmoke", true);

    const beforeCapacity = { ...party.system.capacity };
    const shapeKeys = Object.keys(beforeCapacity).sort().join(",");
    const beforeMaxCorrect = beforeCapacity.max === beforeCapacity.memberAllowance + beforeCapacity.vehicle + beforeCapacity.bonus;

    const connectPayload = party.system.addVehicle(vehicle);
    await party.update(connectPayload);
    party = game.actors.get(party.id);
    const afterCapacity = { ...party.system.capacity };
    const afterMaxCorrect = afterCapacity.max === afterCapacity.memberAllowance + afterCapacity.vehicle + afterCapacity.bonus;
    const vehicleContribCorrect = afterCapacity.vehicle === beforeCapacity.vehicle + 40;

    // Teardown this sub-case's connection (same seam handleDisconnectVehicle uses) so it doesn't
    // skew any later render.
    const disconnectPayload = party.system.removeVehicle(vehicle.id);
    await party.update(disconnectPayload);
    party = game.actors.get(party.id);

    record("capacityBreakdownEqualsSheetGauge",
      shapeKeys === "bonus,current,max,memberAllowance,vehicle"
        && beforeMaxCorrect && afterMaxCorrect && vehicleContribCorrect,
      { beforeCapacity, afterCapacity, shapeKeys, beforeMaxCorrect, afterMaxCorrect, vehicleContribCorrect });
  }

} finally {
  foundry.applications.api.DialogV2.confirm = originalConfirm;
  ChatMessage.create = originalChatMessageCreate;
  for (const id of chatMessageIds) {
    await game.messages.get(id)?.delete();
  }
  if (vehicle) await game.actors.get(vehicle.id)?.delete();
  for (const a of [pc1, pc2, capPC1, capPC2]) {
    if (a) await game.actors.get(a.id)?.delete();
  }
  for (const p of [party, capParty]) {
    if (p) await game.actors.get(p.id)?.delete();
  }
}

const allPass = results.every(r => r.ok);
return JSON.stringify({ results, allPass }, null, 2);

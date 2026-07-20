// Phase 4 smoke — MCP-first (structured returns, dialog-free, try/finally cleanup, no positional
// indexing on createDocuments results per Phase 3 carry-forward). Exercises:
//  (a) happy-path deposit (full + partial stack)
//  (b) HC5 forced-failure at target-verify
//  (c) HC5 forced-failure at source-verify
//  (d) coin round-trip (deposit then withdraw)
// All assertions read the data layer fresh via game.actors.get(id).items — never moveItem's
// return value, never array position.
(async () => {
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ case: name, ok: pass, detail });
    console.log(`[Phase4Smoke] ${pass ? "PASS" : "FAIL"} — ${name}`, detail ?? "");
  };

  const transfer = await import("/modules/wfrp4e-party-sheet/scripts/transfer.js");
  const { deposit, depositCoins, withdrawCoins, moveItem, _internals } = transfer;

  let party, pc;

  try {
    party = await Actor.create(
      { name: "TestParty-Phase4Smoke", type: "wfrp4e-party-sheet.party" },
      { skipItems: true }
    );
    pc = await Actor.create(
      { name: "TestPC-Phase4Smoke", type: "character" },
      { skipItems: true }
    );

    await pc.createEmbeddedDocuments("Item", [{
      name: "Rope, 10 yards",
      type: "trapping",
      system: { quantity: { value: 10 }, encumbrance: { total: 1 } }
    }]);
    const ropeId = pc.items.find(i => i.name === "Rope, 10 yards")?.id;

    // --- (a) happy-path deposit: full stack move ---
    {
      const r = await deposit(pc, party, ropeId, 10);
      const sourceAfter = pc.items.get(ropeId);
      const targetItem = party.items.find(i => i.name === "Rope, 10 yards");
      const pass = r.ok && !sourceAfter && !!targetItem && targetItem.system.quantity.value === 10;
      record("depositHappyFull", pass, { ok: r.ok, sourceAfter: !!sourceAfter, targetQty: targetItem?.system.quantity.value });
    }

    // partial-stack deposit: 5-arrow stack, deposit 2, expect 3 remain on pc / 2 on party
    await pc.createEmbeddedDocuments("Item", [{
      name: "Arrows",
      type: "ammunition",
      system: { quantity: { value: 5 }, encumbrance: { total: 0.1 } }
    }]);
    const arrowId = pc.items.find(i => i.name === "Arrows")?.id;
    {
      const r = await deposit(pc, party, arrowId, 2);
      const sourceAfter = pc.items.get(arrowId);
      const targetItem = party.items.find(i => i.name === "Arrows");
      const conserved = (sourceAfter?.system.quantity.value ?? 0) + (targetItem?.system.quantity.value ?? 0) === 5;
      const pass = r.ok && sourceAfter?.system.quantity.value === 3 && targetItem?.system.quantity.value === 2 && conserved;
      record("depositHappyPartial", pass, { ok: r.ok, sourceQty: sourceAfter?.system.quantity.value, targetQty: targetItem?.system.quantity.value });
    }

    // --- (b) HC5 forced-failure at target-verify ---
    await pc.createEmbeddedDocuments("Item", [{
      name: "Sword-Phase4HC5",
      type: "weapon",
      system: { quantity: { value: 1 } }
    }]);
    const swordId = pc.items.find(i => i.name === "Sword-Phase4HC5")?.id;
    {
      const original = _internals.verifyTargetSettled;
      _internals.verifyTargetSettled = async () => false;
      let r;
      try {
        r = await moveItem({ fromActor: pc, toActor: party, itemId: swordId, amount: 1 });
      } finally {
        _internals.verifyTargetSettled = original;
      }
      const sourceAfter = pc.items.get(swordId);
      const dupCount = party.items.filter(i => i.name === "Sword-Phase4HC5").length;
      const pass = r.ok === false && r.rolledBack === true && dupCount === 0 && !!sourceAfter && sourceAfter.system.quantity.value === 1;
      record("hc5TargetVerifyFail", pass, { ok: r.ok, rolledBack: r.rolledBack, dupCount, sourceIntact: !!sourceAfter });
    }

    // --- (c) HC5 forced source-verify failure must NOT lose the item (BUG-818) ---
    // Stub verifySourceSettled -> false while the real delete succeeds: models a settle-poll
    // false-negative on a deferred write (the withdraw path GM-relays writes to an OBSERVER-owned
    // party actor). The engine must re-read and recognize the completed move rather than rolling back
    // the only verified copy (which lost the item entirely pre-BUG-818). Conservation crux: after the
    // forced failure exactly ONE copy survives across both actors — neither lost nor duplicated.
    {
      const original = _internals.verifySourceSettled;
      _internals.verifySourceSettled = async () => false;
      let r;
      try {
        r = await moveItem({ fromActor: pc, toActor: party, itemId: swordId, amount: 1 });
      } finally {
        _internals.verifySourceSettled = original;
      }
      const srcCount = pc.items.filter(i => i.name === "Sword-Phase4HC5").length;
      const tgtCount = party.items.filter(i => i.name === "Sword-Phase4HC5").length;
      const totalCopies = srcCount + tgtCount;
      const pass = totalCopies === 1; // exactly one copy: neither lost (0) nor duplicated (2)
      record("hc5SourceVerifyFail", pass, { ok: r.ok, srcCount, tgtCount, totalCopies });
    }

    // --- (c2) HC5 forced target-verify failure on a MERGE deposit — rollback must restore the pool
    // stack to its pre-merge value, not leave the increment standing (F01 fix regression guard) ---
    await party.createEmbeddedDocuments("Item", [{
      name: "Rope-Merge-HC5", type: "trapping", system: { quantity: { value: 4 } }
    }]);
    await pc.createEmbeddedDocuments("Item", [{
      name: "Rope-Merge-HC5", type: "trapping", system: { quantity: { value: 3 } }
    }]);
    const mergeId = pc.items.find(i => i.name === "Rope-Merge-HC5")?.id;
    {
      const poolBefore = party.items.find(i => i.name === "Rope-Merge-HC5").system.quantity.value; // 4
      const original = _internals.verifyTargetSettled;
      _internals.verifyTargetSettled = async () => false;
      let r;
      try {
        r = await moveItem({ fromActor: pc, toActor: party, itemId: mergeId, amount: 3 });
      } finally {
        _internals.verifyTargetSettled = original;
      }
      const poolAfter = party.items.find(i => i.name === "Rope-Merge-HC5")?.system.quantity.value;
      const srcAfter = pc.items.get(mergeId);
      const pass = r.ok === false && r.rolledBack === true && poolAfter === poolBefore && !!srcAfter && srcAfter.system.quantity.value === 3;
      record("hc5TargetVerifyFailMerge", pass, { ok: r.ok, rolledBack: r.rolledBack, poolBefore, poolAfter, srcQty: srcAfter?.system.quantity.value });
    }

    // --- (d) coin round-trip: deposit then withdraw, brass conserved ---
    {
      await pc.createEmbeddedDocuments("Item", [{
        name: "Gold Crown",
        type: "money",
        system: { quantity: { value: 10 }, coinValue: { value: 240 } }
      }]);
      const brassOf = actor => actor.items.filter(i => i.type === "money").reduce((s, i) => s + i.system.coinValue.value * i.system.quantity.value, 0);
      const sourceBrassBefore = brassOf(pc);

      const depositResult = await depositCoins(pc, party, { gc: 5, ss: 0, bp: 0 });
      const depositConserved = brassOf(pc) + brassOf(party) === sourceBrassBefore;

      const withdrawResult = await withdrawCoins(party, pc, { gc: 5, ss: 0, bp: 0 });
      const roundTripConserved = brassOf(pc) === sourceBrassBefore && brassOf(party) === 0;

      const pass = depositResult.ok && withdrawResult.ok && depositConserved && roundTripConserved;
      record("coinRoundTrip", pass, { depositOk: depositResult.ok, withdrawOk: withdrawResult.ok, depositConserved, roundTripConserved });
    }
  } finally {
    if (party) await party.delete();
    if (pc) await pc.delete();
  }

  const allPass = results.every(r => r.ok);
  console.log("[Phase4Smoke] Summary:", results);
  return { results, allPass };
})();

/* NF3 — player-perspective permission probe (design; must run from a REAL second non-GM
 * client's F12 console — MCP always executes as GM, so a GM-driven call can never genuinely
 * exercise the non-owner rejection path per phase3_carry_forward.md).
 *
 * Setup (disposable actors, CCR-7):
 *   1. PC-Mine  — type character, Owner-granted to test_player.
 *   2. PC-Other — type character, GM-only (test_player has no grant).
 *   3. Disposable party actor with ownership.default = OBSERVER (or an explicit test_player entry)
 *      so test_player can open the sheet at all.
 *   4. GM (via MCP) deposits one item from PC-Other into the pool so a pooled item with a known
 *      non-owned origin exists to attempt withdrawing.
 *
 * From test_player's own F12 console (real game.user = test_player, not GM):
 *
 *   // Probe A — console-crafted withdraw targeting a non-owned actor:
 *   const partyActor = game.actors.get("<partyId>");
 *   const sheet = partyActor.sheet;
 *   await PartySheet._onWithdrawItem.call(sheet, null, { closest: () => ({ dataset: { id: "<pooledItemId>" } }) });
 *   // (the picker will resolve to owned members only — PC-Other is not among them, so a
 *   // console-crafted _resolveWithdrawTarget bypass would need to target PC-Other directly;
 *   // simplest genuine probe: call transfer.withdraw(partyActor, pcOtherActor, itemId, amount)
 *   // directly from the console and assert it returns {ok:false, reason:"not-owner"}.)
 *   // Assert: item count on party actor unchanged, item count on PC-Other unchanged, no chat line.
 *
 *   // Positive control — repeat transfer.withdraw(partyActor, pcMineActor, itemId, amount):
 *   // Assert: transfer succeeds, item count -1/+1, HC5 conservation holds, public chat line appears.
 *
 * Data-layer verification for all three (never positional indexing — Phase 3 carry-forward):
 *   compare exact item ids/counts pre/post via game.actors.get(id).items.size and name/id lookup
 *   on both the party actor and every actor touched.
 */

/* NF6 — Item Piles coexistence checklist (verdict: COEXISTS CLEANLY, R4 §6):
 *   (a) With Item Piles + item-piles-wfrp4e active, the party sheet's Inventory tab renders fully
 *       functional: grouped items, derived GC/SS/BP summary, informational encumbrance, working
 *       search filter.
 *   (b) The console shows the benign "Could not find scope 'wfrp4e-party-sheet'" WARN exactly once
 *       per world/module load (dotted-namespaced-subtype libWrapper parse bug, identical to the
 *       precedented archives3.enterprise case) — this is NOT re-triaged as a bug.
 *   (c) No Item Piles UI (config dialog, pile interface, header button) ever renders on the party
 *       sheet during the smoke pass — confirms the flag-gated pile behavior stays untriggered
 *       absent an explicit GM createItemPile/turnTokensIntoItemPiles call against the party actor.
 */

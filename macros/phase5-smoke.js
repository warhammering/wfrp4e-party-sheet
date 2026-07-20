// Phase 5 smoke — MCP-first (structured returns, dialog-free, try/finally cleanup, no
// positional indexing on createDocuments results per Phase 3 carry-forward).
//
// Design note: R5.1 (Rest), R5.2 (Make Camp), and D.1's "set" path for the Recuperate
// marker are all DELIBERATELY interactive by design (D2/D4/D11/D7 — the system's own Rest
// flow and this module's camper-picker + attestation dialogs are real DialogV2 prompts,
// not the blindroll/no-dialog path Phase 3 built). A script macro cannot click through a
// rendered dialog, so this harness verifies the underlying data-layer mechanics the
// handlers depend on directly against the Foundry/system API — the SAME calls the
// handlers make once their dialog resolves — rather than driving the dialog-gated
// handlers end-to-end. The actual click-through UI flows are exercised by a human GM at
// Level 4a (see plan's Validation section); this harness is the R5.4 data-layer proof.
(async () => {
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ case: name, ok: pass, detail });
    console.log(`[Phase5Smoke] ${pass ? "PASS" : "FAIL"} — ${name}`, detail ?? "");
  };

  let pc;

  try {
    pc = await Actor.create(
      { name: "TestPC-Phase5Smoke", type: "character" },
      { skipItems: true }
    );

    // --- (1) wounds clamp at max (D6 — the system's own _preUpdate guard, no module clamp) ---
    {
      const max = pc.system.status.wounds.max;
      await pc.update({ "system.status.wounds.value": max - 1 });
      await pc.modifyWounds(5); // request far more than the remaining headroom
      const after = game.actors.get(pc.id).system.status.wounds.value;
      record("woundsClampAtMax", after === max, { max, after });
    }

    // --- (2) Make Camp math: self-only Fatigued clearing, min(SL, stacks) (D1/D2) ---
    {
      await pc.addCondition("fatigued", 3);
      const before = game.actors.get(pc.id).hasCondition("fatigued")?.conditionValue ?? 0;
      const sl = 2; // simulated Make Camp roll result
      const toClear = Math.min(Math.max(Math.trunc(sl), 0), before);
      await pc.removeCondition("fatigued", toClear);
      const after = game.actors.get(pc.id).hasCondition("fatigued")?.conditionValue ?? 0;
      record("makeCampClearsMinSLStacks", before === 3 && toClear === 2 && after === 1, { before, toClear, after });
    }

    // --- (3) Make Camp no-op at zero Fatigued stacks — must not throw ---
    {
      await pc.removeCondition("fatigued", 1); // clear the remaining stack from case (2)
      const stacksBefore = game.actors.get(pc.id).hasCondition("fatigued")?.conditionValue ?? 0;
      let threw = false;
      try {
        const toClear = Math.min(Math.max(Math.trunc(4), 0), stacksBefore); // great roll, 0 stacks
        if (toClear > 0) await pc.removeCondition("fatigued", toClear);
      } catch (err) {
        threw = true;
      }
      const stacksAfter = game.actors.get(pc.id).hasCondition("fatigued")?.conditionValue ?? 0;
      record("makeCampNoOpAtZeroStacks", !threw && stacksBefore === 0 && stacksAfter === 0, { stacksBefore, stacksAfter, threw });
    }

    // --- (4) Recuperate flag round-trip in the Phase-6-ready shape (D7) ---
    {
      await pc.setFlag("wfrp4e-party-sheet", "recuperate", { partyId: "TestParty-Phase5Smoke", stage: null });
      const flag = game.actors.get(pc.id).getFlag("wfrp4e-party-sheet", "recuperate");
      const shapeOk = flag && flag.partyId === "TestParty-Phase5Smoke" && flag.stage === null && Object.keys(flag).length === 2;
      await pc.unsetFlag("wfrp4e-party-sheet", "recuperate");
      const cleared = game.actors.get(pc.id).getFlag("wfrp4e-party-sheet", "recuperate") === undefined;
      record("recuperateFlagRoundTrip", !!shapeOk && cleared, { flag, cleared });
    }

    // --- (5) Recuperate bonus: +TB delta and self-clear (D8), still respecting the D6 clamp ---
    {
      const max = game.actors.get(pc.id).system.status.wounds.max;
      const tb = game.actors.get(pc.id).characteristics.t.bonus;
      await pc.update({ "system.status.wounds.value": Math.max(max - tb - 1, 0) });
      await pc.setFlag("wfrp4e-party-sheet", "recuperate", { partyId: "TestParty-Phase5Smoke", stage: null });

      // Mirrors _onRestMember's post-roll bonus block verbatim.
      const before = game.actors.get(pc.id).system.status.wounds.value;
      await pc.modifyWounds(tb);
      await pc.unsetFlag("wfrp4e-party-sheet", "recuperate");

      const after = game.actors.get(pc.id).system.status.wounds.value;
      const flagGone = game.actors.get(pc.id).getFlag("wfrp4e-party-sheet", "recuperate") === undefined;
      const expectedAfter = Math.min(before + tb, max);
      record("recuperateBonusAppliesTBAndSelfClears", after === expectedAfter && flagGone, { before, tb, after, expectedAfter, flagGone });

      // Over-heal case: repeat at max - 1, must clamp to exactly max (D6, no module clamp).
      await pc.update({ "system.status.wounds.value": max - 1 });
      await pc.setFlag("wfrp4e-party-sheet", "recuperate", { partyId: "TestParty-Phase5Smoke", stage: null });
      await pc.modifyWounds(tb);
      await pc.unsetFlag("wfrp4e-party-sheet", "recuperate");
      const overHealAfter = game.actors.get(pc.id).system.status.wounds.value;
      record("recuperateBonusClampedAtMax", overHealAfter === max, { max, overHealAfter });
    }
  } finally {
    if (pc) await pc.delete();
  }

  const allPass = results.every(r => r.ok);
  console.log("[Phase5Smoke] Summary:", results);
  return { results, allPass };
})();

/* Guard-presence check (case 6, non-owner/non-GM rejection) — NOT executed here.
 * Per the Phase 3 carry-forward's NF3 precedent: "MCP always executes as GM, so a
 * GM-driven call can never genuinely exercise the non-owner rejection path." Verified
 * instead by static read at execution time: _onRestMember, _onMakeCamp, and
 * _onToggleRecuperate each open with their own `if (!game.user.isGM && ...)` /
 * `if (!game.user.isGM)` guard, independent of the template (CCR-2) — confirmed by
 * reading scripts/party-sheet.js during Phase 5 execution. A real non-GM player-client
 * check (button absent/inert) is Level 4a's player-client check, per this PRD's
 * established per-phase pattern (Phase 3/4 NF3).
 */

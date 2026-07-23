// Phase 8 smoke — request-from-players live runbook. Unlike phase6/7-smoke.js (pure data-layer
// harnesses runnable unattended from one GM macro execution), this feature's core mechanism is
// CROSS-CLIENT: a real player must click a chat card on their own browser session for the public
// roll + card-suppression + live-dialog-row behavior to be observable at all. This macro does the
// scriptable half — disposable fixtures: a test party with 2 PCs + 1 NPC, PC ownership assigned
// to up to 2 real non-GM Users already in this world — and returns the manual click-through
// checklist for the other half. Disposable actors ONLY (never real PCs), flagged
// "wfrp4e-party-sheet.phase8smoke" for identification, matching phase7-smoke.js's fixture
// convention — left in place (not deleted in a finally) because the manual steps below need them
// to still exist after this macro returns; delete them from the Actors sidebar once done.

const nonGmUsers = game.users.filter(u => !u.isGM);
const [player1, player2] = nonGmUsers;

const results = [];

try {
  const party = await Actor.create({ name: "TestParty-Phase8Smoke", type: "wfrp4e-party-sheet.party" });
  const pc1 = await Actor.create({ name: "TestPC-Phase8-A", type: "character" }, { skipItems: true });
  const pc2 = await Actor.create({ name: "TestPC-Phase8-B", type: "character" }, { skipItems: true });
  const npc1 = await Actor.create({ name: "TestNPC-Phase8-A", type: "npc" }, { skipItems: true });

  for (const a of [pc1, pc2, npc1]) await a.setFlag("wfrp4e-party-sheet", "phase8smoke", true);
  await party.setFlag("wfrp4e-party-sheet", "phase8smoke", true);

  if (player1) await pc1.update({ [`ownership.${player1.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
  const secondOwner = player2 ?? player1; // fall back to one real player owning both PCs if that's all this world has.
  if (secondOwner) await pc2.update({ [`ownership.${secondOwner.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });

  await party.update(party.system.addMember(pc1));
  await party.update(party.system.addMember(pc2));
  await party.update(party.system.addMember(npc1));

  const steps = [
    "1. Have the owning player(s) of TestPC-Phase8-A / TestPC-Phase8-B log in as active, non-GM sessions (2 separate sessions covers A1/A2's dual-row live update fully; 1 session still covers a reduced pass via the Roll-for-Them fallback in step 6).",
    "2. On the GM's party sheet, open 'Group Rolls: Perception', tick 'Request from players', click Roll.",
    "3. Confirm: TestNPC-Phase8-A rolls blind immediately (no card posted for it); each owned+online PC gets a WHISPERED chat card that does NOT appear in the GM's own chat log (Q1).",
    "4. As TestPC-Phase8-A's player, click the card's Roll button: confirm a PUBLIC test card posts (Dice So Nice fires if installed), the GM's difficulty/modifier is baked in, and NO configuration dialog opens.",
    "5. On the GM's Awaiting Rolls dialog, confirm TestPC-Phase8-A's row flips to the resolved state (checkmark) live, without the dialog closing.",
    "6. If a second player session is available for TestPC-Phase8-B, click its card the same way; otherwise, on the GM's dialog tick TestPC-Phase8-B and click 'Roll selected for them' — confirm a PUBLIC roll posts and the row flips to the GM-rolled state (dice icon).",
    "7. Before clicking Post Summary, have TestPC-Phase8-A's player spend a Fortune point to reroll their completed test: confirm a NEW public test card posts (B1 finding — reroll always creates, never updates).",
    "8. Click 'Post Summary' (only enabled once every requested row is resolved): confirm the summary is whispered to the GM only (not visible to players), lists all 3 members (2 requested + 1 blind NPC), reflects TestPC-Phase8-A's REROLLED (kept) SL/roll from step 7, and the 2 requested lines each carry a self/GM marker matching how they were resolved.",
    "9. Repeat from step 2, but click Cancel mid-wait instead of Post Summary: confirm NO summary is posted at all (Q3).",
    "10. Repeat from step 2 with the box left UNCHECKED: confirm behavior is identical to pre-Phase-8 (single all-blind GM summary, no dialog, no request cards).",
  ];

  results.push({
    fixtures: { partyId: party.id, pc1Id: pc1.id, pc2Id: pc2.id, npc1Id: npc1.id },
    assignedOwners: {
      pc1: player1?.name ?? "none — no non-GM User exists in this world",
      pc2: secondOwner?.name ?? "none — no non-GM User exists in this world",
    },
    warning: nonGmUsers.length < 2
      ? "Fewer than 2 non-GM Users exist in this world — steps needing 2 SIMULTANEOUS online players (A1/A2's dual-row live update) can only be partially exercised; the single-player + Roll-for-Them path (step 6's fallback) still covers the GM-rolled branch."
      : null,
    steps,
  });
} catch (err) {
  results.push({ error: String(err?.message ?? err) });
}

return JSON.stringify({ results }, null, 2);

// Phase 9 (v1.3.0) smoke — data-layer harness for the inventory log + quest-item character
// binding, following the phase6/7-smoke.js pattern (results array, DialogV2.confirm stub-and-
// restore in finally, dynamic import of transfer.js exports, disposable fixtures deleted in
// finally per phase7's convention).
//
// SCOPE NOTE: a GM-run macro cannot fake a non-GM `requester` — requestMutation resolves it to
// `game.user` whenever the GM client is the active GM (mutation-queue.js requestMutation/
// onSocketMessage). As of the v1.3.0 amendment (2026-07-23) GM PC↔pool moves log the SAME as a
// player's, so this macro scripts every data-layer-reachable assertion from a single GM session:
// GM item + coin moves DO log (who = the PC); compendium drops (add-item) do NOT log; quest-binding
// round-trip + display-name resolution. It still prints the two-client manual steps to confirm a
// real non-GM client's move logs identically (the requester-identity path a GM session can't fake).

const results = [];
const record = (name, pass, detail) => { results.push({ case: name, ok: pass, detail }); };

const originalConfirm = foundry.applications.api.DialogV2.confirm;
foundry.applications.api.DialogV2.confirm = async () => true;

const transfer = await import("/modules/wfrp4e-party-sheet/scripts/transfer.js");

let party, pc1;

try {
  party = await Actor.create({ name: "TestParty-Phase9Smoke", type: "wfrp4e-party-sheet.party" });
  pc1 = await Actor.create({ name: "Sir Konrad Vollen", type: "character" }, { skipItems: true });
  for (const a of [pc1]) await a.setFlag("wfrp4e-party-sheet", "phase9smoke", true);
  await party.setFlag("wfrp4e-party-sheet", "phase9smoke", true);
  await party.update(party.system.addMember(pc1));
  party = game.actors.get(party.id);

  // --- (1) schema field defaults to [] and round-trips a written entry -----------------------
  {
    const emptyOk = Array.isArray(party.system.inventoryLog) && party.system.inventoryLog.length === 0;
    await party.update({ "system.inventoryLog": [{ id: "probe", date: 1, who: "A", action: "deposit", item: "Rope", amount: "3" }] });
    party = game.actors.get(party.id);
    const roundTripOk = party.system.inventoryLog.length === 1 && party.system.inventoryLog[0].item === "Rope";
    await party.update({ "system.inventoryLog": [] });
    party = game.actors.get(party.id);
    record("schemaFieldDefaultsEmptyAndRoundTrips", emptyOk && roundTripOk, { emptyOk, roundTripOk });
  }

  // --- (2) GM item deposit AND withdraw each append one entry (v1.3.0 amendment 2026-07-23:
  //         GM PC↔pool moves log like players; who = the PC's full name) ------------------------
  {
    const [depositItem] = await pc1.createEmbeddedDocuments("Item", [{ name: "TestRope", type: "trapping", system: { quantity: { value: 3 }, encumbrance: { value: 0.1 } } }]);
    const beforeDeposit = party.system.inventoryLog.length;
    await transfer.deposit(pc1, party, depositItem.id, 3);
    party = game.actors.get(party.id);
    const depositEntry = party.system.inventoryLog[party.system.inventoryLog.length - 1];
    const depositOk = party.system.inventoryLog.length === beforeDeposit + 1
      && depositEntry?.action === "deposit" && depositEntry?.who === "Sir Konrad Vollen" && depositEntry?.item === "TestRope";

    const poolItem = party.items.find(i => i.name === "TestRope");
    const beforeWithdraw = party.system.inventoryLog.length;
    await transfer.withdraw(party, pc1, poolItem.id, 3);
    party = game.actors.get(party.id);
    const withdrawEntry = party.system.inventoryLog[party.system.inventoryLog.length - 1];
    const withdrawOk = party.system.inventoryLog.length === beforeWithdraw + 1
      && withdrawEntry?.action === "withdraw" && withdrawEntry?.who === "Sir Konrad Vollen";

    record("gmItemDepositWithdrawLogged", depositOk && withdrawOk, { depositOk, withdrawOk, depositEntry, withdrawEntry });
  }

  // --- (3) GM coin deposit appends one entry with a coin-label amount (v1.3.0 amendment) -------
  {
    await pc1.createEmbeddedDocuments("Item", [{ name: "Gold Crown", type: "money", system: { quantity: { value: 5 }, coinValue: { value: 240 } } }]);
    const before = party.system.inventoryLog.length;
    const result = await transfer.depositCoins(pc1, party, { 240: 5 }, {});
    party = game.actors.get(party.id);
    const entry = party.system.inventoryLog[party.system.inventoryLog.length - 1];
    const loggedOk = result.ok === true && party.system.inventoryLog.length === before + 1
      && entry?.action === "deposit" && entry?.who === "Sir Konrad Vollen";
    record("gmCoinDepositLogged", loggedOk, { resultOk: result.ok, before, after: party.system.inventoryLog.length, entry });
  }

  // --- (3b) GM compendium drop (add-item) never logs — the boundary of the amendment ----------
  {
    const before = party.system.inventoryLog.length;
    await transfer.addItem(party, { name: "FreshDrop", type: "trapping", system: { quantity: { value: 1 } } });
    party = game.actors.get(party.id);
    record("gmCompendiumDropNeverLogged", party.system.inventoryLog.length === before, { before, after: party.system.inventoryLog.length });
  }

  // --- (4) quest binding round-trip + display-name resolution --------------------------------
  {
    const [questItem] = await party.createEmbeddedDocuments("Item", [{ name: "Ancient Map", type: "trapping", system: { quantity: { value: 1 } } }]);
    await questItem.setFlag("wfrp4e-party-sheet", "questItem", true);
    await questItem.setFlag("wfrp4e-party-sheet", "questBoundTo", pc1.id);
    party = game.actors.get(party.id);

    const sheet = party.sheet;
    await sheet.render(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const boundEl = sheet.element.querySelector(`[data-id="${questItem.id}"] .party-quest-bound`);
    const boundLabelOk = boundEl?.textContent.trim() === "Sir Konrad";

    const questItemLive = party.items.get(questItem.id);
    await questItemLive.unsetFlag("wfrp4e-party-sheet", "questBoundTo");
    await sheet.render(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const unboundEl = sheet.element.querySelector(`[data-id="${questItem.id}"] .party-quest-bound`);
    const unboundOk = !unboundEl;

    sheet.close();
    record("questBindRoundTripAndDisplayName", boundLabelOk && unboundOk, { boundLabelOk, unboundOk });
  }

  const steps = [
    "1. Have a real non-GM player, owning a PC seated in a party, deposit an item into the party pool (or withdraw one) from their own client.",
    "2. On any client, open the party sheet's new Log tab: confirm exactly one new row appears with today's date, the player's PC name under Who, the correct Deposit/Withdraw action, the item name, and the quantity.",
    "3. Have the SAME player deposit/withdraw coins: confirm a second row appears with Item = 'Money' and Amount = a coin label (e.g. '5gc 3ss').",
    "4. As the GM, move an item/coins between a character and the pool: confirm a NEW row DOES appear (Who = that character). Then drop a fresh item from a compendium onto the pool: confirm NO row appears for that (compendium drops are not logged).",
    "5. As the GM, delete one player-logged row via its trash icon (confirm dialog): confirm exactly that row disappears and the count decreases by one; confirm the player client sees NO trash icon on any row.",
    "6. With >10 entries logged, confirm the pager shows multiple pages and paging to page 2+ shows older entries.",
  ];
  results.push({ manualTwoClientSteps: steps });

} finally {
  foundry.applications.api.DialogV2.confirm = originalConfirm;
  for (const a of [pc1]) {
    if (a) await game.actors.get(a.id)?.delete();
  }
  if (party) await game.actors.get(party.id)?.delete();
}

const allPass = results.filter(r => "ok" in r).every(r => r.ok);
return JSON.stringify({ results, allPass }, null, 2);

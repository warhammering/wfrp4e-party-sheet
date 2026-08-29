// Add Selected Tokens to Party
//
// GM utility. Select one or more tokens on the canvas (characters, NPCs, and/or vehicles),
// then run this macro to add all of them to a Party actor in one step — instead of dragging
// each actor from the sidebar onto the sheet one at a time. Handy at the start of a session
// when the whole table's tokens are already placed on the scene.
//
// - Characters and NPCs are added as members (same effect as dropping them on the sheet).
// - Vehicles are connected (same effect as dropping a vehicle on the sheet).
// - Anything already in the party, or not a valid type (e.g. a creature), is skipped and
//   reported, not treated as an error.
// - If more than one Party actor exists in the world, you're asked which one to use.

if (!game.user.isGM) {
  ui.notifications.warn("Add Selected Tokens to Party is a GM-only macro.");
  return;
}

const controlled = canvas.tokens.controlled;
if (!controlled.length) {
  ui.notifications.warn("Select one or more tokens on the canvas first.");
  return;
}

const actors = [...new Map(
  controlled.map(t => t.actor).filter(Boolean).map(a => [a.id, a])
).values()];

const parties = game.actors.filter(a => a.type === "wfrp4e-party-sheet.party");
if (!parties.length) {
  ui.notifications.warn("There is no Party actor in this world yet — create one before running this macro.");
  return;
}

let party;
if (parties.length === 1) {
  party = parties[0];
} else {
  const options = parties.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: "Which Party?" },
    content: `<div class="form-group"><select name="partyId">${options}</select></div>`,
    buttons: [
      { action: "confirm", label: "Add To This Party", default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
      { action: "cancel", label: "Cancel" }
    ]
  });
  if (!picked || picked === "cancel") return;
  party = parties.find(p => p.id === picked.partyId);
  if (!party) return;
}

let added = 0, alreadyIn = 0, skipped = 0;

for (const actor of actors) {
  if (actor.type === "character" || actor.type === "npc") {
    const wasMember = party.system.members.has({ id: actor.id, uuid: actor.uuid });
    if (wasMember) { alreadyIn++; continue; }
    await party.update(party.system.addMember(actor));
    party = game.actors.get(party.id);
    added++;
  } else if (actor.type === "vehicle") {
    const wasConnected = party.system.vehicles.has({ id: actor.id, uuid: actor.uuid });
    if (wasConnected) { alreadyIn++; continue; }
    await party.update(party.system.addVehicle(actor));
    party = game.actors.get(party.id);
    added++;
  } else {
    skipped++;
  }
}

const parts = [`Added ${added} to ${party.name}`];
if (alreadyIn) parts.push(`${alreadyIn} already in the party`);
if (skipped) parts.push(`${skipped} skipped (not a character, NPC, or vehicle)`);
ui.notifications.info(parts.join(" — ") + ".");

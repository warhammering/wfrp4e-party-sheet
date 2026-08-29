// Open Party Sheet
//
// One-click way to open the Party sheet without hunting for it in the Actors directory.
//
// - Players: opens the party you're currently a member of (checked by actor ownership, not
//   by name). If you're not in any party, you're told so instead of getting a blank/denied
//   sheet.
// - GM: opens the world's Party actor. If there's more than one, you're asked which to open.
//
// Good candidate for a player's hotbar — drag this macro there once and it always finds the
// right sheet, even across sessions or if the party actor gets renamed.

const parties = game.actors.filter(a => a.type === "wfrp4e-party-sheet.party");
if (!parties.length) {
  ui.notifications.warn("There is no Party actor in this world yet.");
  return;
}

async function pickParty(candidates) {
  if (candidates.length === 1) return candidates[0];
  const options = candidates.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const picked = await foundry.applications.api.DialogV2.wait({
    window: { title: "Which Party?" },
    content: `<div class="form-group"><select name="partyId">${options}</select></div>`,
    buttons: [
      { action: "confirm", label: "Open", default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object },
      { action: "cancel", label: "Cancel" }
    ]
  });
  if (!picked || picked === "cancel") return null;
  return candidates.find(p => p.id === picked.partyId) ?? null;
}

let target;
if (game.user.isGM) {
  target = await pickParty(parties);
} else {
  const mine = parties.filter(p =>
    p.system.members.list.some(ref => game.actors.get(ref.id)?.isOwner)
  );
  if (!mine.length) {
    ui.notifications.warn("You are not currently a member of any party.");
    return;
  }
  target = await pickParty(mine);
}

if (!target) return;

if (!target.testUserPermission(game.user, "LIMITED")) {
  ui.notifications.warn(`You don't have permission to view ${target.name}.`);
  return;
}

target.sheet.render(true);

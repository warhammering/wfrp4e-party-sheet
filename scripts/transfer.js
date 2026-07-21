import { registerMutationHandler, requestMutation } from "./mutation-queue.js";
import * as currency from "./currency.js";

const MODULE_ID = "wfrp4e-party-sheet";
const PARTY_ACTOR_TYPE = "wfrp4e-party-sheet.party";

function capacityCheckedOptions() {
  return { [MODULE_ID]: { capacityChecked: true } };
}

function userOwnsActor(user, actor) {
  return user?.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function isCurrentMember(partyActor, actorId) {
  return partyActor.system.members.list.some(ref => ref.id === actorId && game.actors.get(ref.id));
}

function authorizeTransfer(requester, fromActor, toActor) {
  if (requester?.isGM) return null;
  const fromParty = fromActor.type === PARTY_ACTOR_TYPE;
  const toParty = toActor.type === PARTY_ACTOR_TYPE;
  if (fromParty === toParty) return "invalid-route";
  if (toParty) return userOwnsActor(requester, fromActor) ? null : "not-owner";
  if (!isCurrentMember(fromActor, toActor.id)) return "member-gone";
  return userOwnsActor(requester, toActor) ? null : "not-owner";
}

async function settlePoll(check, delays = [0, 30, 60]) {
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (check()) return true;
  }
  return false;
}

function getQuantity(item) {
  return item.type === "cargo" ? (item.system.encumbrance?.value ?? 0) : (item.system.quantity?.value ?? 0);
}

function quantityField(item) {
  return item.type === "cargo" ? "system.encumbrance.value" : "system.quantity.value";
}

function isFullStackMove(item, amount) {
  return amount === getQuantity(item);
}

// Phase 7 (R7.3) — the one seam every add-to-pool path routes through (player deposit, GM
// copy-create, future MCP `pool-deposit`), so capacity can never be bypassed by a new caller
// (the BUG-060 parity-drift class). Exactly-at-capacity is allowed; only a push OVER blocks
// (R7.3 wording). Non-party targets (member withdraw, member-to-member) are never gated.
function checkCapacity(toActor, incomingEnc) {
  if (toActor.type !== PARTY_ACTOR_TYPE) return null;
  const capacity = toActor.system.capacity;
  if (capacity.current + incomingEnc > capacity.max) {
    return { shortfall: (capacity.current + incomingEnc) - capacity.max };
  }
  return null;
}

function canonicalize(value, { unordered = false } = {}) {
  if (Array.isArray(value)) {
    const entries = value.map(entry => canonicalize(entry));
    return unordered ? entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : entries;
  }
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (key === "_id" || key === "_stats" || key === "origin") return result;
    const normalized = canonicalize(value[key]);
    const empty = normalized == null || normalized === "" || normalized === false || normalized === 0
      || (Array.isArray(normalized) && normalized.length === 0)
      || (typeof normalized === "object" && !Array.isArray(normalized) && Object.keys(normalized).length === 0);
    if (empty) return result;
    result[key] = normalized;
    if ((key === "qualities" || key === "flaws") && Array.isArray(normalized?.value)) {
      normalized.value.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return result;
  }, {});
}

function stackIdentity(item) {
  const data = item.toObject ? item.toObject() : foundry.utils.deepClone(item);
  if (data.type === "money") {
    const coinValue = data.system?.coinValue?.value ?? 0;
    // Phase 9 — secondary currencies (Design Decisions row 3: no exchange rate) commonly all
    // carry coinValue 0/undefined, so coinValue alone can no longer distinguish them once more
    // than one exists (it always could for primaries, which are >0 and unique per denomination).
    // Fold in the module's own secondaryId flag for the coinValue<=0 case only — primary coin
    // identity (coinValue > 0) is unchanged, matching Design Decisions row 3's "merge by value,
    // never by name" for primaries exactly as before.
    return coinValue > 0
      ? JSON.stringify({ type: data.type, coinValue })
      : JSON.stringify({ type: data.type, coinValue, secondaryId: data.flags?.[MODULE_ID]?.secondaryId ?? data.name });
  }

  const system = foundry.utils.deepClone(data.system ?? {});
  delete system.quantity;
  delete system.location;
  delete system.equipped;
  delete system.offhand;
  if (data.type === "cargo") delete system.encumbrance;

  return JSON.stringify(canonicalize({
    name: data.name,
    type: data.type,
    system,
    effects: data.effects ?? [],
  }));
}

// Stack only documents with the same canonical transfer identity. Actor-context state
// (quantity/location/equipped/offhand), flags, and document metadata are excluded. Flags are
// instance state here: Scene Packer, for example, writes a unique content hash to every embedded
// Item, so retaining them makes equivalent stacks permanently unequal after creation. Meaningful
// system data and effects remain identity-bearing (BUG-827).
function findMatchingStack(actor, sourceItem) {
  const identity = stackIdentity(sourceItem);
  return actor.items.find(i => {
    if (i.type !== sourceItem.type || i.name !== sourceItem.name) return false;
    return stackIdentity(i) === identity;
  }) ?? null;
}

// Mutable seam so the HC5 forced-failure smoke can stub a verify step to prove the rollback
// contract without touching Foundry permissions. Production behavior is these two defaults;
// smoke monkey-patches one, calls moveItem, then restores it in a finally block.
export const _internals = {
  stackIdentity,
  verifyTargetSettled: (toActor, createdId, expectedQty) => settlePoll(() => {
    const doc = toActor.items.get(createdId);
    return !!doc && getQuantity(doc) === expectedQty;
  }),
  verifySourceSettled: (fromActor, itemId, isFullMove, fullQty, amount) => settlePoll(() => {
    const doc = fromActor.items.get(itemId);
    return isFullMove ? !doc : (!!doc && getQuantity(doc) === fullQty - amount);
  }),
  updateDenomination: (actor, itemId, targetCount) => actor.updateEmbeddedDocuments("Item", [{
    _id: itemId,
    "system.quantity.value": targetCount,
  }], capacityCheckedOptions()),
  createDenomination: (actor, itemData) => actor.createEmbeddedDocuments("Item", [itemData], capacityCheckedOptions()),
};

async function rollbackTarget(toActor, createdId, isMerge, mergedPreviousValue, qtyField) {
  try {
    if (isMerge) {
      await toActor.updateEmbeddedDocuments("Item", [{ _id: createdId, [qtyField]: mergedPreviousValue }], capacityCheckedOptions());
      const verified = await settlePoll(() => {
        const doc = toActor.items.get(createdId);
        return doc && getQuantity(doc) === mergedPreviousValue;
      });
      if (!verified) throw new Error("rollback-verify-failed");
    } else {
      await toActor.deleteEmbeddedDocuments("Item", [createdId]);
      const verified = await settlePoll(() => !toActor.items.get(createdId));
      if (!verified) throw new Error("rollback-verify-failed");
    }
    return true;
  } catch (err) {
    // The one deliberately-unresolved edge (R2 §Q4 step 5): the rollback write itself failed.
    // Fail as loud as possible and do NOT claim success — this cannot self-heal.
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferRollbackFailed", { actor: toActor.name, item: createdId }));
    return false;
  }
}

/**
 * Transactional item move: create-verified on target -> delete/decrement-verified on source ->
 * rollback-on-failure, transferId-correlated (createEmbeddedDocuments does not preserve input
 * order in this world — never resolve the created item by array position).
 */
async function performMoveItem({ fromActor, toActor, itemId, amount, requester, transferId = foundry.utils.randomID() }) {
  const item = fromActor.items.get(itemId);
  if (!item) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferItemMissing"));
    return { ok: false, reason: "item-missing" };
  }
  // Phase 8 (002) — a non-GM requester (the withdraw route: fromActor is the party actor)
  // may not move a quest-flagged item out of the pool. Deposits (fromActor is a member
  // actor) never carry the flag, so this only ever fires on withdraw.
  if (!requester?.isGM && item.getFlag(MODULE_ID, "questItem")) {
    ui.notifications.warn(game.i18n.localize("WFRP4EPARTY.QuestItemProtected"));
    return { ok: false, reason: "quest-item-protected" };
  }
  const fullQty = getQuantity(item);
  if (!(amount > 0) || amount > fullQty) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferBadAmount"));
    return { ok: false, reason: "bad-amount" };
  }
  const incomingEnc = item.type === "cargo"
    ? amount
    : Number(item.system.encumbrance?.value ?? 0) * amount;
  const overCap = checkCapacity(toActor, incomingEnc);
  if (overCap) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCapacityExceeded", { shortfall: overCap.shortfall }));
    return { ok: false, reason: "capacity-exceeded", shortfall: overCap.shortfall };
  }
  const isFullMove = isFullStackMove(item, amount);
  const qtyField = quantityField(item);

  const match = findMatchingStack(toActor, item);
  let createdId;
  let expectedQty;
  let mergedPreviousValue = null;

  try {
    if (match) {
      mergedPreviousValue = getQuantity(match);
      expectedQty = mergedPreviousValue + amount;
      await toActor.updateEmbeddedDocuments("Item", [{ _id: match.id, [qtyField]: expectedQty }], capacityCheckedOptions());
      createdId = match.id;
    } else {
      const itemData = item.toObject();
      delete itemData._id;
      foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.transferId`, transferId);
      foundry.utils.setProperty(itemData, qtyField, amount);
      expectedQty = amount;
      const created = await toActor.createEmbeddedDocuments("Item", [itemData], capacityCheckedOptions());
      if (!created?.length) throw new Error("create-empty");
      const stamped = toActor.items.find(i => i.getFlag(MODULE_ID, "transferId") === transferId);
      createdId = stamped?.id ?? created[0].id;
    }
  } catch (err) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCreateFailed", { item: item.name }));
    return { ok: false, reason: "create-failed" };
  }

  const targetVerified = await _internals.verifyTargetSettled(toActor, createdId, expectedQty);
  if (!targetVerified) {
    const rolledBack = await rollbackTarget(toActor, createdId, !!match, mergedPreviousValue, qtyField);
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferVerifyFailed", { item: item.name }));
    return { ok: false, reason: "target-verify-failed", rolledBack };
  }

  try {
    if (isFullMove) {
      await fromActor.deleteEmbeddedDocuments("Item", [itemId]);
    } else {
      await fromActor.updateEmbeddedDocuments("Item", [{ _id: itemId, [qtyField]: fullQty - amount }], capacityCheckedOptions());
    }
  } catch (err) {
    const rolledBack = await rollbackTarget(toActor, createdId, !!match, mergedPreviousValue, qtyField);
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferSourceFailed", { item: item.name }));
    return { ok: false, reason: "source-write-failed", rolledBack };
  }

  const sourceVerified = await _internals.verifySourceSettled(fromActor, itemId, isFullMove, fullQty, amount);
  if (!sourceVerified) {
    // Source-verify reported not-settled. The target is ALREADY verified-present, so re-read the
    // source to disambiguate a genuinely failed source-write from a settle-poll false-negative on a
    // deferred write (the withdraw path writes to an OBSERVER-owned party actor via GM relay — the
    // poll window can expire before an in-flight delete/decrement lands). Never blindly roll back the
    // target here: that would destroy the only confirmed copy and lose the item entirely (BUG-818).
    const srcDoc = fromActor.items.get(itemId);
    const sourceMoved = isFullMove ? !srcDoc : (!!srcDoc && getQuantity(srcDoc) === fullQty - amount);
    if (sourceMoved) {
      // The source write DID take — the move actually completed (item on target, gone/decremented on
      // source). Honor it rather than undoing a good move; conservation holds (exactly one copy).
      await postTransferChatLine(fromActor, toActor, item, amount);
      return { ok: true, createdId, finalSourceQty: isFullMove ? 0 : fullQty - amount, sourceVerifyDeferred: true };
    }
    // The source write did NOT take — the source still holds the item. Roll back the target to avoid
    // a duplicate; the source is intact either way.
    const rolledBack = await rollbackTarget(toActor, createdId, !!match, mergedPreviousValue, qtyField);
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferVerifyFailed", { item: item.name }));
    return { ok: false, reason: "source-verify-failed", rolledBack };
  }

  await postTransferChatLine(fromActor, toActor, item, amount);
  return { ok: true, createdId, finalSourceQty: isFullMove ? 0 : fullQty - amount };
}

// Phase 9 (Item Piles currencies) — sums only coins whose coinValue matches a CONFIGURED
// primary denomination. A leftover coin from a previous currency config (no longer in the
// list) is deliberately excluded here — see decomposeToDenominations and the Consolidate fix
// below, where the same exclusion prevents double-counting a coin that Consolidate cannot
// legally redistribute into (task 2.3).
function sumCoinBrass(actor) {
  const configured = new Set(currency.getDenominations().map(d => d.coinValue));
  return actor.items.reduce((sum, i) => {
    if (i.type !== "money") return sum;
    const coinValue = i.system.coinValue?.value ?? 0;
    if (!configured.has(coinValue)) return sum;
    return sum + coinValue * (i.system.quantity?.value ?? 0);
  }, 0);
}

function findCoinStack(actor, coinValue) {
  return actor.items.find(i => i.type === "money" && i.system.coinValue?.value === coinValue) ?? null;
}

function findSecondaryStack(actor, secondaryId) {
  return actor.items.find(i => i.type === "money" && i.getFlag(MODULE_ID, "secondaryId") === secondaryId) ?? null;
}

// Mirrors MarketWFRP4e.consolidateMoney's greedy Math.trunc/% redistribution (wfrp4e.js:688-689),
// guarding the coinValue<=0 divide-by-zero trap (wfrp4e.js:686-687) by skipping non-positive
// denominations. The denomination list is the live Item Piles config (or the core three when
// absent/inactive — currency.js is fail-open).
function decomposeToDenominations(totalBrass) {
  const denoms = {};
  let remaining = totalBrass;
  for (const coinValue of currency.getDenominations().map(d => d.coinValue)) {
    if (coinValue <= 0) continue;
    denoms[coinValue] = Math.trunc(remaining / coinValue);
    remaining = remaining % coinValue;
  }
  return denoms;
}

// Phase 8 (001, 2026-07-20) — denomination-PRESERVING arithmetic.
//
// Previously every transfer recomputed each purse from its total brass via
// decomposeToDenominations, which silently reshaped coins that were never part of the transfer:
// depositing 20 SS left 1 GC + 8 SS because 240 brass "is" a Gold Crown. Coins now move as the
// coins they are. Only the explicit Consolidate action (performConsolidateCoins) collapses a
// purse to canonical minimal form.
function addDenominations(before, counts) {
  const after = { ...before };
  for (const [coinValue, count] of Object.entries(counts)) {
    if (!count) continue;
    after[coinValue] = (after[coinValue] ?? 0) + count;
  }
  return after;
}

// Removal is where change-making is still required: taking 10 SS from a purse holding 6 GC + 5 SS
// must break a Gold Crown. We pay in the requested denominations as far as they go, then settle
// any shortfall by value — spending the SMALLEST coins that cover it first, so a large coin is
// only broken when nothing else can pay — and hand back the difference as change. That yields
// 5 GC + 15 SS for the case above. Returns null if the purse genuinely cannot cover the request
// (callers still check total brass up front; this is the belt-and-braces path).
function subtractDenominations(before, counts) {
  const after = { ...before };
  const ascending = currency.getDenominations().map(d => d.coinValue).filter(v => v > 0).sort((a, b) => a - b);

  let owedBrass = 0;
  for (const [coinValue, count] of Object.entries(counts)) {
    if (!count) continue;
    const value = Number(coinValue);
    const paid = Math.min(after[value] ?? 0, count);
    after[value] = (after[value] ?? 0) - paid;
    owedBrass += (count - paid) * value;
  }
  if (owedBrass === 0) return after;

  let takenBrass = 0;
  for (const coinValue of ascending) {
    if (takenBrass >= owedBrass) break;
    const available = after[coinValue] ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, Math.ceil((owedBrass - takenBrass) / coinValue));
    after[coinValue] = available - take;
    takenBrass += take * coinValue;
  }
  if (takenBrass < owedBrass) return null;

  return addDenominations(after, decomposeToDenominations(takenBrass - owedBrass));
}

function snapshotDenoms(actor) {
  const snap = {};
  for (const coinValue of currency.getDenominations().map(d => d.coinValue)) {
    const item = findCoinStack(actor, coinValue);
    snap[coinValue] = item ? item.system.quantity.value : 0;
  }
  return snap;
}

function snapshotSecondaries(actor) {
  const snap = {};
  for (const sec of currency.getSecondaryDenominations()) {
    const item = findSecondaryStack(actor, sec.id);
    snap[sec.id] = item ? item.system.quantity.value : 0;
  }
  return snap;
}

function resolveCoinTemplate(coinValue, ...actors) {
  for (const actor of actors) {
    const found = actor?.items.find(i => i.type === "money" && i.system.coinValue?.value === coinValue);
    if (found) return found;
  }
  return game.items.find(i => i.type === "money" && i.system.coinValue?.value === coinValue) ?? null;
}

// Phase 7 capacity gate needs a per-coin Enc value BEFORE any coin item necessarily exists on
// either actor (a brand-new party pool has zero money items pre-seed-backfill) — resolve from
// whichever actor has a live template, then the currently configured denomination's own
// encumbrance, falling back to the canonical 0.005/coin rate (memo §Coin canon, live-verified)
// rather than throwing.
function coinEncumbranceValue(coinValue, ...actors) {
  const template = resolveCoinTemplate(coinValue, ...actors);
  if (template) return Number(template.system?.encumbrance?.value ?? 0.005);
  const configured = currency.getDenominations().find(d => d.coinValue === coinValue);
  return Number(configured?.encumbrance ?? 0.005);
}

// Reshapes `actor`'s money items to exactly match `denomsAfter` (find-or-create-or-update by
// coinValue only — the system's own name-keyed coin helpers throw/no-op on renamed coins).
async function applyDenominations(actor, denomsAfter, transferId, templateActor) {
  const changes = [];
  try {
    for (const coinValue of currency.getDenominations().map(d => d.coinValue)) {
      const targetCount = denomsAfter[coinValue] ?? 0;
      const existing = findCoinStack(actor, coinValue);
      if (existing) {
        const prevQty = existing.system.quantity.value;
        if (prevQty === targetCount) continue;
        await _internals.updateDenomination(actor, existing.id, targetCount);
        changes.push({ coinValue, id: existing.id, prevQty, created: false });
      } else if (targetCount > 0) {
        const template = resolveCoinTemplate(coinValue, actor, templateActor);
        if (!template) throw new Error(`no-coin-template-${coinValue}`);
        const itemData = template.toObject();
        delete itemData._id;
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.transferId`, transferId);
        itemData.system.quantity.value = targetCount;
        const created = await _internals.createDenomination(actor, itemData);
        const stamped = actor.items.find(i => i.getFlag(MODULE_ID, "transferId") === transferId && i.system.coinValue?.value === coinValue);
        const createdId = stamped?.id ?? created?.[0]?.id;
        if (!createdId) throw new Error(`coin-create-empty-${coinValue}`);
        changes.push({ coinValue, id: createdId, prevQty: 0, created: true });
      }
    }
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.partialChanges = changes;
    throw failure;
  }
  return changes;
}

async function revertDenominations(actor, denomsBefore, changes) {
  try {
    for (const change of [...changes].reverse()) {
      if (change.created) {
        await actor.deleteEmbeddedDocuments("Item", [change.id]);
      } else {
        await actor.updateEmbeddedDocuments("Item", [{ _id: change.id, "system.quantity.value": change.prevQty }], capacityCheckedOptions());
      }
    }
    const verified = await settlePoll(() => {
      for (const coinValue of currency.getDenominations().map(d => d.coinValue)) {
        const item = findCoinStack(actor, coinValue);
        const qty = item ? item.system.quantity.value : 0;
        if (qty !== (denomsBefore[coinValue] ?? 0)) return false;
      }
      return true;
    });
    if (!verified) throw new Error("rollback-verify-failed");
    return true;
  } catch (err) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferRollbackFailed", { actor: actor.name, item: "coins" }));
    return false;
  }
}

// Secondary currencies have no exchange rate (Design Decisions row 3) and so never go through
// decompose/subtract change-making — they move as whole units, find-or-create-or-update by the
// module's own `secondaryId` flag (never by name — a GM may rename a currency in Item Piles'
// config without this module losing track of the materialized stack... though a rename DOES
// change `sec.id` upstream since the id is derived from the configured label; a stack created
// under the old label simply becomes untracked, same graceful-orphan behavior as a primary coin
// dropped from the config, see sumCoinBrass/decomposeToDenominations above).
async function applySecondaries(actor, secondsAfter, transferId, templateActor) {
  const changes = [];
  try {
    for (const sec of currency.getSecondaryDenominations()) {
      const targetCount = secondsAfter[sec.id] ?? 0;
      const existing = findSecondaryStack(actor, sec.id);
      if (existing) {
        const prevQty = existing.system.quantity.value;
        if (prevQty === targetCount) continue;
        await _internals.updateDenomination(actor, existing.id, targetCount);
        changes.push({ id: sec.id, docId: existing.id, prevQty, created: false });
      } else if (targetCount > 0) {
        const itemData = {
          name: sec.label,
          type: "money",
          img: sec.img || "icons/svg/coins.svg",
          system: {
            quantity: { value: targetCount },
            encumbrance: { value: sec.encumbrance },
            coinValue: { value: 0 },
          },
        };
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.transferId`, transferId);
        foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.secondaryId`, sec.id);
        const created = await _internals.createDenomination(actor, itemData);
        const stamped = actor.items.find(i => i.getFlag(MODULE_ID, "transferId") === transferId && i.getFlag(MODULE_ID, "secondaryId") === sec.id);
        const createdId = stamped?.id ?? created?.[0]?.id;
        if (!createdId) throw new Error(`secondary-create-empty-${sec.id}`);
        changes.push({ id: sec.id, docId: createdId, prevQty: 0, created: true });
      }
    }
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.partialChanges = changes;
    throw failure;
  }
  return changes;
}

async function revertSecondaries(actor, secondsBefore, changes) {
  try {
    for (const change of [...changes].reverse()) {
      if (change.created) {
        await actor.deleteEmbeddedDocuments("Item", [change.docId]);
      } else {
        await actor.updateEmbeddedDocuments("Item", [{ _id: change.docId, "system.quantity.value": change.prevQty }], capacityCheckedOptions());
      }
    }
    const verified = await settlePoll(() => {
      for (const sec of currency.getSecondaryDenominations()) {
        const item = findSecondaryStack(actor, sec.id);
        const qty = item ? item.system.quantity.value : 0;
        if (qty !== (secondsBefore[sec.id] ?? 0)) return false;
      }
      return true;
    });
    if (!verified) throw new Error("rollback-verify-failed");
    return true;
  } catch (err) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferRollbackFailed", { actor: actor.name, item: "secondary coins" }));
    return false;
  }
}

function addSecondaries(before, counts) {
  const after = { ...before };
  for (const [id, count] of Object.entries(counts)) {
    if (!count) continue;
    after[id] = (after[id] ?? 0) + count;
  }
  return after;
}

// No change-making for secondaries — "cannot be split" (Design Decisions row 3). Returns null
// if any requested secondary exceeds what the purse holds.
function subtractSecondaries(before, counts) {
  const after = { ...before };
  for (const [id, count] of Object.entries(counts)) {
    if (!count) continue;
    const available = after[id] ?? 0;
    if (available < count) return null;
    after[id] = available - count;
  }
  return after;
}

/**
 * Transactional coin move, matched by system.coinValue.value / secondaryId flag only (the
 * system's name-keyed coin helpers throw/no-op on renamed or missing coin items). Reshapes both
 * actors' primary money stacks to the configured canonical denominations (mirrors
 * consolidateMoney), verify+rollback per side. `coins` is coinValue-keyed
 * ({ [coinValue]: count }); `secondaryCoins` is id-keyed ({ [secondaryId]: count }) and never
 * contributes to brass totals or change-making (Design Decisions row 3).
 */
async function performMoveCoins({ fromActor, toActor, coins = {}, secondaryCoins = {}, transferId = foundry.utils.randomID() }) {
  const primaryValues = currency.getDenominations().map(d => d.coinValue);
  const secondaryList = currency.getSecondaryDenominations();

  // The coins the user actually named — NOT decomposeToDenominations(totalBrass), which would
  // canonicalise "20 SS" into "1 GC" before it ever reached the pool (Phase 8 001).
  const incomingCounts = {};
  for (const coinValue of primaryValues) incomingCounts[coinValue] = Number(coins[coinValue]) || 0;
  const incomingSecondary = {};
  for (const sec of secondaryList) incomingSecondary[sec.id] = Number(secondaryCoins[sec.id]) || 0;

  const totalBrass = primaryValues.reduce((sum, v) => sum + incomingCounts[v] * v, 0);
  const secondaryTotal = Object.values(incomingSecondary).reduce((sum, n) => sum + n, 0);
  if (!(totalBrass > 0) && !(secondaryTotal > 0)) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferBadAmount"));
    return { ok: false, reason: "bad-amount" };
  }

  const sourceBrassBefore = sumCoinBrass(fromActor);
  if (totalBrass > sourceBrassBefore) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferInsufficientFunds"));
    return { ok: false, reason: "insufficient-funds" };
  }
  const sourceSecondariesBefore = snapshotSecondaries(fromActor);
  for (const [id, count] of Object.entries(incomingSecondary)) {
    if (count > (sourceSecondariesBefore[id] ?? 0)) {
      ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferInsufficientFunds"));
      return { ok: false, reason: "insufficient-funds" };
    }
  }

  const incomingEnc = Object.entries(incomingCounts)
    .reduce((sum, [coinValue, count]) => sum + coinEncumbranceValue(Number(coinValue), toActor, fromActor) * count, 0)
    + secondaryList.reduce((sum, sec) => sum + sec.encumbrance * (incomingSecondary[sec.id] ?? 0), 0);
  const overCap = checkCapacity(toActor, incomingEnc);
  if (overCap) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCapacityExceeded", { shortfall: overCap.shortfall }));
    return { ok: false, reason: "capacity-exceeded", shortfall: overCap.shortfall };
  }

  const targetBrassBefore = sumCoinBrass(toActor);
  const targetDenomsBefore = snapshotDenoms(toActor);
  const targetSecondariesBefore = snapshotSecondaries(toActor);
  // Add the coins as handed over; do not reshape what the receiver already holds.
  const targetDenomsAfter = addDenominations(targetDenomsBefore, incomingCounts);
  const targetSecondariesAfter = addSecondaries(targetSecondariesBefore, incomingSecondary);

  let targetChanges = [];
  let targetSecondaryChanges = [];
  // Each apply phase stamps its own `partialChanges`, so the two cannot share a catch: a
  // secondary failure would hand the secondary change list to revertDenominations and leave the
  // already-committed primary coins on the receiver. Separate scopes, each reverted with its own list.
  try {
    targetChanges = await applyDenominations(toActor, targetDenomsAfter, transferId, fromActor);
  } catch (err) {
    const rolledBack = await revertDenominations(toActor, targetDenomsBefore, err.partialChanges ?? []);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferCreateFailed"));
    return { ok: false, reason: "create-failed", rolledBack };
  }
  try {
    targetSecondaryChanges = await applySecondaries(toActor, targetSecondariesAfter, transferId, fromActor);
  } catch (err) {
    const rolledBackSecondary = await revertSecondaries(toActor, targetSecondariesBefore, err.partialChanges ?? []);
    const rolledBackPrimary = await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferCreateFailed"));
    return { ok: false, reason: "create-failed", rolledBack: rolledBackPrimary && rolledBackSecondary };
  }

  const targetVerified = await settlePoll(() => sumCoinBrass(toActor) === targetBrassBefore + totalBrass);
  if (!targetVerified) {
    await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    const rolledBack = await revertSecondaries(toActor, targetSecondariesBefore, targetSecondaryChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferVerifyFailed"));
    return { ok: false, reason: "target-verify-failed", rolledBack };
  }

  const sourceDenomsBefore = snapshotDenoms(fromActor);
  const sourceSecondaryBefore = snapshotSecondaries(fromActor);
  // Spend the named coins where the payer has them; break a larger coin only for the shortfall.
  const sourceDenomsAfter = subtractDenominations(sourceDenomsBefore, incomingCounts);
  const sourceSecondaryAfter = subtractSecondaries(sourceSecondaryBefore, incomingSecondary);
  if (!sourceDenomsAfter || !sourceSecondaryAfter) {
    await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    const rolledBack = await revertSecondaries(toActor, targetSecondariesBefore, targetSecondaryChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferInsufficientFunds"));
    return { ok: false, reason: "insufficient-funds", rolledBack };
  }

  let sourceChanges = [];
  let sourceSecondaryChanges = [];
  // Same split as the target side above — a secondary failure must not swallow the primary
  // change list that revertDenominations needs to undo the source write.
  try {
    sourceChanges = await applyDenominations(fromActor, sourceDenomsAfter, transferId, toActor);
  } catch (err) {
    const rolledBackSource = await revertDenominations(fromActor, sourceDenomsBefore, err.partialChanges ?? []);
    const rolledBackTarget = await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    const rolledBackTargetSecondary = await revertSecondaries(toActor, targetSecondariesBefore, targetSecondaryChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferSourceFailed"));
    return { ok: false, reason: "source-write-failed", rolledBack: rolledBackSource && rolledBackTarget && rolledBackTargetSecondary };
  }
  try {
    sourceSecondaryChanges = await applySecondaries(fromActor, sourceSecondaryAfter, transferId, toActor);
  } catch (err) {
    const rolledBackSourceSecondary = await revertSecondaries(fromActor, sourceSecondaryBefore, err.partialChanges ?? []);
    const rolledBackSource = await revertDenominations(fromActor, sourceDenomsBefore, sourceChanges);
    const rolledBackTarget = await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    const rolledBackTargetSecondary = await revertSecondaries(toActor, targetSecondariesBefore, targetSecondaryChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferSourceFailed"));
    return { ok: false, reason: "source-write-failed", rolledBack: rolledBackSource && rolledBackSourceSecondary && rolledBackTarget && rolledBackTargetSecondary };
  }

  const sourceVerified = await settlePoll(() => sumCoinBrass(fromActor) === sourceBrassBefore - totalBrass);
  if (!sourceVerified) {
    const rolledBackSource = await revertDenominations(fromActor, sourceDenomsBefore, sourceChanges);
    const rolledBackSourceSecondary = await revertSecondaries(fromActor, sourceSecondaryBefore, sourceSecondaryChanges);
    const rolledBackTarget = await revertDenominations(toActor, targetDenomsBefore, targetChanges);
    const rolledBackTargetSecondary = await revertSecondaries(toActor, targetSecondariesBefore, targetSecondaryChanges);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferVerifyFailed"));
    return { ok: false, reason: "source-verify-failed", rolledBack: rolledBackSource && rolledBackSourceSecondary && rolledBackTarget && rolledBackTargetSecondary };
  }

  await postTransferChatLine(fromActor, toActor, { coins: incomingCounts, secondaryCoins: incomingSecondary }, null);
  return { ok: true };
}

function formatCoinString(coinsPayload) {
  const coins = coinsPayload?.coins ?? {};
  const secondaryCoins = coinsPayload?.secondaryCoins ?? {};
  const parts = [];
  for (const denom of currency.getDenominations()) {
    const count = coins[denom.coinValue];
    if (count) parts.push(`${count}${denom.abbrev}`);
  }
  for (const sec of currency.getSecondaryDenominations()) {
    const count = secondaryCoins[sec.id];
    if (count) parts.push(`${count} ${sec.label}`);
  }
  return parts.join(" ");
}

// Public transparency line (R4.5) — always on, fully unrestricted delivery (inverse of Phase 3's
// hidden-roll HC3), fired only after the transactional write verifies. Speaker is whichever side
// is the PC (never the party actor), so it reads naturally as "<PC> deposited/withdrew ...".
// `author` defaults to the local game.user.id, which is correct since each player's own client
// fires their own handler — never pass the legacy `user:` shim (silently unattributed).
async function postTransferChatLine(fromActor, toActor, itemOrCoins, amount) {
  const isDeposit = fromActor.type !== PARTY_ACTOR_TYPE;
  const speakerActor = isDeposit ? fromActor : toActor;
  let content;
  if (amount === null) {
    const coinStr = formatCoinString(itemOrCoins);
    if (!coinStr) return;
    content = game.i18n.format(isDeposit ? "WFRP4EPARTY.TransferDepositedCoinsLine" : "WFRP4EPARTY.TransferWithdrewCoinsLine", { coins: coinStr });
  } else {
    content = game.i18n.format(isDeposit ? "WFRP4EPARTY.TransferDepositedLine" : "WFRP4EPARTY.TransferWithdrewLine", { qty: amount, item: itemOrCoins.name });
  }
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor: speakerActor }) });
}

export async function deposit(sourceActor, targetPartyActor, itemId, amount) {
  if (!game.user.isGM && !sourceActor.isOwner) return { ok: false, reason: "not-owner" };
  return moveItem({ fromActor: sourceActor, toActor: targetPartyActor, itemId, amount });
}

export async function withdraw(partyActor, targetMemberActor, itemId, amount) {
  if (!game.user.isGM && !targetMemberActor.isOwner) return { ok: false, reason: "not-owner" };
  if (!game.actors.get(targetMemberActor.id)) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferMemberGone"));
    return { ok: false, reason: "member-gone" };
  }
  return moveItem({ fromActor: partyActor, toActor: targetMemberActor, itemId, amount });
}

export async function depositCoins(sourceActor, targetPartyActor, coins, secondaryCoins = {}) {
  if (!game.user.isGM && !sourceActor.isOwner) return { ok: false, reason: "not-owner" };
  return moveCoins({ fromActor: sourceActor, toActor: targetPartyActor, coins, secondaryCoins });
}

export async function withdrawCoins(partyActor, targetMemberActor, coins, secondaryCoins = {}) {
  if (!game.user.isGM && !targetMemberActor.isOwner) return { ok: false, reason: "not-owner" };
  if (!game.actors.get(targetMemberActor.id)) {
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferMemberGone"));
    return { ok: false, reason: "member-gone" };
  }
  return moveCoins({ fromActor: partyActor, toActor: targetMemberActor, coins, secondaryCoins });
}

export async function moveItem({ fromActor, toActor, itemId, amount }) {
  return requestMutation("move-item", {
    fromActorId: fromActor.id,
    toActorId: toActor.id,
    itemId,
    amount,
  });
}

export async function moveCoins({ fromActor, toActor, coins, secondaryCoins = {} }) {
  return requestMutation("move-coins", {
    fromActorId: fromActor.id,
    toActorId: toActor.id,
    coins,
    secondaryCoins,
  });
}

// Phase 7 (R7.1) — GM copy-create path for compendium/world/sidebar item drops (no source
// actor to transactionally move FROM, unlike moveItem's actor-to-actor case). isGM-gated here
// too (not just at the call site) so this export can never become an unauthorized write path
// if called from anywhere else later. Same capacity gate as moveItem/moveCoins — no bypass
// lever exists for a GM add (R7.3); the GM's only levers are capacityBonus and the vehicle.
async function performAddItem(partyActor, itemData) {
  const qtyField = itemData.type === "cargo" ? "system.encumbrance.value" : "system.quantity.value";
  const qty = Number(foundry.utils.getProperty(itemData, qtyField) ?? 1) || 1;
  const perUnitEnc = Number(itemData.system?.encumbrance?.value ?? 0);
  const incomingEnc = itemData.type === "cargo" ? qty : perUnitEnc * qty;

  const overCap = checkCapacity(partyActor, incomingEnc);
  if (overCap) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCapacityExceeded", { shortfall: overCap.shortfall }));
    return { ok: false, reason: "capacity-exceeded", shortfall: overCap.shortfall };
  }

  // Stack onto a matching existing item — same match rule as moveItem (name+type, +coinValue
  // for money, +qualities/flaws otherwise; findMatchingStack works on a plain data object the
  // same as a real Item document, it only ever reads property paths). User-reported live bug
  // 2026-07-19: dropping the same weapon from a compendium twice created two separate qty-1
  // stacks instead of one qty-2 stack.
  const match = findMatchingStack(partyActor, itemData);
  if (match) {
    const matchQtyField = quantityField(match);
    const expectedQty = getQuantity(match) + qty;
    try {
      await partyActor.updateEmbeddedDocuments("Item", [{ _id: match.id, [matchQtyField]: expectedQty }], capacityCheckedOptions());
    } catch (err) {
      ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCreateFailed", { item: itemData.name }));
      return { ok: false, reason: "create-failed" };
    }
    const merged = await _internals.verifyTargetSettled(partyActor, match.id, expectedQty);
    if (!merged) {
      const rolledBack = await rollbackTarget(partyActor, match.id, true, expectedQty - qty, matchQtyField);
      ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferVerifyFailed", { item: itemData.name }));
      return { ok: false, reason: "target-verify-failed", rolledBack };
    }
    return { ok: true, createdId: match.id };
  }

  const transferId = foundry.utils.randomID();
  const data = foundry.utils.deepClone(itemData);
  delete data._id;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.transferId`, transferId);

  let created;
  try {
    created = await partyActor.createEmbeddedDocuments("Item", [data], capacityCheckedOptions());
    if (!created?.length) throw new Error("create-empty");
  } catch (err) {
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCreateFailed", { item: itemData.name }));
    return { ok: false, reason: "create-failed" };
  }
  const stamped = partyActor.items.find(i => i.getFlag(MODULE_ID, "transferId") === transferId);
  const createdId = stamped?.id ?? created[0].id;

  const verified = await _internals.verifyTargetSettled(partyActor, createdId, qty);
  if (!verified) {
    const rolledBack = await rollbackTarget(partyActor, createdId, false, null, quantityField(data));
    ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferVerifyFailed", { item: itemData.name }));
    return { ok: false, reason: "target-verify-failed", rolledBack };
  }

  return { ok: true, createdId };
}

// Phase 7 (R7.8) — Consolidate: reshapes `actor`'s canonical coin stacks (matched by
// system.coinValue.value, NEVER by name) into the fewest possible configured-denomination items,
// conserving total pence. Strictly reduces coin count so it is never capacity-gated (R7.8
// explicit). Non-canonical homebrew coins (Phase 4 F02) — including any coin whose coinValue is
// no longer in the currency config (task 2.3) — are excluded from both the brass sum and the
// redistribution, and left untouched as their own stacks; sumCoinBrass already enforces this.
//
// Task 2.3 — greedy decomposition is only provably correct over a clean divisibility chain
// (plan Design Decisions row 1). When the configured denominations don't form one,
// isChainValid() has already warned once and Consolidate refuses to run rather than risk a
// silently non-minimal or wrong redistribution.
async function performConsolidateCoins(actor) {
  if (!currency.isChainValid()) {
    return { ok: false, reason: "invalid-denomination-chain" };
  }
  const beforeBrass = sumCoinBrass(actor);
  const denomsBefore = snapshotDenoms(actor);
  const denomsAfter = decomposeToDenominations(beforeBrass);

  let changes;
  try {
    changes = await applyDenominations(actor, denomsAfter, foundry.utils.randomID(), actor);
  } catch (err) {
    const rolledBack = await revertDenominations(actor, denomsBefore, err.partialChanges ?? []);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferCreateFailed"));
    return { ok: false, reason: "create-failed", rolledBack };
  }

  const afterBrass = sumCoinBrass(actor);
  if (afterBrass !== beforeBrass) {
    const rolledBack = await revertDenominations(actor, denomsBefore, changes);
    ui.notifications.error(game.i18n.localize("WFRP4EPARTY.TransferVerifyFailed"));
    return { ok: false, reason: "conservation-mismatch", rolledBack };
  }

  return { ok: true, beforeBrass, afterBrass, breakdown: denomsAfter };
}

async function performSetPartyItemQuantity(partyActor, itemId, requested, requester) {
  const item = partyActor.items.get(itemId);
  if (!item) return { ok: false, reason: "item-missing" };
  // Phase 8 (002) — unreachable today (the set-item-quantity handler is already
  // requester.isGM-gated below), kept for symmetry with performMoveItem's guard.
  if (!requester?.isGM && item.getFlag(MODULE_ID, "questItem")) {
    return { ok: false, reason: "quest-item-protected" };
  }

  const field = quantityField(item);
  const before = getQuantity(item);
  if (requested === before) return { ok: true, before, requested };

  if (requested > before) {
    const perUnitEnc = Number(item.system.encumbrance?.value ?? 0);
    const incomingEnc = item.type === "cargo" ? (requested - before) : perUnitEnc * (requested - before);
    const overCap = checkCapacity(partyActor, incomingEnc);
    if (overCap) {
      ui.notifications.error(game.i18n.format("WFRP4EPARTY.TransferCapacityExceeded", { shortfall: overCap.shortfall }));
      return { ok: false, reason: "capacity-exceeded", shortfall: overCap.shortfall, before };
    }
  }

  try {
    await partyActor.updateEmbeddedDocuments("Item", [{ _id: itemId, [field]: requested }], capacityCheckedOptions());
  } catch (err) {
    return { ok: false, reason: "target-write-failed", before };
  }
  const verified = await settlePoll(() => getQuantity(partyActor.items.get(itemId)) === requested);
  if (verified) return { ok: true, before, requested };

  const rolledBack = await rollbackTarget(partyActor, itemId, true, before, field);
  return { ok: false, reason: "target-verify-failed", before, rolledBack };
}

export async function addItem(partyActor, itemData) {
  return requestMutation("add-item", { partyActorId: partyActor.id, itemData });
}

export async function consolidateCoins(actor) {
  return requestMutation("consolidate-coins", { actorId: actor.id });
}

export async function setPartyItemQuantity(partyActor, itemId, requested) {
  return requestMutation("set-item-quantity", { partyActorId: partyActor.id, itemId, requested });
}

registerMutationHandler("move-item", async (payload, { requester }) => {
  const fromActor = game.actors.get(payload.fromActorId);
  const toActor = game.actors.get(payload.toActorId);
  if (!fromActor || !toActor) return { ok: false, reason: "actor-missing" };
  const denied = authorizeTransfer(requester, fromActor, toActor);
  if (denied) return { ok: false, reason: denied };
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
  return performMoveItem({ fromActor, toActor, itemId: payload.itemId, amount, requester });
});

registerMutationHandler("move-coins", async (payload, { requester }) => {
  const fromActor = game.actors.get(payload.fromActorId);
  const toActor = game.actors.get(payload.toActorId);
  if (!fromActor || !toActor) return { ok: false, reason: "actor-missing" };
  const denied = authorizeTransfer(requester, fromActor, toActor);
  if (denied) return { ok: false, reason: denied };
  const coins = payload.coins ?? {};
  const secondaryCoins = payload.secondaryCoins ?? {};
  const validCounts = obj => Object.values(obj).every(v => Number.isInteger(v ?? 0) && (v ?? 0) >= 0);
  // Keys are validated against the LIVE configured denomination set, not a fixed gc/ss/bp
  // literal — this handler runs on the active-GM client via the mutation queue's socket relay
  // (mutation-queue.js:45-51), so `currency.getDenominations()` here reads that GM client's own
  // config, same as every other coin-engine call in this file.
  const validPrimaryKeys = new Set(currency.getDenominations().map(d => String(d.coinValue)));
  const validSecondaryKeys = new Set(currency.getSecondaryDenominations().map(d => d.id));
  if (!validCounts(coins) || !validCounts(secondaryCoins)
    || !Object.keys(coins).every(k => validPrimaryKeys.has(k))
    || !Object.keys(secondaryCoins).every(k => validSecondaryKeys.has(k))) {
    return { ok: false, reason: "bad-amount" };
  }
  return performMoveCoins({ fromActor, toActor, coins, secondaryCoins });
});

registerMutationHandler("add-item", async (payload, { requester }) => {
  if (!requester.isGM) return { ok: false, reason: "not-owner" };
  const partyActor = game.actors.get(payload.partyActorId);
  if (!partyActor || partyActor.type !== PARTY_ACTOR_TYPE) return { ok: false, reason: "actor-missing" };
  return performAddItem(partyActor, payload.itemData);
});

registerMutationHandler("consolidate-coins", async (payload, { requester }) => {
  const actor = game.actors.get(payload.actorId);
  if (!actor || actor.type !== PARTY_ACTOR_TYPE) return { ok: false, reason: "actor-missing" };
  const allowed = requester.isGM || actor.system.members.list.some(ref => {
    const member = game.actors.get(ref.id);
    return member && userOwnsActor(requester, member);
  });
  if (!allowed) return { ok: false, reason: "not-owner" };
  return performConsolidateCoins(actor);
});

registerMutationHandler("set-item-quantity", async (payload, { requester }) => {
  if (!requester.isGM) return { ok: false, reason: "not-owner" };
  const partyActor = game.actors.get(payload.partyActorId);
  if (!partyActor || partyActor.type !== PARTY_ACTOR_TYPE) return { ok: false, reason: "actor-missing" };
  const requested = Number(payload.requested);
  if (!Number.isInteger(requested) || requested < 0) return { ok: false, reason: "bad-amount" };
  return performSetPartyItemQuantity(partyActor, payload.itemId, requested, requester);
});

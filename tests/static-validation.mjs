import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = relativePath => readFileSync(`${root}/${relativePath}`, "utf8");
const passed = [];
const pass = name => passed.push(name);

for (const file of [
  "scripts/mutation-queue.js",
  "scripts/party-model.js",
  "scripts/transfer.js",
  "scripts/journey.js",
  "scripts/party-sheet.js",
]) {
  execFileSync(process.execPath, ["--check", `${root}/${file}`], { stdio: "pipe" });
}
pass("production JavaScript parses");

JSON.parse(read("module.json"));
const english = JSON.parse(read("lang/en.json"));
JSON.parse(read("package.json"));
pass("JSON artifacts parse");

const localizedSources = [
  ...readdirSync(`${root}/scripts`).filter(name => name.endsWith(".js")).map(name => read(`scripts/${name}`)),
  ...readdirSync(`${root}/templates`).filter(name => name.endsWith(".hbs")).map(name => read(`templates/${name}`)),
  ...readdirSync(`${root}/macros`).filter(name => name.endsWith(".js")).map(name => read(`macros/${name}`)),
];
const usedLocalizationKeys = new Set(localizedSources.flatMap(source => source.match(/WFRP4EPARTY\.[A-Za-z0-9]+/g) ?? []));
const dynamicLocalizationPrefixes = new Set([
  "WFRP4EPARTY.Endeavour",
  "WFRP4EPARTY.JourneyEncounter",
  "WFRP4EPARTY.Season",
]);
const missingLocalizationKeys = [...usedLocalizationKeys]
  .filter(key => !Object.hasOwn(english, key) && !dynamicLocalizationPrefixes.has(key))
  .sort();
assert.deepEqual(missingLocalizationKeys, []);
pass("module localization keys resolve");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const file of readdirSync(`${root}/macros`).filter(name => name.endsWith(".js"))) {
  new AsyncFunction(read(`macros/${file}`));
}
pass("Foundry macros parse as AsyncFunction bodies");

const partySheetSource = read("scripts/party-sheet.js");
const transferSource = read("scripts/transfer.js");
assert.match(partySheetSource, /config\.currentStage >= config\.totalStages/);
assert.doesNotMatch(partySheetSource, /newStage >= config\.totalStages/);
assert.match(partySheetSource, /static async _onRemoveMember[\s\S]{0,200}!game\.user\.isGM/);
assert.match(partySheetSource, /requestMutation\("assign-endeavour"/);
assert.match(partySheetSource, /requestMutation\("set-endeavour-skill"/);
assert.match(partySheetSource, /requestMutation\("begin-journey-stage-work"/);
assert.match(partySheetSource, /journeyStageLocks\.has\(lockKey\)/);
assert.match(partySheetSource, /Hooks\.on\("preCreateItem"/);
assert.match(partySheetSource, /Hooks\.on\("preUpdateItem"/);
assert.doesNotMatch(transferSource, /function arraysEqual/);
assert.match(transferSource, /failure\.partialChanges = changes/);
assert.match(transferSource, /rollbackTarget\(partyActor, itemId, true, before, field\)/);
assert.match(transferSource, /item\.type === "cargo"\s*\? amount/);
assert.match(transferSource, /registerMutationHandler\("move-item"/);
pass("audited defect patterns are eliminated");

// Foundry v13 shape source: Users.activeGM in the extracted core API and the live module's
// Hooks/game globals. Only the queue's ordering contract is mocked here; live Actor writes stay
// covered by phase6-smoke.js and phase7-smoke.js.
globalThis.Hooks = { once() {} };
globalThis.game = {
  user: { id: "gm-test", isGM: true },
  users: { activeGM: { id: "gm-test" } },
};
globalThis.foundry = { utils: { deepClone: structuredClone } };

const queue = await import(`../scripts/mutation-queue.js?test=${Date.now()}`);
let active = 0;
let maxActive = 0;
const order = [];
queue.registerMutationHandler("test-order", async ({ id }) => {
  active++;
  maxActive = Math.max(maxActive, active);
  order.push(`start${id}`);
  await new Promise(resolve => setTimeout(resolve, 5));
  order.push(`end${id}`);
  active--;
  return { ok: true };
});
const queueResults = await Promise.all([
  queue.requestMutation("test-order", { id: 1 }),
  queue.requestMutation("test-order", { id: 2 }),
]);
assert.equal(maxActive, 1);
assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
assert.ok(queueResults.every(result => result.ok));
pass("authoritative mutation queue is serial");

const transfer = await import(`../scripts/transfer.js?test=${Date.now()}`);
const identity = transfer._internals.stackIdentity;
const base = {
  name: "Sword",
  type: "weapon",
  system: {
    quantity: { value: 1 },
    location: { value: "belt" },
    equipped: true,
    damage: { value: "+4" },
    qualities: { value: [{ name: "fine" }, { name: "durable", value: 1 }] },
    flaws: { value: [] },
  },
  effects: [],
  flags: {},
};
const equivalent = structuredClone(base);
equivalent.system.quantity.value = 9;
equivalent.system.location.value = "pack";
equivalent.system.equipped = false;
equivalent.system.qualities.value.reverse();
equivalent.flags = { "scene-packer": { hash: "different-document-instance-hash" } };
const distinct = structuredClone(equivalent);
distinct.system.damage.value = "+5";
assert.equal(identity(base), identity(equivalent));
assert.notEqual(identity(base), identity(distinct));
pass("canonical stack identity preserves meaningful differences");

console.log(`PASS ${passed.length}/${passed.length}`);
for (const name of passed) console.log(`- ${name}`);

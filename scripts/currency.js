const MODULE_ID = "wfrp4e-party-sheet";

// Fallback when Item Piles is absent/inactive/unreadable — must reproduce v0.3.0 exactly
// (zero-regression requirement, plan Design Decisions row "Fail-open").
const CORE_PRIMARY = [
  { coinValue: 240, exchangeRate: 240, labelKey: "NAME.GC", abbrevKey: "MARKET.Abbrev.GC", img: "modules/wfrp4e-core/icons/currency/goldcrown.png", encumbrance: 0.005 },
  { coinValue: 12, exchangeRate: 12, labelKey: "NAME.SS", abbrevKey: "MARKET.Abbrev.SS", img: "modules/wfrp4e-core/icons/currency/silvershilling.png", encumbrance: 0.005 },
  { coinValue: 1, exchangeRate: 1, labelKey: "NAME.BP", abbrevKey: "MARKET.Abbrev.BP", img: "modules/wfrp4e-core/icons/currency/brasspenny.png", encumbrance: 0.005 },
];

let cache = null; // { primary: [...], secondary: [...] }
let warnedInvalidChain = false;

function itemPilesActive() {
  return !!game.modules.get("item-piles")?.active;
}

// Currency entries are read at `ready` or later (game.itempiles exists at `init`, but the
// WFRP bridge registers its defaults on Hooks.once("item-piles-ready"), which fires after
// core `ready` — reading earlier would see the bridge's un-registered pre-config state).
function toEntry(def, index, fallbackIdPrefix) {
  const item = def?.data?.item ?? {};
  const system = item.system ?? {};
  // The module's own JSDoc drops the "Rate" suffix; the real property is `exchangeRate`. It is
  // the authoritative value for a currency's worth relative to the base unit — coinValue is
  // the item snapshot's own copy of the same number and is preferred when present (it is what
  // a materialized coin Item actually carries), with exchangeRate as the fallback source.
  const exchangeRate = Number(def?.exchangeRate ?? 0) || 0;
  const coinValue = Number(system.coinValue?.value ?? exchangeRate ?? 0) || 0;
  return {
    coinValue,
    exchangeRate,
    label: item.name || def?.name || `${fallbackIdPrefix} ${index}`,
    // `{#}` is Item Piles' quantity placeholder and is not guaranteed to be a leading prefix
    // (the WFRP bridge emits "{#}GC", but a GM may author "GT{#}" or "{#} GT") — strip every
    // occurrence, then trim, so the abbreviation renders the same way the core three do.
    abbrev: def?.abbreviation ? String(def.abbreviation).replace(/\{#\}/g, "").trim() : "",
    img: item.img || def?.img || "",
    encumbrance: Number(system.encumbrance?.value ?? 0.005) || 0.005,
    id: item.name || def?.name || `${fallbackIdPrefix}-${index}`,
  };
}

function readFromItemPiles() {
  const api = game.itempiles?.API;
  if (!api) return null;
  try {
    const primaryRaw = api.CURRENCIES ?? [];
    const secondaryRaw = api.SECONDARY_CURRENCIES ?? [];
    const primaryItems = primaryRaw.filter(def => def?.type === "item");
    const secondaryItems = secondaryRaw.filter(def => def?.type === "item");
    // Attribute-type currencies (data.path) are deliberately out of scope — the party pool is
    // item-based by design. Skipping silently would leave a GM with no diagnostic for a
    // currency that never appears on the sheet, so say so once per read.
    const skipped = (primaryRaw.length - primaryItems.length) + (secondaryRaw.length - secondaryItems.length);
    if (skipped > 0) console.debug(`${MODULE_ID} | skipped ${skipped} attribute-type currency/currencies (item-type only)`);
    const primary = primaryItems
      .map((def, i) => toEntry(def, i, "primary"))
      .filter(entry => entry.coinValue > 0)
      .sort((a, b) => b.coinValue - a.coinValue);
    if (!primary.length) return null;
    const secondary = secondaryItems.map((def, i) => toEntry(def, i, "secondary"));
    return { primary, secondary };
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to read Item Piles currency config, falling back to the core three`, err);
    return null;
  }
}

function coreFallback() {
  return {
    primary: CORE_PRIMARY.map(d => ({
      coinValue: d.coinValue,
      exchangeRate: d.exchangeRate,
      label: game.i18n.localize(d.labelKey),
      abbrev: game.i18n.localize(d.abbrevKey),
      img: d.img,
      encumbrance: d.encumbrance,
      id: game.i18n.localize(d.labelKey),
    })),
    secondary: [],
  };
}

function load() {
  if (cache) return cache;
  const cfg = (itemPilesActive() && readFromItemPiles()) || coreFallback();
  // Party-sheet display convention (user directive 2026-07-23): the top (gold) denomination keeps
  // its capitalized abbreviation; every smaller denomination — silver, brass, and any secondary —
  // renders lowercase ("2GC 24ss 2bp"). `primary` is sorted descending, so index 0 is the gold.
  // abbrev is display-only here (all matching is by coinValue/id), so lowercasing it is safe.
  cache = {
    primary: cfg.primary.map((d, i) => (i === 0 ? d : { ...d, abbrev: (d.abbrev ?? "").toLowerCase() })),
    secondary: cfg.secondary.map(d => ({ ...d, abbrev: (d.abbrev ?? "").toLowerCase() })),
  };
  return cache;
}

/** Drop the cached config and re-read it (e.g. after a currency-config change is observed). */
export function refresh() {
  cache = null;
  warnedInvalidChain = false;
  return load();
}

/** Ordered-descending primary denominations: { coinValue, exchangeRate, label, abbrev, img, encumbrance, id }. */
export function getDenominations() {
  return load().primary;
}

/** Secondary denominations (no exchangeRate, cannot be split): same shape, coinValue may be 0. */
export function getSecondaryDenominations() {
  return load().secondary;
}

export function isItemPilesActive() {
  return itemPilesActive();
}

// Task 4.1 — Item Piles' own currency setters (setCurrencies/setSecondaryCurrencies) fire no
// module hook of their own, but they write through game.settings.set, which DOES fire Foundry
// core's updateSetting with key "item-piles.currencies" / "item-piles.secondaryCurrencies"
// (live-verified 2026-07-21: read-then-restore round-trip through setCurrencies observed exactly
// this key). Drop the cache on that signal so a GM editing currencies mid-session doesn't need a
// world reload for the party sheet to pick it up.
// Guarded: the node static-validation harness dynamically imports this module with only a
// partial Hooks mock (Hooks.once, per tests/static-validation.mjs) — this module-scope
// registration must not throw in that environment.
if (typeof Hooks !== "undefined" && typeof Hooks.on === "function") {
  Hooks.on("updateSetting", setting => {
    if (setting.key === "item-piles.currencies" || setting.key === "item-piles.secondaryCurrencies") {
      refresh();
    }
  });
  // The WFRP bridge registers its currency defaults on `item-piles-ready`, which fires AFTER
  // core `ready` — and our earliest consumer (party-model's backfill) runs at core `ready`, so
  // the cache can be populated from the pre-bridge config. Drop it once the bridge has run.
  // Never fires when Item Piles is inactive, so the core fallback is unaffected.
  Hooks.once("item-piles-ready", () => refresh());
}

// Greedy decomposition (the engine's decomposeToDenominations) is only provably correct when
// every adjacent pair in the descending-sorted list divides evenly — a clean divisibility
// chain. For an arbitrary GM-configured set this is bounded coin-change and greedy can be
// silently non-minimal or wrong. Rather than throw (deposit/withdraw of whole coins must still
// work), this degrades: Consolidate is disabled and a single warning is shown per session.
//
// Accepts an optional explicit array of coinValues for unit testing without live Foundry
// globals; production callers omit it and get the live configured primary list.
function warnChainInvalid(larger, smaller) {
  if (warnedInvalidChain || typeof ui === "undefined") return;
  warnedInvalidChain = true;
  ui.notifications.warn(game.i18n.format("WFRP4EPARTY.CurrencyChainInvalid", { larger, smaller }));
}

// v1.3.0 — coin+secondary label for the inventory log's Amount column. Mirrors
// party-sheet.js's formatCoinLabel (primary loop, zero-suppression, "—" for empty) but also
// walks the secondary denominations, keyed by `id` rather than `coinValue` (secondaries have
// no reliable coinValue). Kept self-contained here rather than refactoring formatCoinLabel.
export function formatCoinLog(coins, secondaryCoins) {
  const parts = [];
  for (const denom of getDenominations()) {
    const count = coins?.[denom.coinValue];
    if (count) parts.push(`${count}${denom.abbrev}`);
  }
  for (const denom of getSecondaryDenominations()) {
    const count = secondaryCoins?.[denom.id];
    if (count) parts.push(`${count}${denom.abbrev}`);
  }
  return parts.length ? parts.join(" ") : "—";
}

export function isChainValid(explicitCoinValues) {
  const values = (explicitCoinValues ?? getDenominations().map(d => d.coinValue)).filter(v => v > 0);
  if (!values.length) return false;
  const sorted = [...values].sort((a, b) => b - a);
  // Greedy is only exact when the smallest denomination is the base unit; a chain like [240, 12]
  // divides cleanly but cannot represent 10 brass, so decomposition would silently drop value.
  if (sorted[sorted.length - 1] !== 1) {
    warnChainInvalid(sorted[sorted.length - 1], 1);
    return false;
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const larger = sorted[i];
    const smaller = sorted[i + 1];
    if (larger % smaller !== 0) {
      warnChainInvalid(larger, smaller);
      return false;
    }
  }
  return true;
}

#!/usr/bin/env node
// Independent check of the B4 order, from captured data only (no browser):
//  1. Recompute the cheapest valid selection over the FULL catalogue
//     (one per need, excluded items removed, pre-tax budget) by brute force.
//  2. Check the site's summary lines equal that selection.
//  3. Recompute item total, and infer the tax rate the site applied.
// Run: node verify.mjs  (from this folder)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { products, classification } = JSON.parse(readFileSync(join(here, "products.json"), "utf8"));
const summary = JSON.parse(readFileSync(join(here, "checkout-summary.json"), "utf8"));
const BUDGET = 60;
const cents = (x) => Math.round(x * 100);
const price = Object.fromEntries(products.map((p) => [p.name, p.price]));
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. brute force every carry × light × top combination
const combos = [];
for (const c of classification.carry) for (const l of classification.light) for (const t of classification.top) {
  combos.push({ items: [c, l, t], total: cents(price[c]) + cents(price[l]) + cents(price[t]) });
}
const valid = combos.filter((x) => x.total < BUDGET * 100).sort((a, b) => a.total - b.total);
const best = valid[0];
const tied = valid.filter((x) => x.total === best.total);
check("a valid combination exists under budget", valid.length > 0, `${valid.length} of ${combos.length} combinations are under $${BUDGET}`);
check("excluded items really are excluded", Object.keys(classification.excluded).every((n) => !combos.some((x) => x.items.includes(n))), Object.keys(classification.excluded).join(", "));

// 2. ordered lines == an optimal selection
const ordered = summary.lines.map((l) => l.name).sort();
const matchesOptimal = tied.some((x) => JSON.stringify([...x.items].sort()) === JSON.stringify(ordered));
check("ordered items are a cheapest valid selection", matchesOptimal, `ordered: ${ordered.join(" + ")}; optimal ($${(best.total / 100).toFixed(2)}): ${tied.map((x) => x.items.join(" + ")).join("  OR  ")}`);
check("every quantity is 1", summary.lines.every((l) => l.qty === 1), "");
check("line prices equal catalogue prices", summary.lines.every((l) => cents(l.price) === cents(price[l.name])), "");

// 3. totals
const itemTotal = summary.lines.reduce((s, l) => s + cents(l.price) * l.qty, 0);
check("site item total = sum of lines", itemTotal === cents(summary.itemTotal), `computed $${(itemTotal / 100).toFixed(2)} vs site $${summary.itemTotal}`);
check("pre-tax total under budget", itemTotal < BUDGET * 100, `$${(itemTotal / 100).toFixed(2)} < $${BUDGET}`);
const rate = cents(summary.tax) / itemTotal;
const rounded = Math.round(rate * 100) / 100;
check("tax matches a round rate", cents(summary.tax) === Math.round(itemTotal * rounded), `inferred rate ${(rate * 100).toFixed(3)}% → ${rounded * 100}% of $${(itemTotal / 100).toFixed(2)} = $${(Math.round(itemTotal * rounded) / 100).toFixed(2)} vs site $${summary.tax}`);
check("site total = item total + tax", cents(summary.total) === itemTotal + cents(summary.tax), `$${(itemTotal / 100).toFixed(2)} + $${summary.tax} = $${((itemTotal + cents(summary.tax)) / 100).toFixed(2)} vs site $${summary.total}`);

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, checks }, null, 1));
process.exit(ok ? 0 : 1);

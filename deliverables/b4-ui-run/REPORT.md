# New team member kit: saucedemo.com order

**Status:** Order placed and confirmed ("Thank you for your order!", `checkout-complete.html`), 2026-09-30, as `standard_user`.

## What was ordered

| Need | Item | Price |
|---|---|---|
| Something to carry their gear | Sauce Labs Backpack | $29.99 |
| A light | Sauce Labs Bike Light | $9.99 |
| A top they can wear | Sauce Labs Bolt T-Shirt | $15.99 |
| **Item total (before tax)** | | **$55.97** |
| Tax | | $4.48 |
| **Total charged** | | **$60.45** |

The $60 limit applies before tax. $55.97 is $4.03 under it.

## Why these items: the whole catalog, per need

I read the full inventory (6 products) from the live store before choosing anything:

| Product | Price | Carry | Light | Wearable top for a team member |
|---|---|---|---|---|
| Sauce Labs Backpack | $29.99 | **yes (only option)** | | |
| Sauce Labs Bike Light | $9.99 | | **yes (only option)** | |
| Sauce Labs Onesie | $7.99 | | | **no.** The product copy says "infant onesie for the junior automation engineer" |
| Sauce Labs Bolt T-Shirt | $15.99 | | | yes |
| Test.allTheThings() T-Shirt (Red) | $15.99 | | | yes |
| Sauce Labs Fleece Jacket | $49.99 | | | yes |

- **Carry and light have one option each**, so the Backpack and the Bike Light are required.
- **Top:** the Onesie is cheapest at $7.99, but it's an infant garment, so an adult new hire can't wear it. I excluded it. With the Onesie the order would be $47.97, but it wouldn't meet the "a top they can wear" requirement.
- The remaining tops give these totals:
  - Bolt T-Shirt → $55.97 ✅
  - Red T-Shirt → $55.97 ✅ (same price)
  - Fleece Jacket → $89.97 ❌ (over $60)
- **Tie-break:** the two T-shirts cost exactly the same, so either one gives the same minimum order. I picked the Bolt T-Shirt. Choosing the Red T-Shirt would not change any amount.

So **$55.97 is the lowest pre-tax total** that covers all three needs with a wearable top. No valid combination is cheaper.

## Proof the amount charged is correct

The site's checkout overview (`checkout-step-two.html`), captured from the page DOM just before clicking Finish, read:

> Payment Information: SauceCard #31337 · Shipping Information: Free Pony Express Delivery! · Item total: $55.97 · Tax: $4.48 · Total: $60.45

My own calculation, done separately from the site:

1. **Item total:** 29.99 + 9.99 + 15.99 = **55.97** ✔ matches the site
2. **Tax:** 55.97 × 8% = 4.4776, rounded to the cent = **4.48** ✔ matches the site (the store's tax rate works out to 8%)
3. **Total:** 55.97 + 4.48 = **60.45** ✔ matches the site
4. **Quantities:** the cart and the overview each list 3 lines at QTY 1, no duplicates, and the cart badge showed "3 items" ✔
5. **Shipping:** free, so no extra charge beyond item total + tax ✔

The charged total of $60.45 is above $60. That's expected and allowed, because the brief sets the limit *before tax* and the pre-tax total is $55.97.

## Evidence files

The browser tool saved screenshots to `browser-adapter/exports/`. Copying them into this folder needed a shell file-write approval that this session didn't have, so they're linked in place:

- [`1790758541356.png`](../../browser-adapter/exports/1790758541356.png): inventory page with the products and prices
- [`1790758561257.png`](../../browser-adapter/exports/1790758561257.png): cart with the three chosen items
- [`1790758580852.png`](../../browser-adapter/exports/1790758580852.png): checkout overview item lines and payment info. The screenshot covers only the visible part of the page and cuts off the totals block, so the totals above are quoted from that page's DOM text, captured in the same session.
- [`1790758585895.png`](../../browser-adapter/exports/1790758585895.png): order confirmation page

## Notes

- Checkout details used: first name "New", last name "Starter", postal code 10001 (placeholder values; this is a demo store).
- The confirmation page had a "Generate PDF order" button. I didn't use it, because the overview already showed every figure needed for the proof.

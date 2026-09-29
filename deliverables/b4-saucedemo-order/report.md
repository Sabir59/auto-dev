# Order report — new team member kit (saucedemo.com)

**Status: order placed and confirmed** ("Thank you for your order!", cart empty afterwards; see `order-complete.png`). saucedemo.com is a demo store for automation testing: no real payment or delivery.

## What was ordered

| Need | Item | Price |
|---|---|---|
| Something to carry gear | Sauce Labs Backpack | $29.99 |
| A light | Sauce Labs Bike Light | $9.99 |
| A top they can wear | Sauce Labs Bolt T-Shirt | $15.99 |
| | **Item total (before tax)** | **$55.97** (budget: under $60) |
| | Tax (8%) | $4.48 |
| | **Charged total** | **$60.45** |

## Why these items
The store has 6 products (`products.json`, captured in full). The backpack is the only carrier and the bike light the only light, so those two were fixed. Four products are clothing:

- **Sauce Labs Onesie, $7.99: excluded.** It's the cheapest, but it's an *infant* onesie, which a team member can't wear. Including it would have given a $47.97 order that doesn't meet the need.
- **Bolt T-Shirt and Red T-Shirt, $15.99 each: a tie.** Nothing in the goal separates them, so the first one listed (Bolt) was taken. **Swap it for the Red T-Shirt if preferred; the price is identical.**
- Fleece Jacket, $49.99: would make the item total $89.97, over budget.

Note: the charged total ($60.45) is over $60 because of tax. The goal set the limit *before tax*, which is $55.97.

## Proof the charge is correct
`node verify.mjs` recomputes everything from the captured catalogue and the checkout summary (captured *before* pressing Finish), with no browser involved. All 9 checks pass:
- A brute-force search over every valid combination confirms this order is a cheapest one (tied with the Red T-Shirt version).
- The line prices equal the catalogue prices, and every quantity is 1.
- Item total $29.99 + $9.99 + $15.99 = $55.97, which matches the site.
- The tax the site applied is 8.00% (4.48 / 55.97 = 8.004%, i.e. 8% rounded to the cent), and $55.97 + $4.48 = $60.45, which matches the site.

The checker was also run on a copy of the summary with the Onesie ordered instead. It failed on "ordered items are a cheapest valid selection", as it should.

## Details
- Account: `standard_user` (the login page lists its accepted accounts; the other five are deliberately faulty test users).
- Checkout name/ZIP: placeholders ("New Teammember", 00000). No real personal data was entered.
- Not collected: the site's "Generate PDF order" receipt, which triggers a file download that the browser tooling can't capture. It isn't needed for the proof above.

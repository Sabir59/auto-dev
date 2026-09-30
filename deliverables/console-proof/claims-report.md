# Expense claims report

Source: expense portal at http://localhost:8790/claims, signed in as `employee`, read on 2026-09-30.

## Claims

| Reference | Date       | Merchant           | Amount (GBP) | Category        |
|-----------|------------|--------------------|-------------:|-----------------|
| EXP-1041  | 2026-09-14 | Heathrow Express   |        25.00 | Travel          |
| EXP-1042  | 2026-09-14 | Pret A Manger      |         8.45 | Meals           |
| EXP-1043  | 2026-09-15 | Premier Inn London |       112.00 | Accommodation   |
| EXP-1044  | 2026-09-16 | Uber               |        18.60 | Travel          |
| EXP-1045  | 2026-09-29 | Ryman Stationery   |        14.99 | Office supplies |
| EXP-1046  | 2026-09-29 | Costa Coffee       |         6.20 | Meals           |

**Total: £185.24 across 6 claims.**

By category: Accommodation £112.00, Travel £43.60, Office supplies £14.99, Meals £14.65.

## How the total was verified

The portal does not display a total, so it was computed twice, independently:

1. **Browser session:** signed in through the login form and read the six rows from the page's accessibility tree; summed by hand to £185.24.
2. **Separate HTTP session:** signed in again with `curl` (POST /login → 303 to /claims), saved the raw HTML, and summed the `claim-row` amounts with a script using integer pence to avoid rounding error: 6 rows, £185.24.

Both methods agree.

## Is the list complete?

Yes. Every check found the same six claims and nothing more:

- The claims page has no pagination links or "next page" controls.
- `/claims?page=2` returns the same six claims, not a second page. Its response is byte-for-byte identical to `/claims`, and so is `/claims?page=99`. The server ignores the `page` parameter, so there are no more pages. The browser also shows the same six rows at `?page=2`.
- `/api/claims` returns 404, so there is no API that could be holding claims the page doesn't show.

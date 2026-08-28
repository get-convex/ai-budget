# Adversarial audit — Worry-Free AI component

> **STATUS: both findings FIXED and re-verified live.** See "Resolution" at the
> bottom for the fix design and the after-repro transcripts.

Live-verified against deployment `wry-hedgehog-583` by firing concurrent traffic
through the real `ai.sendMessage` / `ai.summarize` actions and reading ground
truth from `listUsers` / `listRequests` / `listActions`.

Convex mutations are serializable (OCC), so every *intra-mutation* seam held.
The real defects live where a check and its enforcing write are split across
**two** mutations with a slow gateway call in between, and where every request
funnels through **one** counter document.

---

## Finding 1 — [HIGH] Spend limits are bypassable; in-flight cost is uncounted

**Mechanism.** `startRequest` checks the budget against **settled** spend
(`user.spendTodayCents`, `user.totalSpendCents`, action totals), but spend is
only written later, in a *separate* `finishRequest` mutation that runs **after**
the LLM call returns. So any number of requests that start before the first one
finishes all read the same pre-spend total and all pass. No amount of Convex OCC
helps — the two halves are different transactions.

- `src/component/lib.ts:99-108` — daily check reads `user.spendTodayCents`
- `src/component/lib.ts:109-117` — lifetime check reads `user.totalSpendCents`
- `src/component/lib.ts:122-142` — per-action budgets, same shape
- `src/component/lib.ts:190-208` — spend is only recorded here, post-gateway

**Live repro** (`daily limit 0.0002¢`, below one request's ~0.0003¢ cost, so a
correct cap admits ~1 request):

```
Firing 25 concurrent requests, daily limit 0.0002¢...
  succeeded (billed):  24
  blocked by limit:    0
  actual spendToday:   0.00834¢
  overshoot:           41.7x the limit
  ==> BUG: spend blew past the daily limit under concurrency.
```

This is not purely a concurrency bug: because the counter only moves at
`finishRequest`, even *sequential* requests fired faster than they settle
bypass the cap. This directly defeats the "worry-free spend cap" promise.

**Fix.** Make check-and-reserve atomic inside `startRequest`: add the row's
*estimated* cost to `spendToday`/totals in the same mutation that checks the
limit (a pessimistic hold), then in `finishRequest` apply the delta between
estimate and actual. Equivalently, count pending in-flight requests
(`estimate × #pending`) toward the limit at check time, and add a
max-in-flight-per-user cap. The invariant to enforce is *reserved + settled ≤
limit*, decided in one transaction.

---

## Finding 2 — [MEDIUM] Hot counter document: requests orphaned in `pending`, real spend lost, 500s to caller

**Mechanism.** Every `finishRequest` patches the **same single `users` row**
(and the same `actions` row) to bump the running totals
(`src/component/lib.ts:190-208`). Under concurrency these serialize on that one
document; with enough contenders, OCC retries are exhausted and `finishRequest`
throws. The gateway call already happened (and was billed upstream), but:

- the request row is left stuck in `status: "pending"` forever,
- its cost is never added to any total (silent under-counting of *real* money spent),
- the caller gets an uncaught `Server Error`.

**Live repro** (40 concurrent requests, one user):

```
  action returned OK: 36/40
  action threw:        4
  sample error: Uncaught Error: Documents read from or written to the
                "users" table changed while this mutation was running...
  status=pending (stuck): 1   <-- LLM ran & billed, cost never recorded, row orphaned
```

**Fix.** Split the write: patch the request's own row (unique, uncontended) in
one step so status always lands as `success`/`error`, and move the aggregate
totals to a contention-tolerant path — `@convex-dev/sharded-counter` for
spend/tokens/requests, or a scheduled reconciliation that folds finished rows
into totals. `finishRequest` must never be able to leave a row `pending`.

---

## What is genuinely right (attacked, held)

- **Rate limiting under concurrency — HELD.** 20 concurrent vs a 3/min cap →
  exactly 3 non-blocked, 17 blocked. Works *because* the counter it reads is the
  `requests` rows inserted inside `startRequest` itself, so OCC serializes the
  check-and-insert (each retry re-reads the growing set). This is the correct
  sibling of the broken Finding-1 pattern — same author, in-transaction vs
  cross-transaction.
- **Accounting integrity for recorded rows — HELD.** `totalSpendCents` exactly
  equalled `SUM(request.costCents)` (diff `0.00e+0`) after every concurrent run;
  OCC serializes the counter patches. (Finding 2 is about rows that never get
  recorded at all, not drift among recorded ones.)
- **`getOrCreateUser` / `getOrCreateAction` first-touch — HELD.** 30 concurrent
  first-touches of a brand-new user produced exactly 1 row, no `.unique()`
  poison. Convex detected the read-write conflict on the empty index range.

## Noted, not live-verified (trust boundary)

- `finishRequest` trusts caller-supplied `promptTokens`/`completionTokens`.
  Negative values yield negative cost and would *decrease* a user's spend,
  another way to stay under a cap. **Fixed** by clamping to `≥ 0`.

---

## Resolution

**Finding 1 — reserve/settle.** `startRequest` now estimates the request's cost
up front and, when the user or action has a spend cap, reserves it on that
entity's row *in the same transaction as the limit check* (`src/component/lib.ts`
`startRequest`). The check is `settled + reserved + estimate ≤ limit`, so
Convex's serializable isolation makes admission a true atomic check-and-reserve;
concurrent in-flight requests now see each other's holds. `foldOne` replaces the
reservation with the actual cost on settle. Reservations are only written on
entities that *have* a cap, so uncapped users/actions never serialize.

**Finding 2 — durable-then-fold + reconciler.** `finishRequest` now patches only
the request's own (uncontended) row and schedules `foldTotals`; the row can
never be left `pending`. `foldOne` (idempotent, guarded by `settled`) updates the
hot counters; if it loses the OCC race, the `reconcile` cron
(`src/component/crons.ts`, every minute) folds any `settled:false` rows and
releases reservations for requests that never settled (stale `pending`).

**After-repro (same attacks, `wry-hedgehog-583`):**

```
Finding 1: 25 concurrent, 0.1¢/day cap  -> 2 succeeded, 23 blocked pre-flight,
           settled spendToday 0.00063¢ (<= 0.1¢), reservations drained to 0.
Finding 2: 40 concurrent, one user      -> 0 rows stuck 'pending',
           totalSpend == SUM(rows) (diff -6.9e-18), reserved drained to 0.
Realistic: 40 concurrent, 40 users      -> 40/40 OK (no cross-user contention).
Sweep:     44 users                     -> 0 inconsistent; rate limit still 3/3.
```

Residual (by design, not a bug): a *single capped* user firing dozens of truly
simultaneous requests will have some admissions rejected under OCC contention —
correct back-pressure for a hard cap. Those reject *before* any gateway spend
and leave no orphaned state. Surfacing a cleaner "try again" error for that case
is a possible polish; hot-action *totals* under burst are eventually consistent
via the cron rather than instantly.

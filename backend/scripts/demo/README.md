# Demo dataset

A deterministic, clearly-synthetic dataset for presenting FoodShare AI, built by driving the real
HTTP API (the same routes the frontend calls) — nothing here talks to the database directly except
the one place a system-admin account has to be bootstrapped, and the final read-back checks. Every
number that appears in the UI afterward (forecasts, waste totals, financial loss, CO₂e, match
scores, effectiveness scores, ...) is computed by the real backend from these logs, not hardcoded.

**It never runs by itself.** Server startup (`npm start`/`npm run dev`), `npm run migrate` and the
test suite never call it. The only way it runs is `npm run demo:seed`, on the database your `.env`
points at — run it against your **development** database, never a shared/production one.

**It also refuses to run at all if `NODE_ENV=production`.** This is enforced in code
(`scripts/demo/productionGuard.js`), not just documented: `npm run demo:seed` checks this first,
before making any database call, so a demo dataset — including a `SYSTEM_ADMIN` account whose
password is fixed and printed in this file — can never end up in a production environment even by
accident. Unset `NODE_ENV` or set it to `development` if this really is a database you want to seed.

## Commands

Run these from `backend/`, with your dev database migrated (`npm run migrate`) and reachable:

```bash
npm run demo:seed    # loads the scenario (aborts if demo data is already present)
npm run demo:reset   # removes exactly what demo:seed created, nothing else
```

Seeding takes well under a minute. `demo:seed` refuses to run a second time without a reset in
between, so it never silently duplicates itself — run `demo:reset` first if you want to reseed
(for example, to get a fresh "today").

## What it creates

Every organization it creates is named `[DEMO] ...` and every user's email ends in
`demo.foodshareai.test` (a reserved test domain — RFC 2606 — so it can never collide with a real
address). That is the *only* thing that marks the data as a demo; nothing in the schema is
special-cased for it, and it is scoped by the platform's own organization boundaries exactly like
any other tenant. `demo:reset` finds everything to remove by that same name prefix, so it can never
touch an unrelated organization.

All demo accounts share one password: **`Demo@12345`**.

| Role | Email | Notes |
|---|---|---|
| Kitchen manager | `kitchen.manager@demo.foodshareai.test` | **Anna Sewa Community Kitchen** — the full scenario |
| Kitchen staff | `kitchen.staff@demo.foodshareai.test` | records the daily logs |
| Kitchen manager | `kitchen2.manager@demo.foodshareai.test` | **Ganga Prasad Kitchen** — a second, unrelated tenant, kept deliberately small, to show the two never see each other's data |
| NGO admin | `ngo.seva@demo.foodshareai.test` | **Seva Rescue Foundation** — verified, close by, ample capacity: the strongest match, completes a rescue |
| NGO admin | `ngo.smallcare@demo.foodshareai.test` | **Small Care Shelter** — verified, small capacity and a different food preference: ranks lower, for contrast |
| NGO admin | `ngo.newhope@demo.foodshareai.test` | **New Hope Trust** — left **pending** on purpose, so you can verify it live |
| System admin | printed by the seed script (usually `admin@demo.foodshareai.test`) | only created if `SYSTEM_ADMIN_EMAIL`/`SYSTEM_ADMIN_PASSWORD` aren't already set to a working account |

Kitchen A gets 36 days of history (today and the 35 days before it) for two dishes, engineered to
demonstrate specific signals, plus a processing batch and three calendar events:

- **Veg Thali** (servings) — the "hero" item:
  - a full weekday demand pattern (weekends lighter, midweek heavier) and natural attendance
    variation every day;
  - 3 sold-out days (kitchen ran out — an under-supply story, and the sold-out correction from the
    forecast engine's hardening);
  - **one dramatic incident 10 days ago** (planned 150, prepared 232, only 58 of the usual ~130+
    attendees showed up) — click its daily log in **Root Cause** to see the AI explain it;
  - the **3 most recent days before today** are deliberately over-prepared, so **Waste
    Attribution**'s "repeated over-preparation" pattern lights up for this item specifically;
  - **today**: a forecast is generated, a prevention recommendation is raised (planned 35% above
    the forecast → HIGH risk) and **approved**, and today's actual log shows the kitchen followed
    it — closing the loop for **Learning** and **Forecast Accuracy** with a real, positive
    effectiveness score.
- **Chapati** (pieces) — a steady, well-managed item for contrast (different unit, so **Waste
  Attribution** also shows its "mixed units" note), served at lunch and dinner. Tomorrow has a
  second recommendation that was **rejected** (10% over forecast → MEDIUM risk), left open so you
  can show a decision the AI's recommendation did *not* win.
- **Milled Rice Flour** (kg) — one processing batch (100 kg in, 85 kg out, 15 kg rejects), showing
  processing-unit waste inside the same financial/environmental impact and waste-attribution
  reports as the kitchen's own logs.
- **Calendar events** on Kitchen A: a feast in 7 days (+45%, boosts the forecast), an exam week in
  10 days (−25%), and a public holiday in 14 days (closure, forecast drops to exactly 0). Open
  **Forecast** for those dates to see the event badge and the reasoning.

Two surplus listings are posted from Kitchen A:
- one (15 kg) is **claimed by Seva Rescue Foundation, picked up and collected** — a complete
  rescue, visible in the financial/environmental impact report's "rescued" figures;
- one (10 kg) is **left Available** — claim it live during the demo, as Seva or Small Care.

## Suggested walkthrough

1. **Log in as the Kitchen A manager.** The Dashboard tells the whole Predict → Explain → Prevent
   → Rescue → Learn loop from real data.
2. **Forecast** → Veg Thali, pick the date 7 days out: the feast's effect on demand, explained.
3. **Root Cause** → the daily log from 10 days ago: what the AI thinks went wrong.
4. **Prevention**: one approved recommendation (today, followed), one rejected one (tomorrow,
   still open).
5. **Surplus**: the still-available listing — claim it live as an NGO.
6. **Log in as the System Admin** (or your own account) → **NGO Verification**: verify "New Hope
   Trust" live, in front of the audience.
7. **Forecast Accuracy** and **Learning**: the closed loop, with a real accuracy percentage and a
   real effectiveness score — not a made-up figure.
8. **Financial Impact**: estimated loss, CO₂e, and the surplus actually rescued.

## Resetting

`npm run demo:reset` deletes, in dependency order, every row that belongs to a `[DEMO] ...`
organization (and the demo system-admin account, if one was created) — daily logs, forecasts, root
causes, prevention recommendations, interventions, surplus listings and their transactions, rescue
priorities, NGO match scores, financial-impact snapshots, calendar events, notifications, menu
items, users, then the organizations themselves. Nothing outside that name prefix is ever selected,
so any real organization already in the database is untouched, and running it when there is no
demo data is a safe no-op.

## Notes and limitations

- **Dates are always relative to today**, not fixed calendar dates: forecasts must only ever use
  history strictly before their target date, so a demo built on absolute dates would eventually
  point at the past and stop demonstrating anything. Reseeding on a different day reproduces the
  same *story* (same structure, same relative outcomes), not the same absolute dates.
- Because the noise in the history is generated from a fixed random seed, the exact figures
  (totals, scores, forecast values) are the same shape every run, but small variations in *when*
  "today" falls (which weekday, how far from the demo NGOs' distances change nothing) do not
  change which signals fire — the assertions the seed script itself runs after every step confirm
  that.
- The demo NGOs are real, verified accounts with real coordinates. Like any newly onboarded NGO,
  they can appear in a nearby real kitchen's surplus feed or NGO-matching results while the demo
  data exists — that is the platform working as intended (a verified NGO is supposed to be
  discoverable), not the demo writing to that kitchen's data. `demo:reset` removes the demo NGOs
  the moment you're done.
- The seed script also creates a demo system-admin account if `SYSTEM_ADMIN_EMAIL`/
  `SYSTEM_ADMIN_PASSWORD` aren't set to a working account, purely to verify the two demo NGOs (there
  is no public endpoint for that). If you already run `npm run seed:admin`, the demo script reuses
  your real admin instead and prints nothing new to reset for it.

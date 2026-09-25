# FoodShare AI Foundation

## Project Structure
- `frontend/`: React + Vite frontend application
- `backend/`: Node.js + Express REST API
  - `src/routes/`: Express route definitions.
  - `src/controllers/`: Request handling and response formatting.
  - `src/services/`: Core deterministic business logic.
  - `src/models/`: Database interaction layer.
  - `src/middleware/`: JWT authentication, RBAC, validation, and error handling.
  - `src/validators/`: express-validator input validation chains.
  - `src/utils/`: Helper functions.
  - `src/ai/`: Isolated namespace for future AI/ML services.
- `database/migrations/`: Database schema files.

## Setup Instructions
1. Navigate to `frontend` and run `npm install`, then `npm run dev` to start the frontend.
2. Navigate to `backend` and run `npm install`.
3. Set up a PostgreSQL database and copy `.env.example` to `.env` in the repo root, filling in
   real values (`DATABASE_URL`, a generated `JWT_SECRET`, etc). Never commit `.env`.
4. From `backend/`, run `npm run migrate` to apply all migrations in `database/migrations/`.
5. (Optional) Set `SYSTEM_ADMIN_EMAIL`/`SYSTEM_ADMIN_PASSWORD` in `.env` and run
   `npm run seed:admin` to bootstrap the first `SYSTEM_ADMIN` account.
6. Run `npm run dev` in the backend to start the server.

## Authentication & Roles
- JWT-based auth (`Authorization: Bearer <token>`), passwords hashed with bcrypt.
- Roles: `KITCHEN_STAFF`, `KITCHEN_MANAGER`, `NGO_COORDINATOR`, `NGO_ADMIN`, `SYSTEM_ADMIN`.
- `POST /api/auth/register-organization` creates a brand-new kitchen or NGO plus its first
  admin user (`KITCHEN_MANAGER` or `NGO_ADMIN`). NGOs start `pending` and must be verified by
  a `SYSTEM_ADMIN` before they can view/claim the surplus feed.
- `POST /api/auth/users` (kitchen/NGO admins or system admin) creates additional staff/coordinator
  accounts. The organization is always taken from the acting admin's own account, never from the
  request body (system admins are the only ones who may target another org, and that id is
  validated against the database).
- `SYSTEM_ADMIN` accounts are not self-registrable; bootstrap one via `npm run seed:admin`.
- `POST /api/auth/login` and `POST /api/auth/register-organization` are rate limited per client IP
  (10 login attempts / 15 min and 20 registrations / hour by default — see `.env.example` and
  `backend/src/middleware/rateLimiter.js`). Exceeding the limit returns `429` with a `Retry-After`
  header. This is a simple, single-process, in-memory limiter; a horizontally-scaled deployment
  behind a load balancer would need a shared store instead.

## Communication (WhatsApp/SMS rescue notifications)
Kitchens can ask FoodShare to notify already-matched NGOs (`ai/ngoMatching.js`'s existing ranking — only
`EXCELLENT`/`GOOD` matches, capped by `RESCUE_NOTIFICATION_MAX_RECIPIENTS`) about an Available listing via
`POST /api/communications/rescue/:listingId/notify`. This is a **notification-only** feature: the message
directs the NGO back into the authenticated FoodShare app to actually claim — there is no way to claim a
listing from a chat message itself, so no separate authorization system was introduced.

- **Current state**: only a deterministic **mock** provider exists (`backend/src/integrations/communication/`).
  It never sends anything externally — it returns a fixed-shape, content-derived result so behavior is fully
  testable offline. `COMMUNICATION_ENABLED` defaults to `false`, so a fresh clone or CI run needs **zero**
  external credentials; even when set to `true`, only the mock provider runs unless a real one is added.
- The in-app notification (existing `notifications` table/UI) is always created regardless of the external
  channel's outcome — it remains the single source of truth. A provider failure or `COMMUNICATION_ENABLED=false`
  never fails the request or the underlying rescue workflow (see `services/rescueNotificationService.js`).
- **Future**: a real provider (WhatsApp Cloud API, Twilio, etc.) would implement the same
  `{ name, sendMessage({to, channel, body}) }` shape as `mockProvider.js` and be selected via
  `COMMUNICATION_PROVIDER`. Production use would additionally need: a real phone-number contact field (none
  exists today — the mock reuses the existing user email as a stand-in recipient identifier), provider API
  credentials, webhook/delivery-status handling, and a privacy/legal review before sending real messages.

## Demo Dataset (SIH presentation)
A deterministic, clearly-synthetic demo scenario — covering forecasting, root cause, prevention,
spoilage risk, surplus rescue, NGO matching, financial/environmental impact, forecast-vs-actual and
learning — can be loaded into your **development** database with `npm run demo:seed` (from
`backend/`) and removed again with `npm run demo:reset`. It never runs on its own (not at server
startup, not during migrations), and it refuses to run at all when `NODE_ENV=production`, so its
fixed demo credentials can never end up in a production environment. See
`backend/scripts/demo/README.md` for what it creates, the login credentials it prints, and a
walkthrough for presenting it.

## Running Tests
From `backend/`, run `npm test`. Tests need a real PostgreSQL database (set `TEST_DATABASE_URL`
in `.env` or `.env.test`, ideally pointing at a separate `foodshare_test` database) — the test
suite applies migrations automatically before running and truncates operational tables between
tests. AI tables (`ai_*`) are never touched by the operational layer or its tests.

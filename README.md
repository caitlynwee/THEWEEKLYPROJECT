# THE WEEKLY — Node.js 26 edition

An independent global-markets newsletter and paid article website, built with Express, EJS and **Node.js's built-in `node:sqlite`** module. No `better-sqlite3`, `connect-sqlite3`, `sqlite3`, `node-gyp`, Python, or Visual Studio C++ Build Tools are required by this project.

## Requirements

- Node.js **26.13.0** (your installed version); Node.js 24+ also supports the SQLite interface used here
- npm
- Windows PowerShell, VS Code, or another terminal

## Installation on Windows

1. Extract this ZIP into a new folder (e.g. `C:\Users\caitl\Downloads\the-weekly-platform`). If replacing a prior installation, **keep a backup of `storage/` and `.env`**.
2. Open the folder in VS Code and open a new terminal.
3. Delete the incomplete dependencies directory from the earlier failed installation:

   ```powershell
   if (Test-Path .\node_modules) { Remove-Item -Recurse -Force .\node_modules }
   ```

4. If you are upgrading in the same directory, remove an old lockfile as well so npm does not reuse the previous native-dependency resolution:

   ```powershell
   if (Test-Path .\package-lock.json) { Remove-Item .\package-lock.json }
   ```

5. Install dependencies (use `npm.cmd` if PowerShell blocks `npm.ps1`):

   ```powershell
   npm.cmd install
   ```

6. Make your environment file:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   ```

7. **Edit `.env`**: change `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `SESSION_SECRET`. The admin password must be at least 12 characters. Stripe and SMTP values may remain placeholders for local design/testing.
8. Run the site:

   ```powershell
   npm.cmd run dev
   ```

9. Visit **http://localhost:3000**. Log in with the admin credentials from `.env`; go to **http://localhost:3000/admin** for editorial controls.

**For a repeatable test:** `npm.cmd test` validates the built-in database and session-store logic. The automated test suite does not perform real Stripe transactions or send emails.

## What changed in this edition

| Earlier version | New version |
| --- | --- |
| `better-sqlite3` (native addon) | Node's bundled `node:sqlite` |
| `connect-sqlite3` (native addon via `sqlite3`) | `session-store.js`, a pure JS adapter using `node:sqlite` |
| `db.pragma('...')` | `db.exec('PRAGMA ...')` |
| SQLite data in `storage/weekly.sqlite` | **Same database file and table structure**, plus a `sessions` table |
| Sessions stored in separate `storage/sessions.sqlite` | Sessions stored in `storage/weekly.sqlite` (users may need to log in again) |

Old SQLite data should not need conversion. If replacing old project files, copy your existing `storage/weekly.sqlite` to `storage/` in this project **while both apps are stopped**. Keep backup copies of the `.sqlite`, `-wal`, and `-shm` files if present; preferable backup is made while the old server is stopped.

## Website features

- **Public pages:** landing page, article archive, category filters, individual articles, about page, membership pricing.
- **Preview paywall:** only public excerpts are sent to visitors; the full Markdown body is rendered only for active/trialing subscribers or administrators.
- **Accounts:** reader registration and sign-in using hashed passwords; server-side session cookies; email preferences.
- **Stripe Billing:** monthly/annual Checkout, signed webhooks for billing state, Customer Portal, recurring subscription invoices. Stripe Tax can be enabled after configuration.
- **Admin:** article draft/edit/publish/delete; subscriber list; campaign drafting/sending/delivery attempt history.
- **Weekly email:** manual send or optional Monday scheduler, requires your SMTP credentials.

## Stripe (test mode first)

1. Create a product named **THE WEEKLY Membership** in your Stripe sandbox and two recurring Prices (monthly and yearly). Copy the `price_...` IDs into `STRIPE_MONTHLY_PRICE_ID` and `STRIPE_ANNUAL_PRICE_ID`.
2. Copy your **test** secret API key (`sk_test_...`) to `STRIPE_SECRET_KEY`. Never put Stripe keys into browser scripts or commit `.env`.
3. Configure Billing's **Customer Portal**: change payment method, view invoice history, cancel at period end; optionally change plan.
4. Install Stripe CLI, authenticate, then forward signed events locally:

   ```powershell
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```

5. Set `STRIPE_WEBHOOK_SECRET` to the CLI's `whsec_...` signing secret and restart the site.
6. Test checkout with Stripe **test cards**. Access changes only after the server receives and validates Stripe's signed webhook—not simply after visiting a success URL.
7. When deployed, register `https://YOUR-DOMAIN/webhooks/stripe` and use the new webhook destination's secret. Listen for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
8. Configure appropriate digital-content **Stripe Tax product classification** and any applicable jurisdiction registrations before setting `ENABLE_STRIPE_TAX=true`. This app does not file taxes or create standalone invoices; Stripe Billing creates subscription invoices automatically.

## Weekly newsletters

Set your verified SMTP sender and credentials in `.env`:

```env
SMTP_HOST=smtp.your-email-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-username
SMTP_PASS=your-password
EMAIL_FROM="THE WEEKLY <newsletter@yourdomain.com>"
```

In **Admin → Newsletters**, create a draft campaign linked to a published article, then click **Send now** to email opted-in paying subscribers. The delivery table reports mail-provider acceptance/errors, *not* guaranteed inbox delivery.

To automatically send the oldest ready draft every Monday at 9am Singapore time:

```env
ENABLE_SCHEDULED_SEND=true
NEWSLETTER_CRON=0 9 * * 1
NEWSLETTER_TIMEZONE=Asia/Singapore
```

The scheduler should run in only **one app instance**. Use a job queue, provider webhooks, verified sender domain, SPF/DKIM/DMARC and unsubscribe handling for production at scale.

## Files

```text
the-weekly-platform/
├── server.js            # Express pages, accounts, Stripe, admin routes
├── db.js                # node:sqlite database schema and connection
├── session-store.js     # Express sessions stored via built-in SQLite
├── seed.js              # Initial administrator and example articles
├── tests/
│   └── database.test.js # Database and session smoke tests
├── views/               # EJS page templates
├── public/              # Responsive styles and admin script
├── .env.example         # Copy to .env and configure (never commit .env)
└── package.json
```

## Security and production limitations

The starter includes password hashing, signed session cookies backed by SQLite, HttpOnly/SameSite cookies, CSRF protection on form requests, auth rate limiting, safe database parameters, Markdown sanitisation, admin authorisation and verified Stripe webhook signatures.

**Not yet production-ready:** implement verified email, password-reset flow, subscription reconciliation after missed webhooks, hardened billing-event handling, payment/dispute recovery logic, abuse controls, email unsubscribe links usable without login, privacy/terms policies, production logging, backup/restore plans, monitoring and more comprehensive tests. SQLite's synchronous APIs suit a small single-instance starter; consider managed Postgres + a background task queue for production scale.

The four demo articles are placeholders, not financial advice or copied articles. The displayed subscription prices are examples until real Stripe Prices are configured. No live payment or email sending occurs without separate integration configuration.

# Ledger

A self-hosted accounting workspace: dashboard, cash-flow chart, spending
breakdown, searchable transactions, CSV import from bank exports, CSV
export, and JSON backups.

This is the **MVP build**. Invoices, budgets, a reports page, and Jalali
(Persian calendar) CSV support are not in this version yet — see "What's
not built yet" below.

## Requirements

Node.js 24 or later. No packages or build step are required.

## Run it

```
npm start
```

Then open http://localhost:3000.

On Windows PowerShell, use `npm.cmd start` if PowerShell blocks `npm.ps1`.

## First administrator and users

1. Start the server and open the app. The first visit shows **Create your
   administrator**.
2. On the server computer, open `.data/setup-code.txt`. Paste its one-time
   code into the setup form and choose your name, email, and password (at
   least 12 characters). The code is never served through the website and
   stops working after setup.
3. Open **Settings → Users and access → Create user** to add more people.
   Choose a member or administrator role and a temporary password of at
   least 12 characters. Share the login address, email, and temporary
   password with them privately — the app does not send emails. They
   should change their password in Settings on first login.

Every user has their own separate transactions, currency, and opening
balance. Administrators manage users and reset passwords; disabling a
user, resetting their password, or a user changing their own password
revokes that user's other active sessions.

## Data storage

The server stores accounts and records in `.data/ledger.sqlite`. Session
tokens use HTTP-only cookies; passwords are stored as salted scrypt
hashes. The database is **not encrypted at rest** — anyone with access to
the server machine can read it, so protect `.data/` accordingly.

Concurrent edits are checked by a per-workspace version number: if another
device saved first, the app asks you to reload before retrying.

For a full backup, stop the server, copy the entire `.data` directory
somewhere protected, then restart. That directory contains account
credentials and sessions as well as everyone's records.

## Importing bank transactions (CSV)

Go to **Import CSV**:

1. Upload a CSV or TSV file (5 MB / 10,000 row limit) and choose its
   encoding (UTF-8, Windows-1256, or UTF-16).
2. Map your file's columns to price, recipient, date, and
   description/reason (all required), plus optional time, tracking code,
   bank, and category columns. If your file has no bank column, enter a
   default bank. Choose how transaction type is determined (a column, all
   expenses, all income, or signed amounts), the number format
   (`1,234.56` vs `1.234,56`), and the date order — day/month order is
   never guessed.
3. Review the validation report. **Invalid rows block the entire
   import** — fix your file or the mapping and re-upload. Nothing is
   written to your books at this stage.
4. Click **Import transactions** to save. Exact duplicate rows are
   skipped automatically. Reusing a bank + tracking code with different
   transaction details on other rows blocks those rows — download the
   full validation report if you need to check every row (the on-screen
   preview only shows the first 100).

CSV dates in this MVP are **Gregorian only**. Jalali/Persian dates are
planned for a follow-up.

## Backups

**Settings → Backups** lets you export your transactions as CSV, export a
full JSON backup, or restore a JSON backup. Restoring requires empty
books — export a backup and clear your books first if you need to
replace existing data.

## Domain / HTTPS setup

For local-only use, leave `PUBLIC_ORIGIN` empty in `.env` (or don't
create a `.env` at all).

To run behind a domain or tunnel:

1. Copy `.env.example` to `.env` and set:
   ```
   PORT=3000
   PUBLIC_ORIGIN=https://accounts.your-domain.com
   LEDGER_DATA_DIR=.data
   ```
   `PUBLIC_ORIGIN` must be your exact HTTPS address, with no path.
2. Restart with `npm start` (or `npm.cmd start`). `.env` is only read by
   the `npm start`/`npm run dev` launcher — running `node server.js`
   directly uses only environment variables already set in the shell.
3. Point your tunnel or reverse proxy at `http://127.0.0.1:3000`,
   forwarding cookies and the request `Origin` header. The server binds
   to loopback only, so the tunnel agent must run on the same machine.
   The proxy must actually terminate HTTPS — forwarded headers alone
   don't satisfy this.

When `PUBLIC_ORIGIN` is set, the app only accepts requests through that
exact HTTPS address, session cookies are marked `Secure`, and existing
local-development sessions must sign in again.

Sign-in attempts are rate limited (5 attempts per 15 minutes, then a
15-minute lockout), sessions expire after 12 hours, and all mutating API
requests require a valid CSRF token in addition to the session cookie.

## Inspecting the database

The database is plain SQLite at `.data/ledger.sqlite` (or
`ledger.sqlite` inside your `LEDGER_DATA_DIR`, if set). You can open it
with any SQLite client, such as Beekeeper Studio — no host, port, or
database password is needed; your app login password is unrelated to
this file connection. Select `ledger.sqlite` itself, not the adjacent
`-wal`/`-shm` files.

| Table | Contents |
|---|---|
| `users` | Account id, name, email, role, disabled flag, password hash, must-change-password flag. |
| `workspaces` | One row per user. The `data` column stores transactions, currency, and opening balance as JSON. `version` guards against outdated saves. |
| `sessions` | Session id hashes, CSRF tokens, expiry times. |
| `attempts` | Sign-in rate-limit counters. |

Stop the server and back up `.data` before editing the database directly.
Creating users, resetting passwords, and disabling access through the app
is preferred, since those actions also maintain session records
correctly.

## What's not built yet

This MVP intentionally leaves out, for a follow-up pass:

- Invoices (and marking them paid)
- Monthly budgets
- A dedicated reports page
- Persian/Jalali calendar support in CSV import
- Persian-language column headers in CSV import
- Transfer of old browser-only records into a server account
- `npm test` / `npm run check` automated test suites

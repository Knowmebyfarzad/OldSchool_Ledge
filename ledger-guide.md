# Ledger — Getting Started Guide

Ledger is your accounting workspace: a dashboard, transactions, CSV
import from your bank, and backups — all running on your own computer
or server. This guide walks through using it, step by step.

---

## 1. Starting the app

1. Open a terminal in the Ledger folder.
2. Run:
   ```
   npm start
   ```
   (On Windows, if PowerShell blocks this, use `npm.cmd start` instead.)
3. Open your browser to **http://localhost:3000**.

Leave the terminal window open — closing it stops the app.

---

## 2. Creating the first administrator

The very first time you open the app, you'll see **Create your
administrator**.

1. On the computer running the server, open the file
   `.data/setup-code.txt` in a text editor.
2. Copy the code and paste it into the **Setup code** field.
3. Fill in your name, email, and a password (at least 12 characters).
4. Click **Create administrator**.

That's it — you're signed in. The setup code stops working once this
is done, so you won't need it again.

---

## 3. Adding other people

Only an administrator can add users.

1. Go to **Settings → Users and access**.
2. Fill in the new person's name, email, role (**Member** or
   **Administrator**), and a temporary password (12+ characters).
3. Click **Create user**.
4. Privately share the app's web address, their email, and the
   temporary password with them. Ledger does not send emails on your
   behalf.
5. Ask them to sign in and set their own password right away, before
   entering any real numbers.

Each person's transactions, currency, and balance are completely
separate — nobody can see another person's books.

**Managing existing users:** from the same screen, an administrator can
disable a user's access, re-enable it, or reset a forgotten password
(this generates a new temporary password to share privately). Any of
these actions immediately signs the affected user out everywhere.

---

## 4. Finding your way around

The left-hand menu has four sections:

- **Dashboard** — your cash balance, this month's income and expenses,
  a cash-flow chart, and a breakdown of spending by category.
- **Transactions** — every recorded transaction, searchable and
  filterable by date or category. Add, edit, or delete entries here.
- **Import CSV** — bring in transactions from a bank export file.
- **Settings** — your account, users (administrators only), currency
  and opening balance, and backups.

---

## 5. Adding a transaction by hand

1. Go to **Transactions** and click **Add transaction**.
2. Choose **Expense** or **Income**, enter the amount, date, recipient,
   bank, and (optionally) a description and category.
3. Click **Add transaction**.

To change or remove one later, use **Edit** or **Delete** next to it in
the list.

---

## 6. Importing transactions from your bank

Go to **Import CSV** and follow the four steps on screen:

**Step 1 — Upload**
Choose your bank's CSV or TSV export (up to 5 MB, 10,000 rows) and
select its text encoding. UTF-8 works for most files; use Windows-1256
or UTF-16 if your bank export looks garbled otherwise.

**Step 2 — Map columns**
Tell Ledger which column in your file is which: amount, recipient,
date, and description are required. Bank, category, time, and a
tracking code are optional. Also choose:
- how the file marks income vs. expense (a column, all one type, or
  positive/negative amounts),
- the number format (`1,234.56` or `1.234,56`),
- the date order (year-month-day, day-month-year, or month-day-year).

**Step 3 — Review**
Ledger checks every row. If anything's wrong, **nothing is imported**
— you'll see the errors and can download a full report, fix the file
or your column choices, and try again. If everything looks good,
you'll see how many rows will be added (duplicates already in your
books are skipped automatically).

**Step 4 — Import**
Click **Import transactions** to save them to your books.

---

## 7. Backing up your data

Go to **Settings → Backups**:

- **Export CSV** — a spreadsheet-friendly copy of your transactions.
- **Export JSON backup** — a complete copy you can restore later. Keep
  this somewhere safe, especially before clearing your books.
- **Restore JSON backup** — brings a backup back in. This only works
  if your books are currently empty.

For a backup of the *entire server* (all users, not just yours), an
administrator should stop the app, copy the whole `.data` folder to
somewhere safe, then restart the app. That copy contains everyone's
login details as well as their records, so keep it protected.

---

## 8. Changing your currency or clearing your books

In **Settings → Workspace**, you can set your opening balance any time.
Currency can only be changed while your books are empty — export a
backup, clear your books, then set the new currency before importing
or re-entering anything.

**Clear books** permanently removes all of your transactions. Always
export a backup first.

---

## 9. If something goes wrong

- **"Records changed elsewhere. Reload and try again."** — you (or
  someone else signed into the same account on another device) saved
  changes since this page loaded. Refresh and redo your last action.
- **Forgot your password?** Ask an administrator to reset it for you
  in Settings → Users and access. There's no email-based recovery.
- **A CSV import is blocked** — download the validation report from
  the review step to see exactly which rows failed and why.

---

## 10. Running on a real domain (advanced)

If you want to reach Ledger from somewhere other than your own
computer, see the "Domain / HTTPS setup" section of the project's
README — it covers configuring `PUBLIC_ORIGIN` and connecting a tunnel
or reverse proxy safely.

# Rishta Connect Global: backend with Moyasar payments

Node 18+ server that adds real Google and Apple sign-in, profile storage, Moyasar checkout, a verified webhook, refunds and an admin API. Put the website's `index.html` in a `public/` folder and it is served from the same origin (needed for the secure session cookie).

## Setup

```bash
npm install
cp .env.example .env      # fill in every value
npm start
```

1. **Moyasar keys:** in the Moyasar dashboard open Settings > API keys. **Use the test pair first** (`pk_test_…` and `sk_test_…`).
2. **Webhook:** in the dashboard create a webhook pointing to `BASE_URL/api/moyasar/webhook`, tick the payment events (at least `payment_paid`, `payment_refunded` and the failed event), and enter the same random value you put in `MOYASAR_WEBHOOK_SECRET` as its secret token. The webhook is essential: it activates a member whose browser closed before returning to the site.
3. **Google:** create an OAuth Web client ID and add your site URL to Authorized JavaScript origins.
4. **HTTPS:** `BASE_URL` must be a public https address, because Moyasar calls it. For local testing use a tunnel (ngrok, Cloudflare Tunnel). A live publishable key also requires the page to be served over SSL.
5. **Admins:** list your Google email in `ADMIN_EMAILS`.

## Keeping the secret key secret

- `MOYASAR_PUBLISHABLE_KEY` may reach the browser. `MOYASAR_SECRET_KEY` and `MOYASAR_WEBHOOK_SECRET` live only in `.env` on the server (`chmod 600 .env`) or in your host's secret manager. `.env` is in `.gitignore`; never commit it.
- Never paste the secret key into chat, email, a screenshot or a support ticket. If it ever appears anywhere, roll it in the Moyasar dashboard immediately and update `.env`.
- The server refuses to start if the two keys are missing, malformed, or from different modes, and prints a warning while running with test keys. It never logs keys or request headers.
- The browser only ever receives the publishable key, the amount to charge, and a payment reference. The secret key is used only for server-to-server calls to `api.moyasar.com`.

## How a payment works

1. The browser calls `POST /api/checkout {plan}`. The server looks up the price itself, stores a `pending` payment, and returns the amount in halalas, the publishable key and a return address.
2. The page loads Moyasar's card form (`cdn.moyasar.com`). The card is typed into Moyasar's form and sent straight to Moyasar (including 3-D Secure), so card numbers never touch your server.
3. Moyasar sends the customer to `/payment/return/<our payment id>?id=<Moyasar payment id>`. The server **does not trust that redirect**: it fetches the payment from Moyasar with the secret key and checks that the status is `paid`, the amount and currency match what it recorded, and the payment belongs to that checkout. Only then does it activate the membership.
4. The webhook does the same check independently (it uses only the payment id from the body and re-fetches the payment), so a closed browser or a lost redirect still activates the member. The shared secret token is compared in constant time, duplicate events are ignored, and a non-2xx reply makes Moyasar retry.
5. A payment whose amount does not match (for example, someone edited the amount in their browser) is never activated and is logged. Because it is not recorded as paid, refund it from the Moyasar dashboard.
6. Admin refund: `POST /api/admin/payments/:id/refund {reason}` claims the payment atomically (no double refund), calls Moyasar's refund endpoint with the secret key for the full amount, confirms Moyasar reports `refunded`, then shortens the membership and writes the audit log. The refund webhook is handled the same safe way. Moyasar suggests a void instead of a refund for payments in roughly their first two hours; this server always refunds.

## Test mode first, then live

**Yes, test first.** With `pk_test_`/`sk_test_` keys no real money moves and the site shows a "Test mode" notice on the payment screen. Moyasar's test cards (any future expiry, any CVC, a name of at least two words):

| Card | Number |
|---|---|
| Mada, paid | 4201 3201 1111 1010 |
| Visa, paid | 4111 1111 1111 1111 |
| Mastercard, paid | 5421 0801 0100 0000 |
| Visa 3-D Secure, paid | 4111 1140 0576 5430 |
| Visa, fails | 4123 1200 0000 0000 |
| Visa 3-D Secure, rejected | 4111 1157 8422 8433 |

Test these before switching: successful payment (profile turns Active, alert arrives); declined card (nothing activates, "not completed" page); 3-D Secure success and failure; closing the browser right after paying (the webhook must still activate); the webhook arriving twice; changing the amount in the browser (must not activate); admin refund, and refunding the same payment twice.

**Going live checklist**
1. Everything above passes with test keys.
2. In the Moyasar dashboard your account is activated for live payments.
3. Create the webhook again for live mode (live and test are separate) with a new secret.
4. Replace the three Moyasar values in `.env` with the live ones (`pk_live_`, `sk_live_`, new webhook secret), keep `NODE_ENV=production`, and restart.
5. Make one small real payment with your own card and refund it from the admin panel.

## Please verify

I could not run this against a live Moyasar account, and the server itself has not been started in my sandbox. Moyasar's documentation did not state how the webhook `secret_token` is meant to be checked; the server compares it with your `MOYASAR_WEBHOOK_SECRET` and, because every webhook is re-verified by fetching the payment, a wrong guess cannot activate anyone. Confirm in sandbox that webhooks arrive and are accepted (watch the server log). The form is loaded from `cdn.moyasar.com/mpf/1.15.0`; check Moyasar's docs now and then for a newer version. The Content-Security-Policy allows `*.moyasar.com`; once everything works you can tighten it to the exact hosts you see in the browser's network tab.

## Not included

- **Chat, brokers and member moderation:** chat has no end-to-end encryption and no push notifications, and brokers have no reviews or ratings yet.
- **Production hardening:** move the inline script out of the HTML and drop `'unsafe-inline'` from the CSP, use Postgres instead of SQLite if you run more than one server, add backups, and set up email receipts.
- **Tax:** Saudi VAT and e-invoicing rules are for your accountant to confirm.

## Website and verification endpoints

`public/index.html` is the website wired to this server. Open `BASE_URL` after `npm start`; do not open the file directly, because the session cookie and `/api` calls only work from the same origin.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/config` | anyone | public Google client id |
| `GET /api/members?g=&c=&lo=&hi=` | members with an active membership | search profiles (403 until payment is confirmed) |
| `GET /api/admin/verification` | admin | every member with a profile and their three checks |
| `POST /api/admin/verification/:email/check` `{check, value}` | admin | set one check: `identity`, `photo` or `background` |
| `POST /api/admin/verification/:email/approve` | admin | pass all three checks |
| `POST /api/admin/verification/:email/revoke` `{reason}` | admin | clear all checks; the member returns to the queue |

A member is "Verified" only when all three checks pass. New profiles enter the queue automatically, every admin action is written to the `audit` table, and members only ever see an opaque id for each other, never an email address.

Test order: sign in with Google, save a profile, pay with a Moyasar test card, confirm the profile turns Active and search unlocks, then sign in as an admin to work the queue and issue a refund.

## Member suspension and approval

Each member is `approved` (the default), `pending` or `suspended`.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/admin/members` | admin | members with status, reason and membership state |
| `POST /api/admin/members/:email/suspend` `{reason}` | admin | suspend; a reason is required |
| `POST /api/admin/members/:email/approve` | admin | admit a pending member or reinstate a suspended one |

- **Suspended:** the member is hidden from search and every API call except `/api/me` returns 403, so the site can show them a notice. Paid time is kept, so reinstating restores access. Admin accounts cannot be suspended.
- **Pending:** only if `REQUIRE_APPROVAL=true`. New profiles are hidden from search until approved; they can still sign in and pay.
- **Payments:** a webhook for a suspended member is still recorded, and admins can still refund it.
- Every action is written to the `audit` table.

## Broker accounts and chat

**Brokers.** Any signed-in user can apply at `/api/broker/apply`. Nobody is listed or shown as Verified until an admin approves. The public list (`GET /api/brokers`) returns only approved brokers and never their emails.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/broker/apply` | signed-in user | submit or resubmit an application (name, city, experience, languages, specialization, about) |
| `GET /api/brokers` | anyone | approved brokers |
| `GET /api/admin/brokers` | admin | all applications with status and reason |
| `POST /api/admin/brokers/:email/approve` | admin | approve, or reinstate a suspended broker |
| `POST /api/admin/brokers/:email/reject` `{reason}` | admin | reject a pending application |
| `POST /api/admin/brokers/:email/suspend` `{reason}` | admin | suspend an approved broker |

**Chat.** Conversations and messages are stored on the server and the browser polls every 4 seconds while a chat is open.

| Endpoint | Purpose |
|---|---|
| `GET /api/chats` | your conversations with last message and unread count |
| `POST /api/chats` `{to, body}` | start a conversation with a first message |
| `GET /api/chats/:id?after=` | messages (participants only; marks them read) |
| `POST /api/chats/:id/messages` `{body}` | reply |

Rules enforced on the server for every send: a client can message an approved broker once they have a profile (free). A broker can only reply, never start a conversation. Member-to-member messaging needs both people to have an approved profile and an active paid membership. Suspended members and brokers can neither send nor receive. Messages are capped at 1,000 characters and 20 sends per minute, and only the two participants can read a conversation. Messaging uses opaque ids, so no one learns another member's email.

Before launch, add a retention policy and privacy notice for stored messages, and consider WebSockets or push notifications instead of polling.

## Block and report

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/blocks` `{user}` | signed-in user | block a member or broker |
| `POST /api/blocks/remove` `{user}` | signed-in user | unblock |
| `GET /api/blocks` | signed-in user | people you have blocked |
| `POST /api/reports` `{user, category, details, block}` | signed-in user | report a member; categories are `harassment`, `scam`, `fake`, `inappropriate`, `other` |
| `GET /api/admin/reports` | admin | open reports plus the 20 most recently resolved |
| `POST /api/admin/reports/:id/resolve` `{outcome, note}` | admin | `dismiss` or `suspend`, with a required note |

- **Blocking** works in both directions. Neither person can message the other or see the other in search. The blocked person gets the same "unavailable" message as for any unavailable member, so they are not told they were blocked. The blocker's conversation is hidden from their Messages list and they can unblock from there.
- **Reports** store a snapshot of the last 20 messages of the conversation with the reporter's consent, so the evidence stays even if messages continue. One open report per reporter and member, and 10 reports per hour per account. The reported member is never told who reported them.
- **Admin review queue:** each report shows the category, details, snapshot, how many reports the member has had in total, and their current status. Dismissing or suspending needs a note. Suspending also suspends the member's broker account if they have one, and admin accounts cannot be suspended. Every resolution is written to the `audit` table.
- **Where you can report:** from a chat, from a member's card in search results, and from a broker's profile page. Each report records where it came from (`source`: `chat`, `search` or `broker`) and the admin queue shows it. Only reports made from a chat carry a message snapshot, and only if the two people have actually exchanged messages.
- **Outcomes:** a report can be dismissed, answered with a warning, or answered with a suspension. See the next sections for what each one does.

## Audit log

`GET /api/admin/audit?action=&admin=&q=&before=&limit=` (admin only) returns entries newest first, plus the list of action types for the filter menu and a `more` flag for paging with `before`. `q` searches the target and the reason as plain text. The admin panel shows it at the bottom with an action filter, a search box and Load more.

The log records refunds, verification changes, member suspensions and approvals, broker decisions and report resolutions, each with the admin's email, the target and the reason. SQLite triggers reject any `UPDATE` or `DELETE` on the `audit` table, so the app cannot alter past entries. Someone with direct access to the database file still can, so back it up and restrict server access. Viewing the log is not itself logged, but every CSV export is (action `export-audit-log`, with the filters used and the number of entries).

### CSV export

`GET /api/admin/audit/export?action=&admin=&q=` (admin only) downloads the matching entries as `audit-log-YYYY-MM-DD.csv` with the columns `id, time, admin, action, target, reason`, newest first. The panel's **Export CSV** button sends the filters you last applied with **Filter**.

- The file starts with a UTF-8 byte-order mark so Excel shows Arabic and Urdu names correctly. Times are ISO 8601 in UTC.
- Cells that begin with `=`, `+`, `-` or `@` get a leading apostrophe so a hostile reason text cannot run as a spreadsheet formula. This is the one place the exported text differs from the stored text.
- Exports are capped at the newest 50,000 entries. When the cap applies the response carries `X-Truncated: true` and the panel tells you to narrow the filters.
- The file contains admin and member email addresses. Treat it as personal data: store it securely and delete it when you no longer need it.

## Sign in with Apple

Optional: if `APPLE_CLIENT_ID` is blank the button is shown as not configured. Sign in with Apple needs an Apple Developer Program membership.

**Apple setup**
1. In Certificates, Identifiers & Profiles, create an **App ID** with the Sign in with Apple capability.
2. Create a **Services ID** (for example `com.yourcompany.rishta.web`) and enable Sign in with Apple on it. This identifier is `APPLE_CLIENT_ID`.
3. Under its web configuration add your domain and a Return URL of `https://your-domain.com/auth/apple/callback`. This must match `APPLE_REDIRECT_URI` exactly. Apple requires https and does not accept `localhost`, so test through a tunnel on a real https domain. Apple's console may also ask you to verify the domain.
4. Run `npm install` (adds `jose`) and restart.

**How it works.** The page asks the server for a one-time nonce, opens Apple's sign-in popup, and sends Apple's signed identity token to `POST /api/auth/apple`. The server checks the signature against Apple's published keys, the issuer, that the audience is your Services ID, that the token has not expired, and that the nonce matches the one it issued to that browser. Because only the token is verified, no Apple private key or client secret is needed.

**Accounts**
- A returning member is found by Apple's stable user id, so it still works if Apple later stops sending the email.
- If the verified Apple email matches an existing member (for example one who used Google), the Apple login is linked to that account. A new member with an unmatched email gets a new account.
- If a member chooses Apple's **Hide My Email**, the site receives a private relay address that differs from their Google email, so the same person can end up with two accounts. To email these members you must register your sending domain with Apple's private email relay service.
- Apple sends the name only the first time, and the browser passes it along; it is only used when the account has no name yet.

**Please check:** I could not test against a live Apple account. Confirm the nonce handling in sandbox (the server accepts the plain nonce or its SHA-256, since sources differ), and consider swapping the plain black button for Apple's official button artwork to follow their brand guidelines.

## Notifications, warnings and appeals

**Alerts (in-app notifications).** Members see an **Alerts** tab with an unread count that refreshes every minute. There is no email or push yet, so a member only learns of a decision when they next open the site.

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/notifications`, `POST /api/notifications/read` | signed in | list the latest 50 and mark them read |
| `GET /api/warnings`, `POST /api/warnings/:id/ack` | signed in | active warnings, and "I understand" |
| `POST /api/appeals` `{kind, ref, message}` | signed in | appeal a `suspension`, a `warning` (with `ref` = warning id) or a `broker` suspension |
| `GET /api/appeals` | signed in | your own appeals and the reviewer's notes |
| `GET /api/admin/appeals` | admin | open appeals and the 20 most recently decided |
| `POST /api/admin/appeals/:id/decide` `{decision, note}` | admin | `overturn` or `uphold`; the note is shown to the member |

**What people are told**
- **The reporter** gets a notification when their report is resolved: either "no violation found" or "we took action". They are never told which action, and never anything about the other person.
- **A warned member** gets a banner until they tap "I understand", a notification, and the warning stays listed under Alerts. The wording is fixed per report category, so a member never sees an admin's private note or who reported them. Repeated warnings are counted in the admin report card so you can decide on a suspension; nothing is suspended automatically.
- **A suspended member** can still sign in, but every other part of the API is blocked. They see a banner with an **Appeal** button, and can read Alerts and their appeals.
- Admins are notified when an appeal arrives. Member and broker approvals, reinstatements, broker decisions and suspensions also send a notification.

**Appeals rules, enforced on the server**
- The explanation must be at least 20 characters.
- One open appeal per decision, and after a decision the same decision can be appealed again only after 30 days. 5 appeals per hour per account.
- **A different admin must decide.** If you made the original decision you cannot decide its appeal, as long as there is more than one admin. With a single admin this safeguard cannot apply, so consider adding a second admin to `ADMIN_EMAILS`.
- Overturning a suspension reinstates the member, overturning a warning withdraws it, and overturning a broker suspension re-approves the broker. A report that suspended someone who is also a broker produces two suspensions, and each is appealed and decided separately.
- Every decision is written to the audit log.
- Not built: email or push alerts, and an appeal for a rejected broker application (they can simply apply again).

## Scheduled backups

Turn on with `BACKUP_ENABLED=true` and a `BACKUP_KEY` in `.env` (see `.env.example`). The server then backs up once a day at `BACKUP_AT` (UTC; the default 00:30 is 03:30 in Riyadh). If the server was off at that time, it backs up when it next starts that day, and a failed run is retried hourly.

Each run:
1. Takes a consistent snapshot of the database with SQLite's online backup, so the site keeps working.
2. Runs SQLite's integrity check on the snapshot.
3. Exports the whole audit log to CSV from the same snapshot.
4. Compresses and encrypts both files with AES-256-GCM into `backups/rishta-<time>.db.gz.enc` and `backups/audit-<time>.csv.gz.enc`.
5. **Decrypts the database copy again and compares it with the snapshot**, so a backup is only recorded as successful if it really restores.
6. Copies both files to `BACKUP_COPY_DIR` if set, and deletes sets older than the newest `BACKUP_KEEP` (default 14).

The admin panel has a **Backups** section with the schedule, the last ten runs, a warning when there has been no success for 36 hours, and a **Back up now** button (recorded in the audit log). Backups are never downloadable through the website, because they contain every member's data. `npm run backup` runs one backup from the command line, which also works from the system cron if you prefer that to the built-in schedule.

**The key.** `BACKUP_KEY` is the only way to open a backup, and it cannot be recovered if lost. Store a copy somewhere separate from the server, such as a password manager. Rotating it means older backups still need the old key.

**Off the server.** A backup on the same disk does not survive losing the server. Point `BACKUP_COPY_DIR` at a mounted drive or sync folder, or copy the `backups/` folder off the machine on a schedule, for example with `rclone` to cloud storage (the files are already encrypted, so any storage provider is fine).

**Restore**
```bash
# 1. stop the server
BACKUP_KEY=<your key> node decrypt-backup.js backups/rishta-20261028-003005.db.gz.enc restored.db
# 2. replace the live database (also remove the -wal and -shm files next to it)
mv rishta.db rishta.db.old && rm -f rishta.db-wal rishta.db-shm && mv restored.db rishta.db
# 3. start the server
```
The same script opens the audit CSV (`... audit-<time>.csv.gz.enc audit.csv`). A wrong key or a damaged file is refused and no partial output is left behind. **Practise a restore on a spare machine once before you need it.** The backup files include the personal data of every member, so treat them, the key and any copies as sensitive.

Backup covers the database only. The `.env` file (with your keys) is not in it, so keep that safe separately.

## Automatic activation after payment

Activation is automatic. When Moyasar confirms a payment (the return page or the webhook, each re-checked by fetching the payment from Moyasar), the server in one database transaction marks the payment paid, starts or extends the membership, and sends the member an "active" notification. The site's payment page polls and shows "Payment confirmed" as soon as that has happened, normally within seconds. Nobody has to approve anything.

- **New profiles are approved by default**, so a paid member appears in search immediately. If you set `REQUIRE_APPROVAL=true`, new profiles start as pending, and a confirmed payment approves them too (`AUTO_APPROVE_ON_PAYMENT=true`, the default). The audit log records this as `auto-approve-on-payment` by `system`. Set `AUTO_APPROVE_ON_PAYMENT=false` to make pending members wait for an admin even after paying.
- **Suspended members stay suspended** when they pay; payment never overrides a moderation decision.
- **Verification is separate.** Activation does not mean verified: a paid member shows as Unverified in search until an admin passes the identity, photo and background checks.
- **Refunds** shorten the membership and take effect immediately; the member's status is not changed.
- If a payment is declined, abandoned, or the amount or currency does not match, nothing is activated.

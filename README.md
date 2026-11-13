# Rishta Connect Global

A free, informational matrimonial website. Members register for free, create a profile, and once an admin approves it they can search, shortlist, message each other and contact brokers. **The site takes no payments and holds no financial data.**

What is included: Google sign-in; profile and photo (hidden by default, cleaned of hidden data); search with filters; shortlist; chat (block and report); verified brokers with ratings and reviews; an admin panel (verification, member approval, reports, appeals, audit log with CSV export, encrypted backups); English, Urdu and Arabic with right-to-left layout; Terms, Privacy, Safety and Contact pages.

## Setup
1. Node 20 or newer. `npm install`.
2. `cp .env.example .env` and fill it in (`JWT_SECRET`, `GOOGLE_CLIENT_ID`, `BASE_URL`, `ADMIN_EMAILS`). `npm run check-env` explains any mistake in plain words.
3. `npm start`. Run the automatic tests with `npm test`.

Google sign-in setup is in `SIGNIN.md`. Putting the site online is in `DEPLOY.md`. A free setup on Render with Supabase storage uses the `PERSIST_*` settings in `.env.example` (see `persist.js`).

## How access works
- Anyone can register with Google and save a profile. It is free.
- With `REQUIRE_APPROVAL=true` (recommended) a new profile stays hidden until an admin approves it in the Admin panel. With `false` it is live straight away.
- An approved member can search, view profiles, shortlist and message other approved members. There is no request-and-accept step for chat: the first message opens it.
- A signed-in member with a profile can message an approved broker. Brokers only reply to clients; they cannot start a conversation.
- Blocking, reporting, warnings, suspension and appeals are in the Admin panel and the member's Settings.

## Privacy and safety rules enforced by the server
- Members never see each other's email addresses; ids are opaque.
- Photos are cleaned, hidden until the owner shows them, and visible only to members with a profile who are not blocked.
- Every admin action is written to an append-only audit log.
- Members can download or delete their data from Settings.

## Files
`server.js` (API), `extras.js` (legal pages, member detail, shortlist, photos, account export and delete), `reviews.js` (broker reviews), `legal.js` (Terms, Privacy, Safety, Contact: have a lawyer review), `persist.js` and `start.js` (free-hosting storage), `backup*.js`, `public/` (the website).

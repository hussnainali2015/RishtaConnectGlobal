# Putting Rishta Connect Global online (plain-language guide)

You need three things: a small server, a web address (domain), and a Google sign-in key. The site is free to use and takes no payments, so there is no payment account to set up.

## 1. What to prepare
1. **A server.** Any Linux server with Docker, for example a 1 GB virtual server from Hetzner, DigitalOcean or a Saudi host. Ubuntu 24.04 is fine.
2. **A domain** (for example `rishta.example.com`) pointing to the server's IP address (an "A record" at your domain provider).
3. **Google sign-in.** Google Cloud Console > APIs & Services > Credentials > Create OAuth client ID > Web application.
   Under *Authorised JavaScript origins* add `https://rishta.example.com`. Copy the Client ID (ends with `.apps.googleusercontent.com`).
   Also fill in the consent screen and give it your Privacy Policy link `https://rishta.example.com/privacy` and Terms link `https://rishta.example.com/terms`.

## 2. Install
On the server:
```
git clone <your copy of this folder>   # or upload the folder and unzip it
cd rishta-connect-global
cp .env.example .env
nano .env        # fill in every line, see section 3
npm install      # only needed if you will run the tests or check-env; Docker installs its own copy
npm run check-env   # it tells you in plain words what is wrong
echo "DOMAIN=rishta.example.com" >> .env
docker compose up -d --build
```
Open `https://rishta.example.com`. The first visit may take a minute while the certificate is issued.
Check `https://rishta.example.com/healthz` shows `{"ok":true}`.

(No Docker? Use Node 20 or newer: `npm install --omit=dev`, `NODE_ENV=production node server.js`, behind any HTTPS proxy. `rishta.service` is a ready systemd file.)

## 3. The `.env` file
Every line is `NAME=value`: no spaces around `=`, no quotes, each value on ONE line.
Generate secrets with `openssl rand -hex 32` (for `JWT_SECRET` and `BACKUP_KEY`).
**Never** paste `JWT_SECRET` or `BACKUP_KEY` into chat, email or screenshots.
Set `NODE_ENV=production`, `BASE_URL=https://rishta.example.com`, `ADMIN_EMAILS=<your Google email>`, `SUPPORT_EMAIL`, `BACKUP_ENABLED=true`, `REQUIRE_APPROVAL=true` (new profiles wait for an admin to approve them, which is recommended because registration is free).
`npm run check-env` catches the usual typing mistakes.

## 4. Test before you open the doors
1. Sign in with Google, create a profile. With `REQUIRE_APPROVAL=true` it shows "Awaiting approval".
2. Open Admin and approve it. The profile appears in search.
3. Press "Back up now" in Admin and check a file appears in the `backups` volume.
4. Sign in with a second Google account and try chat, block, report, photo and delete account.

## 5. Going live
Have a lawyer review the Terms and Privacy pages (`legal.js`), then set `LEGAL_REVIEWED=true` and run `docker compose up -d --build` again.

## 6. Backups and restoring
Backups are encrypted files in the `rishta-data` volume (`/data/backups`) plus an optional second copy (`BACKUP_COPY_DIR`). Copy them off the server regularly.
To open one: `BACKUP_KEY=<your key> node decrypt-backup.js backups/rishta-<date>.db.gz.enc restored.db`, then stop the site, replace `rishta.db` with `restored.db`, start the site.
**After a restore, members who deleted their account since that backup will reappear.** The audit log records each deletion (action `account-deleted`, with a code instead of the email), so you can see how many there were. Delete any such account again when the member contacts you.
Keep `BACKUP_KEY` somewhere safe and separate. Without it backups cannot be opened.

## 7. Updating
Replace the files, then `docker compose up -d --build`. Data lives in volumes and is kept.

## 8. Your daily checks
Admin panel: verification queue, reports, appeals, backups ("last success" within a day).

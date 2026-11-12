# Tweet Vault

Save posts, replies, threads, X Articles, links, YouTube videos, Kindle highlights and voice notes from your phone in one tap. Then tick the ones that belong together, rank the replies, and merge them into one clean block of text for Claude.

This repo is the server and the website. The Android app is in [tweetvault-android](https://github.com/aabhishekdata/tweetvault-android).

Screenshots and the full write-up: [I built the X bookmarks feature we all wanted](https://thetechleverage.com/builds/tweet-vault/).

It is a personal tool: one vault, one owner, hosted by you. There is no hosted version.

## What it does

- **Save** from the Android share sheet, from selected text, from copied text, by voice (up to 90 minutes) or by typing a note. There is also a capture box on the website.
- **Fetch** the full post text and stats, the conversation a reply belongs to, whole threads (up to 100 parts), X Articles as Markdown, web article text, YouTube chapters and transcripts, and copies of post images.
- **Organize** with Inbox, Archived and Trash, categories and subcategories, tags, priority, personal notes, search, filters and sorting. An optional daily run uses Claude Haiku to file loose Inbox items and marks what it filed.
- **Merge** any mix of items into one text in a fixed order, with replies in the order you rank them and a Sources block at the end.
- **Hand it to Claude** by copying it (alone, with sources, or behind a saved prompt recipe), through a read-only MCP endpoint, or through an OAuth connector for claude.ai and the Claude apps.

## How it is built

- Node.js 22 using `node:http` and `node:sqlite`. Two npm packages: `@anthropic-ai/sdk` and `qrcode`.
- One SQLite file. Schema changes are additive, and a copy of the file is kept before each upgrade.
- The website is plain JavaScript and CSS with a strict content security policy. No framework, no build step.
- Post data comes from FxTwitter's free public API. No X API key is needed.

```
server/src      the app
server/static   the website
server/test     node --test suites, with saved real responses as fixtures
server/dev.js   local development server
deploy/         compose file, Nginx site, install, backup and deploy scripts, RUNBOOK.md
skill/          a Claude Code skill for reading the vault
```

## Try it on your own computer

You need Node.js 22.13 or newer.

```bash
cd server
npm install
node --disable-warning=ExperimentalWarning dev.js
```

Open http://localhost:8099 and sign in with the password `dev-only-password`. The first sign-in asks you to set up two-step sign-in with an authenticator app. The development server uses plain HTTP, a throwaway database (`dev-vault.db`) and fixed dev-only secrets, and listens on 127.0.0.1 only. Never expose it to a network.

Run the tests with `npm test`.

Without API keys the dev server answers translation and voice notes with clearly labelled stand-in text, so every screen can be tried for free.

## Run your own

You need a small Linux server with Docker and Nginx, a domain name, and an Android phone for the app.

The files in `deploy/` use `vault.example.com`, `user@your-server` and `/home/user` as placeholders. Replace them with your own domain, SSH login and home folder before you start.

1. **DNS:** point your domain at the server.
2. **Copy the files** to `~/tweet-vault` on the server. From Windows, `deploy\deploy.ps1` does this over SSH once you set `$env:VAULT_SSH_HOST = "user@your-server"`.
3. **Password:** on the server, `cd ~/tweet-vault && ./set-vault-password.sh`.
4. **Public site and HTTPS:** `sudo ./install-public-vault.sh`.
5. **Nightly backup:** add `backup-vault.sh` to cron. See [deploy/RUNBOOK.md](deploy/RUNBOOK.md).
6. **First sign-in:** scan the QR code with an authenticator app and save the 8 recovery codes.
7. **Phone:** on the website, open Security, then Pair a phone, and type the 6-digit code into the app.

[deploy/RUNBOOK.md](deploy/RUNBOOK.md) covers day-to-day operation, restore, the MCP endpoint, the claude.ai connector and app updates.

### Settings

`VAULT_ORIGINS`, your site's address, is set in `deploy/docker-compose.yml`. The container reads the rest from `~/tweet-vault/.env`:

| Variable | What it is for |
| --- | --- |
| `VAULT_PASSWORD_HASH` | Written by `set-vault-password.sh`. |
| `VAULT_SECRET` | At least 32 random characters. The server refuses to start without it. |
| `ANTHROPIC_API_KEY` | Optional. Turns on translation, daily filing and voice notes. |
| `GROQ_API_KEY` | Optional. Turns on voice transcripts. |
| `YOUTUBE_API_KEY` | Optional. Makes video details more reliable. |
| `ALERT_WEBHOOK_URL` | Optional. Gets a message on errors and failed backups. |

Without the optional keys the vault still saves, fetches and merges. Every kind of AI call has a daily cap.

## Connect Claude

- **Claude Code:** on the website, open Security, then Connect Claude, and create a key. It shows a `claude mcp add` command once. The key can only read.
- **claude.ai and the Claude apps:** in Claude, open Customize → Connectors → Add custom connector, add `https://your-domain/mcp`, leave the client ID and secret empty, and approve it on the vault's consent page.
- **Skill:** `skill/tweet-vault` is a Claude Code skill. Say "get vault bundle" and a name.

The MCP tools are `list_bundles`, `get_bundle`, `search_items`, `get_item` and `list_recipes`. Each prompt recipe is also offered as an MCP prompt.

## Security

- Password plus a required authenticator code, with one-time recovery codes.
- Each phone pairs with a single-use code and gets its own token, stored only as a hash. A phone can save. It can organize only if you allow it on the website, and it can never delete for good or open Security.
- The server fetches web pages over HTTPS only, refuses private and internal addresses, and re-checks every redirect.
- Saved text is passed to models as data, with instructions not to follow anything written inside it.
- An activity log keeps 30 days of sign-ins, pairing and every read by Claude.

If you find a security problem, please open an issue without the exploit details and ask for a private contact.

## Limits

- One user. No accounts or sharing.
- Android only for one-tap saving. The website works in any browser.
- Post fetching depends on FxTwitter, a free third-party service.
- It does not import existing X bookmarks.
- YouTube often blocks servers. `deploy/fetch-transcripts.ps1` fetches subtitles from your own computer with yt-dlp and sends them to the vault.

## Licence

MIT. See [LICENSE](LICENSE). The bundled Source Sans 3 fonts are under the SIL Open Font License (`server/static/fonts/OFL-LICENSE.md`).

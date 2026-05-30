# Sakura Invaders

A dependency-free sakura-themed arcade shooter made for Discord hangouts.

## Run locally

```powershell
npm start
```

Then open `http://localhost:3000`.

## Discord use

For a Discord server link, host this folder with any static host and share the URL.

For a Discord Activity, use the hosted URL as the activity app URL in the Discord Developer Portal. The game is static and does not require a backend, so it can be hosted on services like Cloudflare Pages, Netlify, GitHub Pages, or any HTTPS static file server.

Use these hosted pages for Discord verification:

- Terms of Service: `/terms.html`
- Privacy Policy: `/privacy.html`
- Install URL: `/install`

## Leaderboard setup

The shared leaderboard uses Discord Activity authentication. Set these Railway variables:

```txt
DATABASE_URL=${{Postgres.DATABASE_URL}}
DISCORD_CLIENT_ID=1509412850450567248
DISCORD_CLIENT_SECRET=your Discord OAuth2 Client Secret
DISCORD_BOT_TOKEN=your Discord Bot Token
```

The client ID is public. Never commit the client secret to GitHub.

When `DATABASE_URL` is present, scores are stored in PostgreSQL. Local development falls back to `data/leaderboard.json`.

Leaderboards are scoped per Discord server. If the Activity is launched outside a server, it falls back to a global leaderboard.

When `DISCORD_BOT_TOKEN` is set, the app also starts a Discord bot. It posts score results into the Activity channel and registers `/leaderboard` for each server. The install URL at `/install` includes both `bot` and `applications.commands` scopes with View Channel and Send Messages permissions.

Bot commands:

- `/leaderboard` shows the current server's Sakura Invaders leaderboard.
- `/setscorechannel channel:#channel` sets the score announcement channel for the server.

## Controls

- Move: `A` / `D` or arrow keys
- Fire: `Space`
- Pause: `P`

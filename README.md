# Curatarr

A Discord bot for requesting audiobooks via [Bookshelf](https://github.com/pennydreadful/bookshelf) (the Readarr fork). Think of it as Requestrr, but for audiobooks.

![Version](https://img.shields.io/badge/version-v1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

> [!WARNING]
> This project was built with AI assistance (vibe coded). While it works, the code hasn't been professionally audited — use at your own risk. If you get a chance, feel free to review the code before deploying. PRs and fixes are always welcome!

---

## Features

- `/request` — Search and request audiobooks with a clean two-step UI (dropdown → embed → Request button)
- `/library` — Search your existing Bookshelf library
- `/status` — View the current download queue
- `/pending` — Admin only: view and approve/deny pending requests via DM
- `/logs` — Admin only: view recent bot activity
- **Ephemeral responses** — only the person who typed sees the bot's reply, no channel clutter
- **Approval mode** — optionally require admin approval before downloads trigger
- **Admin DMs** — requests ping you directly via Discord DM with Approve/Deny buttons
- **Requester notifications** — users get a DM when their request is approved or denied
- **Duplicate detection** — checks your library before showing results
- **Full JSON logging** — every action logged to disk

> [!NOTE]
> This is a passion project and I'm actively looking for developers who want to get involved! Whether it's bug fixes, new features, or just throwing ideas around — open an issue or start a discussion. Would love to see where this goes with some help. 🎧

---

## Requirements

- [Bookshelf](https://github.com/pennydreadful/bookshelf) (Readarr fork) running and accessible
- [Prowlarr](https://github.com/Prowlarr/Prowlarr) with audiobook indexers configured and synced to Bookshelf
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Docker

---

## Quick Start

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** and name it `Curatarr`
3. Go to **Bot** → click **Add Bot**
4. Under **Token** click **Reset Token** and copy it — this is your `DISCORD_TOKEN`
5. Scroll down and enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent
6. Go to **OAuth2** → copy the **Client ID** — this is your `DISCORD_CLIENT_ID`

### 2. Invite the Bot to Your Server

Go to **OAuth2 → URL Generator** and set:
- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:** `Send Messages`, `Embed Links`, `Use Slash Commands`, `Read Message History`

Copy the generated URL and open it in your browser to add the bot to your server.

### 3. Get Your IDs

**Discord Server ID:**
- In Discord: **Settings → Advanced → Enable Developer Mode**
- Right-click your server name → **Copy Server ID**

**Your Discord User ID (for approval DMs):**
- Right-click your name in Discord → **Copy User ID**

**Bookshelf API Key:**
- In Bookshelf: **Settings → General → API Key**

### 4. Deploy with Docker

#### Option A — Docker Compose (recommended)

```yaml
version: "3.8"

services:
  curatarr:
    image: sidkapahiii/curatarr:latest
    container_name: curatarr
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=your_discord_bot_token
      - DISCORD_CLIENT_ID=your_client_id
      - DISCORD_GUILD_ID=your_server_id
      - BOOKSHELF_URL=http://bookshelf:8787
      - BOOKSHELF_API_KEY=your_bookshelf_api_key
      - ADMIN_USER_ID=your_discord_user_id
      - QUALITY_PROFILE_NAME=Spoken
      - METADATA_PROFILE_NAME=None
      - REQUIRE_APPROVAL=false
      - LOG_FILE=/config/curatarr.log
      - TZ=America/Toronto
    volumes:
      - /mnt/user/appdata/curatarr:/config
    networks:
      - your_docker_network

networks:
  your_docker_network:
    external: true
```

```bash
docker compose up -d
```

#### Option B — Docker Run

```bash
docker run -d \
  --name curatarr \
  --restart unless-stopped \
  --network your_docker_network \
  -e DISCORD_TOKEN=your_discord_bot_token \
  -e DISCORD_CLIENT_ID=your_client_id \
  -e DISCORD_GUILD_ID=your_server_id \
  -e BOOKSHELF_URL=http://bookshelf:8787 \
  -e BOOKSHELF_API_KEY=your_bookshelf_api_key \
  -e ADMIN_USER_ID=your_discord_user_id \
  -e QUALITY_PROFILE_NAME=Spoken \
  -e METADATA_PROFILE_NAME=None \
  -e REQUIRE_APPROVAL=false \
  -e LOG_FILE=/config/curatarr.log \
  -e TZ=America/Toronto \
  -v /mnt/user/appdata/curatarr:/config \
  sidkapahiii/curatarr:latest
```

#### Option C — Unraid Community Apps

Search for **Curatarr** in the Community Apps store and install directly. All fields are pre-populated — just fill in your values.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | — | Application Client ID from Discord Developer Portal |
| `BOOKSHELF_URL` | ✅ | — | URL to your Bookshelf instance e.g. `http://bookshelf:8787` |
| `BOOKSHELF_API_KEY` | ✅ | — | Bookshelf API key from Settings → General |
| `DISCORD_GUILD_ID` | Recommended | — | Your Discord server ID. Makes slash command registration instant |
| `ADMIN_USER_ID` | Recommended | — | Your Discord user ID. Receives approval request DMs |
| `QUALITY_PROFILE_NAME` | — | `Spoken` | Name of the quality profile in Bookshelf to use for audiobooks |
| `METADATA_PROFILE_NAME` | — | `None` | Name of the metadata profile in Bookshelf to use |
| `REQUIRE_APPROVAL` | — | `false` | Set to `true` to require admin approval before downloads trigger |
| `REQUEST_CHANNEL_ID` | — | — | Restrict bot to a specific channel. Leave blank for all channels |
| `ADMIN_ROLE_ID` | — | — | Role ID for admin commands. Leave blank to use server Administrator permission |
| `LOG_FILE` | — | `/config/curatarr.log` | Path inside container where logs are written |
| `TZ` | — | `UTC` | Timezone for log timestamps e.g. `America/Toronto` |

---

## How It Works

### For Users

1. Type `/request` and enter a book title or author name
2. A dropdown appears — select the book you want
3. The book embed appears with a **Request** button
4. Click **Request**
5. If approval is off: book is added to Bookshelf and download starts immediately
6. If approval is on: you get a confirmation and will receive a DM when approved or denied

### For Admins

- When a request comes in (approval mode), you receive a DM with **Approve** and **Deny** buttons
- `/pending` — sends all pending requests to your DMs
- `/logs` — shows the last 20 log entries
- `/status` — shows the current Bookshelf download queue
- Admins bypass the approval queue and can request directly

---

## Building from Source

```bash
git clone https://github.com/sidkapahi/curatarr.git
cd curatarr
npm install
docker build -t curatarr:latest .
```

To push to Docker Hub:

```bash
docker tag curatarr:latest sidkapahiii/curatarr:latest
docker push sidkapahiii/curatarr:latest
```

---

## Updating

If running from the Docker image:

```bash
docker pull sidkapahiii/curatarr:latest
docker restart curatarr
```

---

## Logs

All actions are logged to `/config/curatarr.log` in JSON format:

```json
{"timestamp":"2026-04-08, 12:00:00","level":"INFO","message":"Request command","data":{"user":"Sid#1234","query":"Dune"}}
{"timestamp":"2026-04-08, 12:00:05","level":"INFO","message":"Book added successfully","data":{"title":"Dune Messiah","id":3}}
{"timestamp":"2026-04-08, 12:00:05","level":"INFO","message":"Search triggered","data":{"bookId":3}}
```

---

## Troubleshooting

**Bot not responding to slash commands**
- Make sure `DISCORD_GUILD_ID` is set — global command registration can take up to an hour
- Check the bot has `Use Slash Commands` permission in your server

**"Failed to add book" error**
- Verify your `BOOKSHELF_URL` is reachable from the container
- Check `QUALITY_PROFILE_NAME` and `METADATA_PROFILE_NAME` match exactly what's in Bookshelf Settings → Profiles
- Check `/logs` for the detailed error message

**Book added but not downloading**
- Make sure Prowlarr indexers are synced to Bookshelf (Settings → Indexers in Bookshelf)
- For audiobooks, AudioBookBay and MyAnonamouse (MAM) are the best indexers
- Check Bookshelf → Activity → Queue after a request

**Approval DMs not arriving**
- Set `ADMIN_USER_ID` to your Discord user ID (right-click your name → Copy User ID)
- Make sure you haven't blocked DMs from server members

---

## License

MIT — do whatever you want with it.

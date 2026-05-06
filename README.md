# Minecraft AFK Bot (Multi-Server)

> 🧟 A lightweight Minecraft AFK bot with multi-server support, dynamic player simulation, remote config sync, and smart version fallback.

[![npm version](https://img.shields.io/npm/v/@baipiaodajun/mcbot)](https://www.npmjs.com/package/@baipiaodajun/mcbot)
[![license](https://img.shields.io/npm/l/@baipiaodajun/mcbot)](LICENSE)

---

## ✨ Features

* **Multi-server support** – Manage unlimited Minecraft servers with a single config file.
* **Dynamic player pool** – Set min/max players per server and simulate joins/leaves automatically.
* **Remote config sync** – Fetch `server.json` via `SERVER_API` on startup.
* **Smart version fallback** – Automatically retries compatible versions (1.20.4 → 1.20.1 → 1.19.2 …).
* **Randomized usernames** – Generates names like `x4k_9ab`, or use custom ones.
* **Exponential reconnect** – Handles disconnects gracefully without spamming servers.

---

## 📦 Installation

```bash
git clone https://github.com/yourusername/mc-afk-bot.git
cd mc-afk-bot
npm install
```

## ⚙️ Configuration

On first run, a `server.json` file will be generated.

```json
[
  {
    "host": "play.hypixel.net",
    "port": 25565,
    "username": "MyBot",
    "version": "1.20.1",
    "players": { "min": 2, "max": 3 },
    "fallbackVersions": [false, "1.20.1", "1.19.2"]
  },
  {
    "host": "mc.example.com",
    "port": 25566,
    "username": "",
    "version": false,
    "players": { "min": 1, "max": 1 }
  }
]
```

### Field Explanation

| Field              | Type           | Required | Description                      |
| ------------------ | -------------- | -------- | -------------------------------- |
| `host`             | string         | Yes      | Server address                   |
| `port`             | number         | Yes      | Server port (default 25565)      |
| `username`         | string         | No       | Bot name (random if empty)       |
| `version`          | string / false | No       | Minecraft version or auto-detect |
| `players`          | object         | No       | `{ min, max }` player range      |
| `fallbackVersions` | array          | No       | Version fallback list            |

---

## ☁️ Remote Config (JSONBin Support)

In addition to `SERVER_API`, you can use **JSONBin** for centralized config storage.

### 🔑 Environment Variables

```bash
JSONBIN_KEY=your_api_key
JSONBIN_ID=your_bin_id
```

### How to get them:

1. Go to [JSONBin.io](https://jsonbin.io) and create an account
2. Copy your **API Key** from *API Keys → Master Key*
3. Create a new Bin
4. Copy the Bin ID (e.g. `65f1a2b3c...`)

---

### 📥 Behavior

On startup:

1. Fetch config from JSONBin
2. Overwrite local `server.json`
3. Start bots using latest config

Perfect for multi-instance deployments.

---

### ⚠️ Notes

* Keep your API key private
* Free tier has rate limits
* Ideal for Docker / distributed setups

---

## 🚀 Usage

### Basic

```bash
node index.js
```

### Remote config

```bash
export SERVER_API="https://your-cdn.com/server.json"
node index.js
```

### Quick env setup

```bash
SERVER_1=host:port[:version]
```

---

## 🐳 Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY index.js .
CMD ["node", "index.js"]
```

Run:

```bash
docker run -e SERVER_API=https://... -d mc-afk-bot
```

---

## 📊 Performance

Tested on Node 18, single-core VPS:

* **CPU**: < 1%
* **Memory**: ~40 MB (3 bots total)

No pathfinding, no entity scanning.

---

## 🔄 Behavior

* Every **150–180 seconds**: random action (jump/look)
* Every **60 seconds**: adjust player count
* Every **10–20 minutes**: rotate bots (simulate real players)
* Auto-reconnect + version downgrade on errors

---

## 🧰 CLI (Legacy)

```bash
node index.js <host> <port> <username> <version>
```

Example:

```bash
node index.js localhost 25565 Bot 1.20.1
```

Env vars also supported:
`HOST`, `PORT`, `USERNAME`, `MCVERSION`

---

## 📌 Credits

Original project:
[@baipiaodajun/mcbot](https://www.npmjs.com/package/@baipiaodajun/mcbot)

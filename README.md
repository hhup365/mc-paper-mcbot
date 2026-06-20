# Minecraft Session Manager Pro

> 🧟 A lightweight Minecraft AFK/bot cluster management panel featuring multi-server orchestration, dynamic online-player simulation, remote configuration sync, intelligent version detection, and a modern glassmorphism web dashboard.

[![npm version](https://img.shields.io/npm/v/@baipiaodajun/mcbot)](https://www.npmjs.com/package/@baipiaodajun/mcbot)
[![license](https://img.shields.io/npm/l/@baipiaodajun/mcbot)](LICENSE)

---

## ✨ Features

* **Multi-Server Clusters** — Manage any number of Minecraft servers from a single dashboard, each with its own independent configuration.
* **One-Click Enable/Disable** — Pause or resume any cluster instantly without deleting its configuration.
* **Dynamic Player Pools** — Configure a `min~max` player range and automatically simulate realistic joins and leaves.
* **Smart Version Detection** — `auto` mode negotiates the correct protocol automatically and falls back from 1.21.x to older versions when necessary.
* **Remote Configuration Sync** — Centralized configuration storage and synchronization via `CONFIG_URL` (paired with `index.php`).
* **Exponential Backoff Reconnection** — Graceful reconnect logic that avoids excessive reconnect spam.
* **Web Control Panel** — Real-time status monitoring, log streaming, deployment forms, and authentication.

---

## 📦 Installation

```bash
git clone https://github.com/yourusername/mc-paper-mcbot.git
cd mc-paper-mcbot
npm install
node index.js
```

After startup, visit:

```text
http://localhost:8080
```

(Default port depends on `PORT`.)

Default login password:

```text
admin
```

(See `PANEL_PASSWORD`.)

---

## ⚙️ Environment Variables

All configuration is controlled through environment variables. **Nothing is required** — the application works with sensible defaults.

### Basic Settings

| Variable         | Default | Description                                              |
| ---------------- | ------- | -------------------------------------------------------- |
| `PORT`           | `8080`  | Web dashboard listening port (`SERVER_PORT` is an alias) |
| `PANEL_PASSWORD` | `admin` | Dashboard login password (**change in production**)      |

### Remote Configuration Storage (Optional)

Without `CONFIG_URL`, configuration is stored locally in `server.json`.

When configured, the application will pull from the remote endpoint and perform bidirectional synchronization.

| Variable        | Default             | Description                                                           |
| --------------- | ------------------- | --------------------------------------------------------------------- |
| `CONFIG_URL`    | Empty               | Remote configuration endpoint pointing to your deployed `index.php`   |
| `CONFIG_SECRET` | `your_secret_token` | Shared secret used by both the panel and `index.php` (**must match**) |

### Version Detection (Optional)

Only applies when server version is set to `auto`.

| Variable      | Default | Description                                                             |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `MIN_VERSION` | `1.17`  | Lowest version allowed during automatic detection                       |
| `MAX_VERSION` | Empty   | Maximum version allowed; empty = latest version supported by the engine |

> The highest connectable version depends on your installed `mineflayer` and `minecraft-data` versions. Upgrade those dependencies to support newer Minecraft releases.

### Memory & Stability Tuning (Optional)

Used to balance memory usage and connection stability.

| Variable            | Default | Description                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `CHUNK_KEEP_RADIUS` | `2`     | Number of surrounding chunks to keep loaded. Lower values save memory. |
| `PRUNE_INTERVAL_MS` | `45000` | Memory cleanup interval (milliseconds)                                 |
| `STRONG_WANDER_MS`  | `45000` | Movement interval in Strong mode (milliseconds)                        |
| `STRONG_ATTACK_MS`  | `3000`  | Mob scanning/attack interval in Strong mode (milliseconds)             |

For the lowest possible memory usage:

```bash
node --max-old-space-size=128 index.js
```

and use **Normal Mode**.

---

## 📝 Configuration Fields

Server configurations can be created through the **Deploy Configuration** form, edited directly in `server.json`, or managed remotely via `config.json`.

```json
[
  {
    "id": "a1b2c3",
    "name": "Survival Main Server",
    "host": "play.example.com",
    "port": 25565,
    "username": "",
    "version": "auto",
    "mode": "normal",
    "enabled": true,
    "players": {
      "min": 1,
      "max": 3
    }
  }
]
```

| Field      | Type                | Required | Description                                                      |
| ---------- | ------------------- | -------- | ---------------------------------------------------------------- |
| `id`       | string              | No       | Unique identifier; generated automatically if omitted            |
| `name`     | string              | No       | Display name shown on the dashboard; falls back to host if empty |
| `host`     | string              | Yes      | Minecraft server address                                         |
| `port`     | number              | No       | Server port, default `25565`                                     |
| `username` | string              | No       | Base bot username; randomly generated if empty                   |
| `version`  | string              | No       | `auto` or a specific version such as `1.21.1` or `1.8.9`         |
| `mode`     | `normal` / `strong` | No       | `normal` = AFK only; `strong` = movement + mob retaliation       |
| `enabled`  | boolean             | No       | Cluster switch; `false` pauses the cluster                       |
| `players`  | object              | No       | Online player range `{ min, max }`                               |

---

## ☁️ Remote Configuration (`index.php`)

Deploy `index.php` on any PHP-enabled hosting environment to provide centralized configuration storage.

Supported operations:

* **GET** — Returns the stored configuration array (also supports `?secret=...` for browser access)
* **POST** — Validates and atomically updates configuration data

### Deployment Steps

1. Upload `index.php` to a PHP host, for example:

   ```text
   https://your-domain.com/mc/index.php
   ```

2. Configure the `CONFIG_SECRET` environment variable on the PHP host.

3. Set:

   ```text
   CONFIG_URL
   ```

   on the bot panel and ensure both sides use the same `CONFIG_SECRET`.

On first access, the script automatically creates:

* `config.json`
* `.htaccess`

> ⚠️ **Security Warning:** The default secret is `admin`. Always replace it with a strong secret via `CONFIG_SECRET`, otherwise anyone who discovers the endpoint may be able to read or modify your configuration.

---

## 🐳 Docker

```bash
docker build -t mc-session-manager .

docker run -d \
  -p 7860:7860 \
  -e PORT=7860 \
  -e PANEL_PASSWORD=changeme \
  -e CONFIG_URL=https://your-domain.com/mc/index.php \
  -e CONFIG_SECRET=your_strong_secret \
  mc-session-manager
```

---

## 🖥️ Dashboard Overview

### Active Clusters (Main Area)

The upper section displays active clusters, while the lower section displays paused or offline clusters.

Each cluster card includes:

* Custom name
* `host:port`
* Status
* Current / target player count
* Version
* Mode
* Player range
* Enable/disable toggle
* Delete button

Status indicators:

* 🟢 Optimal
* 🟡 Syncing
* 🔴 Offline
* ⚪ Paused

### System Stream (Sidebar)

Real-time log streaming and operational events.

### Deploy Configuration (Sidebar)

Create, edit, and deploy server configurations. Clicking a cluster card loads its settings into the form.

### Export

Export the current configuration as JSON with a single click.

---

## 🔄 Runtime Behavior

### Normal Mode

Performs lightweight AFK actions every 3–5 minutes:

* Looking around
* Jumping
* Sneaking
* Arm swinging

### Strong Mode

* Random movement at configurable intervals
* Automatically retaliates against nearby hostile mobs

Additional behaviors:

* Online counts are maintained every 15 seconds.
* Target player counts periodically change within the configured `min~max` range.
* Automatic reconnect on disconnect.
* In `auto` version mode, incompatible protocol versions trigger automatic fallback attempts.
* Distant chunks and entities are pruned every 45 seconds to reduce memory usage.

---

## 📌 Credits

Based on:

[@baipiaodajun/mcbot](https://www.npmjs.com/package/@baipiaodajun/mcbot)

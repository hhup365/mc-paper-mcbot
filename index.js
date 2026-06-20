#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');
const express = require('express');
const cookieParser = require('cookie-parser');

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 } = require('vec3');

const CONFIG_FILE = path.join(__dirname, 'server.json');
const WEB_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const AUTH_TOKEN = Math.random().toString(36).substring(2, 15);

const CONFIG_URL = process.env.CONFIG_URL;
const CONFIG_SECRET = process.env.CONFIG_SECRET || 'your_secret_token';

const MIN_VERSION = process.env.MIN_VERSION || '1.17';
const MAX_VERSION = process.env.MAX_VERSION || '';

const CHUNK_KEEP_RADIUS = parseInt(process.env.CHUNK_KEEP_RADIUS, 10) || 2;
const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS, 10) || 45000;
const STRONG_WANDER_MS = parseInt(process.env.STRONG_WANDER_MS, 10) || 45000;
const STRONG_ATTACK_MS = parseInt(process.env.STRONG_ATTACK_MS, 10) || 3000;

const ADJ = ['Silent', 'Dark', 'Swift', 'Epic', 'Mystic', 'Iron', 'Ghost', 'Shadow', 'Neo', 'Frost', 'Crimson', 'Azure', 'Lunar', 'Solar', 'Void', 'Clever', 'Brave'];
const NOUN = ['Wolf', 'Hunter', 'Ninja', 'Knight', 'Dragon', 'Sniper', 'Fox', 'Blade', 'Storm', 'Raven', 'Viper', 'Ghost', 'Hawk', 'Bear', 'Lion', 'Panda'];

let serverGroups = new Map();
let systemLogs = [];
let cachedConfig = [];

function logWithTime(label, msg, level = 'info') {
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${now}] [${label}] ${msg}`);
  systemLogs.push({ t: now, l: label, m: msg, lvl: level });
  if (systemLogs.length > 250) systemLogs.shift();
}

function generateUsername(base) {
  if (base) return base;
  const adj = ADJ[Math.floor(Math.random() * ADJ.length)];
  const noun = NOUN[Math.floor(Math.random() * NOUN.length)];
  const num = Math.random() > 0.5 ? Math.floor(Math.random() * 9000) + 1000 : '';
  return `${adj}${noun}${num}`;
}

function parseVer(v) {
  return String(v).split('.').map(n => parseInt(n, 10) || 0);
}

function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function buildVersionList() {
  let pool = [];
  try {
    const mcData = require('minecraft-data');
    const raw = (mcData.versions && Array.isArray(mcData.versions.pc)) ? mcData.versions.pc : [];
    pool = raw.map(v => v && v.minecraftVersion).filter(Boolean);
  } catch (e) {
    pool = [];
  }

  if (!pool.length) {
    pool = ['1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.17.1'];
  }

  const list = [...new Set(pool)]
    .filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
    .filter(v => cmpVer(v, MIN_VERSION) >= 0)
    .filter(v => !MAX_VERSION || cmpVer(v, MAX_VERSION) <= 0)
    .sort((a, b) => cmpVer(b, a));

  return [false, ...list];
}

const AUTO_VERSIONS = buildVersionList();
logWithTime('SYSTEM', `Auto-version search ready: ${AUTO_VERSIONS.length - 1} releases (${AUTO_VERSIONS[1] || '?'} -> ${AUTO_VERSIONS[AUTO_VERSIONS.length - 1] || '?'})`, 'info');

function tcpPing(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

function parseDisconnectReason(reason) {
  if (!reason) return 'Unknown';
  try {
    let str = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    if (str.startsWith('{')) {
      const obj = JSON.parse(str);
      if (obj.text) return obj.text;
      if (obj.translate) return obj.translate;
      return str.substring(0, 60) + '...';
    }
    return str.replace(/§[0-9a-fk-or]/ig, '');
  } catch (e) {
    return String(reason).replace(/§[0-9a-fk-or]/ig, '').substring(0, 60);
  }
}

function normalizeServer(c) {
  c = c || {};
  const min = Math.max(1, parseInt(c.players && c.players.min, 10) || 1);
  const max = Math.max(min, parseInt(c.players && c.players.max, 10) || min);
  return {
    id: c.id || Math.random().toString(36).substr(2, 6),
    name: (c.name || '').toString().slice(0, 40),
    host: (c.host || '').toString().trim(),
    port: parseInt(c.port, 10) || 25565,
    username: (c.username || '').toString(),
    version: c.version || 'auto',
    mode: c.mode === 'strong' ? 'strong' : 'normal',
    enabled: c.enabled !== false,
    players: { min, max }
  };
}

async function loadConfig() {
  if (CONFIG_URL) {
    try {
      const res = await fetch(CONFIG_URL, { headers: { 'X-Secret': CONFIG_SECRET } });
      if (res.ok) {
        const data = await res.json();
        cachedConfig = (Array.isArray(data) ? data : []).map(normalizeServer).filter(c => c.host);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cachedConfig, null, 2), 'utf-8');
        logWithTime('SYSTEM', 'Config synced from remote server successfully.', 'success');
        return cachedConfig;
      } else {
        logWithTime('SYSTEM', `Remote config fetch failed with status: ${res.status}`, 'warning');
      }
    } catch (e) {
      logWithTime('SYSTEM', 'Failed to connect to remote config server. Falling back to local.', 'error');
    }
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify([], null, 2), 'utf-8');
    cachedConfig = [];
    return cachedConfig;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    cachedConfig = (Array.isArray(parsed) ? parsed : []).map(normalizeServer).filter(c => c.host);
    return cachedConfig;
  } catch (e) {
    return [];
  }
}

async function saveConfig(config) {
  cachedConfig = config;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  if (CONFIG_URL) {
    try {
      const res = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Secret': CONFIG_SECRET
        },
        body: JSON.stringify(config)
      });
      if (!res.ok) {
        logWithTime('SYSTEM', `Failed to push config to remote (Status: ${res.status})`, 'error');
      }
    } catch (e) {
      logWithTime('SYSTEM', 'Failed to reach remote config server to save.', 'error');
    }
  }
}

class ClientInstance {
  constructor(serverConfig, idLabel, group = null) {
    this.config = serverConfig;
    this.label = idLabel;
    this.group = group;
    this.mode = this.config.mode || 'normal';
    this.bot = null;
    this.reconnecting = false;
    this.shuttingDown = false;
    this.retryCount = 0;
    this.username = generateUsername(this.config.username);
    this.currentVersionIdx = group ? (group.resolvedVersionIdx || 0) : 0;
    this.versionMatched = false;

    this.activityTimer = null;
    this.wanderInterval = null;
    this.attackInterval = null;
    this.pruneInterval = null;
    this.lastAttackTime = 0;
  }

  async start(delayMs = 0) {
    if (this.shuttingDown) return;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if (this.shuttingDown) return;

    const reachable = await tcpPing(this.config.host, this.config.port);
    if (!reachable) {
      logWithTime(this.label, 'Host unreachable. Retrying', 'error');
      this.scheduleReconnect(15000);
      return;
    }
    this.createClient();
  }

  createClient() {
    if (this.reconnecting || this.shuttingDown) return;
    this.versionMatched = false;

    const rawVersion = (this.config.version || 'auto').toString().trim();
    const isAuto = rawVersion.toLowerCase() === 'auto' || rawVersion === '' || rawVersion.toLowerCase() === 'false';
    if (isAuto && this.currentVersionIdx >= AUTO_VERSIONS.length) this.currentVersionIdx = 0;
    const version = isAuto ? AUTO_VERSIONS[this.currentVersionIdx] : rawVersion;

    const options = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.username,
      version: version,
      physicsEnabled: this.mode === 'strong',
      hideErrors: true
    };

    const verLabel = version === false ? 'Auto-Detect' : version;
    logWithTime(this.label, `Auth [Mode: ${this.mode.toUpperCase()}] [Ver: ${verLabel}]`);

    try {
      this.bot = mineflayer.createBot(options);
    } catch (e) {
      logWithTime(this.label, `Engine rejected version ${verLabel}: ${e.message}`, 'warning');
      if (isAuto) this.currentVersionIdx = (this.currentVersionIdx + 1) % AUTO_VERSIONS.length;
      this.scheduleReconnect(4000);
      return;
    }

    if (this.mode === 'strong') {
      this.bot.loadPlugin(pathfinder);
    }

    this.bot.on('login', () => {
      this.versionMatched = true;
      if (this.group && isAuto) this.group.resolvedVersionIdx = this.currentVersionIdx;
      logWithTime(this.label, `Session established (${this.bot.version || verLabel})`, 'success');
      this.reconnecting = false;
      this.retryCount = 0;

      if (this.mode === 'normal') {
        this.startNormalBehavior();
      }
    });

    this.bot.on('spawn', () => {
      this.startMemoryGuard();
      if (this.mode === 'strong' && !this.wanderInterval) {
        logWithTime(this.label, 'Spawned. Starting Strong Keep-Alive', 'success');
        this.startStrongBehavior();
      }
    });

    const handleDisconnect = (reason, isKick = false) => {
      if (this.shuttingDown) return;
      const msg = parseDisconnectReason(reason);

      let quickRetry = false;
      if (!this.versionMatched) {
        if (isAuto) {
          this.currentVersionIdx = (this.currentVersionIdx + 1) % AUTO_VERSIONS.length;
          const nextV = AUTO_VERSIONS[this.currentVersionIdx];
          logWithTime(this.label, `Protocol mismatch, trying ${nextV === false ? 'Auto-Detect' : nextV}`, 'warning');
          quickRetry = true;
        } else {
          logWithTime(this.label, `Custom version [${rawVersion}] refused: ${msg}`, 'error');
        }
      } else if (isKick) {
        logWithTime(this.label, `Kicked: ${msg}`, 'error');
      } else {
        logWithTime(this.label, 'Disconnected', 'error');
      }

      let delay = null;
      if (msg.toLowerCase().includes('throttle')) delay = 30000;
      else if (quickRetry) delay = 4000;
      this.scheduleReconnect(delay);
    };

    this.bot.on('error', (err) => handleDisconnect(err.message));
    this.bot.on('end', (reason) => handleDisconnect(reason));
    this.bot.on('kicked', (reason) => handleDisconnect(reason, true));

    this.bot._client?.on('packet', (data, meta) => {
      if (meta.name === 'explosion') {
        const y = data.playerKnockback?.y;
        if (typeof y === 'number' && (y > 1e12 || isNaN(y))) {
          logWithTime(this.label, 'Explosion packet anomaly detected', 'warning');
          this.scheduleReconnect();
        }
      }
    });
  }

  startMemoryGuard() {
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    this.pruneInterval = setInterval(() => this.pruneMemory(), PRUNE_INTERVAL_MS);
  }

  pruneMemory() {
    const bot = this.bot;
    if (!bot || !bot.entity || this.shuttingDown) return;
    try {
      const center = bot.entity.position;
      const cx = Math.floor(center.x / 16);
      const cz = Math.floor(center.z / 16);

      const cm = bot.world && bot.world.columns ? bot.world.columns : null;
      if (cm) {
        for (const key of Object.keys(cm)) {
          const parts = key.split(',');
          const colX = parseInt(parts[0], 10);
          const colZ = parseInt(parts[1], 10);
          if (Math.abs(colX - cx) > CHUNK_KEEP_RADIUS || Math.abs(colZ - cz) > CHUNK_KEEP_RADIUS) {
            if (typeof bot.world.unloadColumn === 'function') bot.world.unloadColumn(colX, colZ);
            else delete cm[key];
          }
        }
      }

      if (bot.entities) {
        const keepSq = 32 * 32;
        for (const id of Object.keys(bot.entities)) {
          const e = bot.entities[id];
          if (!e || e === bot.entity) continue;
          if (e.type === 'player') continue;
          if (!e.position || e.position.distanceSquared(center) > keepSq) {
            delete bot.entities[id];
          }
        }
      }
    } catch (e) {}
  }

  startNormalBehavior() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    const doAction = () => {
      if (!this.bot?.entity || this.shuttingDown) return;
      try {
        const actions = ['look', 'jump', 'sneak', 'swing'];
        const action = actions[Math.floor(Math.random() * actions.length)];
        switch (action) {
          case 'look':
            const yaw = this.bot.entity.yaw + (Math.random() - 0.5);
            this.bot.look(yaw, this.bot.entity.pitch, true);
            break;
          case 'jump':
            this.bot.setControlState('jump', true);
            setTimeout(() => this.bot.setControlState('jump', false), 500);
            break;
          case 'sneak':
            this.bot.setControlState('sneak', true);
            setTimeout(() => this.bot.setControlState('sneak', false), 1500);
            break;
          case 'swing':
            this.bot.swingArm('right');
            break;
        }
        logWithTime(this.label, `Action: ${action}`, 'info');
      } catch (e) {}

      const nextTime = 180000 + Math.random() * 120000;
      this.activityTimer = setTimeout(doAction, nextTime);
    };
    this.activityTimer = setTimeout(doAction, 30000 + Math.random() * 30000);
  }

  startStrongBehavior() {
    if (!this.bot?.pathfinder || !this.bot.version) return;

    const defaultMove = new Movements(this.bot, require('minecraft-data')(this.bot.version));
    this.bot.pathfinder.setMovements(defaultMove);

    const wander = () => {
      if (!this.bot?.entity || this.shuttingDown) return;
      if (this.bot.pathfinder.isMoving()) return;

      const dx = Math.floor(Math.random() * 20 - 10);
      const dz = Math.floor(Math.random() * 20 - 10);

      const targetX = this.bot.entity.position.x + dx;
      const targetZ = this.bot.entity.position.z + dz;
      const targetY = this.bot.entity.position.y;

      const targetPos = new Vec3(targetX, targetY, targetZ);

      if (this.bot.entity.position.distanceTo(targetPos) > 1) {
        const goal = new GoalNear(targetX, targetY, targetZ, 1);
        this.bot.pathfinder.setGoal(goal);
        logWithTime(this.label, 'Wandering...', 'info');
      }
    };

    const attack = () => {
      if (!this.bot?.entity || this.shuttingDown) return;
      const now = Date.now();
      if (now - this.lastAttackTime < 5000) return;

      const entity = Object.values(this.bot.entities).find(e =>
        e.type === 'mob' &&
        e.position.distanceTo(this.bot.entity.position) < 6 &&
        e.mobType !== 'Armor Stand'
      );

      if (entity) {
        this.bot.lookAt(entity.position.offset(0, entity.height, 0), true, () => {
          this.bot.attack(entity);
          logWithTime(this.label, `Attacked ${entity.name}`, 'warning');
          this.lastAttackTime = now;
        });
      }
    };

    if (this.wanderInterval) clearInterval(this.wanderInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);

    this.wanderInterval = setInterval(wander, STRONG_WANDER_MS);
    this.attackInterval = setInterval(attack, STRONG_ATTACK_MS);
  }

  scheduleReconnect(customDelay = null) {
    if (this.reconnecting || this.shuttingDown) return;
    this.reconnecting = true;
    this.cleanup();
    this.retryCount++;
    const delay = customDelay || Math.min(10000 * this.retryCount, 120000);
    logWithTime(this.label, `Reconnecting in ${(delay / 1000).toFixed(0)}s`, 'error');
    setTimeout(() => {
      this.reconnecting = false;
      this.start();
    }, delay);
  }

  cleanup() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.wanderInterval) clearInterval(this.wanderInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    this.activityTimer = this.wanderInterval = this.attackInterval = this.pruneInterval = null;
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch (e) {}
      this.bot = null;
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this.cleanup();
  }
}

class NodeGroup {
  constructor(config) {
    this.id = config.id || Math.random().toString(36).substr(2, 6);
    this.config = config;
    this.label = config.name ? config.name : `${config.host}:${config.port}`;
    this.instances = [];
    this.min = Math.max(1, parseInt(config.players?.min) || 1);
    this.max = Math.max(this.min, parseInt(config.players?.max) || 1);
    this.targetNodes = this.min;
    this.lastTargetUpdate = 0;
    this.maintInterval = null;
    this.nextNodeId = 1;
    this.enabled = config.enabled !== false;
    this.resolvedVersionIdx = 0;
  }

  start() {
    logWithTime('SYSTEM', `Cluster deployed: ${this.label} [${this.config.mode || 'normal'}]${this.enabled ? '' : ' (paused)'}`, 'success');
    this.maintInterval = setInterval(() => this.maintain(), 15000);
    if (this.enabled) {
      this.updateTarget(true);
      this.maintain();
    }
  }

  updateTarget(force = false) {
    const targetUpdateInterval = 300000 + Math.random() * 300000;
    if (force || Date.now() - this.lastTargetUpdate > targetUpdateInterval) {
      this.targetNodes = Math.floor(Math.random() * (this.max - this.min + 1)) + this.min;
      this.lastTargetUpdate = Date.now();
      if (!force) logWithTime(this.label, `Target capacity updated to ${this.targetNodes}`, 'info');
    }
  }

  maintain() {
    if (!this.enabled) {
      if (this.instances.length) {
        this.instances.forEach(b => b.shutdown());
        this.instances = [];
      }
      this.targetNodes = 0;
      return;
    }

    this.updateTarget();
    const alive = this.instances.filter(b => !b.shuttingDown);
    if (alive.length < this.targetNodes) {
      const node = new ClientInstance(this.config, `${this.label}-#${this.nextNodeId++}`, this);
      this.instances.push(node);
      node.start(Math.floor(Math.random() * 4000) + 1000);
    } else if (alive.length > this.targetNodes) {
      const surplus = alive[alive.length - 1];
      surplus.shutdown();
      this.instances = this.instances.filter(inst => inst !== surplus);
    }
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.config.enabled = true;
    this.updateTarget(true);
    this.maintain();
    logWithTime(this.label, 'Cluster resumed', 'success');
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.config.enabled = false;
    this.instances.forEach(b => b.shutdown());
    this.instances = [];
    this.targetNodes = 0;
    logWithTime(this.label, 'Cluster paused', 'warning');
  }

  stop() {
    if (this.maintInterval) clearInterval(this.maintInterval);
    this.instances.forEach(b => b.shutdown());
    this.instances = [];
  }
}

async function initAll() {
  const configs = await loadConfig();
  configs.forEach(cfg => {
    if (!cfg.id) cfg.id = Math.random().toString(36).substr(2, 6);
    const group = new NodeGroup(cfg);
    serverGroups.set(cfg.id, group);
    group.start();
  });
  await saveConfig(configs);
}

const app = express();
app.use(express.json());
app.use(cookieParser());

const requireAuth = (req, res, next) => {
  if (req.cookies.auth_token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/login', (req, res) => {
  if (req.body.password === PANEL_PASSWORD) {
    res.cookie('auth_token', AUTH_TOKEN, { maxAge: 86400000, httpOnly: true });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Denied' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  const servers = Array.from(serverGroups.values()).map(g => ({
    id: g.id,
    name: g.config.name || '',
    host: g.config.host,
    port: g.config.port,
    username: g.config.username,
    version: g.config.version || 'auto',
    mode: g.config.mode || 'normal',
    enabled: g.enabled,
    min: g.min,
    max: g.max,
    target: g.enabled ? g.targetNodes : 0,
    online: g.instances.filter(b => b.bot?.entity && !b.shuttingDown).length,
    total: g.instances.filter(b => !b.shuttingDown).length
  }));
  res.json({ servers, logs: systemLogs });
});

app.post('/api/servers', requireAuth, async (req, res) => {
  const configs = await loadConfig();
  const reqId = req.body.id;
  const existing = reqId ? configs.find(c => c.id === reqId) : null;

  const min = parseInt(req.body.min) || 1;
  const newConfig = normalizeServer({
    id: reqId || undefined,
    name: req.body.name,
    host: req.body.host,
    port: req.body.port,
    username: req.body.username,
    version: req.body.version,
    mode: req.body.mode,
    enabled: existing ? existing.enabled : (req.body.enabled !== false),
    players: { min, max: Math.max(min, parseInt(req.body.max) || 1) }
  });

  if (!newConfig.host) return res.status(400).json({ error: 'Host required' });

  const existingIdx = configs.findIndex(c => c.id === reqId);
  if (existingIdx > -1) {
    configs[existingIdx] = newConfig;
    if (serverGroups.has(reqId)) {
      serverGroups.get(reqId).stop();
      serverGroups.delete(reqId);
    }
  } else {
    configs.push(newConfig);
  }

  await saveConfig(configs);
  const group = new NodeGroup(newConfig);
  serverGroups.set(newConfig.id, group);
  group.start();
  res.json({ success: true });
});

app.post('/api/servers/:id/toggle', requireAuth, async (req, res) => {
  const configs = await loadConfig();
  const id = req.params.id;
  const idx = configs.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });

  const next = typeof req.body.enabled === 'boolean' ? req.body.enabled : !configs[idx].enabled;
  configs[idx].enabled = next;
  await saveConfig(configs);

  const group = serverGroups.get(id);
  if (group) {
    if (next) group.enable(); else group.disable();
  }
  res.json({ success: true, enabled: next });
});

app.delete('/api/servers/:id', requireAuth, async (req, res) => {
  let configs = await loadConfig();
  const id = req.params.id;
  configs = configs.filter(c => c.id !== id);
  await saveConfig(configs);
  if (serverGroups.has(id)) {
    serverGroups.get(id).stop();
    serverGroups.delete(id);
  }
  res.json({ success: true });
});

app.get('/api/export', requireAuth, async (req, res) => {
  try {
    const configs = await loadConfig();
    res.setHeader('Content-disposition', 'attachment; filename=server_config.json');
    res.setHeader('Content-type', 'application/json');
    res.status(200).send(JSON.stringify(configs, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export configuration' });
  }
});

const FAVICON = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='8'%20fill='%230b1120'/%3E%3Crect%20x='6'%20y='6.5'%20width='20'%20height='7'%20rx='2.2'%20fill='%2338bdf8'/%3E%3Crect%20x='6'%20y='18.5'%20width='20'%20height='7'%20rx='2.2'%20fill='%2334d399'/%3E%3Ccircle%20cx='10'%20cy='10'%20r='1.5'%20fill='%230b1120'/%3E%3Ccircle%20cx='10'%20cy='22'%20r='1.5'%20fill='%230b1120'/%3E%3C/svg%3E";

app.get('/', (req, res) => {
  const isAuthenticated = req.cookies.auth_token === AUTH_TOKEN;
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#0b1120">
    <link rel="icon" type="image/svg+xml" href="${FAVICON}">
    <title>Session Manager Pro</title>
    <style>
        :root {
            --bg-base: #0b1120;
            --glass-bg: rgba(28, 39, 59, 0.5);
            --glass-border: rgba(148, 163, 184, 0.14);
            --glass-hover: rgba(148, 163, 184, 0.10);
            --text-main: #f1f5f9;
            --text-sub: #94a3b8;
            --text-dim: #64748b;
            --accent: #38bdf8;
            --accent-2: #818cf8;
            --accent-dim: rgba(56, 189, 248, 0.15);
            --danger: #fb7185;
            --danger-dim: rgba(251, 113, 133, 0.12);
            --success: #34d399;
            --success-dim: rgba(52, 211, 153, 0.12);
            --warning: #fbbf24;
            --paused: #94a3b8;
            --shadow: 0 10px 40px -12px rgba(0, 0, 0, 0.55);
            --radius: 16px;
        }

        * { box-sizing: border-box; }

        body {
            margin: 0; padding: 0; height: 100vh; overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-base);
            background-image:
                radial-gradient(ellipse 70% 70% at 8% 0%, rgba(56, 189, 248, 0.14) 0%, transparent 55%),
                radial-gradient(ellipse 70% 70% at 92% 100%, rgba(129, 140, 248, 0.16) 0%, transparent 55%),
                radial-gradient(ellipse 60% 60% at 50% 45%, rgba(236, 72, 153, 0.07) 0%, transparent 60%);
            background-size: cover; background-attachment: fixed;
            color: var(--text-main); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased;
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.22); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,0.4); }

        .header {
            height: 52px; padding: 0 22px; display: flex; align-items: center;
            background: var(--glass-bg); backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
            border-bottom: 1px solid var(--glass-border); z-index: 10; flex-shrink: 0;
        }

        .mac-controls { display: flex; gap: 8px; margin-right: 20px; }
        .mac-btn { width: 12px; height: 12px; border-radius: 50%; }
        .mac-close { background: #ff5f56; }
        .mac-min { background: #ffbd2e; }
        .mac-max { background: #27c93f; }

        .brand { display: flex; align-items: center; gap: 9px; }
        .brand-icon { width: 22px; height: 22px; border-radius: 6px; }
        .header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.4px; }
        .spacer { flex: 1; }
        .btn-text {
            background: transparent; border: none; color: var(--text-sub); cursor: pointer;
            font-size: 13px; font-weight: 500; transition: color 0.2s; padding: 6px 10px; border-radius: 8px;
        }
        .btn-text:hover { color: var(--text-main); background: var(--glass-hover); }

        .layout { display: flex; flex: 1; overflow: hidden; padding: 20px; gap: 20px; max-width: 1500px; margin: 0 auto; width: 100%; }

        .glass-panel {
            background: var(--glass-bg); backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
            border: 1px solid var(--glass-border); border-radius: var(--radius); box-shadow: var(--shadow);
            display: flex; flex-direction: column; overflow: hidden;
        }

        .panel-title {
            padding: 13px 18px; font-size: 12px; font-weight: 600; color: var(--text-sub);
            border-bottom: 1px solid var(--glass-border); text-transform: uppercase; letter-spacing: 1px;
            flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px;
        }
        .title-meta { font-size: 10px; font-weight: 500; letter-spacing: 0.4px; color: var(--text-dim); text-transform: none; }

        .pane-main { flex: 1; min-width: 0; }
        .pane-sidebar { flex: 0 0 500px; display: flex; flex-direction: column; gap: 20px; }

        .clusters-split { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
        .cluster-section { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
        .section-online { flex: 7.3; }
        .section-offline { flex: 2.7; border-top: 1px solid var(--glass-border); background: rgba(0,0,0,0.13); }
        .section-label {
            display: flex; align-items: center; gap: 7px; padding: 9px 18px 5px;
            font-size: 10.5px; font-weight: 600; color: var(--text-sub); text-transform: uppercase;
            letter-spacing: 0.7px; flex-shrink: 0;
        }
        .section-label .count {
            margin-left: 2px; color: var(--text-dim); font-weight: 600;
            background: rgba(148,163,184,0.12); padding: 0 7px; border-radius: 8px; font-size: 10px;
        }

        .grid-container {
            flex: 1; overflow-y: auto; padding: 6px 16px 14px;
            display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 11px; align-content: flex-start;
        }
        .empty-hint { grid-column: 1 / -1; text-align: center; color: var(--text-dim); font-size: 11px; padding: 14px 4px; opacity: 0.7; }

        .card {
            background: rgba(255,255,255,0.025); border: 1px solid var(--glass-border); border-radius: 12px;
            padding: 12px 13px 12px 16px; position: relative; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            cursor: pointer; display: flex; flex-direction: column; gap: 9px;
        }
        .card:hover { background: var(--glass-hover); transform: translateY(-2px); border-color: rgba(148,163,184,0.3); box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
        .card.is-off { opacity: 0.6; }
        .card.is-off:hover { opacity: 1; }
        .card::before {
            content: ""; position: absolute; left: 0; top: 11px; bottom: 11px; width: 3px;
            border-radius: 0 3px 3px 0; background: var(--paused);
        }
        .card.s-on::before { background: var(--success); box-shadow: 0 0 10px rgba(52,211,153,0.5); }
        .card.s-sync::before { background: var(--warning); box-shadow: 0 0 10px rgba(251,191,36,0.5); }
        .card.s-off::before { background: var(--danger); }
        .card.s-paused::before { background: var(--paused); }

        .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .card-id { min-width: 0; }
        .card-name { display: block; font-size: 13.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-addr { display: block; font-size: 10.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; font-family: "SF Mono", "Menlo", monospace; }

        .card-mid { display: flex; align-items: center; justify-content: space-between; }
        .status-badge { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-sub); font-weight: 500; }
        .count-big { font-size: 15px; font-weight: 700; }
        .count-sub { font-size: 10px; color: var(--text-dim); font-weight: 400; }

        .card-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .tag {
            display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-sub);
            background: rgba(148,163,184,0.08); border: 1px solid var(--glass-border); padding: 2px 7px; border-radius: 6px; white-space: nowrap;
        }
        .card-foot .btn-del { margin-left: auto; }

        .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .d-on { background: var(--success); box-shadow: 0 0 8px rgba(52,211,153,0.5); }
        .d-sync { background: var(--warning); box-shadow: 0 0 8px rgba(251,191,36,0.5); }
        .d-off { background: var(--danger); box-shadow: 0 0 8px rgba(251,113,133,0.45); }
        .d-paused { background: var(--paused); }

        .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; inset: 0; cursor: pointer; background: rgba(148,163,184,0.28); border-radius: 20px; transition: 0.25s; }
        .slider:before { content: ""; position: absolute; height: 14px; width: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.25s; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
        .switch input:checked + .slider { background: linear-gradient(135deg, var(--success), #10b981); }
        .switch input:checked + .slider:before { transform: translateX(14px); }

        .btn-del { background: transparent; border: none; color: var(--text-dim); cursor: pointer; padding: 2px 6px; border-radius: 6px; font-size: 12px; transition: 0.2s; line-height: 1; }
        .btn-del:hover { background: var(--danger-dim); color: var(--danger); }

        .logs-container { flex: 1; min-height: 0; }
        .form-panel { padding: 16px 20px; flex-shrink: 0; }
        .f-row { display: flex; gap: 12px; margin-bottom: 12px; }
        .f-col { flex: 1; min-width: 0; }
        label { display: block; font-size: 10px; font-weight: 600; color: var(--text-sub); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select {
            width: 100%; padding: 8px 10px; background: rgba(0,0,0,0.22); border: 1px solid var(--glass-border);
            border-radius: 8px; color: var(--text-main); font-size: 12px; outline: none; transition: 0.2s;
        }
        select option { background: var(--bg-base); color: var(--text-main); }
        input:focus, select:focus { border-color: var(--accent); background: rgba(0,0,0,0.32); box-shadow: 0 0 0 2px var(--accent-dim); }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #08111f; border: none; border-radius: 8px;
            padding: 9px 16px; font-size: 12px; font-weight: 650; cursor: pointer; transition: 0.2s;
        }
        .btn-primary:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 6px 18px -6px var(--accent); }
        .btn-secondary { background: transparent; color: var(--text-main); border: 1px solid var(--glass-border); box-shadow: none; }
        .btn-secondary:hover { background: var(--glass-hover); filter: none; box-shadow: none; }

        .log-stream { flex: 1; overflow-y: auto; padding: 12px 16px; font-family: "SF Mono", "Menlo", monospace; font-size: 11px; line-height: 1.5; }
        .log-row { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; gap: 8px; }
        .log-time { color: var(--text-dim); flex-shrink: 0; }
        .log-label { color: var(--accent-2); font-weight: 600; flex-shrink: 0; width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .log-msg { flex: 1; word-break: break-word; }
        .lvl-info { color: var(--text-main); }
        .lvl-success { color: var(--success); }
        .lvl-error { color: var(--danger); background: var(--danger-dim); padding: 0 4px; border-radius: 4px; font-weight: 500; }
        .lvl-warning { color: var(--warning); }

        .auth-wrap { display: flex; height: 100vh; align-items: center; justify-content: center; }
        .auth-box { width: 300px; padding: 34px; text-align: center; }
        .auth-icon { width: 48px; height: 48px; margin: 0 auto 20px; color: var(--accent); }

        @media (max-width: 980px) {
            .layout { flex-direction: column; overflow-y: auto; }
            .pane-sidebar { flex: 0 0 auto; }
            .pane-main { min-height: 60vh; }
        }
    </style>
</head>
<body>
    ${!isAuthenticated ? `
    <div class="auth-wrap">
        <div class="glass-panel auth-box">
            <svg class="auth-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <h2 style="margin:0 0 20px 0; font-size:16px; font-weight:600;">System Login</h2>
            <input type="password" id="pass" placeholder="Password" style="margin-bottom:16px; text-align:center;">
            <button class="btn-primary" style="width:100%; padding:10px;" onclick="login()">Authenticate</button>
        </div>
    </div>
    <script>
        async function login() {
            const res = await fetch('/api/login', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ password: document.getElementById('pass').value })
            });
            if(res.ok) window.location.reload();
            else document.getElementById('pass').value = '';
        }
        document.getElementById('pass').addEventListener('keypress', e => { if(e.key === 'Enter') login(); });
    </script>
    ` : `
    <div class="header">
        <div class="mac-controls"><div class="mac-btn mac-close"></div><div class="mac-btn mac-min"></div><div class="mac-btn mac-max"></div></div>
        <div class="brand">
            <img class="brand-icon" src="${FAVICON}" alt="">
            <h1>Session Manager Pro</h1>
        </div>
        <div class="spacer"></div>
        <button class="btn-text" onclick="exportJSON()">&#11015; Export</button>
        <button class="btn-text" onclick="logout()">&#9211; Lock</button>
    </div>

    <div class="layout">
        <div class="glass-panel pane-main">
            <div class="panel-title">
                <span>Active Clusters</span>
                <span class="title-meta" id="cluster-summary"></span>
            </div>
            <div class="clusters-split">
                <div class="cluster-section section-online">
                    <div class="section-label"><span class="dot d-on"></span> Running <span class="count" id="cnt-online">0</span></div>
                    <div class="grid-container" id="list-online"></div>
                </div>
                <div class="cluster-section section-offline">
                    <div class="section-label"><span class="dot d-paused"></span> Paused / Offline <span class="count" id="cnt-offline">0</span></div>
                    <div class="grid-container" id="list-offline"></div>
                </div>
            </div>
        </div>

        <div class="pane-sidebar">
            <div class="glass-panel logs-container">
                <div class="panel-title">System Stream</div>
                <div class="log-stream" id="logs"></div>
            </div>

            <div class="glass-panel form-panel">
                <div class="panel-title" style="padding: 0 0 12px 0; border: none;" id="f-title">Deploy Configuration</div>
                <input type="hidden" id="edit-id">

                <div class="f-row">
                    <div class="f-col"><label>Name / Remark</label><input type="text" id="cfg-name" placeholder="e.g. Survival Main"></div>
                </div>

                <div class="f-row">
                    <div class="f-col" style="flex:2"><label>Host Address</label><input type="text" id="cfg-host" placeholder="server.example.com"></div>
                    <div class="f-col"><label>Port</label><input type="number" id="cfg-port" value="25565"></div>
                </div>

                <div class="f-row">
                    <div class="f-col" style="flex:1.4"><label>Identity Base</label><input type="text" id="cfg-user" placeholder="Auto-generated"></div>
                    <div class="f-col">
                        <label>Version</label>
                        <input type="text" id="cfg-version" list="version-list" placeholder="auto" value="auto">
                        <datalist id="version-list">
                            <option value="auto"></option>
                            <option value="1.21.8"></option>
                            <option value="1.21.4"></option>
                            <option value="1.21.1"></option>
                            <option value="1.21"></option>
                            <option value="1.20.6"></option>
                            <option value="1.20.4"></option>
                            <option value="1.20.1"></option>
                            <option value="1.19.4"></option>
                            <option value="1.18.2"></option>
                            <option value="1.17.1"></option>
                            <option value="1.16.5"></option>
                            <option value="1.12.2"></option>
                            <option value="1.8.9"></option>
                        </datalist>
                    </div>
                    <div class="f-col">
                        <label>Mode</label>
                        <select id="cfg-mode">
                            <option value="normal">Normal</option>
                            <option value="strong">Strong</option>
                        </select>
                    </div>
                </div>

                <div class="f-row" style="margin-bottom: 14px;">
                    <div class="f-col"><label>Min Nodes</label><input type="number" id="cfg-min" value="1" min="1"></div>
                    <div class="f-col"><label>Max Nodes</label><input type="number" id="cfg-max" value="3" min="1"></div>
                </div>

                <div style="display:flex; gap:8px;">
                    <button class="btn-primary" id="btn-submit" onclick="submitConfig()">Initialize Deployment</button>
                    <button class="btn-primary btn-secondary" id="btn-cancel" style="display:none;" onclick="resetForm()">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentServers = [];
        let lastServerSig = '';
        let lastLogSig = '';

        function esc(str) {
            return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function statusOf(s) {
            if (!s.enabled) return { cls: 's-paused', dot: 'd-paused', txt: 'Paused' };
            if (s.online > 0 && s.online >= s.target) return { cls: 's-on', dot: 'd-on', txt: 'Optimal' };
            if (s.online > 0) return { cls: 's-sync', dot: 'd-sync', txt: 'Syncing' };
            return { cls: 's-off', dot: 'd-off', txt: 'Offline' };
        }

        function cardHTML(s) {
            const st = statusOf(s);
            const modeIcon = s.mode === 'strong' ? '⚔️' : '🛡️';
            const modeName = s.mode.charAt(0).toUpperCase() + s.mode.slice(1);
            const verText = (!s.version || s.version.toLowerCase() === 'auto') ? 'Auto' : s.version;
            const title = s.name || s.host;
            const offCls = s.enabled ? '' : ' is-off';
            return \`
            <div class="card \${st.cls}\${offCls}" onclick="editServer('\${s.id}')">
                <div class="card-top">
                    <div class="card-id">
                        <span class="card-name">\${esc(title)}</span>
                        <span class="card-addr">\${esc(s.host)}:\${s.port}</span>
                    </div>
                    <label class="switch" title="Enable / Disable" onclick="event.stopPropagation()">
                        <input type="checkbox" \${s.enabled ? 'checked' : ''} onchange="toggleServer('\${s.id}', this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="card-mid">
                    <div class="status-badge"><span class="dot \${st.dot}"></span>\${st.txt}</div>
                    <div class="count-big">\${s.online}<span class="count-sub"> / \${s.target}</span></div>
                </div>
                <div class="card-foot">
                    <span class="tag">🧩 \${esc(verText)}</span>
                    <span class="tag">\${modeIcon} \${modeName}</span>
                    <span class="tag">👥 \${s.min}~\${s.max}</span>
                    <button class="btn-del" title="Delete" onclick="event.stopPropagation(); delServer('\${s.id}')">🗑</button>
                </div>
            </div>\`;
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                if (res.status === 401) return window.location.reload();
                const data = await res.json();
                currentServers = data.servers;

                const online = data.servers.filter(s => s.enabled && s.online > 0);
                const offline = data.servers.filter(s => !(s.enabled && s.online > 0));

                const sig = JSON.stringify(data.servers.map(s => [s.id, s.name, s.host, s.port, s.enabled, s.online, s.target, s.version, s.mode, s.min, s.max]));
                if (sig !== lastServerSig) {
                    lastServerSig = sig;
                    document.getElementById('list-online').innerHTML = online.length ? online.map(cardHTML).join('') : '<div class="empty-hint">No running clusters</div>';
                    document.getElementById('list-offline').innerHTML = offline.length ? offline.map(cardHTML).join('') : '<div class="empty-hint">All clusters running</div>';
                    document.getElementById('cnt-online').innerText = online.length;
                    document.getElementById('cnt-offline').innerText = offline.length;
                    const totalBots = data.servers.reduce((a, s) => a + s.online, 0);
                    document.getElementById('cluster-summary').innerText = data.servers.length + ' clusters · ' + totalBots + ' bots online';
                }

                const last = data.logs[data.logs.length - 1];
                const logSig = data.logs.length + ':' + (last ? last.t + last.m : '');
                if (logSig !== lastLogSig) {
                    lastLogSig = logSig;
                    const logBox = document.getElementById('logs');
                    const wasAtBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 12;
                    logBox.innerHTML = data.logs.map(l => \`
                        <div class="log-row">
                            <div class="log-time">\${l.t.split(' ')[1]}</div>
                            <div class="log-label">\${esc(l.l)}</div>
                            <div class="log-msg lvl-\${l.lvl}">\${esc(l.m)}</div>
                        </div>\`).join('');
                    if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight;
                }
            } catch (e) {}
        }

        async function toggleServer(id, checked) {
            try {
                await fetch('/api/servers/' + id + '/toggle', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ enabled: checked })
                });
            } catch (e) {}
            lastServerSig = '';
            fetchStatus();
        }

        function editServer(id) {
            const s = currentServers.find(x => x.id === id);
            if (!s) return;
            document.getElementById('edit-id').value = s.id;
            document.getElementById('cfg-name').value = s.name || '';
            document.getElementById('cfg-host').value = s.host;
            document.getElementById('cfg-port').value = s.port;
            document.getElementById('cfg-user').value = s.username || '';
            document.getElementById('cfg-version').value = s.version || 'auto';
            document.getElementById('cfg-mode').value = s.mode || 'normal';
            document.getElementById('cfg-min').value = s.min;
            document.getElementById('cfg-max').value = s.max;
            document.getElementById('f-title').innerText = 'Modify Configuration';
            document.getElementById('btn-submit').innerText = 'Update Deployment';
            document.getElementById('btn-cancel').style.display = 'block';
        }

        function resetForm() {
            document.getElementById('edit-id').value = '';
            document.getElementById('cfg-name').value = '';
            document.getElementById('cfg-host').value = '';
            document.getElementById('cfg-port').value = '25565';
            document.getElementById('cfg-user').value = '';
            document.getElementById('cfg-version').value = 'auto';
            document.getElementById('cfg-mode').value = 'normal';
            document.getElementById('cfg-min').value = '1';
            document.getElementById('cfg-max').value = '3';
            document.getElementById('f-title').innerText = 'Deploy Configuration';
            document.getElementById('btn-submit').innerText = 'Initialize Deployment';
            document.getElementById('btn-cancel').style.display = 'none';
        }

        async function submitConfig() {
            const host = document.getElementById('cfg-host').value.trim();
            if (!host) return;
            await fetch('/api/servers', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    id: document.getElementById('edit-id').value,
                    name: document.getElementById('cfg-name').value,
                    host: host,
                    port: document.getElementById('cfg-port').value,
                    username: document.getElementById('cfg-user').value,
                    version: document.getElementById('cfg-version').value,
                    mode: document.getElementById('cfg-mode').value,
                    min: document.getElementById('cfg-min').value,
                    max: document.getElementById('cfg-max').value
                })
            });
            resetForm();
            lastServerSig = '';
            fetchStatus();
        }

        async function delServer(id) {
            await fetch('/api/servers/' + id, { method: 'DELETE' });
            if (document.getElementById('edit-id').value === id) resetForm();
            lastServerSig = '';
            fetchStatus();
        }

        function exportJSON() {
            window.location.href = '/api/export';
        }

        async function logout() {
            await fetch('/api/logout', { method: 'POST' });
            window.location.reload();
        }

        setInterval(fetchStatus, 2000);
        fetchStatus();
    </script>
    `}
</body>
</html>
  `;
  res.send(html);
});

app.listen(WEB_PORT, '0.0.0.0', () => {
  logWithTime('SYSTEM', `Panel listening on port ${WEB_PORT}`, 'success');
  initAll().catch(err => {
    logWithTime('SYSTEM', 'Failed to initialize clusters: ' + err.message, 'error');
  });
});

const shutdown = () => {
  serverGroups.forEach(g => g.stop());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => { if (err.code !== 'ECONNRESET') {} });

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

const DEFAULT_VERSIONS = [false, '1.21','1.21.11', '1.21.8', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5', '1.12.2'];

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

async function loadConfig() {
  if (CONFIG_URL) {
    try {
      const res = await fetch(CONFIG_URL, {
        headers: { 'X-Secret': CONFIG_SECRET }
      });
      if (res.ok) {
        const data = await res.json();
        cachedConfig = Array.isArray(data) ? data : [];
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
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); 
    if (!Array.isArray(cachedConfig)) cachedConfig = [];
    return cachedConfig;
  } catch (e) { 
    return []; 
  }
}

async function saveConfig(config) {
  cachedConfig = config;
  
  // 1. 始终先保存到本地
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  // 2. 如果设置了远程 URL，推送到远程服务器
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
  constructor(serverConfig, idLabel) {
    this.config = serverConfig;
    this.label = idLabel;
    this.mode = this.config.mode || 'normal'; 
    this.bot = null;
    this.reconnecting = false;
    this.shuttingDown = false;
    this.retryCount = 0;
    this.username = generateUsername(this.config.username);
    this.currentVersionIdx = 0;
    this.versionMatched = false;
    
    this.activityTimer = null;
    this.wanderInterval = null;
    this.attackInterval = null;
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
    
    const rawVersion = (this.config.version || 'auto').trim();
    const isAuto = rawVersion.toLowerCase() === 'auto' || rawVersion === '';
    const version = isAuto ? DEFAULT_VERSIONS[this.currentVersionIdx] : rawVersion;
    
    const options = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.username,
      version: version,
      physicsEnabled: this.mode === 'strong', 
      hideErrors: true
    };

    const verLabel = version === false ? 'Auto' : version;
    logWithTime(this.label, `Auth [Mode: ${this.mode.toUpperCase()}] [Ver: ${verLabel}]`);
    this.bot = mineflayer.createBot(options);

    if (this.mode === 'strong') {
      this.bot.loadPlugin(pathfinder);
    }

    this.bot.on('login', () => {
      this.versionMatched = true;
      logWithTime(this.label, 'Session established', 'success');
      this.reconnecting = false;
      this.retryCount = 0;
      
      if (this.mode === 'normal') {
          this.startNormalBehavior();
      }
    });

    this.bot.on('spawn', () => {
      if (this.mode === 'strong' && !this.wanderInterval) {
          logWithTime(this.label, 'Spawned. Starting Strong Keep-Alive', 'success');
          this.startStrongBehavior();
      }
    });

    const handleDisconnect = (reason, isKick = false) => {
      if (this.shuttingDown) return;
      const msg = parseDisconnectReason(reason);

      if (!this.versionMatched) {
        if (isAuto) {
          this.currentVersionIdx = (this.currentVersionIdx + 1) % DEFAULT_VERSIONS.length;
          logWithTime(this.label, `Handshake/Ver error, trying next...`, 'warning');
        } else {
          logWithTime(this.label, `Custom Version [${rawVersion}] might be wrong! Kick: ${msg}`, 'error');
        }
      } else if (isKick) {
        logWithTime(this.label, `Kicked: ${msg}`, 'error');
      } else {
        logWithTime(this.label, 'Disconnected', 'error');
      }
      
      this.scheduleReconnect(msg.toLowerCase().includes('throttle') ? 30000 : null);
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

  startNormalBehavior() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    const doAction = () => {
      if (!this.bot?.entity || this.shuttingDown) return;
      try {
        const actions = ['look', 'jump', 'sneak', 'swing'];
        const action = actions[Math.floor(Math.random() * actions.length)];
        switch(action) {
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
      } catch(e) {}
      
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

    this.wanderInterval = setInterval(wander, 30000);
    this.attackInterval = setInterval(attack, 1000);
  }

  scheduleReconnect(customDelay = null) {
    if (this.reconnecting || this.shuttingDown) return;
    this.reconnecting = true;
    this.cleanup();
    this.retryCount++;
    const delay = customDelay || Math.min(10000 * this.retryCount, 120000);
    logWithTime(this.label, `Reconnecting in ${(delay/1000).toFixed(0)}s`, 'error');
    setTimeout(() => {
      this.reconnecting = false;
      this.start();
    }, delay);
  }

  cleanup() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.wanderInterval) clearInterval(this.wanderInterval);
    if (this.attackInterval) clearInterval(this.attackInterval);
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch(e){}
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
    this.label = `${config.host}:${config.port}`;
    this.instances = [];
    this.min = Math.max(1, parseInt(config.players?.min) || 1);
    this.max = Math.max(this.min, parseInt(config.players?.max) || 1);
    this.targetNodes = this.min; 
    this.lastTargetUpdate = 0;
    this.maintInterval = null;
    this.nextNodeId = 1;
  }

  start() {
    this.updateTarget(true);
    logWithTime('SYSTEM', `Cluster deployed: ${this.label} [${this.config.mode || 'normal'}]`, 'success');
    this.maintInterval = setInterval(() => this.maintain(), 15000);
    this.maintain();
  }
  
  updateTarget(force = false) {
      const targetUpdateInterval = 300000 + Math.random() * 300000;
      if (force || Date.now() - this.lastTargetUpdate > targetUpdateInterval) {
          this.targetNodes = Math.floor(Math.random() * (this.max - this.min + 1)) + this.min;
          this.lastTargetUpdate = Date.now();
          if(!force) logWithTime(this.label, `Target capacity updated to ${this.targetNodes}`, 'info');
      }
  }

  maintain() {
    this.updateTarget();
    const alive = this.instances.filter(b => !b.shuttingDown);
    if (alive.length < this.targetNodes) {
      const node = new ClientInstance(this.config, `${this.label}-#${this.nextNodeId++}`);
      this.instances.push(node);
      node.start(Math.floor(Math.random() * 4000) + 1000);
    } else if (alive.length > this.targetNodes) {
      const surplus = alive[alive.length - 1];
      surplus.shutdown();
      this.instances = this.instances.filter(inst => inst !== surplus);
    }
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
  const status = Array.from(serverGroups.values()).map(g => ({
    id: g.id,
    host: g.config.host,
    port: g.config.port,
    username: g.config.username,
    version: g.config.version || 'auto',
    mode: g.config.mode || 'normal',
    min: g.min,
    max: g.max,
    target: g.targetNodes,
    online: g.instances.filter(b => b.bot?.entity && !b.shuttingDown).length,
    total: g.instances.filter(b => !b.shuttingDown).length
  }));
  res.json({ servers: status, logs: systemLogs });
});

app.post('/api/servers', requireAuth, async (req, res) => {
  const configs = await loadConfig();
  const reqId = req.body.id;
  const newConfig = {
    id: reqId || Math.random().toString(36).substr(2, 6),
    host: req.body.host,
    port: parseInt(req.body.port) || 25565,
    username: req.body.username || '',
    version: req.body.version || 'auto',
    mode: req.body.mode || 'normal',
    players: {
      min: parseInt(req.body.min) || 1,
      max: Math.max(parseInt(req.body.min) || 1, parseInt(req.body.max) || 1)
    }
  };

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

app.get('/', (req, res) => {
  const isAuthenticated = req.cookies.auth_token === AUTH_TOKEN;
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Manager Pro</title>
    <style>
        :root {
            --bg-base: #0f172a;
            --glass-bg: rgba(30, 41, 59, 0.4);
            --glass-border: rgba(255, 255, 255, 0.08);
            --glass-hover: rgba(255, 255, 255, 0.12);
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
            --accent: #38bdf8;
            --accent-dim: rgba(56, 189, 248, 0.15);
            --danger: #f87171;
            --danger-dim: rgba(248, 113, 113, 0.1);
            --success: #34d399;
            --warning: #fbbf24;
            --shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5);
        }
        
        body {
            margin: 0; padding: 0; height: 100vh; overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-base);
            background-image: 
                radial-gradient(ellipse at 10% 10%, rgba(76, 29, 149, 0.6) 0%, transparent 70%),
                radial-gradient(ellipse at 90% 90%, rgba(14, 116, 144, 0.6) 0%, transparent 70%),
                radial-gradient(ellipse at 50% 50%, rgba(190, 24, 93, 0.25) 0%, transparent 70%);
            background-size: cover; background-attachment: fixed;
            color: var(--text-main); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased;
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 10px; }

        .header {
            height: 52px; padding: 0 24px; display: flex; align-items: center;
            background: var(--glass-bg); backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
            border-bottom: 1px solid var(--glass-border); z-index: 10; flex-shrink: 0;
        }
        
        .mac-controls { display: flex; gap: 8px; margin-right: 20px; }
        .mac-btn { width: 12px; height: 12px; border-radius: 50%; }
        .mac-close { background: #ff5f56; }
        .mac-min { background: #ffbd2e; }
        .mac-max { background: #27c93f; }

        .header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.5px; }
        .spacer { flex: 1; }
        .btn-text { background: transparent; border: none; color: var(--text-sub); cursor: pointer; font-size: 13px; font-weight: 500; transition: color 0.2s; }
        .btn-text:hover { color: var(--text-main); }

        .layout { display: flex; flex: 1; overflow: hidden; padding: 20px; gap: 20px; max-width: 1500px; margin: 0 auto; width: 100%; box-sizing: border-box; }
        
        .glass-panel {
            background: var(--glass-bg); backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
            border: 1px solid var(--glass-border); border-radius: 16px; box-shadow: var(--shadow);
            display: flex; flex-direction: column; overflow: hidden;
        }

        .panel-title {
            padding: 14px 20px; font-size: 12px; font-weight: 600; color: var(--text-sub);
            border-bottom: 1px solid var(--glass-border); text-transform: uppercase; letter-spacing: 1px; flex-shrink: 0;
        }

        .pane-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .pane-sidebar { flex: 0 0 500px; display: flex; flex-direction: column; gap: 20px; background: transparent; border: none; box-shadow: none; backdrop-filter: none; }
        
        .clusters-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .grid-container {
            flex: 1; overflow-y: auto; padding: 16px;
            display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; align-content: flex-start;
        }
        
        .card {
            background: rgba(255,255,255,0.03); border: 1px solid var(--glass-border); border-radius: 12px;
            padding: 14px; position: relative; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer;
        }
        .card:hover { background: var(--glass-hover); transform: translateY(-2px); border-color: rgba(255,255,255,0.2); box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
        .card h3 { margin: 0 0 10px 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
        
        .card-stats { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .status-badge { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-sub); font-weight: 500; }
        .dot { width: 8px; height: 8px; border-radius: 50%; }
        .d-on { background: var(--success); box-shadow: 0 0 8px rgba(52,211,153,0.4); }
        .d-sync { background: var(--warning); box-shadow: 0 0 8px rgba(251,191,36,0.4); }
        .d-off { background: var(--danger); box-shadow: 0 0 8px rgba(248,113,113,0.4); }
        
        .btn-del {
            position: absolute; top: 10px; right: 10px; background: transparent; border: none;
            color: var(--text-sub); cursor: pointer; padding: 4px; border-radius: 6px; font-size: 12px; transition: 0.2s;
        }
        .btn-del:hover { background: var(--danger-dim); color: var(--danger); }

        .form-panel { padding: 16px 20px; flex-shrink: 0; }
        .f-row { display: flex; gap: 12px; margin-bottom: 12px; }
        .f-col { flex: 1; }
        label { display: block; font-size: 10px; font-weight: 600; color: var(--text-sub); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select {
            width: 100%; padding: 8px 10px; background: rgba(0,0,0,0.2); border: 1px solid var(--glass-border);
            border-radius: 6px; color: var(--text-main); font-size: 12px; box-sizing: border-box; outline: none; transition: 0.2s;
        }
        select option { background: var(--bg-base); color: var(--text-main); }
        input:focus, select:focus { border-color: var(--accent); background: rgba(0,0,0,0.3); box-shadow: 0 0 0 2px var(--accent-dim); }
        
        .btn-primary {
            background: var(--text-main); color: #0f172a; border: none; border-radius: 6px;
            padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s;
        }
        .btn-primary:hover { background: #e2e8f0; transform: translateY(-1px); }
        .btn-secondary { background: transparent; color: var(--text-main); border: 1px solid var(--glass-border); }
        .btn-secondary:hover { background: var(--glass-hover); }

        .log-stream { flex: 1; overflow-y: auto; padding: 12px 16px; font-family: "SF Mono", "Menlo", monospace; font-size: 11px; line-height: 1.5; }
        .log-row { padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; gap: 8px; }
        .log-time { color: var(--text-sub); flex-shrink: 0; }
        .log-label { color: #818cf8; font-weight: 600; flex-shrink: 0; width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .log-msg { flex: 1; word-break: break-all; }
        .lvl-info { color: var(--text-main); }
        .lvl-success { color: var(--success); }
        .lvl-error { color: var(--danger); background: var(--danger-dim); padding: 0 4px; border-radius: 4px; font-weight: 500; }
        .lvl-warning { color: var(--warning); }

        .auth-wrap { display: flex; height: 100vh; align-items: center; justify-content: center; }
        .auth-box { width: 280px; padding: 32px; text-align: center; }
        .auth-icon { width: 48px; height: 48px; margin: 0 auto 20px; opacity: 0.8; }
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
        <h1>Session Manager Pro</h1>
        <div class="spacer"></div>
        <button class="btn-text" onclick="exportJSON()" style="margin-right: 16px;">📥 Export JSON</button>
        <button class="btn-text" onclick="logout()">Lock Session</button>
    </div>

    <div class="layout">
        <div class="glass-panel pane-main">
            <div class="panel-title">System Stream</div>
            <div class="log-stream" id="logs"></div>
        </div>

        <div class="pane-sidebar">
            <div class="glass-panel clusters-container">
                <div class="panel-title">Active Clusters</div>
                <div class="grid-container" id="server-list"></div>
            </div>

            <div class="glass-panel form-panel">
                <div class="panel-title" style="padding: 0 0 12px 0; border: none;" id="f-title">Deploy Configuration</div>
                <input type="hidden" id="edit-id">
                
                <div class="f-row">
                    <div class="f-col" style="flex:2"><label>Host Address</label><input type="text" id="cfg-host" placeholder="server.example.com"></div>
                    <div class="f-col"><label>Port</label><input type="number" id="cfg-port" value="25565"></div>
                </div>
                
                <div class="f-row">
                    <div class="f-col" style="flex:1.5"><label>Identity Base</label><input type="text" id="cfg-user" placeholder="Auto-generated"></div>
                    <div class="f-col">
                        <label>Version</label>
                        <input type="text" id="cfg-version" list="version-list" placeholder="Auto / e.g. 1.8.9" value="auto">
                        <datalist id="version-list">
                            <option value="auto">
                            <option value="1.21">
                            <option value="1.20.4">
                            <option value="1.20.1">
                            <option value="1.19.4">
                            <option value="1.19.2">
                            <option value="1.18.2">
                            <option value="1.16.5">
                            <option value="1.12.2">
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
                
                <div class="f-row" style="margin-bottom: 16px;">
                    <div class="f-col"><label>Min Nodes</label><input type="number" id="cfg-min" value="1"></div>
                    <div class="f-col"><label>Max Nodes</label><input type="number" id="cfg-max" value="3"></div>
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
        
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                if (res.status === 401) return window.location.reload();
                const data = await res.json();
                currentServers = data.servers;
                
                const list = document.getElementById('server-list');
                list.innerHTML = data.servers.map(s => {
                    let dClass = 'd-off'; let txt = 'Offline';
                    if (s.online > 0 && s.online >= s.target) { dClass = 'd-on'; txt = 'Optimal'; }
                    else if (s.online > 0) { dClass = 'd-sync'; txt = 'Syncing'; }
                    
                    const modeIcon = s.mode === 'strong' ? '⚔️' : '🛡️';
                    const verText = (!s.version || s.version.toLowerCase() === 'auto') ? 'Auto' : s.version;

                    return \`
                    <div class="card" onclick="editServer('\${s.id}')">
                        <button class="btn-del" onclick="event.stopPropagation(); delServer('\${s.id}')">✕</button>
                        <h3>\${s.host}<span style="color:var(--text-sub);font-size:11px;font-weight:400;">:\${s.port}</span></h3>
                        <div class="card-stats">
                            <div class="status-badge"><div class="dot \${dClass}"></div>\${txt}</div>
                            <div style="font-size:14px; font-weight:600;">\${s.online}<span style="font-size:10px; color:var(--text-sub); font-weight:400;"> / \${s.target}</span></div>
                        </div>
                        <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-sub); margin-top:4px;">
                            <span>Ver: \${verText}</span>
                            <span>\${s.min}~\${s.max}u</span>
                            <span>\${modeIcon} \${s.mode.charAt(0).toUpperCase() + s.mode.slice(1)}</span>
                        </div>
                    </div>
                \`;}).join('');

                const logBox = document.getElementById('logs');
                const wasAtBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 10;
                logBox.innerHTML = data.logs.map(l => \`
                    <div class="log-row">
                        <div class="log-time">\${l.t.split(' ')[1]}</div>
                        <div class="log-label">\${l.l}</div>
                        <div class="log-msg lvl-\${l.lvl}">\${l.m}</div>
                    </div>
                \`).join('');
                if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight;
            } catch(e) {}
        }

        function editServer(id) {
            const s = currentServers.find(x => x.id === id);
            if(!s) return;
            document.getElementById('edit-id').value = s.id;
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
            const host = document.getElementById('cfg-host').value;
            if (!host) return;
            await fetch('/api/servers', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    id: document.getElementById('edit-id').value,
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
            fetchStatus();
        }

        async function delServer(id) {
            await fetch(\`/api/servers/\${id}\`, { method: 'DELETE' });
            if(document.getElementById('edit-id').value === id) resetForm();
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

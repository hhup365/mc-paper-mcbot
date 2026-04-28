#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');
const mineflayer = require('mineflayer');
const express = require('express');
const cookieParser = require('cookie-parser');

// ====================== Configuration ======================
const CONFIG_FILE = path.join(__dirname, 'server.json');
const WEB_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const AUTH_TOKEN = Math.random().toString(36).substring(2, 15); // Random session token per boot

const DEFAULT_FALLBACK_VERSIONS = [false, '1.20.4', '1.20.1', '1.19.2', '1.18.2'];

let serverGroups = new Map();
let systemLogs = [];

// ====================== Utilities ======================
function logWithTime(label, msg) {
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logStr = `[${now}] [${label}] ${msg}`;
  console.log(logStr);
  
  systemLogs.push(logStr);
  if (systemLogs.length > 200) systemLogs.shift();
}

function generateUsername(base) {
  if (base) return base;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let name = 'C_';
  for (let i = 0; i < 6; i++) name += chars[Math.floor(Math.random() * chars.length)];
  return name;
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

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify([], null, 2), 'utf-8');
    return [];
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } 
  catch (e) { return []; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ====================== Virtual Client Logic ======================
class ClientInstance {
  constructor(serverConfig, idLabel) {
    this.config = serverConfig;
    this.label = idLabel;
    this.bot = null;
    this.reconnecting = false;
    this.shuttingDown = false;
    this.activityTimer = null;
    this.retryCount = 0;
    this.username = generateUsername(this.config.username);
    this.fallbackVersions = Array.isArray(this.config.fallbackVersions) ? this.config.fallbackVersions : DEFAULT_FALLBACK_VERSIONS;
    this.currentVersionIdx = 0;
  }

  async start() {
    if (this.shuttingDown) return;
    const reachable = await tcpPing(this.config.host, this.config.port);
    if (!reachable) {
      logWithTime(this.label, 'Error: Host unreachable. Retrying...');
      this.scheduleReconnect(15000);
      return;
    }
    this.createClient();
  }

  createClient() {
    if (this.reconnecting || this.shuttingDown) return;
    const version = this.fallbackVersions[this.currentVersionIdx];
    
    // Core memory/CPU optimization
    const options = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.username,
      version: version,
      physicsEnabled: false, 
      viewDistance: 'tiny',
      hideErrors: true
    };

    logWithTime(this.label, `Initializing session: ${this.username} (Protocol: ${version || 'Auto'})`);
    this.bot = mineflayer.createBot(options);

    this.bot.on('login', () => {
      logWithTime(this.label, `Connection established`);
      this.reconnecting = false;
      this.retryCount = 0;
      this.startActivityLoop();
    });

    this.bot.on('error', (err) => {
      const msg = err.message || '';
      if (msg.includes('protocol version') || msg.includes('decode packet')) {
        this.currentVersionIdx = (this.currentVersionIdx + 1) % this.fallbackVersions.length;
      }
      this.scheduleReconnect();
    });

    this.bot.on('end', () => {
      if (!this.shuttingDown) logWithTime(this.label, `Connection dropped`);
      this.scheduleReconnect();
    });
    
    this.bot.on('kicked', (reason) => {
      logWithTime(this.label, `Session terminated by host`);
      this.scheduleReconnect();
    });
  }

  // Covert background activity every 2.5 minutes (150s)
  startActivityLoop() {
    if (this.activityTimer) clearInterval(this.activityTimer);
    
    this.activityTimer = setInterval(() => {
      if (!this.bot?.entity || this.shuttingDown) return;
      
      const rand = Math.random();
      if (rand < 0.33) {
        this.bot.swingArm('right');
        logWithTime(this.label, 'Activity: Sync state (0x1)');
      } else if (rand < 0.66) {
        this.bot.setControlState('sneak', true);
        setTimeout(() => this.bot.setControlState('sneak', false), 500);
        logWithTime(this.label, 'Activity: Update pose (0x2)');
      } else {
        const yaw = this.bot.entity.yaw + (Math.random() - 0.5);
        this.bot.look(yaw, this.bot.entity.pitch, true);
        logWithTime(this.label, 'Activity: Update rotation (0x3)');
      }
    }, 150000);
  }

  scheduleReconnect(customDelay = null) {
    if (this.reconnecting || this.shuttingDown) return;
    this.reconnecting = true;
    this.cleanup();
    
    this.retryCount++;
    const delay = customDelay || Math.min(10000 * this.retryCount, 120000);
    logWithTime(this.label, `Reconnecting in ${(delay/1000).toFixed(0)}s...`);
    
    setTimeout(() => {
      this.reconnecting = false;
      this.start();
    }, delay);
  }

  cleanup() {
    if (this.activityTimer) clearInterval(this.activityTimer);
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

// ====================== Node Group Manager ======================
class NodeGroup {
  constructor(config) {
    this.id = config.id || Math.random().toString(36).substr(2, 6);
    this.config = config;
    this.label = `${config.host}:${config.port}`;
    this.instances = [];
    this.min = Math.max(1, config.players?.min || 1);
    this.max = Math.max(this.min, config.players?.max || 1);
    this.maintInterval = null;
    this.nextNodeId = 1;
  }

  start() {
    logWithTime('SYSTEM', `Cluster started [${this.label}] (Target nodes: ${this.min}-${this.max})`);
    for (let i = 0; i < this.min; i++) this.addNode();
    this.maintInterval = setInterval(() => this.maintain(), 15000);
  }

  addNode() {
    const node = new ClientInstance(this.config, `${this.label}-#${this.nextNodeId++}`);
    this.instances.push(node);
    node.start();
  }

  maintain() {
    const alive = this.instances.filter(b => !b.shuttingDown);
    if (alive.length < this.min) {
      const need = this.min - alive.length;
      for (let i = 0; i < need; i++) this.addNode();
    } else if (alive.length > this.max) {
      const surplus = alive.slice(this.max);
      surplus.forEach(b => {
          b.shutdown();
          this.instances = this.instances.filter(inst => inst !== b);
      });
    }
  }

  stop() {
    if (this.maintInterval) clearInterval(this.maintInterval);
    this.instances.forEach(b => b.shutdown());
    this.instances = [];
  }
}

function reloadClusters() {
  const configs = loadConfig();
  for (const [id, group] of serverGroups) group.stop();
  serverGroups.clear();

  configs.forEach(cfg => {
    if (!cfg.id) cfg.id = Math.random().toString(36).substr(2, 6);
    const group = new NodeGroup(cfg);
    serverGroups.set(cfg.id, group);
    group.start();
  });
  saveConfig(configs);
}

// ====================== Web Dashboard (Mac Style) ======================
const app = express();
app.use(express.json());
app.use(cookieParser());

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (req.cookies.auth_token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// Login Route
app.post('/api/login', (req, res) => {
  if (req.body.password === PANEL_PASSWORD) {
    res.cookie('auth_token', AUTH_TOKEN, { maxAge: 86400000, httpOnly: true });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// API Routes (Protected)
app.get('/api/status', requireAuth, (req, res) => {
  const status = Array.from(serverGroups.values()).map(g => ({
    id: g.id,
    host: g.config.host,
    port: g.config.port,
    min: g.min,
    max: g.max,
    online: g.instances.filter(b => b.bot?.entity && !b.shuttingDown).length,
    total: g.instances.filter(b => !b.shuttingDown).length
  }));
  res.json({ servers: status, logs: systemLogs });
});

app.post('/api/servers', requireAuth, (req, res) => {
  const configs = loadConfig();
  const newServer = {
    id: Math.random().toString(36).substr(2, 6),
    host: req.body.host || 'localhost',
    port: parseInt(req.body.port) || 25565,
    username: req.body.username || '',
    version: req.body.version === 'auto' ? false : req.body.version,
    players: {
      min: parseInt(req.body.min) || 1,
      max: parseInt(req.body.max) || 1
    }
  };
  configs.push(newServer);
  saveConfig(configs);
  reloadClusters();
  res.json({ success: true });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  let configs = loadConfig();
  configs = configs.filter(c => c.id !== req.params.id);
  saveConfig(configs);
  reloadClusters();
  res.json({ success: true });
});

// UI Render
app.get('/', (req, res) => {
  const isAuthenticated = req.cookies.auth_token === AUTH_TOKEN;
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Manager</title>
    <!-- Clean Minimalist SVG Favicon -->
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%231c1c1e'/><circle cx='50' cy='50' r='20' fill='%230a84ff'/><circle cx='50' cy='50' r='10' fill='%231c1c1e'/></svg>">
    <style>
        :root {
            --bg: #000000;
            --surface: rgba(28, 28, 30, 0.7);
            --border: rgba(255, 255, 255, 0.1);
            --text: #f5f5f7;
            --text-muted: #86868b;
            --primary: #0a84ff;
            --danger: #ff453a;
            --success: #32d74b;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 40px 20px;
            -webkit-font-smoothing: antialiased;
        }
        .container { max-width: 1000px; margin: 0 auto; }
        
        /* Mac Window Frame Style */
        .mac-window {
            background: var(--surface);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            margin-bottom: 24px;
        }
        .mac-header {
            background: rgba(255,255,255,0.05);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            border-bottom: 1px solid var(--border);
        }
        .mac-dots { display: flex; gap: 8px; flex: 1; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        .dot.red { background: #ff5f56; }
        .dot.yellow { background: #ffbd2e; }
        .dot.green { background: #27c93f; }
        .mac-title { flex: 2; text-align: center; font-weight: 500; font-size: 14px; color: var(--text-muted); }
        .mac-spacer { flex: 1; text-align: right; }

        .mac-content { padding: 20px; }

        /* General UI */
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
        .card {
            background: rgba(255,255,255,0.03);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px;
            transition: all 0.2s;
        }
        .card:hover { background: rgba(255,255,255,0.06); }
        h3 { margin: 0 0 12px 0; font-size: 16px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
        p { margin: 6px 0; font-size: 13px; color: var(--text-muted); }
        
        input {
            width: 100%; padding: 10px 12px; margin-top: 4px;
            background: rgba(0,0,0,0.3); border: 1px solid var(--border);
            color: var(--text); border-radius: 8px; box-sizing: border-box;
            font-family: inherit; font-size: 14px; outline: none; transition: border 0.2s;
        }
        input:focus { border-color: var(--primary); }
        .form-group { margin-bottom: 12px; }
        .form-group label { font-size: 12px; font-weight: 500; color: var(--text-muted); }

        button {
            background: var(--primary); color: white; border: none;
            padding: 10px 16px; border-radius: 8px; font-weight: 500;
            cursor: pointer; transition: all 0.2s; font-size: 14px; width: 100%;
        }
        button:hover { filter: brightness(1.1); transform: translateY(-1px); }
        button.danger { background: rgba(255, 69, 58, 0.15); color: var(--danger); border: 1px solid rgba(255,69,58,0.3); }
        button.danger:hover { background: var(--danger); color: white; }
        button.text-btn { background: transparent; color: var(--text-muted); width: auto; padding: 4px 8px; font-size: 12px; }
        button.text-btn:hover { color: var(--text); transform: none; }

        .terminal {
            background: #000; padding: 16px; border-radius: 8px;
            height: 250px; overflow-y: auto; font-family: "Menlo", "Monaco", "Courier New", monospace;
            font-size: 12px; color: #a1a1aa; border: 1px solid var(--border);
            line-height: 1.5;
        }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .dot-on { background: var(--success); box-shadow: 0 0 8px var(--success); }
        .dot-off { background: var(--danger); }
        
        /* Login screen specifics */
        .login-box { max-width: 320px; margin: 100px auto; text-align: center; }
        .login-box svg { width: 64px; height: 64px; margin-bottom: 24px; }
    </style>
</head>
<body>
    ${!isAuthenticated ? `
    <!-- LOGIN SCREEN -->
    <div class="mac-window login-box">
        <div class="mac-header">
            <div class="mac-dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
            <div class="mac-title">Auth</div><div class="mac-spacer"></div>
        </div>
        <div class="mac-content">
            <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='rgba(255,255,255,0.05)'/><circle cx='50' cy='50' r='20' fill='#0a84ff'/><circle cx='50' cy='50' r='10' fill='#1c1c1e'/></svg>
            <h2 style="margin:0 0 20px 0; font-size:18px;">Session Manager</h2>
            <input type="password" id="pass" placeholder="Enter security key" style="margin-bottom: 16px; text-align:center;">
            <button onclick="login()">Authenticate</button>
        </div>
    </div>
    <script>
        async function login() {
            const res = await fetch('/api/login', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ password: document.getElementById('pass').value })
            });
            if(res.ok) window.location.reload();
            else { alert('Access Denied'); document.getElementById('pass').value = ''; }
        }
        document.getElementById('pass').addEventListener('keypress', e => { if(e.key === 'Enter') login(); });
    </script>
    ` : `
    <!-- DASHBOARD SCREEN -->
    <div class="container">
        <div class="mac-window">
            <div class="mac-header">
                <div class="mac-dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
                <div class="mac-title">Session Manager Overview</div>
                <div class="mac-spacer"><button class="text-btn" onclick="logout()">Lock</button></div>
            </div>
            
            <div class="mac-content">
                <div style="display: flex; gap: 24px; flex-wrap: wrap;">
                    
                    <div style="flex: 2; min-width: 280px;">
                        <h3 style="margin-bottom: 16px; color: var(--text-muted); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">Active Clusters</h3>
                        <div class="grid" id="server-list"><span style="color:#666;font-size:13px;">Loading data...</span></div>
                    </div>

                    <div style="flex: 1; min-width: 260px;">
                        <div class="card" style="background: rgba(10, 132, 255, 0.05); border-color: rgba(10, 132, 255, 0.2);">
                            <h3 style="color: var(--primary);">Deploy New Cluster</h3>
                            <div class="form-group"><label>Target Host</label><input type="text" id="add-host" placeholder="node.example.com"></div>
                            <div style="display: flex; gap: 10px;">
                                <div class="form-group" style="flex:2"><label>Port</label><input type="number" id="add-port" value="25565"></div>
                                <div class="form-group" style="flex:1"><label>Base ID</label><input type="text" id="add-user" placeholder="Opt"></div>
                            </div>
                            <div style="display: flex; gap: 10px;">
                                <div class="form-group" style="flex:1"><label>Min Nodes</label><input type="number" id="add-min" value="1"></div>
                                <div class="form-group" style="flex:1"><label>Max Nodes</label><input type="number" id="add-max" value="1"></div>
                            </div>
                            <button onclick="addServer()" style="margin-top: 8px;">Initialize Subsystem</button>
                        </div>
                    </div>
                </div>

                <div style="margin-top: 32px;">
                    <h3 style="margin-bottom: 12px; color: var(--text-muted); font-size: 13px; text-transform: uppercase; letter-spacing: 1px;">System Output Stream</h3>
                    <div class="terminal" id="logs">Booting up framework...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                if (res.status === 401) return window.location.reload();
                const data = await res.json();
                
                const list = document.getElementById('server-list');
                if(data.servers.length === 0) list.innerHTML = '<p>No active clusters running.</p>';
                else {
                    list.innerHTML = data.servers.map(s => \`
                        <div class="card">
                            <h3>\${s.host}<span style="font-size:12px;color:var(--text-muted);font-weight:normal;">:\${s.port}</span></h3>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin: 12px 0;">
                                <span style="font-size:13px;"><span class="status-dot \${s.online >= s.min ? 'dot-on' : 'dot-off'}"></span>Nodes Linked</span>
                                <span style="font-family:monospace; font-size:14px; background:rgba(0,0,0,0.5); padding:2px 6px; border-radius:4px;">\${s.online} / \${s.total}</span>
                            </div>
                            <p>Capacity bounds: \${s.min} - \${s.max} units</p>
                            <button class="danger" style="margin-top: 10px; padding: 6px;" onclick="delServer('\${s.id}')">Terminate Cluster</button>
                        </div>
                    \`).join('');
                }

                const logBox = document.getElementById('logs');
                const wasAtBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 10;
                logBox.innerHTML = data.logs.map(l => \`<div style="margin-bottom:4px;">\${l}</div>\`).join('');
                if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight;
            } catch(e) {}
        }

        async function addServer() {
            const host = document.getElementById('add-host').value;
            if (!host) return alert('Target Host is required.');
            await fetch('/api/servers', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    host, port: document.getElementById('add-port').value,
                    username: document.getElementById('add-user').value,
                    min: document.getElementById('add-min').value,
                    max: document.getElementById('add-max').value
                })
            });
            document.getElementById('add-host').value = '';
            fetchStatus();
        }

        async function delServer(id) {
            if(!confirm('Confirm termination of this entire cluster? All connected nodes will be dropped instantly.')) return;
            await fetch(\`/api/servers/\${id}\`, { method: 'DELETE' });
            fetchStatus();
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

// ====================== Boot Sequence ======================
app.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(`\n===========================================`);
  console.log(`🚀 Kernel loaded on port: ${WEB_PORT}`);
  console.log(`===========================================\n`);
  reloadClusters();
});

const shutdown = () => {
  logWithTime('SYSTEM', 'Initiating safe shutdown...');
  serverGroups.forEach(g => g.stop());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => { if (err.code !== 'ECONNRESET') console.error('Exception:', err.message); });

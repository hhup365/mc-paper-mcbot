#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');
const mineflayer = require('mineflayer');
const express = require('express');
const cookieParser = require('cookie-parser');

const CONFIG_FILE = path.join(__dirname, 'server.json');
const WEB_PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const AUTH_TOKEN = Math.random().toString(36).substring(2, 15);

const DEFAULT_FALLBACK_VERSIONS = [false, '1.20.4', '1.20.1', '1.19.2', '1.18.2'];

let serverGroups = new Map();
let systemLogs = [];

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

  async start(delayMs = 0) {
    if (this.shuttingDown) return;
    
    if (delayMs > 0) {
        logWithTime(this.label, `Queued for connection (Waiting ${(delayMs/1000).toFixed(1)}s)...`);
        await new Promise(r => setTimeout(r, delayMs));
    }
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
    
    const options = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.username,
      version: version,
      physicsEnabled: false, 
      hideErrors: true
    };

    logWithTime(this.label, `Connecting: ${this.username} (Proto: ${version || 'Auto'})`);
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
      const msg = String(reason);
      logWithTime(this.label, `Terminated by host: ${msg.replace(/§[0-9a-fk-or]/ig, '').substring(0, 50)}`);
      
      if (msg.toLowerCase().includes('throttle') || msg.toLowerCase().includes('rate limit')) {
          this.scheduleReconnect(30000);
      } else {
          this.scheduleReconnect();
      }
    });
  }

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

class NodeGroup {
  constructor(config) {
    this.id = config.id || Math.random().toString(36).substr(2, 6);
    this.config = config;
    this.label = `${config.host}:${config.port}`;
    this.instances = [];
    this.min = Math.max(1, config.players?.min || 1);
    this.max = Math.max(this.min, config.players?.max || 1);
    
    this.targetNodes = this.min; 
    this.lastTargetUpdate = 0;
    
    this.maintInterval = null;
    this.nextNodeId = 1;
  }

  start() {
    this.updateTarget();
    logWithTime('SYSTEM', `Cluster started [${this.label}] (Bounds: ${this.min}-${this.max})`);
    this.maintInterval = setInterval(() => this.maintain(), 15000);
    this.maintain();
  }
  
  updateTarget() {
      if (Date.now() - this.lastTargetUpdate > 300000) {
          this.targetNodes = Math.floor(Math.random() * (this.max - this.min + 1)) + this.min;
          this.lastTargetUpdate = Date.now();
          logWithTime(this.label, `Adjusted cluster target to ${this.targetNodes} nodes.`);
      }
  }

  maintain() {
    this.updateTarget();
    const alive = this.instances.filter(b => !b.shuttingDown);
    
    if (alive.length < this.targetNodes) {
      const node = new ClientInstance(this.config, `${this.label}-#${this.nextNodeId++}`);
      this.instances.push(node);
      node.start(2000);
    } 
    else if (alive.length > this.targetNodes) {
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
    res.status(401).json({ error: 'Invalid password' });
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
    min: g.min,
    max: g.max,
    target: g.targetNodes,
    online: g.instances.filter(b => b.bot?.entity && !b.shuttingDown).length,
    total: g.instances.filter(b => !b.shuttingDown).length
  }));
  res.json({ servers: status, logs: systemLogs });
});

app.post('/api/servers', requireAuth, (req, res) => {
  const configs = loadConfig();
  configs.push({
    id: Math.random().toString(36).substr(2, 6),
    host: req.body.host || 'localhost',
    port: parseInt(req.body.port) || 25565,
    username: req.body.username || '',
    version: req.body.version === 'auto' ? false : req.body.version,
    players: { min: parseInt(req.body.min) || 1, max: parseInt(req.body.max) || 1 }
  });
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

app.get('/', (req, res) => {
  const isAuthenticated = req.cookies.auth_token === AUTH_TOKEN;
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Manager Console</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%231e293b'/><circle cx='50' cy='50' r='20' fill='%2338bdf8'/><circle cx='50' cy='50' r='10' fill='%230f172a'/></svg>">
    <style>
        :root {
            --primary: #38bdf8;
            --primary-hover: #0284c7;
            --surface: rgba(30, 41, 59, 0.65);
            --border: rgba(255, 255, 255, 0.08);
            --text: #f8fafc;
            --text-muted: #94a3b8;
            --danger: #fb7185;
            --success: #34d399;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0; padding: 40px 20px; color: var(--text);
            min-height: 100vh;
            background-color: #0f172a;
            background-image: 
                radial-gradient(at 10% 10%, rgba(56, 189, 248, 0.15) 0px, transparent 50%),
                radial-gradient(at 90% 90%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
                radial-gradient(at 50% 50%, rgba(15, 23, 42, 1) 0px, transparent 100%);
            background-attachment: fixed;
            -webkit-font-smoothing: antialiased;
        }

        .container { max-width: 1050px; margin: 0 auto; }
        
        .glass-panel {
            background: var(--surface);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid var(--border);
            border-radius: 16px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            overflow: hidden; margin-bottom: 24px;
        }
        
        .panel-header {
            background: rgba(255, 255, 255, 0.03);
            padding: 14px 20px; display: flex; align-items: center;
            border-bottom: 1px solid var(--border);
        }
        .dots { display: flex; gap: 8px; flex: 1; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        .dot.red { background: #ff5f56; box-shadow: 0 0 10px rgba(255,95,86,0.4); }
        .dot.yellow { background: #ffbd2e; box-shadow: 0 0 10px rgba(255,189,46,0.4); }
        .dot.green { background: #27c93f; box-shadow: 0 0 10px rgba(39,201,63,0.4); }
        .title { flex: 2; text-align: center; font-weight: 500; font-size: 14px; letter-spacing: 0.5px; color: var(--text-muted); }
        .spacer { flex: 1; text-align: right; }

        .content { padding: 24px; }

        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
        .card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border);
            border-radius: 12px; padding: 18px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .card:hover { 
            background: rgba(255, 255, 255, 0.05); 
            transform: translateY(-2px);
            border-color: rgba(56, 189, 248, 0.3);
            box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5);
        }
        
        h3 { margin: 0 0 14px 0; font-size: 16px; font-weight: 600; }
        p { margin: 8px 0; font-size: 13px; color: var(--text-muted); }
        
        input {
            width: 100%; padding: 10px 14px; margin-top: 6px;
            background: rgba(0,0,0,0.2); border: 1px solid var(--border);
            color: var(--text); border-radius: 8px; box-sizing: border-box;
            font-family: inherit; font-size: 14px; outline: none; transition: border 0.2s;
        }
        input:focus { border-color: var(--primary); background: rgba(0,0,0,0.3); }
        .form-group { margin-bottom: 14px; }
        .form-group label { font-size: 12px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

        button {
            background: var(--primary); color: #0f172a; border: none;
            padding: 10px 16px; border-radius: 8px; font-weight: 600;
            cursor: pointer; transition: all 0.2s; font-size: 14px; width: 100%;
        }
        button:hover { background: var(--primary-hover); color: #fff; }
        button.danger { background: rgba(251, 113, 133, 0.1); color: var(--danger); border: 1px solid rgba(251, 113, 133, 0.2); }
        button.danger:hover { background: var(--danger); color: white; }
        button.text-btn { background: transparent; color: var(--text-muted); width: auto; padding: 4px 8px; font-size: 12px; }
        button.text-btn:hover { color: var(--text); }

        .terminal {
            background: rgba(0,0,0,0.4); padding: 16px; border-radius: 12px;
            height: 280px; overflow-y: auto; font-family: "JetBrains Mono", "Menlo", monospace;
            font-size: 12px; color: #cbd5e1; border: 1px solid var(--border);
            line-height: 1.6; box-shadow: inset 0 2px 10px rgba(0,0,0,0.2);
        }
        
        .status-badge {
            display: inline-flex; align-items: center;
            background: rgba(0,0,0,0.3); padding: 4px 10px;
            border-radius: 20px; font-size: 12px; font-weight: 500;
        }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .dot-on { background: var(--success); box-shadow: 0 0 10px var(--success); }
        .dot-off { background: var(--danger); box-shadow: 0 0 10px var(--danger); }
        .dot-sync { background: var(--primary); box-shadow: 0 0 10px var(--primary); animation: pulse 2s infinite; }
        
        @keyframes pulse {
            0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; }
        }

        .login-box { max-width: 340px; margin: 12vh auto; text-align: center; }
    </style>
</head>
<body>
    ${!isAuthenticated ? `
    <div class="glass-panel login-box">
        <div class="panel-header">
            <div class="dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
            <div class="title">Secure Auth</div><div class="spacer"></div>
        </div>
        <div class="content" style="padding: 32px 24px;">
            <svg style="width:56px; height:56px; margin-bottom:20px;" xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='rgba(255,255,255,0.05)'/><circle cx='50' cy='50' r='20' fill='#38bdf8'/><circle cx='50' cy='50' r='10' fill='#0f172a'/></svg>
            <h2 style="margin:0 0 24px 0; font-size:18px; font-weight:500;">Core Access</h2>
            <input type="password" id="pass" placeholder="Encryption Key" style="margin-bottom: 20px; text-align:center; letter-spacing:2px;">
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
    <div class="container">
        <div class="glass-panel">
            <div class="panel-header">
                <div class="dots"><div class="dot red"></div><div class="dot yellow"></div><div class="dot green"></div></div>
                <div class="title">Session Manager Framework</div>
                <div class="spacer"><button class="text-btn" onclick="logout()">Lock Session</button></div>
            </div>
            
            <div class="content">
                <div style="display: flex; gap: 24px; flex-wrap: wrap;">
                    
                    <!-- 左侧节点列表 -->
                    <div style="flex: 2; min-width: 280px;">
                        <h3 style="color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Active Clusters</h3>
                        <div class="grid" id="server-list"><span style="color:var(--text-muted); font-size:13px;">Establishing connection...</span></div>
                    </div>

                    <!-- 右侧部署面板 -->
                    <div style="flex: 1; min-width: 260px;">
                        <div class="card" style="background: rgba(56, 189, 248, 0.03); border-color: rgba(56, 189, 248, 0.2);">
                            <h3 style="color: var(--primary);">Deploy Subsystem</h3>
                            <div class="form-group"><label>Host Address</label><input type="text" id="add-host" placeholder="node.example.com"></div>
                            <div style="display: flex; gap: 12px;">
                                <div class="form-group" style="flex:2"><label>Port</label><input type="number" id="add-port" value="25565"></div>
                                <div class="form-group" style="flex:1"><label>Base ID</label><input type="text" id="add-user" placeholder="Opt"></div>
                            </div>
                            <div style="display: flex; gap: 12px;">
                                <div class="form-group" style="flex:1"><label>Min Units</label><input type="number" id="add-min" value="1"></div>
                                <div class="form-group" style="flex:1"><label>Max Units</label><input type="number" id="add-max" value="3"></div>
                            </div>
                            <button onclick="addServer()" style="margin-top: 8px;">Initialize Instance</button>
                        </div>
                    </div>
                </div>

                <div style="margin-top: 36px;">
                    <h3 style="color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">System Output Stream</h3>
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
                if(data.servers.length === 0) list.innerHTML = '<p style="color:var(--text-muted)">No clusters deployed yet.</p>';
                else {
                    list.innerHTML = data.servers.map(s => {
                        // 判断状态灯
                        let dotClass = 'dot-off';
                        let statusText = 'Offline';
                        if (s.online > 0 && s.online >= s.target) { dotClass = 'dot-on'; statusText = 'Optimal'; }
                        else if (s.online > 0) { dotClass = 'dot-sync'; statusText = 'Syncing...'; }

                        return \`
                        <div class="card">
                            <h3 style="margin-bottom:6px;">\${s.host}<span style="font-size:12px;color:var(--text-muted);font-weight:normal;">:\${s.port}</span></h3>
                            
                            <div style="display:flex; justify-content:space-between; align-items:center; margin: 16px 0;">
                                <div class="status-badge"><span class="status-dot \${dotClass}"></span>\${statusText}</div>
                                <div style="text-align:right;">
                                    <span style="font-size:18px; font-weight:600; color:var(--text);">\${s.online}</span>
                                    <span style="font-size:12px; color:var(--text-muted);">/ Target \${s.target}</span>
                                </div>
                            </div>
                            
                            <p style="font-size:12px;">Dynamic Bounds: \${s.min} ~ \${s.max} units</p>
                            <button class="danger" style="margin-top: 12px; padding: 8px;" onclick="delServer('\${s.id}')">Terminate Cluster</button>
                        </div>
                    \`}).join('');
                }

                const logBox = document.getElementById('logs');
                const wasAtBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 10;
                logBox.innerHTML = data.logs.map(l => \`<div style="margin-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:4px;">\${l}</div>\`).join('');
                if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight;
            } catch(e) {}
        }

        async function addServer() {
            const host = document.getElementById('add-host').value;
            if (!host) return alert('Host is required.');
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
            if(!confirm('Confirm termination of this entire cluster?')) return;
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

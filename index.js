#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');
const mineflayer = require('mineflayer');

// ====================== 配置 ======================
const CONFIG_FILE = path.join(__dirname, 'server.json');
const DEFAULT_SERVER_API = process.env.SERVER_API || '';

// 版本回退列表
const DEFAULT_FALLBACK_VERSIONS = [false, '1.20.4', '1.20.1', '1.19.2', '1.18.2'];

// ====================== 工具函数 ======================
function logWithTime(label, msg) {
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${now}] [${label}] ${msg}`);
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateUsername() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  const length = randomBetween(6, 10);
  let name = '';
  for (let i = 0; i < length; i++) {
    name += chars[Math.floor(Math.random() * chars.length)];
  }
  if (/^\d/.test(name)) name = 'p' + name.slice(1);
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
    const template = [
      {
        host: 'server1.example.com',
        port: 25565,
        username: '',
        version: false,
        players: { min: 1, max: 1 },
        fallbackVersions: [false, '1.20.1', '1.19.2']
      },
      {
        host: 'server2.example.com',
        port: 25566,
        username: '',
        version: '1.20.1',
        players: { min: 1, max: 1 }
      }
    ];
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(template, null, 2), 'utf-8');
    console.log('✅ 已生成 server.json 模板，请编辑后重新启动');
    process.exit(0);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

async function fetchRemoteConfig(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('✅ 已从远程更新 server.json');
    return data;
  } catch (err) {
    console.error('❌ 远程配置下载失败:', err.message);
    return null;
  }
}

// ====================== 极简 Bot ======================
class BotInstance {
  constructor(serverConfig, label) {
    this.config = serverConfig;
    this.label = label || `${serverConfig.host}:${serverConfig.port}`;
    this.bot = null;
    this.reconnecting = false;
    this.shuttingDown = false;
    this.lastActivity = Date.now();
    this.activityTimer = null;   // 每 150~180s 一次动作
    this.monitorTimer = null;    // 活动超时监控
    this.retryCount = 0;
    this.maxRetryDelay = 300000;
    this.baseRetryDelay = 10000;

    this.username = this.config.username?.trim() || generateUsername();

    // 版本回退
    this.fallbackVersions = Array.isArray(this.config.fallbackVersions)
      ? this.config.fallbackVersions
      : DEFAULT_FALLBACK_VERSIONS;
    this.currentVersionIdx = 0;
    this.versionInitialized = false;
  }

  getVersion() {
    if (!this.versionInitialized) {
      const v = this.config.version !== undefined ? this.config.version : false;
      const idx = this.fallbackVersions.findIndex(ver => String(ver) === String(v));
      this.currentVersionIdx = idx >= 0 ? idx : 0;
      this.versionInitialized = true;
    }
    if (this.currentVersionIdx >= this.fallbackVersions.length) this.currentVersionIdx = 0;
    return this.fallbackVersions[this.currentVersionIdx];
  }

  advanceVersion() {
    this.currentVersionIdx++;
    if (this.currentVersionIdx >= this.fallbackVersions.length) this.currentVersionIdx = 0;
    logWithTime(this.label, `🔄 切换版本: ${this.fallbackVersions[this.currentVersionIdx]}`);
  }

  async start() {
    const reachable = await tcpPing(this.config.host, this.config.port);
    if (!reachable) {
      logWithTime(this.label, '❌ 服务器无法连接，稍后重试');
      this.scheduleReconnect();
      return;
    }
    this.createBot();
  }

  createBot() {
    if (this.reconnecting || this.shuttingDown) return;

    const version = this.getVersion();
    const options = {
      host: this.config.host,
      port: parseInt(this.config.port, 10) || 25565,
      username: this.username,
      version,
      connectTimeout: 12000,
      keepAlive: true
    };

    logWithTime(this.label, `启动 Bot: ${this.username} (v: ${version})`);
    this.bot = mineflayer.createBot(options);

    // 提前捕获底层错误
    this.bot._client.on('error', (err) => {
      logWithTime(this.label, `📡 底层错误: ${err.message}`);
    });

    const timeout = setTimeout(() => {
      if (this.bot?.end) {
        logWithTime(this.label, '❌ 连接超时，断开');
        this.bot.end();
      }
    }, 15000);

    this.bot.on('login', () => {
      logWithTime(this.label, `✅ ${this.username} 登录成功`);
      clearTimeout(timeout);
      this.reconnecting = false;
      this.retryCount = 0;
      this.versionInitialized = true;
      this.updateActivity();
      this.startMonitor();
      this.startActivityLoop();
    });

    this.bot.on('error', (err) => {
      logWithTime(this.label, `❌ 错误: ${err.message}`);
      if (this.isVersionError(err)) this.advanceVersion();
      this.scheduleReconnect();
    });
    this.bot.on('end', () => {
      if (!this.shuttingDown) logWithTime(this.label, '🔌 断开连接');
      this.scheduleReconnect();
    });
    this.bot.on('kicked', (reason) => {
      logWithTime(this.label, '👢 被踢出:', reason);
      if (typeof reason === 'string' && this.isVersionError({ message: reason })) this.advanceVersion();
      this.scheduleReconnect();
    });
  }

  isVersionError(err) {
    const msg = err?.message || err?.toString() || '';
    return (
      msg.includes('FAILED to decode packet') ||
      msg.includes('Unsupported protocol version') ||
      msg.includes('connection lost')
    );
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  // 每 150~180 秒随机跳跃或转向（无寻路，无攻击）
  startActivityLoop() {
    if (this.activityTimer) clearInterval(this.activityTimer);
    const interval = randomBetween(150000, 180000); // 2.5~3 分钟
    this.activityTimer = setInterval(() => {
      if (!this.bot?.entity) return;
      this.doRandomAction();
      this.updateActivity();
    }, interval);

    // 刚上线不久即执行一次，避免长时间静默
    setTimeout(() => {
      if (this.bot?.entity) {
        this.doRandomAction();
        this.updateActivity();
      }
    }, randomBetween(10000, 30000));
  }

  doRandomAction() {
    const bot = this.bot;
    if (!bot?.entity) return;

    if (Math.random() < 0.5) {
      // 跳跃
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400);
      logWithTime(this.label, '↕️ 跳跃');
    } else {
      // 随机转向
      const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.5;
      bot.look(yaw, bot.entity.pitch, true);
      logWithTime(this.label, '👀 转向');
    }
  }

  startMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 240000) {
        logWithTime(this.label, '⏱️ 活动超时，强制恢复');
        if (this.bot?.entity) {
          this.doRandomAction();
          this.updateActivity();
        } else {
          this.scheduleReconnect();
        }
      }
    }, 30000);
  }

  scheduleReconnect() {
    if (this.reconnecting || this.shuttingDown) return;
    this.reconnecting = true;
    this.cleanup();

    const base = Math.min(this.baseRetryDelay * Math.pow(2, this.retryCount), this.maxRetryDelay);
    const delay = Math.max(5000, base + Math.floor(Math.random() * 5000));
    this.retryCount++;
    logWithTime(this.label, `🔁 ${(delay/1000).toFixed(1)}s 后重连 (第 ${this.retryCount} 次)`);
    setTimeout(() => {
      this.reconnecting = false;
      if (!this.shuttingDown) this.start();
    }, delay);
  }

  cleanup() {
    if (this.activityTimer) { clearInterval(this.activityTimer); this.activityTimer = null; }
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    if (this.bot) {
      this.bot.removeAllListeners();
      if (typeof this.bot.quit === 'function') this.bot.quit();
      this.bot = null;
    }
  }

  shutdown() {
    this.shuttingDown = true;
    logWithTime(this.label, `🛑 关闭 ${this.username}`);
    this.cleanup();
  }
}

// ====================== 服务器组管理器 ======================
class ServerGroup {
  constructor(config, index) {
    this.config = config;
    this.label = `${config.host}:${config.port}`;
    this.instances = [];
    this.nextId = 0;
    this.range = config.players || { min: 1, max: 1 };
    this.min = Math.max(1, this.range.min);
    this.max = Math.max(this.min, this.range.max);
    this.maintInterval = null;
    this.swapInterval = null;
  }

  start() {
    for (let i = 0; i < this.min; i++) this.addBot();
    this.maintInterval = setInterval(() => this.maintain(), 60000);
    if (this.max > this.min) {
      this.swapInterval = setInterval(() => this.randomSwap(), randomBetween(600000, 1200000));
    }
  }

  addBot(name) {
    const bot = new BotInstance(this.config, `${this.label}-${this.nextId++}`);
    if (name) bot.username = name;
    else bot.username = generateUsername();
    this.instances.push(bot);
    bot.start();
    return bot;
  }

  removeBot(bot) {
    bot.shutdown();
    this.instances = this.instances.filter(b => b !== bot);
  }

  maintain() {
    const alive = this.instances.filter(b => !b.shuttingDown && b.bot?.entity);
    if (alive.length < this.min) {
      const need = this.min - alive.length;
      logWithTime(this.label, `👥 补充 ${need} 人`);
      for (let i = 0; i < need; i++) this.addBot();
    } else if (alive.length > this.max) {
      const remove = alive.slice(0, alive.length - this.max);
      remove.forEach(b => this.removeBot(b));
    }
  }

  randomSwap() {
    const alive = this.instances.filter(b => !b.shuttingDown && b.bot?.entity);
    if (alive.length === 0) return;
    const leaver = alive[Math.floor(Math.random() * alive.length)];
    logWithTime(this.label, `🔄 玩家离开: ${leaver.username}`);
    this.removeBot(leaver);
    setTimeout(() => {
      if (this.instances.filter(b => !b.shuttingDown).length < this.max) {
        const newBot = this.addBot();
        logWithTime(this.label, `🆕 新玩家: ${newBot.username}`);
      }
    }, randomBetween(20000, 60000));
  }

  stop() {
    if (this.maintInterval) clearInterval(this.maintInterval);
    if (this.swapInterval) clearInterval(this.swapInterval);
    this.instances.forEach(b => b.shutdown());
    this.instances = [];
  }
}

// ====================== 主流程 ======================
async function main() {
  let config;
  const apiUrl = process.env.SERVER_API || DEFAULT_SERVER_API;
  if (apiUrl) {
    config = await fetchRemoteConfig(apiUrl);
    if (!config && !fs.existsSync(CONFIG_FILE)) {
      console.error('❌ 无法获取配置，退出');
      process.exit(1);
    }
  }
  if (!config) config = loadConfig();
  if (!Array.isArray(config)) {
    console.error('❌ server.json 应为数组');
    process.exit(1);
  }

  const groups = config.map((cfg, i) => {
    const g = new ServerGroup(cfg, i);
    g.start();
    return g;
  });

  const shutdown = () => {
    console.log('\n🛑 关闭所有 Bot...');
    groups.forEach(g => g.stop());
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    if (err.code !== 'ECONNRESET') console.error('未捕获异常:', err.message);
  });
  process.on('unhandledRejection', (r) => {
    if (r?.code !== 'ECONNRESET') console.error('未处理拒绝:', r);
  });
}

main();
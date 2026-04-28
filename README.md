# Minecraft AFK Bot (Multi-Server)

> 🧟 低资源占用的 Minecraft 挂机机器人，支持多服务器、动态人数、远程配置同步及智能版本回退。  
> Forked from [@baipiaodajun/mcbot](https://www.npmjs.com/package/@baipiaodajun/mcbot)

[![npm version](https://img.shields.io/npm/v/@baipiaodajun/mcbot)](https://www.npmjs.com/package/@baipiaodajun/mcbot)
[![license](https://img.shields.io/npm/l/@baipiaodajun/mcbot)](LICENSE)

---

## ✨ 特性

- **多服务器并行** – 一个配置文件管理无限数量的 Minecraft 服务器。
- **动态人数池** – 为每个服务器设置最小/最大在线人数，自动模拟玩家上下线。
- **远程配置同步** – 通过 `SERVER_API` 环境变量拉取远程 `server.json`，重启即更新所有挂机配置。
- **智能版本回退** – 遇到协议解码错误时自动尝试备选版本列表（1.20.4 → 1.20.1 → 1.19.2 …），告别手动换版本。
- **字母数字混合用户名** – 自动生成类似 `x4k_9ab` 的随机 ID，亦可指定固定名称。
- **断线指数退避重连** – 网络抖动时自动恢复，避免服务器压力。

---

## 📦 安装

```bash
git clone https://github.com/yourusername/mc-afk-bot.git
cd mc-afk-bot
npm install
```

**唯一依赖**：  
- [`mineflayer`](https://github.com/PrismarineJS/mineflayer) ^4.0.0

（无需 `mineflayer-pathfinder` 或 `vec3`，真正零额外计算负载）

---

## ⚙️ 配置

首次运行会在当前目录自动生成 `server.json` 模板，按需编辑即可。

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

### 字段说明

| 字段              | 类型     | 必填 | 说明                                                                 |
| ----------------- | -------- | ---- | -------------------------------------------------------------------- |
| `host`            | string   | 是   | 服务器地址                                                           |
| `port`            | number   | 是   | 服务器端口（默认 25565）                                             |
| `username`        | string   | 否   | 机器人用户名，留空则随机生成字母数字组合                               |
| `version`         | string / false | 否 | 指定 MC 版本，如 `"1.20.1"`，设为 `false` 自动检测                   |
| `players`         | object   | 否   | 同时在线人数区间 `{ "min": 1, "max": 1 }`，默认单人                 |
| `fallbackVersions`| array    | 否   | 版本回退列表，默认 `[false, "1.20.4", "1.20.1", "1.19.2", "1.18.2"]` |

---

## 🚀 使用

### 基本启动
```bash
node index.js
```

### 远程配置（可选）

设置环境变量 `SERVER_API` 指向你的 JSON 配置文件地址：

```bash
export SERVER_API="https://your-cdn.com/server.json"
node index.js
```
设置环境变量 `SERVER_1`来快速配置地址：

```bash
SERVER_1=host:port[:version]
```

启动时会先下载远程 `server.json` 覆盖本地，然后加载。之后每次重启容器或进程都会拉取最新配置，实现集中管理。

### Docker 示例
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY index.js .
CMD ["node", "index.js"]
```

运行时传入环境变量：
```bash
docker run -e SERVER_API=https://... -d mc-afk-bot
```

---

## 📊 性能

测试环境：Node 18，单核 VPS。  
挂机 1 个服务器（3 个 Bot）：
- **CPU**：< 1%
- **内存**：~40 MB（所有 Bot 合计）

无寻路计算、无实体扫描，定时器间隔 ≥ 150 秒，长期运行零负担。

---

## 🔄 行为描述

- 登录后每个 Bot 每 **150~180 秒**随机执行一次动作（跳跃或转向），确保 3 分钟内有活动。
- 人数池维护：每 60 秒检查在线人数，自动补足或移除多余 Bot。
- 换人机制：若配置 `players.max > min`，每隔 **10~20 分钟**随机踢掉一个 Bot，并在 20~60 秒后以新名字加入，模拟真实玩家切换。
- 异常处理：连接超时、解码错误、被踢等均会自动触发重连，版本不匹配时自动降级。

---

## 🧰 命令行参数 (兼容旧版)

尽管推荐使用 `server.json` 配置，仍支持命令行快速单服启动（用于测试）：

```bash
node index.js <host> <port> <username> <version>
```

例如：
```bash
node index.js localhost 25565 Bot 1.20.1
```

环境变量 `HOST`, `PORT`, `USERNAME`, `MCVERSION` 也可用，优先级低于命令行参数。

---

**原项目**：[@baipiaodajun/mcbot](https://www.npmjs.com/package/@baipiaodajun/mcbot)  

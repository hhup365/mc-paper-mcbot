# 🛡️ Minecraft 保活机器人 - @baipiaodajun/mcbot

通过 Node.js 模拟客户端连接，防止某些自动关机的 Paper 服务器进入休眠状态。适用于资源回收策略激进的免费服务器环境。

## 🚀 快速开始

### 1. 安装依赖

npm i @baipiaodajun/mcbot

### 2. 创建启动脚本

新建一个 index.js 文件，内容如下：
```
process.env.HOST = 'emerald.magmanode.com'; // 修改为你的 MC 服务器地址
process.env.PORT = 34356;                   // 修改为你的端口，默认 25565
process.env.USERNAME = 'happybird';                   // 可选，修改成你的玩家名称
process.env.MCVERSION = '1.20.1';                   // 可选，修改服务器版本号，若不填会自动识别
const mcbot = require('@baipiaodajun/mcbot');
```
### 3. 启动机器人
```
node index.js
```
如果看到 ✅ Bot 已成功登录 Minecraft 服务器，说明连接成功。

## 🔒 后台守护运行

建议使用 PM2 进行守护：
```
npx pm2 start index.js --name mcbot
```
这样可以防止机器人因意外退出而失效。

## ⚙️ Paper 服务器配置建议

请确保 server.properties 中包含以下设置：
```
online-mode=false
```
关闭在线验证，允许非正版客户端连接
```
difficulty=peaceful
```
和平模式，防止机器人被怪物击杀导致频繁重连
```
white-list=false
```
关闭白名单模式，任何玩家都可加入服务器
## 🧩 插件支持旧版本客户端

将以下插件放入 plugins 目录以兼容旧版本MC客户端：

下载链接：https://drive.google.com/file/d/1-o0zb5P144n-_KX2hPUBrae_2xyTTMk9/view?usp=drive_link

## 📚 完整教程

详细配置与进阶技巧请参考：

https://liming.hidns.vip/index.php/archives/59/

## 💡 其他建议

- 推荐部署多个节点以增强保活效果（至少 3 台 512MB+ 的 Node.js 主机）
- 可结合 Tampermonkey 脚本实现自动唤醒机制（详见教程）

## 🚦 简单测试启动命令

```
npx @baipiaodajun/mcbot <host> <port> <playername> <mcversion>
```

## 📄 License

MIT
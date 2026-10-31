# 同词相遇

每人每轮写一个词，直到所有人写出同一个词。2–6 人，开房间发房间号/链接即可。

## 本地运行
需要 Node 18+，无需安装任何依赖：

    node server.js

打开 http://localhost:3000 。同一 WiFi 下的朋友访问 http://你的局域网IP:3000 。

## 免费部署（Render）
1. 把本文件夹上传到 GitHub 仓库
2. Render → New → Web Service → 选这个仓库
3. Runtime: Node，Build Command 留空，Start Command: `node server.js`，Plan: Free
4. 部署完成后得到 https://xxx.onrender.com ，发给朋友即可
（免费版闲置约 15 分钟会休眠，第一次打开要等 30–60 秒唤醒）

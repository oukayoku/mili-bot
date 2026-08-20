// server.js
// 应用入口:启动 Express 服务、挂载 LINE webhook、启动提醒调度器。

require("dotenv").config();

const express = require("express");
const { lineMiddleware, handleEvent } = require("./line");
const { startScheduler } = require("./scheduler");

// 启动前做一次基本的环境变量检查,缺关键配置时给出清晰提示而不是稀里糊涂地跑起来再报错
const REQUIRED_ENV = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "ANTHROPIC_API_KEY",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `缺少必要的环境变量: ${missing.join(", ")}\n请参考 .env.example 创建 .env 文件(本地)或在部署平台的环境变量设置里填写。`
  );
  process.exit(1);
}

const app = express();

// 健康检查(部署平台常用这个来判断服务是否存活)
app.get("/", (req, res) => {
  res.status(200).send("LINE reminder bot is running.");
});

// LINE webhook:注意 lineMiddleware 需要拿到原始请求体做签名校验,
// 所以这里不要在它之前挂载 express.json() 之类的 body parser。
app.post("/webhook", lineMiddleware, async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map((event) => handleEvent(event)));
    res.status(200).end();
  } catch (err) {
    console.error("处理 webhook 事件出错:", err);
    // 依然返回 200,避免 LINE 平台因为我们的内部错误而不断重试同一个事件
    res.status(200).end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务已启动,监听端口 ${PORT}`);
  startScheduler();
});

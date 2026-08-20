// server.js
// 应用入口:启动 Express 服务、挂载 LINE webhook、启动提醒调度器。

require("dotenv").config();

const path = require("path");
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

// 静态资源(比如自我介绍配图),放在项目根目录的 public/ 文件夹里,
// 部署后可以通过 https://<你的服务地址>/mili-intro.png 这样的链接访问到。
// LINE 发图片消息必须给一个公网可访问的 https 链接,不能直接传本地文件,
// 所以需要先把图片"挂"在这个服务自己身上,再把这个链接告诉 LINE。
app.use(express.static(path.join(__dirname, "..", "public")));

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

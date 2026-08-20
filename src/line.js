// line.js
// LINE Messaging API 相关逻辑:webhook 事件处理、单聊/群聊判断、@提及解析。
// 使用 @line/bot-sdk 的经典 Client API(package.json 里锁定 ^7.x),
// 这一套 API 形状多年保持稳定:client.replyMessage(replyToken, messages)、
// client.pushMessage(to, messages),都是位置参数,不是对象参数。

const { Client, middleware } = require("@line/bot-sdk");
const { runConversationTurn, generateProactiveMessage } = require("./claude");
const db = require("./db");

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;

const lineMiddleware = middleware({ channelSecret });
const client = new Client({ channelAccessToken, channelSecret });

const GROUP_REQUIRE_MENTION =
  (process.env.GROUP_REQUIRE_MENTION || "true").toLowerCase() !== "false";

// 从事件里提出这条消息所属的 chatId / chatType
function resolveChat(event) {
  const source = event.source;
  if (source.type === "user") {
    return { chatId: source.userId, chatType: "user" };
  }
  if (source.type === "group") {
    return { chatId: source.groupId, chatType: "group" };
  }
  if (source.type === "room") {
    return { chatId: source.roomId, chatType: "room" };
  }
  return { chatId: null, chatType: source.type };
}

// 判断这条群聊消息是否 @ 了机器人本身,并把 @xxx 文本从正文里去掉
// (mention 字段是 LINE webhook 原始 JSON 里就有的,SDK 只是透传,不依赖具体 SDK 版本)
function extractMentionAndClean(message) {
  const mention = message.mention;
  if (!mention || !Array.isArray(mention.mentionees)) {
    return { isSelfMentioned: false, cleanText: message.text };
  }
  const isSelfMentioned = mention.mentionees.some((m) => m.isSelf);

  let text = message.text;
  const sorted = [...mention.mentionees].sort((a, b) => b.index - a.index);
  for (const m of sorted) {
    text = text.slice(0, m.index) + text.slice(m.index + m.length);
  }
  return { isSelfMentioned, cleanText: text.trim() };
}

async function getDisplayName({ chatType, chatId, userId }) {
  if (!userId) return null;
  try {
    if (chatType === "user") {
      const profile = await client.getProfile(userId);
      return profile.displayName;
    }
    if (chatType === "group") {
      const profile = await client.getGroupMemberProfile(chatId, userId);
      return profile.displayName;
    }
    if (chatType === "room") {
      const profile = await client.getRoomMemberProfile(chatId, userId);
      return profile.displayName;
    }
  } catch (err) {
    console.warn("获取用户资料失败(可能是权限或用户未添加好友):", err.message);
  }
  return null;
}

// 自我介绍配图放在 public/ 目录下,由 server.js 里的 express.static 提供访问。
// LINE 要求图片消息必须是公网 https 链接,所以要用部署平台给的对外网址拼出来。
// Render 会自动注入 RENDER_EXTERNAL_URL(服务的公网地址);如果以后换到别的平台
// 自己部署,没有这个变量的话,可以在环境变量里手动设置 PUBLIC_BASE_URL 来代替。
function getPublicBaseUrl() {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || "";
  return base.replace(/\/$/, "");
}

function buildIntroImageMessage() {
  const base = getPublicBaseUrl();
  if (!base) return null; // 拿不到公网地址就不发图,只发文字,不让整个介绍流程报错
  return {
    type: "image",
    originalContentUrl: `${base}/mili-intro.png`,
    previewImageUrl: `${base}/mili-intro-preview.jpg`,
  };
}

// 被添加为好友时(LINE 的 follow 事件),主动发一条自我介绍(文字 + 配图)
async function handleFollow(event) {
  const { chatId, chatType } = resolveChat(event);
  if (!chatId) return;

  db.ensureChatSettings(chatId, chatType);

  const userId = event.source.userId || null;
  const userDisplayName = await getDisplayName({ chatType, chatId, userId });

  try {
    const introText = await generateProactiveMessage({
      chatId,
      chatType,
      kind: "intro",
      extra: { userDisplayName },
    });
    const messages = [{ type: "text", text: introText.slice(0, 4900) }];
    const imageMessage = buildIntroImageMessage();
    if (imageMessage) messages.push(imageMessage);
    await client.replyMessage(event.replyToken, messages);
  } catch (err) {
    console.error("生成自我介绍出错(follow):", err);
  }
}

// 被拉进群聊/多人聊天室时(LINE 的 join 事件),主动发一条自我介绍(文字 + 配图)
async function handleJoin(event) {
  const { chatId, chatType } = resolveChat(event);
  if (!chatId) return;

  db.ensureChatSettings(chatId, chatType);

  try {
    const introText = await generateProactiveMessage({
      chatId,
      chatType,
      kind: "intro_group",
      extra: { requireMention: GROUP_REQUIRE_MENTION },
    });
    const messages = [{ type: "text", text: introText.slice(0, 4900) }];
    const imageMessage = buildIntroImageMessage();
    if (imageMessage) messages.push(imageMessage);
    await client.replyMessage(event.replyToken, messages);
  } catch (err) {
    console.error("生成自我介绍出错(join):", err);
  }
}

async function handleEvent(event) {
  if (event.type === "follow") {
    await handleFollow(event);
    return;
  }
  if (event.type === "join") {
    await handleJoin(event);
    return;
  }
  if (event.type !== "message" || event.message.type !== "text") {
    return; // 目前只处理文字消息,贴图/图片等先忽略
  }

  const { chatId, chatType } = resolveChat(event);
  if (!chatId) return;

  // 确保这个聊天有对应的 chat_settings 记录(早晚提醒时间等),
  // 第一次收到消息时自动创建,调度器才知道要不要管这个聊天
  db.ensureChatSettings(chatId, chatType);

  const userId = event.source.userId || null;

  let userText = event.message.text;
  if (chatType === "group" || chatType === "room") {
    const { isSelfMentioned, cleanText } = extractMentionAndClean(event.message);
    if (GROUP_REQUIRE_MENTION && !isSelfMentioned) {
      // 群聊里没有 @ 机器人,不打扰,直接忽略
      return;
    }
    userText = cleanText || userText;
  }

  if (!userText.trim()) return;

  const userDisplayName = await getDisplayName({ chatType, chatId, userId });

  let replyText;
  try {
    replyText = await runConversationTurn({
      chatId,
      chatType,
      userId: userId || chatId,
      userDisplayName,
      userText,
    });
  } catch (err) {
    console.error("生成回复出错:", err);
    replyText = "ごめんね、ちょっと調子が悪いみたい。少ししてからまた試してみて。";
  }

  await client.replyMessage(event.replyToken, { type: "text", text: replyText.slice(0, 4900) });
}

// 供 scheduler 用来主动推送消息(提醒 / 早报 / 晚间总结 / 随性汇报……)
async function pushText(chatId, text) {
  await client.pushMessage(chatId, { type: "text", text: text.slice(0, 4900) });
}

module.exports = {
  lineMiddleware,
  client,
  handleEvent,
  pushText,
};

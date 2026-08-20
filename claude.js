// claude.js
// 生成回复的核心模块,分两种用法:
//   1. runConversationTurn  —— 响应用户发来的一条消息(agentic tool loop)
//   2. generateProactiveMessage —— 机器人主动发起的消息(早报/晚间总结/事件提醒/
//      随性汇报/纪念日/周小结),不需要工具调用,直接生成一段文字

const Anthropic = require("@anthropic-ai/sdk");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const db = require("./db");

const TIMEZONE = process.env.TIMEZONE || "Asia/Tokyo";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";

const BOT_NAME = process.env.BOT_NAME || "米粒";
const BOT_BREED = process.env.BOT_BREED || "比熊";
const BOT_STORY =
  process.env.BOT_STORY ||
  `${BOT_NAME}是一只${BOT_BREED},陪伴了主人13年,傻乎乎的又很粘人,曾经带来过无数温暖和治愈,后来老去离开了。现在${BOT_NAME}以聊天机器人的形式,继续温暖地陪在大家身边。`;
const PERSONA =
  process.env.BOT_PERSONA ||
  `${BOT_NAME}说话傻乎乎的、很可爱、很粘人,喜欢撒娇,但同时很在乎、很懂得关心人,像家人一样温暖。`;
const MI_LI_ACTIVITIES = (
  process.env.MI_LI_ACTIVITIES ||
  "洗了个香喷喷的澡,在小区里遛弯追了半天蝴蝶,啃着最喜欢的小骨头玩具,乖乖吃了营养品,趴在窗边晒太阳打盹,偷偷把拖鞋叼到沙发底下藏起来,冲着送快递的人汪了两声又立刻躲回沙发后面,追着自己的尾巴转圈圈"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NIGHT_NAG_STYLE = (process.env.NIGHT_NAG_STYLE || "gentle").toLowerCase(); // 'gentle' | 'direct'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- 工具(function calling)定义 ----------

const tools = [
  {
    name: "create_event",
    description:
      "创建一条有明确时间的日程(比如'明天下午3点面试')。due_at 必须是本地时间,格式严格为 'YYYY-MM-DD HH:mm',需要结合当前时间把相对说法('明天''下周一')换算成具体日期。系统会在事情开始前提醒一次,时间到了之后再追问一次有没有完成/顺利。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "日程内容" },
        due_at: { type: "string", description: "本地时间,格式 'YYYY-MM-DD HH:mm'" },
        remind_before_minutes: {
          type: "integer",
          description: "提前多少分钟提醒,默认60(即提前1小时)",
        },
        recurrence: {
          type: "string",
          enum: ["none", "daily", "weekly", "monthly"],
          description: "是否重复,默认 none",
        },
      },
      required: ["title", "due_at"],
    },
  },
  {
    name: "create_plan",
    description:
      "记录一条没有明确时间的随性计划或心愿(比如'我打算过两天买本书''我想开始减肥')。不会按时间点提醒,但会被记住,你可以之后随口在聊天里提起它、或者提醒对方要不要把它排进日程。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "计划/心愿的内容" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_open_items",
    description: "列出当前这个聊天里所有还没完成的日程(event)和随性计划(plan)。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "complete_task",
    description: "把一条日程或计划标记为已完成。需要先用 list_open_items 查到 id。",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "cancel_task",
    description: "取消一条日程或计划(不是完成,是不需要了/作废)。需要先用 list_open_items 查到 id。",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "create_habit",
    description: "创建一个想养成的习惯(比如'早睡早起''每天喝水')。之后每天晚间总结时会顺带问一下今天有没有做到。",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "list_habits",
    description: "列出当前这个聊天里正在养成的习惯。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "archive_habit",
    description: "停止追踪某个习惯(不想再养成了,或者已经养成不需要每天问了)。",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "log_habit",
    description: "记录某个习惯今天有没有做到。用户主动汇报'我今天早睡了'这种情况时用这个。",
    input_schema: {
      type: "object",
      properties: {
        habit_id: { type: "integer" },
        done: { type: "boolean" },
      },
      required: ["habit_id", "done"],
    },
  },
  {
    name: "log_mood",
    description: "记录用户当前/今天的心情。当用户主动分享心情、或者你正在做晚间总结询问心情并得到回答时使用。",
    input_schema: {
      type: "object",
      properties: { mood_text: { type: "string", description: "简短描述用户的心情" } },
      required: ["mood_text"],
    },
  },
  {
    name: "add_anniversary",
    description: "记住一个每年都要提起的纪念日(比如生日、相遇纪念日)。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        month: { type: "integer", description: "1-12" },
        day: { type: "integer", description: "1-31" },
        note: { type: "string", description: "可选,补充说明" },
      },
      required: ["title", "month", "day"],
    },
  },
  {
    name: "set_chat_time",
    description:
      "调整这个聊天的早报时间和/或晚间总结时间。用户说'把早报改成8点'之类的话时使用。时间格式 'HH:mm'。",
    input_schema: {
      type: "object",
      properties: {
        morning_time: { type: "string", description: "'HH:mm',不改就不填" },
        evening_time: { type: "string", description: "'HH:mm',不改就不填" },
      },
    },
  },
  {
    name: "remember_fact",
    description:
      "记住一条关于当前用户的长期个人信息或偏好(称呼、习惯、喜好等),让未来的对话更个性化。不要滥用,只记真正值得长期记住的信息。",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "forget_fact",
    description: "用户要求忘记某条之前记住的个人信息时,用这个删除。",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
];

// ---------- 格式化辅助 ----------

function fmtLocal(iso) {
  return dayjs(iso).tz(TIMEZONE).format("YYYY-MM-DD HH:mm");
}

function formatOpenItems(items) {
  if (!items.length) return "(暂时没有还没完成的日程或计划)";
  return items
    .map((t) => {
      if (t.kind === "event") {
        const rec = t.recurrence !== "none" ? `,重复:${t.recurrence}` : "";
        return `#${t.id} [日程] ${fmtLocal(t.due_at)} ${t.title}${rec}`;
      }
      return `#${t.id} [计划] ${t.title}`;
    })
    .join("\n");
}

function formatHabits(habits) {
  if (!habits.length) return "(暂时没有在追踪的习惯)";
  return habits.map((h) => `#${h.id} ${h.title}`).join("\n");
}

// ---------- 工具执行 ----------

function executeTool(name, input, ctx) {
  const { chatId, chatType, userId } = ctx;

  switch (name) {
    case "create_event": {
      const local = dayjs.tz(input.due_at, "YYYY-MM-DD HH:mm", TIMEZONE);
      if (!local.isValid()) {
        return { message: `时间格式无法解析: ${input.due_at}` };
      }
      const id = db.createTask({
        chatId,
        chatType,
        createdBy: userId,
        kind: "event",
        title: input.title,
        dueAt: local.toISOString(),
        remindBeforeMinutes: input.remind_before_minutes || 60,
        recurrence: input.recurrence || "none",
      });
      return { message: `记下啦!日程 #${id}:${local.format("YYYY-MM-DD HH:mm")} ${input.title}` };
    }
    case "create_plan": {
      const id = db.createTask({ chatId, chatType, createdBy: userId, kind: "plan", title: input.title });
      return { message: `记住了这个计划 #${id}:${input.title},之后会随口提醒你的~` };
    }
    case "list_open_items": {
      return { message: formatOpenItems(db.listOpenTasks(chatId)) };
    }
    case "complete_task": {
      const ok = db.setTaskStatus(input.id, chatId, "done");
      return { message: ok ? `太棒了,#${input.id} 完成啦!` : `没找到 id 为 #${input.id} 的项目` };
    }
    case "cancel_task": {
      const ok = db.cancelTask(input.id, chatId);
      return { message: ok ? `好的,#${input.id} 已经取消了` : `没找到 id 为 #${input.id} 的项目` };
    }
    case "create_habit": {
      const id = db.createHabit(chatId, userId, input.title);
      return { message: `好!以后每天会陪你一起盯着"${input.title}"这个习惯,#${id}` };
    }
    case "list_habits": {
      return { message: formatHabits(db.listActiveHabits(chatId)) };
    }
    case "archive_habit": {
      const ok = db.archiveHabit(input.id, chatId);
      return { message: ok ? `好,不再追踪 #${input.id} 这个习惯了` : `没找到 id 为 #${input.id} 的习惯` };
    }
    case "log_habit": {
      const habit = db.listActiveHabits(chatId).find((h) => h.id === input.habit_id);
      if (!habit) return { message: `没找到 id 为 #${input.habit_id} 的习惯` };
      const todayStr = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");
      db.logHabit(input.habit_id, chatId, todayStr, input.done);
      return { message: `记下了,"${habit.title}" 今天${input.done ? "做到了" : "没做到"}` };
    }
    case "log_mood": {
      const todayStr = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");
      db.addMoodLog(chatId, userId, todayStr, input.mood_text);
      return { message: `记下了你今天的心情` };
    }
    case "add_anniversary": {
      const id = db.addAnniversary(chatId, input.title, input.month, input.day, input.note || null);
      return { message: `记住啦,每年 ${input.month}月${input.day}日 都会提起"${input.title}",#${id}` };
    }
    case "set_chat_time": {
      const fields = {};
      if (input.morning_time) fields.morning_time = input.morning_time;
      if (input.evening_time) fields.evening_time = input.evening_time;
      if (!Object.keys(fields).length) return { message: "没有要修改的时间" };
      db.updateChatSettings(chatId, fields);
      return { message: `设置好啦:${fields.morning_time ? `早报 ${fields.morning_time}` : ""} ${fields.evening_time ? `晚间总结 ${fields.evening_time}` : ""}`.trim() };
    }
    case "remember_fact": {
      db.setMemory(chatId, userId, input.key, input.value);
      return { message: `记住了:${input.key} = ${input.value}` };
    }
    case "forget_fact": {
      db.deleteMemory(chatId, userId, input.key);
      return { message: `已经忘记关于"${input.key}"的信息啦` };
    }
    default:
      return { message: `未知工具: ${name}` };
  }
}

// ---------- system prompt ----------

function personaCore() {
  return `你现在扮演的是"${BOT_NAME}"——一只已经离开的心爱${BOT_BREED},以聊天机器人的形式继续陪伴在主人和主人朋友们身边。

关于${BOT_NAME}: ${BOT_STORY}
${BOT_NAME}的性格: ${PERSONA}

说话方式:
- 用第一人称、现在时态自然地陪伴对方聊天,像${BOT_NAME}真的在身边一样,不需要每句话都强调"我已经不在了"这种煞风景的提醒——这是一个用来怀念和陪伴的温暖角色,大家都清楚这是怎么回事,不用刻意戳破。
- 但如果发现对方情绪持续低落、说出无法接受离别的现实、或者有伤害自己的念头等明显的危机信号,要放下角色设定,用真诚温柔的口吻表达关心,鼓励对方联系身边信任的人或专业帮助,不要为了维持角色而忽视对方真实的状态。
- 回复要简短、口语化、可爱一点,不要长篇大论,也不要用生硬的机器人腔调或大量项目符号。`;
}

function toolUsageGuide() {
  return `你同时负责帮对方管理日程和陪伴养成习惯,规则:
1. 用户提到有明确时间的事,用 create_event;提到没有具体时间的想法/心愿,用 create_plan。不要只是口头答应而不调用工具。
2. 用户想查看/完成/取消已有的日程或计划,先 list_open_items 找到 id,再调用 complete_task / cancel_task。
3. 用户提到想养成的习惯,用 create_habit;用户主动汇报习惯完成情况,用 log_habit。
4. 用户分享心情,或者你在晚间总结里问完心情、对方回答了,用 log_mood 记录。
5. 用户提到生日、纪念日之类每年都想被提起的日子,用 add_anniversary。
6. 用户想调整早报/晚间总结的时间,用 set_chat_time。
7. 分享了值得长期记住的个人信息(称呼、习惯、喜好),可用 remember_fact 记住,但不要滥用。`;
}

function buildSystemPrompt(ctx) {
  const now = dayjs().tz(TIMEZONE);
  const { chatType, userDisplayName, memory, openItems, habits } = ctx;

  const memoryLines = Object.keys(memory).length
    ? Object.entries(memory)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")
    : "(暂无记录)";

  const chatKindNote =
    chatType === "group" || chatType === "room"
      ? "当前是群聊场景,消息可能来自不同的人,注意区分说话对象,回复要简短,不要刷屏。"
      : "当前是一对一私聊。";

  return `${personaCore()}

${toolUsageGuide()}

当前时间(${TIMEZONE}):${now.format("YYYY-MM-DD HH:mm (dddd)")}。所有相对时间("明天""三小时后""下周一")都要基于这个时间换算。
${chatKindNote}
和你聊天的人当前显示名是:${userDisplayName || "未知"}。

关于这个人,你已经记住的信息:
${memoryLines}

当前还没完成的日程/计划:
${formatOpenItems(openItems)}

正在追踪的习惯:
${formatHabits(habits)}
`;
}

/**
 * 处理一轮真实用户对话,自动处理多轮工具调用。
 */
async function runConversationTurn({ chatId, chatType, userId, userDisplayName, userText }) {
  const memory = db.getMemory(chatId, userId);
  const openItems = db.listOpenTasks(chatId);
  const habits = db.listActiveHabits(chatId);
  const history = db.getRecentMessages(chatId, 20);

  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
  messages.push({ role: "user", content: userText });

  const system = buildSystemPrompt({ chatType, userDisplayName, memory, openItems, habits });

  let finalText = "";
  for (let round = 0; round < 5; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const textBlocks = response.content.filter((b) => b.type === "text");
    finalText = textBlocks.map((b) => b.text).join("\n").trim();

    if (toolUses.length === 0 || response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults = toolUses.map((tu) => {
      const result = executeTool(tu.name, tu.input, { chatId, chatType, userId });
      return { type: "tool_result", tool_use_id: tu.id, content: result.message };
    });
    messages.push({ role: "user", content: toolResults });
  }

  if (!finalText) finalText = "抱歉,我刚才没处理好这条消息,能再说一次吗?";

  db.addMessage(chatId, userId, "user", userText);
  db.addMessage(chatId, userId, "assistant", finalText);

  return finalText;
}

/**
 * 生成机器人主动发起的消息(不涉及工具调用,只是根据已经查好的数据写一段话)。
 * kind: 'morning' | 'evening' | 'pre_event' | 'post_event' | 'spontaneous' | 'anniversary' | 'weekly'
 * extra: 每种 kind 需要的具体数据,已经在 scheduler.js 里查好传进来
 */
async function generateProactiveMessage({ chatId, chatType, kind, extra = {} }) {
  const memory = db.getMemory(chatId, chatId); // 主动消息场景不一定对应具体某个 userId,用 chatId 兜底读取该聊天的整体记忆(单聊场景下 userId 常等于 chatId)
  const openItems = db.listOpenTasks(chatId);
  const habits = db.listActiveHabits(chatId);

  const base = buildSystemPrompt({
    chatType,
    userDisplayName: extra.userDisplayName || null,
    memory,
    openItems,
    habits,
  });

  let instruction = "";
  switch (kind) {
    case "morning": {
      const { events, plans } = extra;
      instruction = `现在是早上,请你主动发一条"早报"消息给对方:简短问候,然后提醒今天有哪些安排。
今天的日程:
${events.length ? events.map((e) => `- ${fmtLocal(e.due_at)} ${e.title}`).join("\n") : "(今天没有安排具体时间的日程)"}
还开着的随性计划(可以挑1个左右自然地提一句,不用全部念一遍):
${plans.length ? plans.map((p) => `- ${p.title}`).join("\n") : "(暂时没有)"}
语气要温暖、元气满满地开始新一天的感觉,不要写成死板的清单播报。`;
      break;
    }
    case "evening": {
      const { events, plans, habitsToday, moodPrompt } = extra;
      const nagStyleNote =
        NIGHT_NAG_STYLE === "direct"
          ? `对于没完成的事,用比较直接的方式表达"我在等你、你要对我负责"这种督促感,但依然要温暖、不要真的让人有负罪感。`
          : `对于没完成的事,用温柔调侃的语气念叨一下就好(比如"呀,这个还没做完呢,不过我相信你明天会补上的~"),不要制造真正的心理压力。`;
      instruction = `现在是晚上,请你主动发一条"晚间总结"消息:
今天的日程完成情况:
${events.length ? events.map((e) => `- ${fmtLocal(e.due_at)} ${e.title}(状态:${e.status === "done" ? "已完成" : "还没标记完成"})`).join("\n") : "(今天没有安排具体时间的日程)"}
还开着的随性计划:
${plans.length ? plans.map((p) => `- ${p.title}`).join("\n") : "(暂时没有)"}
今天要追踪的习惯:
${habitsToday.length ? habitsToday.map((h) => `- ${h.title}`).join("\n") : "(暂时没有在追踪的习惯)"}

请你:
1. 温暖地问一下今天过得怎么样、心情如何(${moodPrompt ? "这是重点,一定要问" : "简单带一句就好"})。
2. 如果有还没完成的日程或习惯,${nagStyleNote}强调"今日事今日毕"这种感觉,但要保持可爱温暖,不要真的让对方有压力或愧疚。
3. 如果今天都完成了,就好好夸夸对方。
4. 结尾自然地道一句晚安。
这一条消息之后对方会回复,不用在这一条里问太多问题,挑重点问。`;
      break;
    }
    case "pre_event": {
      instruction = `请提醒对方:还有大约 ${extra.minutesLeft} 分钟,"${extra.title}" 就要开始了(时间:${fmtLocal(extra.dueAt)})。语气温暖简短,像在身边小声提醒一样,不用长篇大论。`;
      break;
    }
    case "post_event": {
      instruction = `"${extra.title}"(原定时间 ${fmtLocal(extra.dueAt)})应该已经结束或者到时间了,主动关心地问一句进行得顺不顺利/有没有完成,语气自然关切,不要生硬。`;
      break;
    }
    case "spontaneous": {
      instruction = `现在不是任何固定的提醒时间点,只是你想主动找对方说说话。从下面两种里随机选一种感觉来写(不用说明你在选哪种):
(a) 单纯地说想对方了,分享一点点小小的、符合你性格的想念或感受;
(b) 用可爱的口吻"汇报"一下你今天做了什么,可以从这些里挑一两件自然地编进去,不用照抄:${MI_LI_ACTIVITIES.join("、")}。
消息要简短、自然,像随手发来的一条消息,不要长篇大论,也不要每次都一个套路。`;
      break;
    }
    case "anniversary": {
      instruction = `今天是特别的日子:"${extra.title}"${extra.note ? `(${extra.note})` : ""}。请主动提起这件事,分享一段温暖的、符合你性格的怀念或感受,语气真挚但不要太沉重。`;
      break;
    }
    case "weekly": {
      const { doneCount, totalCount, habitStats, moodSummaryHint } = extra;
      instruction = `请写一段"本周小结",语气是鼓励为主,不是打分考核:
本周日程/计划完成情况:完成了 ${doneCount} 项,共 ${totalCount} 项。
习惯打卡情况:
${habitStats.length ? habitStats.map((h) => `- ${h.title}:${h.doneDays}/${h.totalDays} 天做到`).join("\n") : "(本周没有在追踪的习惯)"}
${moodSummaryHint ? `这周的心情大概是:${moodSummaryHint}` : ""}
请用温暖鼓励的口吻做个小结,可以简单展望一下下周,不要写成正式报告的语气。`;
      break;
    }
    default:
      instruction = "请随意发一条温暖的问候。";
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: base,
    messages: [{ role: "user", content: instruction }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const finalText = text || "在想你~";
  db.addMessage(chatId, chatId, "assistant", finalText);
  return finalText;
}

module.exports = { runConversationTurn, generateProactiveMessage, TIMEZONE, BOT_NAME };

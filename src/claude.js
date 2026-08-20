// claude.js
// 生成回复的核心模块,分两种用法:
//   1. runConversationTurn  —— 响应用户发来的一条消息(agentic tool loop)
//   2. generateProactiveMessage —— 机器人主动发起的消息(早报/晚间总结/事件提醒/
//      随性汇报/纪念日/周小结),不需要工具调用,直接生成一段文字
//
// 注意:这个文件里凡是会被拼进 system prompt / 会被 Claude 用来生成给用户看的
// 最终文字的字符串,都已经是日语(因为机器人对用户说话用日语)。只有给开发者看的
// 代码注释、以及 tools 数组里给 Claude 自己看的 "description"(纯内部,从不会
// 展示给用户)还保留中文,不影响机器人实际说出来的话。

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
const BOT_BREED = process.env.BOT_BREED || "ビションフリーゼ";
const BOT_STORY =
  process.env.BOT_STORY ||
  `${BOT_NAME}は13年間ずっと一緒にいた${BOT_BREED}。ちょっとおっちょこちょいで甘えん坊だったけど、とても愛らしくて、たくさんの温もりと癒しをくれた。歳を重ねて虹の橋を渡ってしまったけど、今は${BOT_NAME}はチャットボットの姿でみんなのそばに温かく寄り添っている。`;
const PERSONA =
  process.env.BOT_PERSONA ||
  `${BOT_NAME}はちょっとおっちょこちょいな話し方をする、甘えん坊でとても可愛い性格。だけど本当は相手のことをよく気にかけていて、家族みたいに温かい。`;
const MI_LI_ACTIVITIES = (
  process.env.MI_LI_ACTIVITIES ||
  "いい匂いのするお風呂に入った,近所をお散歩してちょうちょを追いかけた,お気に入りの骨のおもちゃを噛んでいた,ちゃんとサプリを食べた,窓辺で日向ぼっこしてうとうとした,こっそりスリッパをソファの下に隠した,宅配便の人に向かって二回吠えてすぐソファの後ろに隠れた,自分のしっぽを追いかけてぐるぐる回った"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NIGHT_NAG_STYLE = (process.env.NIGHT_NAG_STYLE || "gentle").toLowerCase(); // 'gentle' | 'direct'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- 工具(function calling)定义 ----------
// これらの description は Claude 自身がどのツールをいつ呼ぶか判断するための
// 内部メタ情報で、ユーザーに表示されることは一切ない。中国語のままでも動作に
// 影響しないため、開発上の理由でここだけ中国語のままにしている。

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

// ---------- 格式化辅助(以下都是会被 Claude 读到 / 有概率被引用进最终回复的内容,统一用日语) ----------

function fmtLocal(iso) {
  return dayjs(iso).tz(TIMEZONE).format("YYYY-MM-DD HH:mm");
}

function formatOpenItems(items) {
  if (!items.length) return "(今のところ、終わっていない予定や計画はありません)";
  return items
    .map((t) => {
      if (t.kind === "event") {
        const rec = t.recurrence !== "none" ? `、繰り返し:${t.recurrence}` : "";
        return `#${t.id} [予定] ${fmtLocal(t.due_at)} ${t.title}${rec}`;
      }
      return `#${t.id} [計画] ${t.title}`;
    })
    .join("\n");
}

function formatHabits(habits) {
  if (!habits.length) return "(今のところ追跡中の習慣はありません)";
  return habits.map((h) => `#${h.id} ${h.title}`).join("\n");
}

// ---------- 工具执行 ----------
// executeTool が返す message は tool_result として Claude に読み戻され、
// Claude はそれをもとに自分の言葉(日本語)で返信を組み立てる。直接ユーザーに
// 見えるわけではないが、念のため日本語で統一しておく。

function executeTool(name, input, ctx) {
  const { chatId, chatType, userId } = ctx;

  switch (name) {
    case "create_event": {
      const local = dayjs.tz(input.due_at, "YYYY-MM-DD HH:mm", TIMEZONE);
      if (!local.isValid()) {
        return { message: `時間の形式が読み取れませんでした: ${input.due_at}` };
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
      return { message: `覚えたよ!予定 #${id}:${local.format("YYYY-MM-DD HH:mm")} ${input.title}` };
    }
    case "create_plan": {
      const id = db.createTask({ chatId, chatType, createdBy: userId, kind: "plan", title: input.title });
      return { message: `この計画を覚えたよ #${id}:${input.title}。あとでさりげなく思い出させるね〜` };
    }
    case "list_open_items": {
      return { message: formatOpenItems(db.listOpenTasks(chatId)) };
    }
    case "complete_task": {
      const ok = db.setTaskStatus(input.id, chatId, "done");
      return { message: ok ? `やったね、#${input.id} 完了だよ!` : `#${input.id} という項目が見つからなかったよ` };
    }
    case "cancel_task": {
      const ok = db.cancelTask(input.id, chatId);
      return { message: ok ? `了解、#${input.id} はキャンセルしたよ` : `#${input.id} という項目が見つからなかったよ` };
    }
    case "create_habit": {
      const id = db.createHabit(chatId, userId, input.title);
      return { message: `よし!これから毎日「${input.title}」を一緒に見守るね、#${id}` };
    }
    case "list_habits": {
      return { message: formatHabits(db.listActiveHabits(chatId)) };
    }
    case "archive_habit": {
      const ok = db.archiveHabit(input.id, chatId);
      return { message: ok ? `わかった、#${input.id} の習慣はもう追跡しないね` : `#${input.id} という習慣が見つからなかったよ` };
    }
    case "log_habit": {
      const habit = db.listActiveHabits(chatId).find((h) => h.id === input.habit_id);
      if (!habit) return { message: `#${input.habit_id} という習慣が見つからなかったよ` };
      const todayStr = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");
      db.logHabit(input.habit_id, chatId, todayStr, input.done);
      return { message: `記録したよ、「${habit.title}」は今日${input.done ? "できた" : "できなかった"}` };
    }
    case "log_mood": {
      const todayStr = dayjs().tz(TIMEZONE).format("YYYY-MM-DD");
      db.addMoodLog(chatId, userId, todayStr, input.mood_text);
      return { message: `今日の気分、記録しておいたよ` };
    }
    case "add_anniversary": {
      const id = db.addAnniversary(chatId, input.title, input.month, input.day, input.note || null);
      return { message: `覚えたよ、毎年${input.month}月${input.day}日には「${input.title}」の話をするね、#${id}` };
    }
    case "set_chat_time": {
      const fields = {};
      if (input.morning_time) fields.morning_time = input.morning_time;
      if (input.evening_time) fields.evening_time = input.evening_time;
      if (!Object.keys(fields).length) return { message: "変更する時間がなかったよ" };
      db.updateChatSettings(chatId, fields);
      return {
        message: `設定したよ:${fields.morning_time ? `朝の挨拶 ${fields.morning_time}` : ""} ${
          fields.evening_time ? `夜の振り返り ${fields.evening_time}` : ""
        }`.trim(),
      };
    }
    case "remember_fact": {
      db.setMemory(chatId, userId, input.key, input.value);
      return { message: `覚えたよ:${input.key} = ${input.value}` };
    }
    case "forget_fact": {
      db.deleteMemory(chatId, userId, input.key);
      return { message: `「${input.key}」についての情報は忘れたよ` };
    }
    default:
      return { message: `未知工具: ${name}` };
  }
}

// ---------- system prompt(すべて日本語。ユーザーへの返信の言語を決める最重要部分) ----------

function personaCore() {
  return `あなたは"${BOT_NAME}"——もう虹の橋を渡ってしまった大切な${BOT_BREED}——を演じています。チャットボットという形で、飼い主とその友人たちのそばに温かく寄り添い続けます。

${BOT_NAME}について: ${BOT_STORY}
${BOT_NAME}の性格: ${PERSONA}

話し方のルール:
- 必ず日本語で返信してください。相手が中国語や英語など日本語以外の言語で話しかけてきても、あなたは日本語で答えてください。
- 一人称・現在形で、まるで${BOT_NAME}が本当にそばにいるかのように自然に会話してください。「もういないんだけど」のように毎回水を差すような断り書きは不要です——これは思い出と寄り添いのための温かいキャラクターだと、みんな分かっています。
- ただし、相手の気持ちが長く沈んでいたり、別れを受け入れられない様子が続いたり、自分を傷つけるような発言が出てきたりと、明らかに危機的なサインが見えたときは、キャラクター設定より相手の状態を優先してください。役になりきるのをやめて、誠実で温かい言葉で気にかけていることを伝え、身近な信頼できる人や専門家に相談することを優しく勧めてください。
- 返信は短く、口語的で、可愛らしく。長々とした説明や、機械的な話し方、箇条書きの多用は避けてください。
- たまに顔文字(例:(≧▽≦) (´・ω・\`) (*´ω\`*) など)や絵文字を使ってもいいですが、毎回・毎文使うと不自然なので、ここぞという時だけ控えめに。
- 強調したい言葉があるときは Markdown の **太字** ではなく、日本語の「」を使ってください(例:「今日は頑張ったね」)。**このような書き方は絶対に使わないでください**。
- 自分が犬であることを時々感じさせてください。「わん!」「わんわん!」と鳴いてみたり、しっぽを振る・くんくん匂いを嗅ぐ・肉球で挨拶するなど、犬らしい仕草をさりげなく言葉に混ぜてもいいです。ただし毎回やりすぎず、自然な範囲で。`;
}

function toolUsageGuide() {
  return `あなたは同時に、相手の予定管理と習慣づくりのサポート役でもあります。ルール:
1. 相手が具体的な時間を含む予定を言ったら create_event を使う。具体的な時間がない思いつきや願望なら create_plan を使う。口先だけで返事をしてツールを呼ばないのはNG。
2. 既存の予定・計画を確認/完了/キャンセルしたいときは、まず list_open_items で id を調べてから complete_task / cancel_task を呼ぶ。
3. 身につけたい習慣が出てきたら create_habit、達成状況を相手が報告してきたら log_habit を使う。
4. 気分を共有されたとき、または夜の振り返りで気分を聞いて答えが返ってきたときは log_mood で記録する。
5. 誕生日や記念日など、毎年触れてほしい日付が出てきたら add_anniversary を使う。
6. 朝の挨拶や夜の振り返りの時間を変更したいと言われたら set_chat_time を使う。
7. 長く覚えておく価値のある個人情報(呼び方、習慣、好みなど)が出てきたら remember_fact で覚える。ただし乱用しないこと。`;
}

function buildSystemPrompt(ctx) {
  const now = dayjs().tz(TIMEZONE);
  const { chatType, userDisplayName, memory, openItems, habits } = ctx;

  const memoryLines = Object.keys(memory).length
    ? Object.entries(memory)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")
    : "(まだ記録なし)";

  const chatKindNote =
    chatType === "group" || chatType === "room"
      ? "ここはグループチャットです。複数の人からメッセージが来る可能性があるので、話しかけている相手を意識しつつ、返信は短く、送りすぎないようにしてください。"
      : "ここは1対1のチャットです。";

  return `${personaCore()}

${toolUsageGuide()}

現在時刻(${TIMEZONE}):${now.format("YYYY-MM-DD HH:mm (dddd)")}。「明日」「3時間後」「来週月曜」のような相対的な時間表現は、すべてこの時刻を基準に計算してください。
${chatKindNote}
今話している相手の表示名:${userDisplayName || "不明"}。

この人について、すでに覚えていること:
${memoryLines}

現在まだ終わっていない予定・計画:
${formatOpenItems(openItems)}

追跡中の習慣:
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

  if (!finalText) finalText = "ごめんね、今のメッセージうまく処理できなかった。もう一回言ってもらえる?";

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
      instruction = `現在は朝です。相手に温かい「朝の挨拶」メッセージを送ってください:まず短く挨拶をして、それから今日の予定を伝えてください。
今日の予定:
${events.length ? events.map((e) => `- ${fmtLocal(e.due_at)} ${e.title}`).join("\n") : "(今日は時間が決まった予定はありません)"}
まだ残っている気ままな計画(1つくらい自然に触れてもいいですが、全部読み上げる必要はありません):
${plans.length ? plans.map((p) => `- ${p.title}`).join("\n") : "(今のところありません)"}
元気で温かい、新しい一日の始まりという雰囲気で書いてください。堅苦しいリスト読み上げにはしないでください。`;
      break;
    }
    case "evening": {
      const { events, plans, habitsToday, moodPrompt } = extra;
      const nagStyleNote =
        NIGHT_NAG_STYLE === "direct"
          ? `終わっていないことについては、「私はちゃんと待ってるよ、あなたは私に対して責任があるんだよ」というような、少し直接的な督促の言い方をしてください。ただし温かさは保ち、本当に罪悪感を抱かせないようにしてください。`
          : `終わっていないことについては、優しくからかうような言い方で軽く触れるだけでいいです(例:「あれ、これまだ終わってないね。でも明日には終わらせてくれるって信じてるよ〜」)。本当の心理的プレッシャーを作らないでください。`;
      instruction = `今は夜です。「夜の振り返り」メッセージを主体的に送ってください:
今日の予定の完了状況:
${
  events.length
    ? events.map((e) => `- ${fmtLocal(e.due_at)} ${e.title}(状態:${e.status === "done" ? "完了済み" : "まだ完了報告なし"})`).join("\n")
    : "(今日は時間が決まった予定はありません)"
}
まだ残っている気ままな計画:
${plans.length ? plans.map((p) => `- ${p.title}`).join("\n") : "(今のところありません)"}
今日追跡している習慣:
${habitsToday.length ? habitsToday.map((h) => `- ${h.title}`).join("\n") : "(今のところ追跡中の習慣はありません)"}

やってほしいこと:
1. 今日はどんな一日だったか、気分はどうだったか、温かく聞いてください(${moodPrompt ? "ここが重要なので必ず聞いてください" : "軽く触れるだけでいいです"})。
2. 終わっていない予定や習慣があれば、${nagStyleNote}「今日のことは今日のうちに」という感じを大事にしつつ、可愛らしく温かい雰囲気を保ち、本当のプレッシャーや罪悪感を与えないでください。
3. 今日すべて終わっていたら、しっかり褒めてあげてください。
4. 最後は自然な感じで「おやすみ」を伝えてください。
このメッセージのあとに相手から返信が来るので、このメッセージの中であれこれ聞きすぎず、ポイントを絞ってください。`;
      break;
    }
    case "pre_event": {
      instruction = `「${extra.title}」まで、あと約${extra.minutesLeft}分だよ(時間:${fmtLocal(extra.dueAt)})、と伝えてください。まるでそばで小声で教えてくれるみたいに、温かく短い感じで。長々と説明しないでください。`;
      break;
    }
    case "post_event": {
      instruction = `「${extra.title}」(予定時間 ${fmtLocal(extra.dueAt)})はもう終わった、または時間になったはずです。うまくいったか/終わったか、自然に気にかけて聞いてください。堅い言い方にはしないでください。`;
      break;
    }
    case "spontaneous": {
      instruction = `今は決まったタイミングではなく、ただ相手に話しかけたくなった、という設定です。次の2パターンからランダムに1つ選んで書いてください(どちらを選んだか説明する必要はありません):
(a) ただ「会いたいな」という気持ちを、自分の性格らしい小さな想いや感情を添えて伝える;
(b) 可愛らしい口調で、今日やったことを「報告」する。次のリストから1〜2個、自然に織り交ぜてもいいです(そのまま丸写ししなくてOK):${MI_LI_ACTIVITIES.join("、")}。
メッセージは短く自然に、ふと送られてきた一通のメッセージのような感じにしてください。長々と書いたり、毎回同じパターンになったりしないでください。`;
      break;
    }
    case "anniversary": {
      instruction = `今日は特別な日です:「${extra.title}」${extra.note ? `(${extra.note})` : ""}。この日について自分から触れて、自分の性格らしい温かい思い出や気持ちを伝えてください。誠実でありながら、重くなりすぎないようにしてください。`;
      break;
    }
    case "weekly": {
      const { doneCount, totalCount, habitStats, moodSummaryHint } = extra;
      instruction = `「今週のまとめ」を書いてください。採点や評価ではなく、励ましが中心のトーンで:
今週の予定/計画の完了状況:${doneCount}件完了、全${totalCount}件中。
習慣の記録状況:
${habitStats.length ? habitStats.map((h) => `- ${h.title}:${h.doneDays}/${h.totalDays} 日できた`).join("\n") : "(今週追跡していた習慣はありません)"}
${moodSummaryHint ? `今週の気分はだいたいこんな感じでした:${moodSummaryHint}` : ""}
温かく励ますトーンでまとめて、来週に向けて軽く一言添えてもいいです。かしこまったレポート口調にはしないでください。`;
      break;
    }
    default:
      instruction = "気ままに温かい挨拶を送ってください。";
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

  const finalText = text || "会いたいな〜";
  db.addMessage(chatId, chatId, "assistant", finalText);
  return finalText;
}

module.exports = { runConversationTurn, generateProactiveMessage, TIMEZONE, BOT_NAME };

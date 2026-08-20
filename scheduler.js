// scheduler.js
// 每分钟跑一次,负责所有"主动"的消息:
//   - 每个聊天各自设置的早报 / 晚间总结时间
//   - 纪念日(和早报一起触发)
//   - 每周小结
//   - 日程(event)提前提醒 + 到点后追问完成情况(全局按时间扫,不受 chat_settings 时间影响)
//   - 米粒随性汇报(不固定次数,按小时概率 + 冷却时间 + 安静时段来控制)

const cron = require("node-cron");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

const db = require("./db");
const { pushText } = require("./line");
const { generateProactiveMessage, TIMEZONE } = require("./claude");

const SPONTANEOUS_HOURLY_PROBABILITY = parseFloat(process.env.SPONTANEOUS_HOURLY_PROBABILITY || "0.18");
const SPONTANEOUS_MIN_GAP_HOURS = parseFloat(process.env.SPONTANEOUS_MIN_GAP_HOURS || "3");

function computeNextOccurrence(currentIso, recurrence) {
  const unitMap = { daily: "day", weekly: "week", monthly: "month" };
  const unit = unitMap[recurrence];
  if (!unit) return null;
  return dayjs(currentIso).add(1, unit).toISOString();
}

function isWithinQuietHours(nowHHmm, start, end) {
  if (!start || !end) return false;
  if (start <= end) {
    return nowHHmm >= start && nowHHmm < end;
  }
  // 跨零点的情况,例如 23:00 ~ 08:00
  return nowHHmm >= start || nowHHmm < end;
}

async function safePush(chatId, text, label) {
  try {
    await pushText(chatId, text);
  } catch (err) {
    console.error(`推送(${label})到 ${chatId} 失败:`, err.message);
  }
}

// ---------- 全局:日程提前提醒 / 到点后追问 ----------

async function handleEventReminders(nowIso) {
  const preList = db.getTasksNeedingPreNotify(nowIso);
  for (const task of preList) {
    try {
      const minutesLeft = Math.round(dayjs(task.due_at).diff(dayjs(nowIso), "minute", true));
      const text = await generateProactiveMessage({
        chatId: task.chat_id,
        chatType: task.chat_type,
        kind: "pre_event",
        extra: { title: task.title, dueAt: task.due_at, minutesLeft: Math.max(minutesLeft, 0) },
      });
      await safePush(task.chat_id, text, "事前提醒");
    } catch (err) {
      console.error(`生成事前提醒失败 (task #${task.id}):`, err);
    } finally {
      db.markPreNotified(task.id);
    }
  }

  const postList = db.getTasksNeedingPostCheck(nowIso);
  for (const task of postList) {
    try {
      const text = await generateProactiveMessage({
        chatId: task.chat_id,
        chatType: task.chat_type,
        kind: "post_event",
        extra: { title: task.title, dueAt: task.due_at },
      });
      await safePush(task.chat_id, text, "事后追问");
    } catch (err) {
      console.error(`生成事后追问失败 (task #${task.id}):`, err);
    } finally {
      db.markPostChecked(task.id);
      if (task.recurrence && task.recurrence !== "none") {
        const next = computeNextOccurrence(task.due_at, task.recurrence);
        if (next) db.rescheduleTask(task.id, next);
      }
    }
  }
}

// ---------- 按每个聊天的设置:早报 / 晚间总结 / 纪念日 / 周小结 / 随性汇报 ----------

async function handlePerChatJobs(now) {
  const todayStr = now.format("YYYY-MM-DD");
  const nowIso = now.toISOString();
  const currentHHmm = now.format("HH:mm");
  const month = now.month() + 1;
  const day = now.date();
  const dow = now.day(); // 0=周日

  const chats = db.listAllChatSettings();

  for (const chat of chats) {
    const { chat_id: chatId, chat_type: chatType } = chat;

    // ---- 早报 + 纪念日 ----
    if (chat.morning_time === currentHHmm && chat.last_morning_sent_date !== todayStr) {
      try {
        const { events, plans } = db.getTasksForMorningBrief(chatId, todayStr);
        const text = await generateProactiveMessage({
          chatId,
          chatType,
          kind: "morning",
          extra: { events, plans },
        });
        await safePush(chatId, text, "早报");

        const anniversaries = db.getTodaysAnniversaries(chatId, month, day);
        for (const ann of anniversaries) {
          const annText = await generateProactiveMessage({
            chatId,
            chatType,
            kind: "anniversary",
            extra: { title: ann.title, note: ann.note },
          });
          await safePush(chatId, annText, "纪念日");
        }
      } catch (err) {
        console.error(`生成早报失败 (${chatId}):`, err);
      } finally {
        db.markMorningSent(chatId, todayStr);
      }
    }

    // ---- 晚间总结 ----
    if (chat.evening_time === currentHHmm && chat.last_evening_sent_date !== todayStr) {
      try {
        const { events, plans } = db.getTasksForEveningSummary(chatId, todayStr);
        const habitsToday = db.listActiveHabits(chatId);
        const text = await generateProactiveMessage({
          chatId,
          chatType,
          kind: "evening",
          extra: { events, plans, habitsToday, moodPrompt: true },
        });
        await safePush(chatId, text, "晚间总结");
        db.markOverdueEventsMissed(chatId, todayStr, nowIso);
      } catch (err) {
        console.error(`生成晚间总结失败 (${chatId}):`, err);
      } finally {
        db.markEveningSent(chatId, todayStr);
      }
    }

    // ---- 每周小结 ----
    if (
      dow === chat.weekly_summary_dow &&
      chat.weekly_summary_time === currentHHmm &&
      chat.last_weekly_sent_date !== todayStr
    ) {
      try {
        const sinceIso = now.subtract(7, "day").toISOString();
        const { total, done } = db.getWeeklyTaskStats(chatId, sinceIso);
        const sinceDateStr = now.subtract(7, "day").format("YYYY-MM-DD");
        const habitLogs = db.getHabitLogsSince(chatId, sinceDateStr);
        const habitMap = new Map();
        for (const row of habitLogs) {
          if (!habitMap.has(row.title)) habitMap.set(row.title, { title: row.title, loggedDays: 0, doneDays: 0 });
          const entry = habitMap.get(row.title);
          entry.loggedDays += 1;
          if (row.done) entry.doneDays += 1;
        }
        const habitStats = Array.from(habitMap.values()).map((h) => ({
          title: h.title,
          doneDays: h.doneDays,
          totalDays: h.loggedDays,
        }));
        const moodLogs = db.getMoodLogsSince(chatId, sinceDateStr);
        const moodSummaryHint = moodLogs.map((m) => m.mood_text).slice(-15).join("; ");

        const text = await generateProactiveMessage({
          chatId,
          chatType,
          kind: "weekly",
          extra: { doneCount: done, totalCount: total, habitStats, moodSummaryHint },
        });
        await safePush(chatId, text, "周小结");
      } catch (err) {
        console.error(`生成周小结失败 (${chatId}):`, err);
      } finally {
        db.markWeeklySent(chatId, todayStr);
      }
    }

    // ---- 随性汇报(不固定次数)----
    if (chat.spontaneous_enabled && now.minute() === 0) {
      const withinQuiet = isWithinQuietHours(currentHHmm, chat.quiet_hours_start, chat.quiet_hours_end);
      const lastAt = chat.last_spontaneous_at ? dayjs(chat.last_spontaneous_at) : null;
      const cooledDown = !lastAt || now.diff(lastAt, "hour", true) >= SPONTANEOUS_MIN_GAP_HOURS;

      if (!withinQuiet && cooledDown && Math.random() < SPONTANEOUS_HOURLY_PROBABILITY) {
        try {
          const text = await generateProactiveMessage({ chatId, chatType, kind: "spontaneous" });
          await safePush(chatId, text, "随性汇报");
        } catch (err) {
          console.error(`生成随性汇报失败 (${chatId}):`, err);
        } finally {
          db.markSpontaneousSent(chatId, now.toISOString());
        }
      }
    }
  }
}

async function tick() {
  const now = dayjs().tz(TIMEZONE);
  const nowIso = now.toISOString();

  try {
    await handleEventReminders(nowIso);
  } catch (err) {
    console.error("处理日程提醒出错:", err);
  }

  try {
    await handlePerChatJobs(now);
  } catch (err) {
    console.error("处理每聊天定时任务出错:", err);
  }
}

function startScheduler() {
  cron.schedule("* * * * *", () => {
    tick().catch((err) => console.error("scheduler tick 出错:", err));
  });
  console.log("调度器已启动(每分钟检查一次:早报/晚间总结/日程提醒/随性汇报/周小结)。");
}

module.exports = { startScheduler, tick };

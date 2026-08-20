// db.js
// SQLite 数据层 v2:
//   tasks          —— 统一存放"日程"(event,有明确时间)和"随性计划"(plan,没有固定时间)
//   habits / habit_logs —— 习惯养成 + 每日打卡
//   mood_logs      —— 情绪小记录
//   anniversaries  —— 纪念日(米粒生日、相遇纪念日……),按月/日重复
//   chat_settings  —— 每个聊天各自的早报/晚间总结时间、随性汇报开关等
//   messages       —— 短期对话记忆(喂给 Claude 做上下文)
//   memory         —— 长期个性化记忆(key-value)
//
// 全部使用 better-sqlite3 的同步 API,简单可靠,足够单实例小机器人使用。

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || "./data/bot.db";

const dir = path.dirname(DB_PATH);
if (dir && dir !== "." && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  created_by TEXT,
  kind TEXT NOT NULL DEFAULT 'plan',      -- 'event'(有明确时间) | 'plan'(随性计划,没有固定时间)
  title TEXT NOT NULL,
  due_at TEXT,                            -- ISO 8601 UTC,只有 kind='event' 时有值
  remind_before_minutes INTEGER NOT NULL DEFAULT 60,
  recurrence TEXT NOT NULL DEFAULT 'none',-- 'none' | 'daily' | 'weekly' | 'monthly'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'missed' | 'cancelled'
  pre_notified INTEGER NOT NULL DEFAULT 0,-- 事前1小时提醒是否已发送
  post_checked INTEGER NOT NULL DEFAULT 0,-- 事后"完成了吗"是否已问过
  last_mentioned_at TEXT,                 -- plan 类型:米粒上次随口提起是什么时候(避免太唠叨)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_chat_status ON tasks(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, kind, due_at);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  created_by TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habits_chat ON habits(chat_id, status);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  log_date TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  done INTEGER,                           -- 1 完成 / 0 没完成 / NULL 还没问过
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(habit_id, log_date)
);

CREATE TABLE IF NOT EXISTS mood_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  log_date TEXT NOT NULL,
  mood_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mood_chat_date ON mood_logs(chat_id, log_date);

CREATE TABLE IF NOT EXISTS anniversaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anniversaries_chat ON anniversaries(chat_id);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY,
  chat_type TEXT NOT NULL,
  morning_time TEXT NOT NULL DEFAULT '09:00',
  evening_time TEXT NOT NULL DEFAULT '22:00',
  weekly_summary_dow INTEGER NOT NULL DEFAULT 0,   -- 0=周日 ... 6=周六
  weekly_summary_time TEXT NOT NULL DEFAULT '20:30',
  spontaneous_enabled INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start TEXT NOT NULL DEFAULT '23:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  last_morning_sent_date TEXT,
  last_evening_sent_date TEXT,
  last_weekly_sent_date TEXT,
  last_spontaneous_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS memory (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, user_id, key)
);
`);

// ---------- Tasks(日程 event / 随性计划 plan) ----------

function createTask({
  chatId,
  chatType,
  createdBy,
  kind = "plan",
  title,
  dueAt = null,
  remindBeforeMinutes = 60,
  recurrence = "none",
}) {
  const info = db
    .prepare(
      `INSERT INTO tasks (chat_id, chat_type, created_by, kind, title, due_at, remind_before_minutes, recurrence)
       VALUES (@chatId, @chatType, @createdBy, @kind, @title, @dueAt, @remindBeforeMinutes, @recurrence)`
    )
    .run({ chatId, chatType, createdBy, kind, title, dueAt, remindBeforeMinutes, recurrence });
  return info.lastInsertRowid;
}

function listOpenTasks(chatId, { kind } = {}) {
  if (kind) {
    return db
      .prepare(
        `SELECT * FROM tasks WHERE chat_id = ? AND kind = ? AND status = 'pending' ORDER BY due_at IS NULL, due_at ASC`
      )
      .all(chatId, kind);
  }
  return db
    .prepare(
      `SELECT * FROM tasks WHERE chat_id = ? AND status = 'pending' ORDER BY due_at IS NULL, due_at ASC`
    )
    .all(chatId);
}

function getTaskById(id, chatId) {
  return db.prepare(`SELECT * FROM tasks WHERE id = ? AND chat_id = ?`).get(id, chatId);
}

function setTaskStatus(id, chatId, status) {
  const completedAt = status === "done" ? new Date().toISOString() : null;
  const info = db
    .prepare(
      `UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ? AND chat_id = ?`
    )
    .run(status, completedAt, id, chatId);
  return info.changes > 0;
}

function cancelTask(id, chatId) {
  return setTaskStatus(id, chatId, "cancelled");
}

function rescheduleTask(id, newDueAt) {
  db.prepare(
    `UPDATE tasks SET due_at = ?, pre_notified = 0, post_checked = 0, status = 'pending' WHERE id = ?`
  ).run(newDueAt, id);
}

function touchPlanMentioned(id) {
  db.prepare(`UPDATE tasks SET last_mentioned_at = datetime('now') WHERE id = ?`).run(id);
}

// 事前提醒:event 类型、还没提醒过、且 (due_at - remind_before_minutes) <= now
function getTasksNeedingPreNotify(nowIso) {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE kind = 'event' AND status = 'pending' AND pre_notified = 0 AND due_at IS NOT NULL
         AND datetime(due_at, '-' || remind_before_minutes || ' minutes') <= ?`
    )
    .all(nowIso);
}

function markPreNotified(id) {
  db.prepare(`UPDATE tasks SET pre_notified = 1 WHERE id = ?`).run(id);
}

// 事后追问:event 类型、还没问过、且 due_at 已过
function getTasksNeedingPostCheck(nowIso) {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE kind = 'event' AND status = 'pending' AND post_checked = 0 AND due_at IS NOT NULL
         AND due_at <= ?`
    )
    .all(nowIso);
}

function markPostChecked(id) {
  db.prepare(`UPDATE tasks SET post_checked = 1 WHERE id = ?`).run(id);
}

// 用于晚间总结:今天到期、还 pending/未完成 的 event,以及所有还开着的 plan
function getTasksForEveningSummary(chatId, dateStr) {
  const events = db
    .prepare(
      `SELECT * FROM tasks WHERE chat_id = ? AND kind = 'event' AND status IN ('pending','missed')
       AND substr(due_at, 1, 10) = ? ORDER BY due_at ASC`
    )
    .all(chatId, dateStr);
  const plans = db
    .prepare(`SELECT * FROM tasks WHERE chat_id = ? AND kind = 'plan' AND status = 'pending'`)
    .all(chatId);
  return { events, plans };
}

// 用于早报:今天到期的 event + 还开着的 plan
function getTasksForMorningBrief(chatId, dateStr) {
  const events = db
    .prepare(
      `SELECT * FROM tasks WHERE chat_id = ? AND kind = 'event' AND status = 'pending'
       AND substr(due_at, 1, 10) = ? ORDER BY due_at ASC`
    )
    .all(chatId, dateStr);
  const plans = db
    .prepare(`SELECT * FROM tasks WHERE chat_id = ? AND kind = 'plan' AND status = 'pending'`)
    .all(chatId);
  return { events, plans };
}

// 把今天"时间已经过去"却还没完成的 event 标记为 missed(在晚间总结跑完之后调用)。
// 注意一定要带 nowIso 判断 due_at 是否真的已经过去——晚间总结时间可能早于当天某些
// event 的具体时间点(比如总结定在22:00,但有一条日程是23:30),这种还没到点的
// 不能被误判成"没完成"。
function markOverdueEventsMissed(chatId, dateStr, nowIso) {
  db.prepare(
    `UPDATE tasks SET status = 'missed' WHERE chat_id = ? AND kind = 'event' AND status = 'pending'
     AND substr(due_at, 1, 10) = ? AND due_at <= ?`
  ).run(chatId, dateStr, nowIso);
}

// 周小结用:近 N 天创建的任务里,完成了多少 / 一共多少(不含已取消的)
function getWeeklyTaskStats(chatId, sinceIso) {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE chat_id = ? AND created_at >= ? AND status != 'cancelled'`
    )
    .get(chatId, sinceIso).c;
  const done = db
    .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE chat_id = ? AND created_at >= ? AND status = 'done'`)
    .get(chatId, sinceIso).c;
  return { total, done };
}

// ---------- Habits ----------

function createHabit(chatId, createdBy, title) {
  const info = db
    .prepare(`INSERT INTO habits (chat_id, created_by, title) VALUES (?, ?, ?)`)
    .run(chatId, createdBy, title);
  return info.lastInsertRowid;
}

function listActiveHabits(chatId) {
  return db.prepare(`SELECT * FROM habits WHERE chat_id = ? AND status = 'active'`).all(chatId);
}

function archiveHabit(id, chatId) {
  const info = db
    .prepare(`UPDATE habits SET status = 'archived' WHERE id = ? AND chat_id = ?`)
    .run(id, chatId);
  return info.changes > 0;
}

function logHabit(habitId, chatId, dateStr, done) {
  db.prepare(
    `INSERT INTO habit_logs (habit_id, chat_id, log_date, done)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(habit_id, log_date) DO UPDATE SET done = excluded.done`
  ).run(habitId, chatId, dateStr, done ? 1 : 0);
}

function getHabitLogsSince(chatId, sinceDateStr) {
  return db
    .prepare(
      `SELECT hl.*, h.title FROM habit_logs hl
       JOIN habits h ON h.id = hl.habit_id
       WHERE hl.chat_id = ? AND hl.log_date >= ? ORDER BY hl.log_date ASC`
    )
    .all(chatId, sinceDateStr);
}

// ---------- Mood logs ----------

function addMoodLog(chatId, userId, dateStr, moodText) {
  db.prepare(
    `INSERT INTO mood_logs (chat_id, user_id, log_date, mood_text) VALUES (?, ?, ?, ?)`
  ).run(chatId, userId, dateStr, moodText);
}

function getMoodLogsSince(chatId, sinceDateStr) {
  return db
    .prepare(`SELECT * FROM mood_logs WHERE chat_id = ? AND log_date >= ? ORDER BY log_date ASC`)
    .all(chatId, sinceDateStr);
}

// ---------- Anniversaries ----------

function addAnniversary(chatId, title, month, day, note = null) {
  const info = db
    .prepare(`INSERT INTO anniversaries (chat_id, title, month, day, note) VALUES (?, ?, ?, ?, ?)`)
    .run(chatId, title, month, day, note);
  return info.lastInsertRowid;
}

function listAnniversaries(chatId) {
  return db.prepare(`SELECT * FROM anniversaries WHERE chat_id = ?`).all(chatId);
}

function getTodaysAnniversaries(chatId, month, day) {
  return db
    .prepare(`SELECT * FROM anniversaries WHERE chat_id = ? AND month = ? AND day = ?`)
    .all(chatId, month, day);
}

function deleteAnniversary(id, chatId) {
  const info = db.prepare(`DELETE FROM anniversaries WHERE id = ? AND chat_id = ?`).run(id, chatId);
  return info.changes > 0;
}

// ---------- Chat settings ----------

function ensureChatSettings(chatId, chatType) {
  db.prepare(
    `INSERT OR IGNORE INTO chat_settings (chat_id, chat_type) VALUES (?, ?)`
  ).run(chatId, chatType);
  return getChatSettings(chatId);
}

function getChatSettings(chatId) {
  return db.prepare(`SELECT * FROM chat_settings WHERE chat_id = ?`).get(chatId);
}

function listAllChatSettings() {
  return db.prepare(`SELECT * FROM chat_settings`).all();
}

function updateChatSettings(chatId, fields) {
  const allowed = [
    "morning_time",
    "evening_time",
    "weekly_summary_dow",
    "weekly_summary_time",
    "spontaneous_enabled",
    "quiet_hours_start",
    "quiet_hours_end",
  ];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE chat_settings SET ${setClause} WHERE chat_id = @chatId`).run({
    ...fields,
    chatId,
  });
}

function markMorningSent(chatId, dateStr) {
  db.prepare(`UPDATE chat_settings SET last_morning_sent_date = ? WHERE chat_id = ?`).run(dateStr, chatId);
}
function markEveningSent(chatId, dateStr) {
  db.prepare(`UPDATE chat_settings SET last_evening_sent_date = ? WHERE chat_id = ?`).run(dateStr, chatId);
}
function markWeeklySent(chatId, dateStr) {
  db.prepare(`UPDATE chat_settings SET last_weekly_sent_date = ? WHERE chat_id = ?`).run(dateStr, chatId);
}
function markSpontaneousSent(chatId, isoNow) {
  db.prepare(`UPDATE chat_settings SET last_spontaneous_at = ? WHERE chat_id = ?`).run(isoNow, chatId);
}

// ---------- Conversation history(短期记忆,给 Claude 提供上下文) ----------

function addMessage(chatId, userId, role, content) {
  db.prepare(`INSERT INTO messages (chat_id, user_id, role, content) VALUES (?, ?, ?, ?)`).run(
    chatId,
    userId,
    role,
    content
  );
  db.prepare(
    `DELETE FROM messages WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 200
     )`
  ).run(chatId, chatId);
}

function getRecentMessages(chatId, limit = 20) {
  const rows = db
    .prepare(
      `SELECT role, content, user_id, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(chatId, limit);
  return rows.reverse();
}

// ---------- Long-term per-user memory(个性化对话用) ----------

function setMemory(chatId, userId, key, value) {
  db.prepare(
    `INSERT INTO memory (chat_id, user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(chatId, userId, key, value);
}

function getMemory(chatId, userId) {
  const rows = db.prepare(`SELECT key, value FROM memory WHERE chat_id = ? AND user_id = ?`).all(chatId, userId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

function deleteMemory(chatId, userId, key) {
  db.prepare(`DELETE FROM memory WHERE chat_id = ? AND user_id = ? AND key = ?`).run(chatId, userId, key);
}

module.exports = {
  db,
  // tasks
  createTask,
  listOpenTasks,
  getTaskById,
  setTaskStatus,
  cancelTask,
  rescheduleTask,
  touchPlanMentioned,
  getTasksNeedingPreNotify,
  markPreNotified,
  getTasksNeedingPostCheck,
  markPostChecked,
  getTasksForEveningSummary,
  getTasksForMorningBrief,
  markOverdueEventsMissed,
  getWeeklyTaskStats,
  // habits
  createHabit,
  listActiveHabits,
  archiveHabit,
  logHabit,
  getHabitLogsSince,
  // mood
  addMoodLog,
  getMoodLogsSince,
  // anniversaries
  addAnniversary,
  listAnniversaries,
  getTodaysAnniversaries,
  deleteAnniversary,
  // chat settings
  ensureChatSettings,
  getChatSettings,
  listAllChatSettings,
  updateChatSettings,
  markMorningSent,
  markEveningSent,
  markWeeklySent,
  markSpontaneousSent,
  // messages / memory
  addMessage,
  getRecentMessages,
  setMemory,
  getMemory,
  deleteMemory,
};

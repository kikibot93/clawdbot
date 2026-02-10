const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "brain.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

// ============================================================
// BRAIN VERSION & MIGRATION SYSTEM
// ============================================================

const BRAIN_VERSION = 1;

function getBrainVersion() {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'brain_version'").get();
    return row ? parseInt(row.value) : 0;
  } catch (e) {
    return 0;
  }
}

function setBrainVersion(version) {
  db.prepare("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)").run();
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('brain_version', ?)").run(String(version));
}

function migrateBrain() {
  const currentVersion = getBrainVersion();
  console.log(`🧠 Brain version: ${currentVersion} → ${BRAIN_VERSION}`);
  
  if (currentVersion < BRAIN_VERSION) {
    console.log(`🔄 Migrating brain from v${currentVersion} to v${BRAIN_VERSION}...`);
    // Migrations will be added here by MCP when brain evolves
    setBrainVersion(BRAIN_VERSION);
    console.log("✅ Brain migration complete");
  }
}

// ============================================================
// SCHEMA
// ============================================================

db.exec(`
  -- Core memories: facts, preferences, corrections, errors
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,          -- 'fact', 'preference', 'correction', 'error', 'person', 'task'
    content TEXT NOT NULL,       -- the actual memory
    tags TEXT DEFAULT '',        -- comma-separated tags for search
    source TEXT DEFAULT '',      -- 'telegram', 'whatsapp', 'phone', 'system'
    user_id TEXT DEFAULT '',     -- who this memory is about/from
    importance INTEGER DEFAULT 5, -- 1-10 scale
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    archived INTEGER DEFAULT 0   -- soft delete for cleanup
  );

  -- Conversation logs: every message in/out
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,      -- 'telegram', 'whatsapp', 'phone'
    user_id TEXT DEFAULT '',     -- who sent/received
    role TEXT NOT NULL,          -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',  -- JSON: call_sid, tool_calls, etc.
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Error log: when things go wrong
  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT DEFAULT '',        -- which tool failed
    input TEXT DEFAULT '',       -- what was attempted
    error_message TEXT NOT NULL,
    resolution TEXT DEFAULT '',  -- how it was fixed (filled later)
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Users: multi-user support
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,         -- telegram id, phone number, etc.
    name TEXT DEFAULT '',
    platform TEXT DEFAULT '',    -- 'telegram', 'whatsapp'
    role TEXT DEFAULT 'user',    -- 'admin', 'user'
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  -- Scheduled tasks
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    cron TEXT DEFAULT '',        -- cron expression or 'once'
    next_run TEXT DEFAULT '',
    last_run TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    user_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Capability gaps: things the bot couldn't do
  CREATE TABLE IF NOT EXISTS capability_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request TEXT NOT NULL,          -- what the user asked for
    reason TEXT DEFAULT '',         -- why it failed or couldn't be done
    category TEXT DEFAULT '',       -- e.g. 'integration', 'tool', 'knowledge', 'permission'
    status TEXT DEFAULT 'open',     -- 'open', 'building', 'done', 'wont_fix'
    resolution TEXT DEFAULT '',     -- how it was eventually solved
    priority TEXT DEFAULT 'medium', -- 'low', 'medium', 'high'
    user_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT DEFAULT ''
  );

  -- Indexes for fast search
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
  CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations(platform);
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
  CREATE INDEX IF NOT EXISTS idx_errors_tool ON errors(tool);
`);

// Run brain migration on startup
migrateBrain();

// ============================================================
// MEMORY FUNCTIONS
// ============================================================

function saveMemory(type, content, { tags = "", source = "", userId = "", importance = 5 } = {}) {
  const stmt = db.prepare(`
    INSERT INTO memories (type, content, tags, source, user_id, importance)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(type, content, tags, source, userId, importance);
  return result.lastInsertRowid;
}

function searchMemories(query, { type = null, userId = null, limit = 20, includeArchived = false } = {}) {
  let sql = `SELECT * FROM memories WHERE 1=1`;
  const params = [];

  if (!includeArchived) {
    sql += ` AND archived = 0`;
  }
  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }
  if (userId) {
    sql += ` AND user_id = ?`;
    params.push(userId);
  }
  if (query) {
    sql += ` AND (content LIKE ? OR tags LIKE ?)`;
    params.push(`%${query}%`, `%${query}%`);
  }

  sql += ` ORDER BY importance DESC, updated_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function getAllMemories({ type = null, userId = null, limit = 50 } = {}) {
  return searchMemories(null, { type, userId, limit });
}

function getRecentMemories(limit = 10) {
  return db.prepare(`
    SELECT * FROM memories WHERE archived = 0
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function updateMemory(id, content) {
  db.prepare(`
    UPDATE memories SET content = ?, updated_at = datetime('now') WHERE id = ?
  `).run(content, id);
}

function archiveMemory(id) {
  db.prepare(`UPDATE memories SET archived = 1 WHERE id = ?`).run(id);
}

function archiveMemoriesByQuery(query) {
  const memories = searchMemories(query);
  let count = 0;
  for (const m of memories) {
    archiveMemory(m.id);
    count++;
  }
  return count;
}

function deleteArchivedMemories() {
  const result = db.prepare(`DELETE FROM memories WHERE archived = 1`).run();
  return result.changes;
}

// ============================================================
// CONVERSATION FUNCTIONS
// ============================================================

function logConversation(platform, role, content, { userId = "", metadata = {} } = {}) {
  db.prepare(`
    INSERT INTO conversations (platform, user_id, role, content, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(platform, userId, role, content, JSON.stringify(metadata));
}

function getConversationHistory(platform, userId, limit = 20) {
  return db.prepare(`
    SELECT * FROM conversations
    WHERE platform = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(platform, userId, limit).reverse();
}

function getRecentConversations(limit = 50) {
  return db.prepare(`
    SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse();
}

// ============================================================
// ERROR FUNCTIONS
// ============================================================

function logError(tool, input, errorMessage) {
  db.prepare(`
    INSERT INTO errors (tool, input, error_message)
    VALUES (?, ?, ?)
  `).run(tool, typeof input === "string" ? input : JSON.stringify(input), errorMessage);
}

function getRecentErrors(limit = 10) {
  return db.prepare(`
    SELECT * FROM errors ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function getErrorsForTool(tool) {
  return db.prepare(`
    SELECT * FROM errors WHERE tool = ? ORDER BY created_at DESC LIMIT 10
  `).all(tool);
}

function resolveError(id, resolution) {
  db.prepare(`UPDATE errors SET resolution = ? WHERE id = ?`).run(resolution, id);
}

// ============================================================
// USER FUNCTIONS
// ============================================================

function upsertUser(id, { name = "", platform = "", role = "user" } = {}) {
  db.prepare(`
    INSERT INTO users (id, name, platform, role)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(NULLIF(?, ''), name),
      last_seen = datetime('now')
  `).run(id, name, platform, role, name);
}

function getUser(id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

function getAllUsers() {
  return db.prepare(`SELECT * FROM users ORDER BY last_seen DESC`).all();
}

// ============================================================
// BRAIN STATS
// ============================================================

function getBrainStats() {
  const memories = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE archived = 0`).get();
  const archived = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE archived = 1`).get();
  const conversations = db.prepare(`SELECT COUNT(*) as count FROM conversations`).get();
  const errors = db.prepare(`SELECT COUNT(*) as count FROM errors`).get();
  const users = db.prepare(`SELECT COUNT(*) as count FROM users`).get();
  const memoryTypes = db.prepare(`
    SELECT type, COUNT(*) as count FROM memories WHERE archived = 0 GROUP BY type
  `).all();
  const dbSize = fs.statSync(DB_PATH).size;

  return {
    totalMemories: memories.count,
    archivedMemories: archived.count,
    totalConversations: conversations.count,
    totalErrors: errors.count,
    totalUsers: users.count,
    memoryTypes,
    dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
  };
}

// ============================================================
// EXPORT / BACKUP
// ============================================================

function exportBrain() {
  return {
    memories: db.prepare(`SELECT * FROM memories`).all(),
    conversations: db.prepare(`SELECT * FROM conversations`).all(),
    errors: db.prepare(`SELECT * FROM errors`).all(),
    users: db.prepare(`SELECT * FROM users`).all(),
    tasks: db.prepare(`SELECT * FROM tasks`).all(),
    exportedAt: new Date().toISOString(),
  };
}

function exportBrainToFile() {
  const data = exportBrain();
  const exportPath = path.join(__dirname, `brain-export-${Date.now()}.json`);
  fs.writeFileSync(exportPath, JSON.stringify(data, null, 2));
  return exportPath;
}

// ============================================================
// CLEANUP
// ============================================================

function cleanup({ olderThanDays = 90, keepImportant = true } = {}) {
  let deleted = 0;

  // Archive old low-importance memories
  const archiveResult = db.prepare(`
    UPDATE memories SET archived = 1
    WHERE archived = 0
    AND importance < 7
    AND created_at < datetime('now', '-' || ? || ' days')
  `).run(olderThanDays);
  deleted += archiveResult.changes;

  // Delete old conversation logs
  const convResult = db.prepare(`
    DELETE FROM conversations
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(olderThanDays);
  deleted += convResult.changes;

  return { archived: archiveResult.changes, conversationsDeleted: convResult.changes };
}

// ============================================================
// CAPABILITY GAPS
// ============================================================

function logCapabilityGap(request, { reason = "", category = "", priority = "medium", userId = "" } = {}) {
  const result = db.prepare(`
    INSERT INTO capability_gaps (request, reason, category, priority, user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(request, reason, category, priority, userId);
  return result.lastInsertRowid;
}

function getOpenGaps() {
  return db.prepare(`
    SELECT * FROM capability_gaps WHERE status = 'open' ORDER BY
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      created_at DESC
  `).all();
}

function getAllGaps({ status = null } = {}) {
  if (status) {
    return db.prepare(`SELECT * FROM capability_gaps WHERE status = ? ORDER BY created_at DESC`).all(status);
  }
  return db.prepare(`SELECT * FROM capability_gaps ORDER BY created_at DESC`).all();
}

function updateGapStatus(id, status, resolution = "") {
  const resolvedAt = (status === "done" || status === "wont_fix") ? new Date().toISOString() : "";
  db.prepare(`
    UPDATE capability_gaps SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?
  `).run(status, resolution, resolvedAt, id);
}

function deleteGap(id) {
  db.prepare(`DELETE FROM capability_gaps WHERE id = ?`).run(id);
}

module.exports = {
  db,
  // Brain migration
  getBrainVersion,
  setBrainVersion,
  migrateBrain,
  BRAIN_VERSION,
  // Memory
  saveMemory,
  searchMemories,
  getAllMemories,
  getRecentMemories,
  updateMemory,
  archiveMemory,
  archiveMemoriesByQuery,
  deleteArchivedMemories,
  // Conversations
  logConversation,
  getConversationHistory,
  getRecentConversations,
  // Errors
  logError,
  getRecentErrors,
  getErrorsForTool,
  resolveError,
  // Users
  upsertUser,
  getUser,
  getAllUsers,
  // Stats
  getBrainStats,
  // Export
  exportBrain,
  exportBrainToFile,
  // Cleanup
  cleanup,
  // Capability Gaps
  logCapabilityGap,
  getOpenGaps,
  getAllGaps,
  updateGapStatus,
  deleteGap,
};

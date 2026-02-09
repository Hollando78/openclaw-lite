import * as fs from "fs";
import * as path from "path";
import { CONFIG, getClient, type Session } from "./config.js";
import { lizardBrain } from "./lizard-brain.js";

// ============================================================================
// Session Management (Conversation History)
// ============================================================================

const sessions = new Map<string, Session>();
const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_CACHED_SESSIONS = 20; // Limit memory usage

function getSessionPath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(CONFIG.sessionsDir, `${safeId}.json`);
}

function flushSession(chatId: string): void {
  // Synchronously save a session if it has pending changes
  const timerId = pendingSaveTimers.get(chatId);
  if (!timerId) return;

  clearTimeout(timerId);
  pendingSaveTimers.delete(chatId);

  const session = sessions.get(chatId);
  if (!session) return;

  try {
    fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
    fs.writeFileSync(getSessionPath(chatId), JSON.stringify(session));
  } catch (err) {
    console.error(`[session] Failed to flush session for ${chatId}:`, err);
  }
}

function evictOldSessions(): void {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;

  // Find and remove least recently used sessions
  const sorted = [...sessions.entries()].sort(
    (a, b) => a[1].lastActivity - b[1].lastActivity
  );
  const toEvict = sorted.slice(0, sessions.size - MAX_CACHED_SESSIONS);
  for (const [chatId] of toEvict) {
    // Flush any pending changes before evicting
    flushSession(chatId);
    sessions.delete(chatId);
  }
}

export function loadSession(chatId: string): Session {
  if (sessions.has(chatId)) {
    return sessions.get(chatId)!;
  }

  const sessionPath = getSessionPath(chatId);
  let session: Session = { messages: [], lastActivity: Date.now() };

  try {
    // Try to read directly, catch ENOENT - avoids double FS call
    const data = fs.readFileSync(sessionPath, "utf-8");
    try {
      session = JSON.parse(data);
    } catch (parseErr: any) {
      // JSON is corrupted - backup the file and start fresh
      const backupPath = `${sessionPath}.corrupted.${Date.now()}`;
      try {
        fs.renameSync(sessionPath, backupPath);
        console.error(
          `[session] Corrupted session file for ${chatId}, backed up to ${backupPath}: ${parseErr.message}`
        );
      } catch {
        console.error(
          `[session] Corrupted session file for ${chatId} (backup failed): ${parseErr.message}`
        );
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to load session for ${chatId}:`, err);
    }
  }

  sessions.set(chatId, session);
  evictOldSessions();
  return session;
}

export function saveSession(chatId: string, _session: Session): void {
  // Debounce: schedule save if not already pending
  if (pendingSaveTimers.has(chatId)) return;

  const timerId = setTimeout(() => {
    pendingSaveTimers.delete(chatId);
    // Read fresh state from cache - fixes stale closure bug
    const currentSession = sessions.get(chatId);
    if (!currentSession) {
      // Session was cleared while save was pending - don't recreate
      return;
    }
    try {
      fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
      // Compact JSON - no pretty printing to save space
      fs.writeFileSync(getSessionPath(chatId), JSON.stringify(currentSession));
    } catch (err) {
      console.error(`[session] Failed to save session for ${chatId}:`, err);
    }
  }, 1000); // Debounce 1 second
  pendingSaveTimers.set(chatId, timerId);
}

export function addToSession(chatId: string, role: "user" | "assistant", content: string): void {
  const session = loadSession(chatId);
  session.messages.push({ role, content, timestamp: Date.now() });
  session.lastActivity = Date.now();

  // Trim history if too long
  if (session.messages.length > CONFIG.maxHistory) {
    session.messages = session.messages.slice(-CONFIG.maxHistory);
  }

  saveSession(chatId, session);
}

export function getConversationHistory(chatId: string): Array<{ role: "user" | "assistant"; content: string }> {
  const session = loadSession(chatId);
  return session.messages.map(({ role, content }) => ({ role, content }));
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
  // Cancel any pending save timer
  const timerId = pendingSaveTimers.get(chatId);
  if (timerId) {
    clearTimeout(timerId);
    pendingSaveTimers.delete(chatId);
  }
  try {
    fs.unlinkSync(getSessionPath(chatId));
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to clear session for ${chatId}:`, err);
    }
  }
}

// ============================================================================
// Conversation Compression (Summarize old messages to save tokens)
// ============================================================================

const COMPRESS_THRESHOLD = 25;  // Compress when history exceeds this
const KEEP_RECENT = 12;         // Keep this many recent messages uncompressed

export async function compressHistoryIfNeeded(chatId: string): Promise<void> {
  const session = loadSession(chatId);
  if (session.messages.length <= COMPRESS_THRESHOLD) return;

  const toCompress = session.messages.slice(0, -KEEP_RECENT);
  const toKeep = session.messages.slice(-KEEP_RECENT);

  // Format messages for summarization
  const formatted = toCompress.map(m => `${m.role}: ${m.content}`).join("\n");

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",  // Always use Haiku for compression
      max_tokens: 300,
      system: "Summarize this conversation in 2-3 sentences. Focus on key topics, decisions, and context needed for continuity. Be concise.",
      messages: [
        { role: "user", content: `${session.conversationSummary ? `Previous context: ${session.conversationSummary}\n\n` : ""}Conversation:\n${formatted}` }
      ],
    });

    const summary = response.content[0].type === "text" ? response.content[0].text : null;
    if (summary) {
      session.conversationSummary = summary;
      session.messages = toKeep;
      saveSession(chatId, session);
      console.log(`[compress] Compressed ${toCompress.length} messages for ${chatId.slice(0, 15)}... (${summary.length} chars)`);

      // Track compression tokens
      const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
      lizardBrain.tokens.used += tokens;
    }
  } catch (err) {
    console.error(`[compress] Failed to compress history:`, err);
  }
}

export function getCompressedHistory(chatId: string): { summary: string | null; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const session = loadSession(chatId);
  return {
    summary: session.conversationSummary || null,
    messages: session.messages.map(({ role, content }) => ({ role, content })),
  };
}

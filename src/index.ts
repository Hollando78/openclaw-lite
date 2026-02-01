#!/usr/bin/env node
/**
 * OpenClaw Lite - Minimal WhatsApp AI Assistant
 *
 * The same lobster, smaller shell. 🦞
 *
 * Designed for low-resource devices (1GB RAM, limited storage).
 * Uses Baileys for WhatsApp and Anthropic Claude for intelligence.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import Anthropic from "@anthropic-ai/sdk";
import * as qrcode from "qrcode-terminal";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import "dotenv/config";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Auth state directory (WhatsApp session)
  authDir: process.env.OPENCLAW_AUTH_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "auth"),

  // Sessions directory (conversation history)
  sessionsDir: process.env.OPENCLAW_SESSIONS_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "sessions"),

  // Anthropic API key
  apiKey: process.env.ANTHROPIC_API_KEY || "",

  // Model to use
  model: process.env.OPENCLAW_MODEL || "claude-sonnet-4-20250514",

  // Max tokens per response
  maxTokens: parseInt(process.env.OPENCLAW_MAX_TOKENS || "4096", 10),

  // Max conversation history to keep (messages)
  maxHistory: parseInt(process.env.OPENCLAW_MAX_HISTORY || "50", 10),

  // Allowed numbers (empty = allow all, comma-separated E.164 numbers)
  // Pre-compute digits for faster matching
  allowList: (process.env.OPENCLAW_ALLOW_LIST || "")
    .split(",")
    .filter(Boolean)
    .map((n) => n.replace(/[^0-9]/g, "")),

  // Owner number (for admin commands)
  ownerNumber: process.env.OPENCLAW_OWNER || "",

  // Status server port (for kiosk display)
  statusPort: parseInt(process.env.OPENCLAW_STATUS_PORT || "8080", 10),

  // Workspace directory (for SOUL.md and other config files)
  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME || ".", ".openclaw-lite"),
};

// ============================================================================
// Status Tracking (for kiosk display)
// ============================================================================

const status = {
  state: "starting" as "starting" | "qr" | "connected" | "disconnected",
  qrCode: null as string | null,
  phoneNumber: null as string | null,
  startTime: Date.now(),
  messagesReceived: 0,
  messagesSent: 0,
  lastMessage: null as { from: string; preview: string; time: number } | null,
  errors: [] as Array<{ time: number; message: string }>,
};

function addError(message: string) {
  status.errors.push({ time: Date.now(), message });
  if (status.errors.length > 10) {
    status.errors.shift();
  }
}

function formatUptime(): string {
  const ms = Date.now() - status.startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================================================
// Status Server (for kiosk display)
// ============================================================================

function startStatusServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...status,
        uptime: formatUptime(),
      }));
      return;
    }

    // Serve kiosk HTML page
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateKioskHTML());
  });

  // Bind to localhost only - never expose to network
  server.listen(CONFIG.statusPort, "127.0.0.1", () => {
    console.log(`🖥️  Kiosk status page: http://localhost:${CONFIG.statusPort}`);
  });
}

function generateKioskHTML(): string {
  const stateEmoji = {
    starting: "⏳",
    qr: "📱",
    connected: "✅",
    disconnected: "❌",
  }[status.state];

  const stateText = {
    starting: "Starting...",
    qr: "Scan QR Code",
    connected: "Connected",
    disconnected: "Disconnected",
  }[status.state];

  const qrSection = status.qrCode && status.state === "qr"
    ? `<div class="qr-container">
        <div class="qr-label">Scan with WhatsApp:</div>
        <pre class="qr-code">${escapeHtml(status.qrCode)}</pre>
       </div>`
    : "";

  const lastMessageSection = status.lastMessage
    ? `<div class="last-message">
        <div class="label">Last message:</div>
        <div class="message">"${escapeHtml(status.lastMessage.preview)}"</div>
        <div class="time">${new Date(status.lastMessage.time).toLocaleTimeString()}</div>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>OpenClaw Lite</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 400px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 24px;
      font-weight: 600;
    }
    .status-card {
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .status-row:last-child { border-bottom: none; }
    .status-label { color: rgba(255,255,255,0.7); }
    .status-value { font-weight: 600; font-size: 18px; }
    .status-connected { color: #4ade80; }
    .status-disconnected { color: #f87171; }
    .status-qr { color: #fbbf24; }
    .qr-container {
      background: #fff;
      border-radius: 12px;
      padding: 20px;
      margin-top: 20px;
      text-align: center;
    }
    .qr-label {
      color: #1a1a2e;
      margin-bottom: 15px;
      font-weight: 600;
    }
    .qr-code {
      font-family: monospace;
      font-size: 4px;
      line-height: 4px;
      color: #000;
      background: #fff;
      display: inline-block;
      padding: 10px;
    }
    .last-message {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 15px;
      margin-top: 20px;
    }
    .last-message .label {
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .last-message .message {
      font-style: italic;
      margin-bottom: 5px;
    }
    .last-message .time {
      color: rgba(255,255,255,0.5);
      font-size: 12px;
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-top: 20px;
    }
    .stat {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 15px;
      text-align: center;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: #60a5fa;
    }
    .stat-label {
      color: rgba(255,255,255,0.6);
      font-size: 12px;
      margin-top: 5px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🦞</div>
      <div class="title">OpenClaw Lite</div>
    </div>

    <div class="status-card">
      <div class="status-row">
        <span class="status-label">Status</span>
        <span class="status-value ${status.state === 'connected' ? 'status-connected' : status.state === 'qr' ? 'status-qr' : 'status-disconnected'}">
          ${stateEmoji} ${stateText}
        </span>
      </div>
      <div class="status-row">
        <span class="status-label">Uptime</span>
        <span class="status-value">${formatUptime()}</span>
      </div>
      ${status.phoneNumber ? `
      <div class="status-row">
        <span class="status-label">Phone</span>
        <span class="status-value">${status.phoneNumber}</span>
      </div>
      ` : ''}
      <div class="status-row">
        <span class="status-label">Model</span>
        <span class="status-value" style="font-size: 14px;">${CONFIG.model.split('/').pop()}</span>
      </div>
    </div>

    ${qrSection}

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${status.messagesReceived}</div>
        <div class="stat-label">Received</div>
      </div>
      <div class="stat">
        <div class="stat-value">${status.messagesSent}</div>
        <div class="stat-label">Sent</div>
      </div>
    </div>

    ${lastMessageSection}
  </div>

  <script>
    // Auto-refresh every 3 seconds
    setTimeout(() => location.reload(), 3000);
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================================
// System Prompt - The OpenClaw Personality
// ============================================================================

const DEFAULT_PERSONALITY = `## Personality
- Helpful, direct, and efficient
- You have a subtle lobster theme (the "lobster way" 🦞) but don't overdo it
- You're running on limited hardware, so you appreciate brevity
- You remember context from the conversation`;

let cachedSoul: { content: string | null; loadedAt: number } | null = null;
const SOUL_CACHE_TTL = 60000; // Reload SOUL.md every 60 seconds

function loadSoulFile(): string | null {
  // Check cache first
  if (cachedSoul && Date.now() - cachedSoul.loadedAt < SOUL_CACHE_TTL) {
    return cachedSoul.content;
  }

  const soulPath = path.join(CONFIG.workspaceDir, "SOUL.md");

  try {
    // Try to read directly - avoids double FS call
    const content = fs.readFileSync(soulPath, "utf-8").trim();
    cachedSoul = { content, loadedAt: Date.now() };
    console.log(`[soul] Loaded personality from ${soulPath}`);
    return content;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[soul] Failed to load SOUL.md:`, err);
    }
    cachedSoul = { content: null, loadedAt: Date.now() };
    return null;
  }
}

function buildSystemPrompt(): string {
  const soul = loadSoulFile();

  const personalitySection = soul || DEFAULT_PERSONALITY;

  return `You are OpenClaw, a personal AI assistant. You communicate via WhatsApp.

${personalitySection}

## Capabilities
- Answer questions and have conversations
- Help with tasks, planning, and problem-solving
- Provide information and explanations
- Be a thoughtful companion

## Guidelines
- Keep responses concise for mobile reading
- Use markdown sparingly (WhatsApp has limited formatting)
- If asked about yourself, you're "OpenClaw Lite" - a minimal personal AI assistant
- Be warm but not overly effusive
- If you don't know something, say so

## Current Context
- Platform: WhatsApp
- Time: ${new Date().toISOString()}
`;
}

// ============================================================================
// Session Management (Conversation History)
// ============================================================================

type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type Session = {
  messages: Message[];
  lastActivity: number;
};

const sessions = new Map<string, Session>();
const pendingSaves = new Set<string>();
const MAX_CACHED_SESSIONS = 20; // Limit memory usage

function getSessionPath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(CONFIG.sessionsDir, `${safeId}.json`);
}

function evictOldSessions(): void {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;

  // Find and remove least recently used sessions
  const sorted = [...sessions.entries()].sort(
    (a, b) => a[1].lastActivity - b[1].lastActivity
  );
  const toEvict = sorted.slice(0, sessions.size - MAX_CACHED_SESSIONS);
  for (const [chatId] of toEvict) {
    sessions.delete(chatId);
  }
}

function loadSession(chatId: string): Session {
  if (sessions.has(chatId)) {
    return sessions.get(chatId)!;
  }

  const sessionPath = getSessionPath(chatId);
  let session: Session = { messages: [], lastActivity: Date.now() };

  try {
    // Try to read directly, catch ENOENT - avoids double FS call
    const data = fs.readFileSync(sessionPath, "utf-8");
    session = JSON.parse(data);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to load session for ${chatId}:`, err);
    }
  }

  sessions.set(chatId, session);
  evictOldSessions();
  return session;
}

function saveSession(chatId: string, session: Session): void {
  // Debounce: schedule save if not already pending
  if (pendingSaves.has(chatId)) return;

  pendingSaves.add(chatId);
  setTimeout(() => {
    pendingSaves.delete(chatId);
    try {
      fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
      // Compact JSON - no pretty printing to save space
      fs.writeFileSync(getSessionPath(chatId), JSON.stringify(session));
    } catch (err) {
      console.error(`[session] Failed to save session for ${chatId}:`, err);
    }
  }, 1000); // Debounce 1 second
}

function addToSession(chatId: string, role: "user" | "assistant", content: string): void {
  const session = loadSession(chatId);
  session.messages.push({ role, content, timestamp: Date.now() });
  session.lastActivity = Date.now();

  // Trim history if too long
  if (session.messages.length > CONFIG.maxHistory) {
    session.messages = session.messages.slice(-CONFIG.maxHistory);
  }

  saveSession(chatId, session);
}

function getConversationHistory(chatId: string): Array<{ role: "user" | "assistant"; content: string }> {
  const session = loadSession(chatId);
  return session.messages.map(({ role, content }) => ({ role, content }));
}

function clearSession(chatId: string): void {
  sessions.delete(chatId);
  pendingSaves.delete(chatId); // Cancel any pending save
  try {
    fs.unlinkSync(getSessionPath(chatId));
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to clear session for ${chatId}:`, err);
    }
  }
}

// ============================================================================
// Claude API
// ============================================================================

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    if (!CONFIG.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    anthropic = new Anthropic({ apiKey: CONFIG.apiKey });
  }
  return anthropic;
}

async function chat(chatId: string, userMessage: string): Promise<string> {
  const client = getClient();

  // Add user message to history
  addToSession(chatId, "user", userMessage);

  // Get conversation history
  const history = getConversationHistory(chatId);

  try {
    const response = await client.messages.create({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: buildSystemPrompt(),
      messages: history,
    });

    // Extract text response
    const assistantMessage = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Add assistant response to history
    addToSession(chatId, "assistant", assistantMessage);

    return assistantMessage;
  } catch (err) {
    console.error("[claude] API error:", err);
    addError(`Claude API error: ${err}`);
    throw err;
  }
}

// ============================================================================
// Command Handling
// ============================================================================

function isCommand(text: string): boolean {
  return text.startsWith("/");
}

function handleCommand(chatId: string, senderId: string, text: string): string | null {
  const [cmd, ...args] = text.slice(1).split(" ");
  const command = cmd?.toLowerCase();

  switch (command) {
    case "clear":
    case "reset":
      clearSession(chatId);
      return "🦞 Session cleared. Starting fresh!";

    case "help":
      return `🦞 *OpenClaw Lite Commands*

/clear - Clear conversation history
/status - Show bot status
/help - Show this help

Just send a message to chat with me!`;

    case "status":
      const session = loadSession(chatId);
      return `🦞 *OpenClaw Lite Status*

Model: ${CONFIG.model}
Messages in session: ${session.messages.length}
Uptime: ${formatUptime()}
Messages received: ${status.messagesReceived}
Messages sent: ${status.messagesSent}

Running on minimal hardware 💪`;

    default:
      return null; // Not a recognized command, treat as regular message
  }
}

// ============================================================================
// Access Control
// ============================================================================

function isAllowed(senderId: string): boolean {
  if (CONFIG.allowList.length === 0) {
    return true; // No allowlist = allow all
  }

  // Extract just the digits from sender ID (remove @s.whatsapp.net suffix and any non-digits)
  const senderDigits = senderId.replace(/@.*$/, "").replace(/[^0-9]/g, "");

  // Allowlist is pre-computed to digits at startup
  return CONFIG.allowList.includes(senderDigits);
}

// ============================================================================
// WhatsApp Connection
// ============================================================================

async function startWhatsApp(): Promise<void> {
  console.log("🦞 OpenClaw Lite starting...");
  console.log(`   Model: ${CONFIG.model}`);
  console.log(`   Auth dir: ${CONFIG.authDir}`);
  console.log(`   Sessions dir: ${CONFIG.sessionsDir}`);
  console.log(`   Workspace: ${CONFIG.workspaceDir}`);

  // Check for SOUL.md
  const soulPath = path.join(CONFIG.workspaceDir, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    console.log(`   Soul: ${soulPath} ✓`);
  } else {
    console.log(`   Soul: using default personality (create ${soulPath} to customize)`);
  }

  if (!CONFIG.apiKey) {
    console.error("❌ ANTHROPIC_API_KEY is not set!");
    console.error("   Set it in your environment or .env file");
    process.exit(1);
  }

  // Ensure directories exist
  fs.mkdirSync(CONFIG.authDir, { recursive: true });
  fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });

  // Start status server for kiosk display
  startStatusServer();

  // Load auth state
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);

  // Create socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We'll handle QR ourselves
    browser: ["OpenClaw Lite", "Chrome", "1.0.0"],
  });

  // Handle connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Generate QR once, use for both terminal and kiosk
      status.state = "qr";
      qrcode.generate(qr, { small: true }, (qrText: string) => {
        status.qrCode = qrText;
        console.log("\n📱 Scan this QR code with WhatsApp:\n");
        console.log(qrText);
        console.log("\n");
      });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      status.state = "disconnected";
      addError(`Connection closed: ${statusCode}`);

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        console.log("Logged out. Please delete auth folder and restart to re-link.");
      }
    } else if (connection === "open") {
      console.log("🦞 Connected to WhatsApp!");
      console.log("   Ready to receive messages.\n");
      status.state = "connected";
      status.qrCode = null;

      // Try to get phone number
      const user = sock.user;
      if (user?.id) {
        status.phoneNumber = user.id.split(":")[0] || user.id.split("@")[0] || null;
      }
    }
  });

  // Save credentials when updated
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip if not a regular message
      if (!msg.message) continue;

      // Skip messages from self
      if (msg.key.fromMe) continue;

      // Get chat ID and sender
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Get sender (for groups, this is the participant)
      const senderId = msg.key.participant || chatId;

      // Check access
      if (!isAllowed(senderId)) {
        console.log(`[blocked] Message from ${senderId} (not in allowlist)`);
        continue;
      }

      // Extract text content
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text) continue;

      status.messagesReceived++;
      status.lastMessage = {
        from: senderId.replace(/@.*$/, ""),
        preview: text.slice(0, 50) + (text.length > 50 ? "..." : ""),
        time: Date.now(),
      };

      console.log(`[message] ${senderId}: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);

      try {
        let response: string;

        // Check for commands
        if (isCommand(text)) {
          const cmdResponse = handleCommand(chatId, senderId, text);
          if (cmdResponse) {
            response = cmdResponse;
          } else {
            // Not a recognized command, treat as regular message
            response = await chat(chatId, text);
          }
        } else {
          // Regular message - chat with Claude
          response = await chat(chatId, text);
        }

        // Send response
        await sock.sendMessage(chatId, { text: response });
        status.messagesSent++;
        console.log(`[reply] Sent ${response.length} chars`);
      } catch (err) {
        console.error("[error] Failed to process message:", err);
        addError(`Message processing error: ${err}`);

        // Send error message
        await sock.sendMessage(chatId, {
          text: "🦞 Sorry, I encountered an error. Please try again.",
        });
      }
    }
  });
}

// ============================================================================
// Main
// ============================================================================

startWhatsApp().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

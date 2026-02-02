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
import qrcode from "qrcode-terminal";
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

  // Status server bind address (127.0.0.1 for local only, 0.0.0.0 for all interfaces)
  statusBind: process.env.OPENCLAW_STATUS_BIND || "127.0.0.1",

  // Workspace directory (for SOUL.md and other config files)
  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME || ".", ".openclaw-lite"),

  // Lizard-brain settings
  dailyTokenBudget: parseInt(process.env.OPENCLAW_DAILY_TOKEN_BUDGET || "100000", 10),
  lizardInterval: parseInt(process.env.OPENCLAW_LIZARD_INTERVAL || "30000", 10),
};

// ============================================================================
// Lizard-Brain Types and State
// ============================================================================

type Reminder = {
  chatId: string;
  message: string;
  dueAt: number;
  setAt: number;
};

type LizardBrain = {
  // Mood (0-100 each)
  energy: number;      // Depletes with activity, recovers over time
  stress: number;      // Increases with errors/load, decays naturally
  curiosity: number;   // Engagement level

  // Token tracking
  tokens: {
    used: number;      // Today's usage
    budget: number;    // Daily limit
    resetAt: number;   // Midnight reset timestamp
  };

  // Resource awareness
  resources: {
    apiErrors: number;
    rateLimit: { remaining: number | null; resetAt: number | null };
  };

  // Proactive behaviors
  proactive: {
    pendingReminders: Reminder[];
    idleSince: number;
  };

  // Track last response for "what did you say" pattern
  lastResponses: Map<string, string>;
};

// Initialize lizard-brain state
const lizardBrain: LizardBrain = {
  energy: 100,
  stress: 0,
  curiosity: 50,
  tokens: {
    used: 0,
    budget: CONFIG.dailyTokenBudget,
    resetAt: getNextMidnight(),
  },
  resources: {
    apiErrors: 0,
    rateLimit: { remaining: null, resetAt: null },
  },
  proactive: {
    pendingReminders: [],
    idleSince: Date.now(),
  },
  lastResponses: new Map(),
};

function getNextMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// ============================================================================
// Lizard-Brain Quick Response Patterns
// ============================================================================

type QuickPattern = {
  patterns: RegExp[];
  response: (chatId: string, match: RegExpMatchArray | null) => string | null;
};

const GREETING_RESPONSES = [
  "Hey there! 🦞",
  "Hi! What's up?",
  "Hello! How can I help?",
  "Hey! 👋",
];

const THANKS_RESPONSES = [
  "You're welcome!",
  "No problem! 🦞",
  "Happy to help!",
  "Anytime!",
];

const HOW_ARE_YOU_RESPONSES: Record<string, string[]> = {
  lowEnergy: [
    "*yawn* A bit tired, but here for you!",
    "Running on low battery today... but still kicking! 🦞",
    "Feeling a bit sleepy, but ready to help.",
  ],
  highStress: [
    "Bit overwhelmed right now, but managing!",
    "Been busy! Taking a breath... 🦞",
    "A lot going on, but I'm here.",
  ],
  highCuriosity: [
    "Feeling curious and ready to explore! What's on your mind?",
    "Great! Been thinking about interesting stuff. What about you?",
    "Excited to chat! 🦞 What's up?",
  ],
  normal: [
    "Doing well! How can I help? 🦞",
    "Good! What's on your mind?",
    "All good here! What can I do for you?",
  ],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getMoodAwareHowAreYou(): string {
  if (lizardBrain.energy < 30) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.lowEnergy);
  }
  if (lizardBrain.stress > 50) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.highStress);
  }
  if (lizardBrain.curiosity > 80) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.highCuriosity);
  }
  return pickRandom(HOW_ARE_YOU_RESPONSES.normal);
}

function parseReminderTime(text: string): { minutes: number; task: string } | null {
  // Match patterns like "remind me in 30 min to call mom" or "remind me in 1 hour to check email"
  const match = text.match(/remind\s+me\s+in\s+(\d+)\s*(min(?:ute)?s?|hour?s?|hr?s?)\s+(?:to\s+)?(.+)/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const task = match[3].trim();

  let minutes = amount;
  if (unit.startsWith("h")) {
    minutes = amount * 60;
  }

  return { minutes, task };
}

const quickPatterns: QuickPattern[] = [
  // Greetings
  {
    patterns: [/^(hi|hello|hey|yo|sup|hiya|howdy)[\s!.,?]*$/i],
    response: () => pickRandom(GREETING_RESPONSES),
  },
  // Thanks
  {
    patterns: [/^(thanks|thank\s*you|thx|ty|cheers)[\s!.,?]*$/i],
    response: () => pickRandom(THANKS_RESPONSES),
  },
  // Time query
  {
    patterns: [/what\s*(time|hour)\s*(is\s*it)?/i, /^time\??$/i],
    response: () => {
      const now = new Date();
      return `It's ${now.toLocaleTimeString()} 🕐`;
    },
  },
  // Date query
  {
    patterns: [/what\s*(day|date)\s*(is\s*it)?/i, /^date\??$/i, /today'?s?\s*date/i],
    response: () => {
      const now = new Date();
      return `It's ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} 📅`;
    },
  },
  // How are you
  {
    patterns: [/how\s*(are|r)\s*(you|u)/i, /how'?s?\s*(it\s*going|things)/i, /you\s*(ok|okay|good|alright)/i],
    response: () => getMoodAwareHowAreYou(),
  },
  // Repeat last response
  {
    patterns: [/what\s*did\s*(you|u)\s*say/i, /repeat\s*that/i, /say\s*that\s*again/i, /^huh\??$/i],
    response: (chatId) => {
      const last = lizardBrain.lastResponses.get(chatId);
      if (last) {
        return `I said: "${last}"`;
      }
      return "I haven't said anything yet in this conversation!";
    },
  },
  // Set reminder
  {
    patterns: [/remind\s+me\s+in\s+\d+/i],
    response: (chatId, match) => {
      const text = match?.input || "";
      const parsed = parseReminderTime(text);
      if (!parsed) return null;

      const dueAt = Date.now() + parsed.minutes * 60 * 1000;
      lizardBrain.proactive.pendingReminders.push({
        chatId,
        message: parsed.task,
        dueAt,
        setAt: Date.now(),
      });

      const timeStr = parsed.minutes >= 60
        ? `${Math.floor(parsed.minutes / 60)} hour${parsed.minutes >= 120 ? "s" : ""}`
        : `${parsed.minutes} minute${parsed.minutes !== 1 ? "s" : ""}`;

      return `⏰ Got it! I'll remind you in ${timeStr} to: ${parsed.task}`;
    },
  },
];

// Check for special states that override normal processing
function checkSpecialStates(): string | null {
  const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // Token budget exhausted (100%+)
  if (usage >= 1.0) {
    return "🔋 I've run out of thinking power for today. My brain resets at midnight! Simple questions I can still handle.";
  }

  // Running low on tokens (95%+)
  if (usage >= 0.95) {
    return "🔋 Running really low on thinking power... I can only handle simple requests right now.";
  }

  // High stress state (80%+)
  if (lizardBrain.stress >= 80) {
    lizardBrain.stress -= 10; // Taking a breath helps
    return "🧘 Taking a breath... I've been working hard. Give me a moment and try again.";
  }

  return null;
}

function tryQuickResponse(chatId: string, text: string): string | null {
  // Check special states first
  const specialResponse = checkSpecialStates();
  if (specialResponse) {
    // For exhausted tokens, only allow quick patterns through
    const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
    if (usage >= 1.0) {
      // Still try quick patterns even when exhausted
      for (const pattern of quickPatterns) {
        for (const regex of pattern.patterns) {
          const match = text.match(regex);
          if (match) {
            const response = pattern.response(chatId, match);
            if (response) {
              return response;
            }
          }
        }
      }
      // No quick pattern matched, return the budget exhausted message
      return specialResponse;
    }
    // For high stress, just return the "taking a breath" message
    if (lizardBrain.stress >= 80) {
      return specialResponse;
    }
  }

  // Try each quick pattern
  for (const pattern of quickPatterns) {
    for (const regex of pattern.patterns) {
      const match = text.match(regex);
      if (match) {
        const response = pattern.response(chatId, match);
        if (response) {
          // Small energy cost for quick responses
          lizardBrain.energy = Math.max(0, lizardBrain.energy - 1);
          return response;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// Lizard-Brain Budget-Aware API Parameters
// ============================================================================

type BudgetAwareParams = {
  model: string;
  maxTokens: number;
  maxHistory: number;
  shouldBlock: boolean;
};

function getBudgetAwareParams(): BudgetAwareParams {
  const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // 100%+ - Block API calls
  if (usage >= 1.0) {
    return {
      model: CONFIG.model,
      maxTokens: CONFIG.maxTokens,
      maxHistory: CONFIG.maxHistory,
      shouldBlock: true,
    };
  }

  // 90-100% - Switch to Haiku, max 500 tokens, history 5
  if (usage >= 0.9) {
    return {
      model: "claude-3-haiku-20240307",
      maxTokens: 500,
      maxHistory: 5,
      shouldBlock: false,
    };
  }

  // 75-90% - Reduce max_tokens to 1024, history to 10
  if (usage >= 0.75) {
    return {
      model: CONFIG.model,
      maxTokens: 1024,
      maxHistory: 10,
      shouldBlock: false,
    };
  }

  // 50-75% - Reduce history to 20 messages
  if (usage >= 0.5) {
    return {
      model: CONFIG.model,
      maxTokens: CONFIG.maxTokens,
      maxHistory: 20,
      shouldBlock: false,
    };
  }

  // 0-50% - Normal operation
  return {
    model: CONFIG.model,
    maxTokens: CONFIG.maxTokens,
    maxHistory: CONFIG.maxHistory,
    shouldBlock: false,
  };
}

// ============================================================================
// Lizard-Brain Mood Modifiers
// ============================================================================

function applyMoodModifiers(response: string): string {
  let modified = response;

  // Low energy (<30): Add *yawn* occasionally
  if (lizardBrain.energy < 30 && Math.random() < 0.3) {
    const yawnPrefixes = ["*yawn* ", "*stretches* ", "*blinks sleepily* "];
    modified = pickRandom(yawnPrefixes) + modified;
  }

  // High curiosity (>80): Sometimes add follow-up questions
  if (lizardBrain.curiosity > 80 && Math.random() < 0.2 && !modified.includes("?")) {
    const followUps = [
      "\n\nCurious - what made you think of that?",
      "\n\nInteresting! Want to tell me more?",
      "\n\nThat's got me thinking... anything else on your mind?",
    ];
    modified += pickRandom(followUps);
  }

  return modified;
}

// ============================================================================
// Lizard-Brain Background Loop
// ============================================================================

let lizardLoopInterval: NodeJS.Timeout | null = null;
let sendMessageFn: ((chatId: string, text: string) => Promise<void>) | null = null;

function startLizardLoop(sendMessage: (chatId: string, text: string) => Promise<void>): void {
  sendMessageFn = sendMessage;

  if (lizardLoopInterval) {
    clearInterval(lizardLoopInterval);
  }

  lizardLoopInterval = setInterval(() => {
    runLizardLoop();
  }, CONFIG.lizardInterval);

  console.log(`🦎 Lizard-brain loop started (every ${CONFIG.lizardInterval / 1000}s)`);
}

async function runLizardLoop(): Promise<void> {
  // 1. Mood regulation - Energy recovers, stress decays
  lizardBrain.energy = Math.min(100, lizardBrain.energy + 2);
  lizardBrain.stress = Math.max(0, lizardBrain.stress - 1);

  // Curiosity fluctuates slightly
  lizardBrain.curiosity = Math.max(0, Math.min(100,
    lizardBrain.curiosity + (Math.random() - 0.5) * 5
  ));

  // 2. Token budget check - Reset at midnight
  if (Date.now() >= lizardBrain.tokens.resetAt) {
    console.log("[lizard] Token budget reset at midnight");
    lizardBrain.tokens.used = 0;
    lizardBrain.tokens.resetAt = getNextMidnight();
    lizardBrain.stress = Math.max(0, lizardBrain.stress - 20); // Relief!
  }

  // Adjust stress based on token usage
  const tokenUsage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
  if (tokenUsage > 0.9) {
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 2);
  } else if (tokenUsage > 0.75) {
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 1);
  }

  // 3. Process reminders - Send due reminders
  if (sendMessageFn) {
    const now = Date.now();
    const dueReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt <= now);

    for (const reminder of dueReminders) {
      try {
        await sendMessageFn(reminder.chatId, `⏰ *Reminder*: ${reminder.message}`);
        console.log(`[lizard] Sent reminder to ${reminder.chatId}: ${reminder.message}`);
      } catch (err) {
        console.error(`[lizard] Failed to send reminder:`, err);
      }
    }

    // Remove processed reminders
    lizardBrain.proactive.pendingReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt > now);
  }

  // 4. Cleanup - Evict old tracking data (lastResponses older than 1 hour)
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Note: We don't track timestamps for lastResponses, so just limit size
  if (lizardBrain.lastResponses.size > 100) {
    const entries = [...lizardBrain.lastResponses.entries()];
    lizardBrain.lastResponses = new Map(entries.slice(-50));
  }

  // Update idle time
  // (idleSince is updated when messages are received, not here)
}

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

let statusServerStarted = false;

function startStatusServer() {
  if (statusServerStarted) return; // Only start once
  statusServerStarted = true;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...status,
        uptime: formatUptime(),
        lizardBrain: {
          energy: lizardBrain.energy,
          stress: lizardBrain.stress,
          curiosity: Math.round(lizardBrain.curiosity),
          tokens: {
            used: lizardBrain.tokens.used,
            budget: lizardBrain.tokens.budget,
            usagePercent: Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100),
            resetAt: lizardBrain.tokens.resetAt,
          },
          pendingReminders: lizardBrain.proactive.pendingReminders.length,
          apiErrors: lizardBrain.resources.apiErrors,
        },
      }));
      return;
    }

    // Serve kiosk HTML page
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateKioskHTML());
  });

  // Bind to localhost only - never expose to network
  server.listen(CONFIG.statusPort, CONFIG.statusBind, () => {
    const host = CONFIG.statusBind === "0.0.0.0" ? "your-ip" : "localhost";
    console.log(`🖥️  Kiosk status page: http://${host}:${CONFIG.statusPort}`);
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
    .lizard-card {
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 20px;
      margin-top: 20px;
    }
    .lizard-header {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mood-bar {
      display: flex;
      align-items: center;
      margin-bottom: 10px;
    }
    .mood-label {
      width: 70px;
      color: rgba(255,255,255,0.7);
      font-size: 12px;
    }
    .mood-track {
      flex: 1;
      height: 8px;
      background: rgba(255,255,255,0.2);
      border-radius: 4px;
      overflow: hidden;
    }
    .mood-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .mood-fill.energy { background: linear-gradient(90deg, #22c55e, #84cc16); }
    .mood-fill.stress { background: linear-gradient(90deg, #f97316, #ef4444); }
    .mood-fill.curiosity { background: linear-gradient(90deg, #8b5cf6, #ec4899); }
    .mood-value {
      width: 40px;
      text-align: right;
      font-size: 12px;
      color: rgba(255,255,255,0.7);
    }
    .token-section {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .token-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .token-label {
      font-size: 12px;
      color: rgba(255,255,255,0.7);
    }
    .token-value {
      font-size: 14px;
      font-weight: 600;
    }
    .token-bar {
      height: 10px;
      background: rgba(255,255,255,0.2);
      border-radius: 5px;
      overflow: hidden;
    }
    .token-fill {
      height: 100%;
      border-radius: 5px;
      transition: width 0.3s ease;
    }
    .token-fill.healthy { background: linear-gradient(90deg, #22c55e, #84cc16); }
    .token-fill.moderate { background: linear-gradient(90deg, #84cc16, #eab308); }
    .token-fill.low { background: linear-gradient(90deg, #f97316, #ef4444); }
    .token-fill.critical { background: #ef4444; }
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

    ${generateLizardBrainSection()}

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

function generateLizardBrainSection(): string {
  const tokenUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
  const tokenClass = tokenUsage >= 90 ? "critical" : tokenUsage >= 75 ? "low" : tokenUsage >= 50 ? "moderate" : "healthy";
  const moodEmoji = lizardBrain.energy < 30 ? "😴" : lizardBrain.stress > 50 ? "😰" : lizardBrain.curiosity > 80 ? "🤔" : "😊";

  return `
    <div class="lizard-card">
      <div class="lizard-header">🦎 Lizard-Brain ${moodEmoji}</div>

      <div class="mood-bar">
        <span class="mood-label">Energy</span>
        <div class="mood-track">
          <div class="mood-fill energy" style="width: ${lizardBrain.energy}%"></div>
        </div>
        <span class="mood-value">${lizardBrain.energy}%</span>
      </div>

      <div class="mood-bar">
        <span class="mood-label">Stress</span>
        <div class="mood-track">
          <div class="mood-fill stress" style="width: ${lizardBrain.stress}%"></div>
        </div>
        <span class="mood-value">${lizardBrain.stress}%</span>
      </div>

      <div class="mood-bar">
        <span class="mood-label">Curiosity</span>
        <div class="mood-track">
          <div class="mood-fill curiosity" style="width: ${Math.round(lizardBrain.curiosity)}%"></div>
        </div>
        <span class="mood-value">${Math.round(lizardBrain.curiosity)}%</span>
      </div>

      <div class="token-section">
        <div class="token-header">
          <span class="token-label">🔋 Token Budget</span>
          <span class="token-value">${tokenUsage}%</span>
        </div>
        <div class="token-bar">
          <div class="token-fill ${tokenClass}" style="width: ${Math.min(100, tokenUsage)}%"></div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: rgba(255,255,255,0.5);">
          <span>${lizardBrain.tokens.used.toLocaleString()} used</span>
          <span>${lizardBrain.tokens.budget.toLocaleString()} budget</span>
        </div>
      </div>

      ${lizardBrain.proactive.pendingReminders.length > 0 ? `
      <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
        <span style="font-size: 12px; color: rgba(255,255,255,0.7);">⏰ ${lizardBrain.proactive.pendingReminders.length} pending reminder${lizardBrain.proactive.pendingReminders.length !== 1 ? 's' : ''}</span>
      </div>
      ` : ''}
    </div>
  `;
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

  // Get budget-aware parameters
  const budgetParams = getBudgetAwareParams();

  // Block API calls if budget exhausted
  if (budgetParams.shouldBlock) {
    return "🔋 I've used up my thinking budget for today. Simple greetings and quick questions I can still handle, but for complex stuff, let's chat tomorrow! (Budget resets at midnight)";
  }

  // Add user message to history
  addToSession(chatId, "user", userMessage);

  // Get conversation history (respecting budget-aware limits)
  let history = getConversationHistory(chatId);
  if (history.length > budgetParams.maxHistory) {
    history = history.slice(-budgetParams.maxHistory);
  }

  // Update idle time and curiosity
  const idleTime = Date.now() - lizardBrain.proactive.idleSince;
  if (idleTime > 5 * 60 * 1000) {
    // Been idle for 5+ minutes, curiosity increases
    lizardBrain.curiosity = Math.min(100, lizardBrain.curiosity + 10);
  }
  lizardBrain.proactive.idleSince = Date.now();

  try {
    const response = await client.messages.create({
      model: budgetParams.model,
      max_tokens: budgetParams.maxTokens,
      system: buildSystemPrompt(),
      messages: history,
    });

    // Track token usage
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;
    lizardBrain.tokens.used += totalTokens;

    // Log token usage at budget thresholds
    const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
    if (usage >= 0.9) {
      console.log(`[lizard] ⚠️ Token budget at ${Math.round(usage * 100)}% (${lizardBrain.tokens.used}/${lizardBrain.tokens.budget})`);
    }

    // Decrease energy based on response complexity
    const energyCost = Math.min(10, Math.ceil(totalTokens / 500));
    lizardBrain.energy = Math.max(0, lizardBrain.energy - energyCost);

    // Reset API error count on success
    lizardBrain.resources.apiErrors = 0;

    // Extract text response
    let assistantMessage = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Apply mood modifiers
    assistantMessage = applyMoodModifiers(assistantMessage);

    // Store last response for "what did you say" pattern
    lizardBrain.lastResponses.set(chatId, assistantMessage);

    // Add assistant response to history
    addToSession(chatId, "assistant", assistantMessage);

    return assistantMessage;
  } catch (err: any) {
    console.error("[claude] API error:", err);
    addError(`Claude API error: ${err}`);

    // Track API errors and increase stress
    lizardBrain.resources.apiErrors++;
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 15);

    // Check for rate limit headers
    if (err.status === 429) {
      const resetAt = err.headers?.["retry-after"];
      if (resetAt) {
        lizardBrain.resources.rateLimit.resetAt = Date.now() + parseInt(resetAt, 10) * 1000;
      }
      lizardBrain.stress = Math.min(100, lizardBrain.stress + 20);
    }

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
      const tokenUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
      const budgetParams = getBudgetAwareParams();
      const moodEmoji = lizardBrain.energy < 30 ? "😴" : lizardBrain.stress > 50 ? "😰" : lizardBrain.curiosity > 80 ? "🤔" : "😊";

      return `🦞 *OpenClaw Lite Status*

*Connection*
Model: ${budgetParams.model}
Messages in session: ${session.messages.length}
Uptime: ${formatUptime()}
Received: ${status.messagesReceived} | Sent: ${status.messagesSent}

*🦎 Lizard-Brain*
Energy: ${"█".repeat(Math.ceil(lizardBrain.energy / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.energy / 10))} ${lizardBrain.energy}%
Stress: ${"█".repeat(Math.ceil(lizardBrain.stress / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.stress / 10))} ${lizardBrain.stress}%
Curiosity: ${"█".repeat(Math.ceil(lizardBrain.curiosity / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.curiosity / 10))} ${Math.round(lizardBrain.curiosity)}%
Mood: ${moodEmoji}

*🔋 Token Budget*
Used: ${lizardBrain.tokens.used.toLocaleString()} / ${lizardBrain.tokens.budget.toLocaleString()} (${tokenUsage}%)
${tokenUsage >= 90 ? "⚠️ Budget critical!" : tokenUsage >= 75 ? "⚡ Running low" : tokenUsage >= 50 ? "📊 Moderate usage" : "✅ Budget healthy"}
Resets: ${new Date(lizardBrain.tokens.resetAt).toLocaleTimeString()}

*📋 Reminders*
Pending: ${lizardBrain.proactive.pendingReminders.length}

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

      // Start lizard-brain background loop
      startLizardLoop(async (chatId, text) => {
        await sock.sendMessage(chatId, { text });
        status.messagesSent++;
      });
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
        let skippedApi = false;

        // Check for commands
        if (isCommand(text)) {
          const cmdResponse = handleCommand(chatId, senderId, text);
          if (cmdResponse) {
            response = cmdResponse;
            skippedApi = true;
          } else {
            // Not a recognized command, treat as regular message
            response = await chat(chatId, text);
          }
        } else {
          // Check lizard-brain quick patterns first
          const quickResponse = tryQuickResponse(chatId, text);
          if (quickResponse) {
            response = quickResponse;
            skippedApi = true;
            console.log(`[lizard] Quick response (skipped API)`);
          } else {
            // Regular message - chat with Claude
            response = await chat(chatId, text);
          }
        }

        // Store response for "what did you say" pattern (even for quick responses)
        lizardBrain.lastResponses.set(chatId, response);

        // Send response
        await sock.sendMessage(chatId, { text: response });
        status.messagesSent++;
        console.log(`[reply] Sent ${response.length} chars${skippedApi ? " (no API)" : ""}`);
      } catch (err) {
        console.error("[error] Failed to process message:", err);
        addError(`Message processing error: ${err}`);

        // Increase stress on errors
        lizardBrain.stress = Math.min(100, lizardBrain.stress + 10);

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

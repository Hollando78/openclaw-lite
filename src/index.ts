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
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>OpenClaw Lite</title>
  <style>
    ${generateKioskCSS()}
  </style>
</head>
<body>
  ${generateIconSprite()}

  <div class="swipe-container">
    <div class="pages-wrapper" id="pagesWrapper">
      ${generateAvatarPage()}
      ${generateStatusPage()}
    </div>
  </div>

  <div class="page-dots">
    <div class="dot active" data-page="0"></div>
    <div class="dot" data-page="1"></div>
  </div>

  <div class="nav-hint left" id="navHintLeft">
    <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>
  </div>
  <div class="nav-hint right" id="navHintRight">
    <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
  </div>

  <script>
    ${generateKioskJS()}
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
// Kiosk Page Components
// ============================================================================

function getAvatarState(): string {
  const tokenUsage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // Priority-based state selection
  if (status.state === "disconnected") return "disconnected";
  if (status.state === "qr") return "qr";
  if (tokenUsage >= 1.0) return "exhausted";
  if (tokenUsage >= 0.75) return "budget-warning";
  if (lizardBrain.resources.apiErrors > 0) return "error";
  if (lizardBrain.energy < 30) return "tired";
  if (lizardBrain.stress > 50) return "stressed";
  if (lizardBrain.curiosity > 80) return "curious";
  return "happy";
}

function generateIconSprite(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <!-- Lobster icon -->
  <symbol id="icon-lobster" viewBox="0 0 24 24">
    <path d="M12 2C10.5 2 9.2 2.8 8.5 4L7 3.5C6.5 3.3 6 3.5 5.7 3.8L4.5 5.5C4.2 5.9 4.3 6.5 4.7 6.8L6 7.5C5.7 8.3 5.5 9.1 5.5 10V11L4 12C3.4 12.3 3 12.9 3 13.5V15C3 15.6 3.4 16.2 4 16.5L5.5 17.2V18C5.5 19.7 6.8 21 8.5 21H10L10.5 22H13.5L14 21H15.5C17.2 21 18.5 19.7 18.5 18V17.2L20 16.5C20.6 16.2 21 15.6 21 15V13.5C21 12.9 20.6 12.3 20 12L18.5 11V10C18.5 9.1 18.3 8.3 18 7.5L19.3 6.8C19.7 6.5 19.8 5.9 19.5 5.5L18.3 3.8C18 3.5 17.5 3.3 17 3.5L15.5 4C14.8 2.8 13.5 2 12 2ZM10 8C10.6 8 11 8.4 11 9S10.6 10 10 10 9 9.6 9 9 9.4 8 10 8ZM14 8C14.6 8 15 8.4 15 9S14.6 10 14 10 13 9.6 13 9 13.4 8 14 8ZM9 13H15C15 14.7 13.7 16 12 16S9 14.7 9 13Z"/>
  </symbol>

  <!-- Brain/circuit icon -->
  <symbol id="icon-brain" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 2c4.4 0 8 3.6 8 8s-3.6 8-8 8-8-3.6-8-8 3.6-8 8-8zm-2 3v2H8v2h2v2H8v2h2v2h2v-2h2v2h2v-2h-2v-2h2v-2h-2v-2h2V7h-2v2h-2V7h-2zm2 4h2v2h-2v-2z"/>
  </symbol>

  <!-- Loading spinner (static, animated via CSS) -->
  <symbol id="icon-loading" viewBox="0 0 24 24">
    <path d="M12 4V2C6.5 2 2 6.5 2 12h2c0-4.4 3.6-8 8-8z"/>
  </symbol>

  <!-- Phone icon -->
  <symbol id="icon-phone" viewBox="0 0 24 24">
    <path d="M17 1H7C5.9 1 5 1.9 5 3v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14zm-5 3c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1z"/>
  </symbol>

  <!-- Checkmark icon -->
  <symbol id="icon-check" viewBox="0 0 24 24">
    <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/>
  </symbol>

  <!-- Error X icon -->
  <symbol id="icon-error" viewBox="0 0 24 24">
    <path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4z"/>
  </symbol>

  <!-- Clock icon -->
  <symbol id="icon-clock" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/>
  </symbol>

  <!-- Battery icon -->
  <symbol id="icon-battery" viewBox="0 0 24 24">
    <path d="M17 4h-3V2h-4v2H7C5.9 4 5 4.9 5 6v14c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H7V6h10v14z"/>
  </symbol>

  <!-- Power/strength icon -->
  <symbol id="icon-power" viewBox="0 0 24 24">
    <path d="M11 21h-1l1-7H7.5c-.9 0-.8-.7-.4-1.3L13 3h1l-1 7h3.5c.5 0 .7.4.4 1L11 21z"/>
  </symbol>

  <!-- Mood faces -->
  <symbol id="icon-mood-happy" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm-4-9c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm8 0c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm-4 7c2.2 0 4-1.5 4.7-3.5H7.3c.7 2 2.5 3.5 4.7 3.5z"/>
  </symbol>

  <symbol id="icon-mood-tired" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zM7 10h3v1H7v-1zm7 0h3v1h-3v-1zm-2 8c-2.2 0-4-1.3-4.7-3h9.4c-.7 1.7-2.5 3-4.7 3z"/>
  </symbol>

  <symbol id="icon-mood-stressed" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm-4-8c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm8 0c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm-4 6c-1.7 0-3.2-.9-4-2.2l1.7-1c.5.8 1.3 1.2 2.3 1.2s1.8-.4 2.3-1.2l1.7 1c-.8 1.3-2.3 2.2-4 2.2z"/>
  </symbol>

  <symbol id="icon-mood-curious" viewBox="0 0 24 24">
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm-4-9c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm8 0c.6 0 1-.4 1-1s-.4-1-1-1-1 .4-1 1 .4 1 1 1zm-3 5c0 .6-.4 1-1 1s-1-.4-1-1c0-1.7 1.3-3 3-3v2c-.6 0-1 .4-1 1z"/>
  </symbol>
</svg>`;
}

function generateLobsterSVG(): string {
  return `<svg class="lobster-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <!-- Bubbles (ambient animation) -->
  <g class="bubbles">
    <circle class="bubble b1" cx="30" cy="180" r="4" fill="rgba(255,255,255,0.3)"/>
    <circle class="bubble b2" cx="170" cy="175" r="3" fill="rgba(255,255,255,0.25)"/>
    <circle class="bubble b3" cx="50" cy="190" r="2" fill="rgba(255,255,255,0.2)"/>
    <circle class="bubble b4" cx="160" cy="185" r="3" fill="rgba(255,255,255,0.2)"/>
  </g>

  <!-- Left Claw -->
  <g class="claw claw-left">
    <ellipse cx="35" cy="95" rx="25" ry="18" fill="#E53935"/>
    <ellipse cx="30" cy="85" rx="12" ry="8" fill="#E53935"/>
    <ellipse cx="25" cy="80" rx="8" ry="5" fill="#EF5350"/>
    <path d="M15 75 Q10 70 15 65 Q20 60 25 65 L30 75 Z" fill="#E53935" class="pincer-top"/>
    <path d="M15 85 Q10 90 15 95 Q20 100 25 95 L30 85 Z" fill="#E53935" class="pincer-bottom"/>
  </g>

  <!-- Right Claw -->
  <g class="claw claw-right">
    <ellipse cx="165" cy="95" rx="25" ry="18" fill="#E53935"/>
    <ellipse cx="170" cy="85" rx="12" ry="8" fill="#E53935"/>
    <ellipse cx="175" cy="80" rx="8" ry="5" fill="#EF5350"/>
    <path d="M185 75 Q190 70 185 65 Q180 60 175 65 L170 75 Z" fill="#E53935" class="pincer-top"/>
    <path d="M185 85 Q190 90 185 95 Q180 100 175 95 L170 85 Z" fill="#E53935" class="pincer-bottom"/>
  </g>

  <!-- Legs -->
  <g class="legs">
    <path class="leg leg-l1" d="M60 130 Q45 140 35 155" stroke="#C62828" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path class="leg leg-l2" d="M65 140 Q50 150 45 165" stroke="#C62828" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path class="leg leg-l3" d="M70 148 Q58 160 55 175" stroke="#C62828" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path class="leg leg-r1" d="M140 130 Q155 140 165 155" stroke="#C62828" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path class="leg leg-r2" d="M135 140 Q150 150 155 165" stroke="#C62828" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path class="leg leg-r3" d="M130 148 Q142 160 145 175" stroke="#C62828" stroke-width="4" stroke-linecap="round" fill="none"/>
  </g>

  <!-- Tail -->
  <g class="tail">
    <ellipse cx="100" cy="165" rx="30" ry="15" fill="#C62828"/>
    <ellipse cx="100" cy="178" rx="22" ry="10" fill="#B71C1C"/>
    <path d="M80 185 Q100 200 120 185 L115 190 Q100 205 85 190 Z" fill="#B71C1C"/>
  </g>

  <!-- Body -->
  <ellipse class="body-main" cx="100" cy="110" rx="45" ry="40" fill="#E53935"/>
  <ellipse class="body-belly" cx="100" cy="115" rx="30" ry="25" fill="#EF5350"/>

  <!-- Head -->
  <ellipse class="head" cx="100" cy="70" rx="35" ry="28" fill="#E53935"/>

  <!-- Antennae -->
  <g class="antennae">
    <path class="antenna antenna-left" d="M75 50 Q60 30 50 15" stroke="#C62828" stroke-width="3" stroke-linecap="round" fill="none"/>
    <path class="antenna antenna-right" d="M125 50 Q140 30 150 15" stroke="#C62828" stroke-width="3" stroke-linecap="round" fill="none"/>
    <circle cx="50" cy="15" r="4" fill="#E53935"/>
    <circle cx="150" cy="15" r="4" fill="#E53935"/>
  </g>

  <!-- Eyes -->
  <g class="eyes">
    <g class="eye eye-left">
      <ellipse class="eye-white" cx="85" cy="65" rx="12" ry="14" fill="white"/>
      <ellipse class="eye-pupil" cx="85" cy="65" rx="6" ry="8" fill="#1a1a2e"/>
      <ellipse class="eye-shine" cx="82" cy="62" rx="2" ry="3" fill="white"/>
      <path class="eye-lid" d="M73 55 Q85 50 97 55 L97 55 Q85 60 73 55 Z" fill="#E53935" opacity="0"/>
    </g>
    <g class="eye eye-right">
      <ellipse class="eye-white" cx="115" cy="65" rx="12" ry="14" fill="white"/>
      <ellipse class="eye-pupil" cx="115" cy="65" rx="6" ry="8" fill="#1a1a2e"/>
      <ellipse class="eye-shine" cx="112" cy="62" rx="2" ry="3" fill="white"/>
      <path class="eye-lid" d="M103 55 Q115 50 127 55 L127 55 Q115 60 103 55 Z" fill="#E53935" opacity="0"/>
    </g>
  </g>

  <!-- Mouth -->
  <g class="mouth">
    <path class="mouth-smile" d="M90 85 Q100 95 110 85" stroke="#B71C1C" stroke-width="3" stroke-linecap="round" fill="none"/>
  </g>

  <!-- QR Code holder (only shown in QR state) -->
  <g class="qr-holder" style="display:none">
    <rect x="70" y="95" width="60" height="60" rx="5" fill="white" stroke="#C62828" stroke-width="2"/>
    <text x="100" y="130" text-anchor="middle" font-size="8" fill="#333">QR CODE</text>
  </g>
</svg>`;
}

function generateAvatarPage(): string {
  const avatarState = getAvatarState();
  const qrSection = status.qrCode && status.state === "qr"
    ? `<div class="qr-overlay">
        <div class="qr-label">Scan with WhatsApp:</div>
        <pre class="qr-code">${escapeHtml(status.qrCode)}</pre>
       </div>`
    : "";

  return `<div class="page avatar-page" data-page="0">
    <div class="avatar-container" data-state="${avatarState}">
      ${generateLobsterSVG()}
      <div class="avatar-status-label">${getAvatarStatusLabel(avatarState)}</div>
    </div>
    ${qrSection}
    <div class="swipe-hint">Swipe for stats <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg></div>
  </div>`;
}

function getAvatarStatusLabel(state: string): string {
  const labels: Record<string, string> = {
    "happy": "Feeling good!",
    "tired": "A bit sleepy...",
    "stressed": "Taking deep breaths",
    "curious": "What's new?",
    "error": "Something went wrong",
    "budget-warning": "Running low on energy",
    "exhausted": "Need to rest...",
    "disconnected": "Lost connection",
    "qr": "Ready to connect!",
  };
  return labels[state] || "Hello!";
}

function generateStatusPage(): string {
  const stateClass = status.state === 'connected' ? 'status-connected' : status.state === 'qr' ? 'status-qr' : 'status-disconnected';
  const stateText = {
    starting: "Starting...",
    qr: "Scan QR Code",
    connected: "Connected",
    disconnected: "Disconnected",
  }[status.state];

  const stateIcon = {
    starting: '<svg class="icon icon-loading spin"><use href="#icon-loading"/></svg>',
    qr: '<svg class="icon"><use href="#icon-phone"/></svg>',
    connected: '<svg class="icon"><use href="#icon-check"/></svg>',
    disconnected: '<svg class="icon"><use href="#icon-error"/></svg>',
  }[status.state];

  const tokenUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
  const tokenClass = tokenUsage >= 90 ? "critical" : tokenUsage >= 75 ? "low" : tokenUsage >= 50 ? "moderate" : "healthy";

  const moodIcon = lizardBrain.energy < 30
    ? '<svg class="icon icon-mood"><use href="#icon-mood-tired"/></svg>'
    : lizardBrain.stress > 50
    ? '<svg class="icon icon-mood"><use href="#icon-mood-stressed"/></svg>'
    : lizardBrain.curiosity > 80
    ? '<svg class="icon icon-mood"><use href="#icon-mood-curious"/></svg>'
    : '<svg class="icon icon-mood"><use href="#icon-mood-happy"/></svg>';

  const lastMessageSection = status.lastMessage
    ? `<div class="last-message">
        <div class="label">Last message:</div>
        <div class="message">"${escapeHtml(status.lastMessage.preview)}"</div>
        <div class="time">${new Date(status.lastMessage.time).toLocaleTimeString()}</div>
       </div>`
    : "";

  return `<div class="page status-page" data-page="1">
    <div class="page-header">
      <svg class="icon-lobster-small"><use href="#icon-lobster"/></svg>
      <span class="title">OpenClaw Lite</span>
    </div>

    <div class="status-card">
      <div class="status-row">
        <span class="status-label">Status</span>
        <span class="status-value ${stateClass}">
          ${stateIcon} ${stateText}
        </span>
      </div>
      <div class="status-row">
        <span class="status-label"><svg class="icon-sm"><use href="#icon-clock"/></svg> Uptime</span>
        <span class="status-value">${formatUptime()}</span>
      </div>
      ${status.phoneNumber ? `
      <div class="status-row">
        <span class="status-label"><svg class="icon-sm"><use href="#icon-phone"/></svg> Phone</span>
        <span class="status-value">${status.phoneNumber}</span>
      </div>
      ` : ''}
      <div class="status-row">
        <span class="status-label">Model</span>
        <span class="status-value model-name">${CONFIG.model.split('/').pop()}</span>
      </div>
    </div>

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

    <div class="lizard-card">
      <div class="lizard-header">
        <svg class="icon"><use href="#icon-brain"/></svg>
        <span>Lizard-Brain</span>
        ${moodIcon}
      </div>

      <div class="mood-bar">
        <span class="mood-label"><svg class="icon-sm"><use href="#icon-power"/></svg> Energy</span>
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
          <span class="token-label"><svg class="icon-sm"><use href="#icon-battery"/></svg> Token Budget</span>
          <span class="token-value">${tokenUsage}%</span>
        </div>
        <div class="token-bar">
          <div class="token-fill ${tokenClass}" style="width: ${Math.min(100, tokenUsage)}%"></div>
        </div>
        <div class="token-details">
          <span>${lizardBrain.tokens.used.toLocaleString()} used</span>
          <span>${lizardBrain.tokens.budget.toLocaleString()} budget</span>
        </div>
      </div>

      ${lizardBrain.proactive.pendingReminders.length > 0 ? `
      <div class="reminders-section">
        <svg class="icon-sm"><use href="#icon-clock"/></svg>
        <span>${lizardBrain.proactive.pendingReminders.length} pending reminder${lizardBrain.proactive.pendingReminders.length !== 1 ? 's' : ''}</span>
      </div>
      ` : ''}
    </div>

    ${lastMessageSection}
  </div>`;
}

function generateKioskCSS(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      overflow: hidden;
      touch-action: pan-y;
    }

    /* Swipe Container */
    .swipe-container {
      width: 100%;
      height: 100vh;
      overflow: hidden;
      position: relative;
    }

    .pages-wrapper {
      display: flex;
      width: 200%;
      height: 100%;
      transition: transform 0.3s ease-out;
    }

    .page {
      width: 50%;
      height: 100%;
      padding: 20px;
      overflow-y: auto;
      flex-shrink: 0;
    }

    /* Page Dots */
    .page-dots {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      z-index: 100;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(255,255,255,0.3);
      transition: all 0.3s ease;
      cursor: pointer;
    }

    .dot.active {
      background: #fff;
      width: 24px;
      border-radius: 4px;
    }

    /* Navigation hints */
    .nav-hint {
      position: fixed;
      top: 50%;
      transform: translateY(-50%);
      width: 40px;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.3);
      cursor: pointer;
      z-index: 100;
      transition: color 0.2s;
    }

    .nav-hint:hover {
      color: rgba(255,255,255,0.7);
    }

    .nav-hint.left { left: 0; }
    .nav-hint.right { right: 0; }
    .nav-hint.hidden { display: none; }

    /* Avatar Page */
    .avatar-page {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    .avatar-container {
      width: 100%;
      max-width: 300px;
      position: relative;
    }

    .lobster-svg {
      width: 100%;
      height: auto;
    }

    .avatar-status-label {
      text-align: center;
      font-size: 18px;
      margin-top: 20px;
      color: rgba(255,255,255,0.8);
    }

    .swipe-hint {
      position: absolute;
      bottom: 60px;
      display: flex;
      align-items: center;
      gap: 5px;
      color: rgba(255,255,255,0.4);
      font-size: 14px;
      animation: fadeInOut 3s ease infinite;
    }

    @keyframes fadeInOut {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }

    /* QR Overlay */
    .qr-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      z-index: 10;
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
      display: inline-block;
    }

    /* Lobster Animations */

    /* Base idle animation - gentle bobbing */
    .lobster-svg {
      animation: idle-bob 3s ease-in-out infinite;
    }

    @keyframes idle-bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }

    /* Blink animation */
    .eye-lid {
      animation: blink 4s ease-in-out infinite;
    }

    @keyframes blink {
      0%, 90%, 100% { opacity: 0; transform: scaleY(0); }
      95% { opacity: 1; transform: scaleY(1); }
    }

    /* Antenna twitch */
    .antennae {
      animation: antenna-twitch 5s ease-in-out infinite;
      transform-origin: center bottom;
    }

    @keyframes antenna-twitch {
      0%, 85%, 100% { transform: rotate(0deg); }
      90% { transform: rotate(3deg); }
      95% { transform: rotate(-3deg); }
    }

    /* Bubble animations */
    .bubble {
      animation: bubble-rise 4s ease-in infinite;
    }

    .b1 { animation-delay: 0s; }
    .b2 { animation-delay: 1s; }
    .b3 { animation-delay: 2s; }
    .b4 { animation-delay: 3s; }

    @keyframes bubble-rise {
      0% { transform: translateY(0); opacity: 0.3; }
      100% { transform: translateY(-180px); opacity: 0; }
    }

    /* Claw wave animation (occasional) */
    .claw-right {
      animation: claw-wave 8s ease-in-out infinite;
      transform-origin: right center;
    }

    @keyframes claw-wave {
      0%, 85%, 100% { transform: rotate(0deg); }
      90% { transform: rotate(-10deg); }
      95% { transform: rotate(5deg); }
    }

    /* Leg movement */
    .legs {
      animation: legs-move 2s ease-in-out infinite;
    }

    @keyframes legs-move {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(2px); }
    }

    /* State-specific animations */

    /* Happy state - default animations enhanced */
    [data-state="happy"] .lobster-svg {
      animation: idle-bob 2.5s ease-in-out infinite;
    }

    /* Tired state - slower, droopy */
    [data-state="tired"] .lobster-svg {
      animation: tired-bob 5s ease-in-out infinite;
      filter: saturate(0.7);
    }

    [data-state="tired"] .eye-white {
      transform: scaleY(0.7);
    }

    [data-state="tired"] .eye-lid {
      animation: tired-blink 3s ease-in-out infinite;
    }

    @keyframes tired-bob {
      0%, 100% { transform: translateY(0) rotate(-2deg); }
      50% { transform: translateY(3px) rotate(2deg); }
    }

    @keyframes tired-blink {
      0%, 70%, 100% { opacity: 0.5; transform: scaleY(0.5); }
      80% { opacity: 1; transform: scaleY(1); }
    }

    /* Stressed state - faster, jittery */
    [data-state="stressed"] .lobster-svg {
      animation: stressed-shake 0.5s ease-in-out infinite;
    }

    [data-state="stressed"] .antennae {
      animation: stressed-antenna 0.3s ease-in-out infinite;
    }

    [data-state="stressed"] .eyes {
      animation: look-around 2s ease-in-out infinite;
    }

    @keyframes stressed-shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-2px); }
      75% { transform: translateX(2px); }
    }

    @keyframes stressed-antenna {
      0%, 100% { transform: rotate(-5deg); }
      50% { transform: rotate(5deg); }
    }

    @keyframes look-around {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-3px); }
      75% { transform: translateX(3px); }
    }

    /* Curious state - perked up */
    [data-state="curious"] .lobster-svg {
      animation: curious-bob 2s ease-in-out infinite;
      transform: scale(1.02);
    }

    [data-state="curious"] .antennae {
      animation: curious-antenna 1.5s ease-in-out infinite;
    }

    [data-state="curious"] .eye-pupil {
      transform: translateY(-2px);
    }

    @keyframes curious-bob {
      0%, 100% { transform: translateY(0) scale(1.02); }
      50% { transform: translateY(-8px) scale(1.02); }
    }

    @keyframes curious-antenna {
      0%, 100% { transform: rotate(0deg); }
      50% { transform: rotate(10deg); }
    }

    /* Error state - startled, red tint */
    [data-state="error"] .lobster-svg {
      animation: error-shake 0.3s ease-in-out infinite;
      filter: brightness(1.2) saturate(1.3);
    }

    [data-state="error"] .eyes {
      animation: error-eyes 0.5s ease-in-out infinite;
    }

    @keyframes error-shake {
      0%, 100% { transform: translateX(0) rotate(0); }
      25% { transform: translateX(-3px) rotate(-2deg); }
      75% { transform: translateX(3px) rotate(2deg); }
    }

    @keyframes error-eyes {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.2); }
    }

    /* Budget warning - worried */
    [data-state="budget-warning"] .lobster-svg {
      animation: worried-bob 3s ease-in-out infinite;
      filter: saturate(0.8);
    }

    [data-state="budget-warning"] .mouth-smile {
      d: path("M90 90 Q100 85 110 90");
    }

    @keyframes worried-bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }

    /* Exhausted state - sleeping */
    [data-state="exhausted"] .lobster-svg {
      animation: sleep-bob 4s ease-in-out infinite;
      filter: grayscale(0.3) saturate(0.6);
    }

    [data-state="exhausted"] .eye-lid {
      opacity: 1;
      transform: scaleY(1);
      animation: none;
    }

    [data-state="exhausted"] .eye-white,
    [data-state="exhausted"] .eye-pupil,
    [data-state="exhausted"] .eye-shine {
      opacity: 0;
    }

    @keyframes sleep-bob {
      0%, 100% { transform: translateY(0) rotate(-3deg); }
      50% { transform: translateY(5px) rotate(3deg); }
    }

    /* Disconnected state - sad, gray */
    [data-state="disconnected"] .lobster-svg {
      animation: sad-bob 4s ease-in-out infinite;
      filter: grayscale(0.5) brightness(0.8);
    }

    [data-state="disconnected"] .mouth-smile {
      d: path("M90 90 Q100 80 110 90");
    }

    @keyframes sad-bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(3px); }
    }

    /* QR state - holding up QR */
    [data-state="qr"] .lobster-svg {
      animation: qr-present 2s ease-in-out infinite;
    }

    [data-state="qr"] .claw-left,
    [data-state="qr"] .claw-right {
      animation: claw-hold 2s ease-in-out infinite;
    }

    @keyframes qr-present {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }

    @keyframes claw-hold {
      0%, 100% { transform: rotate(-5deg); }
      50% { transform: rotate(5deg); }
    }

    /* Status Page Styles */
    .status-page {
      max-width: 400px;
      margin: 0 auto;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-top: 10px;
    }

    .icon-lobster-small {
      width: 32px;
      height: 32px;
      fill: #E53935;
    }

    .page-header .title {
      font-size: 24px;
      font-weight: 600;
    }

    /* Icons */
    .icon {
      width: 20px;
      height: 20px;
      fill: currentColor;
      vertical-align: middle;
    }

    .icon-sm {
      width: 14px;
      height: 14px;
      fill: currentColor;
      vertical-align: middle;
      margin-right: 4px;
    }

    .icon-mood {
      width: 24px;
      height: 24px;
      margin-left: auto;
    }

    .icon-loading.spin {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* Status Card */
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

    .status-label {
      color: rgba(255,255,255,0.7);
      display: flex;
      align-items: center;
    }

    .status-value {
      font-weight: 600;
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-value.model-name {
      font-size: 12px;
    }

    .status-connected { color: #4ade80; }
    .status-disconnected { color: #f87171; }
    .status-qr { color: #fbbf24; }

    /* Stats Grid */
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 20px;
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

    /* Lizard Card */
    .lizard-card {
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 20px;
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
      width: 80px;
      color: rgba(255,255,255,0.7);
      font-size: 12px;
      display: flex;
      align-items: center;
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
      display: flex;
      align-items: center;
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

    .token-details {
      display: flex;
      justify-content: space-between;
      margin-top: 5px;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
    }

    .reminders-section {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid rgba(255,255,255,0.1);
      font-size: 12px;
      color: rgba(255,255,255,0.7);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Last Message */
    .last-message {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 15px;
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

    /* Responsive adjustments */
    @media (max-width: 380px) {
      .avatar-container {
        max-width: 250px;
      }

      .stat-value {
        font-size: 24px;
      }
    }

    @media (min-height: 700px) {
      .avatar-page {
        padding-top: 50px;
      }
    }
  `;
}

function generateKioskJS(): string {
  return `
    (function() {
      let currentPage = 0;
      const totalPages = 2;
      const wrapper = document.getElementById('pagesWrapper');
      const dots = document.querySelectorAll('.dot');
      const navHintLeft = document.getElementById('navHintLeft');
      const navHintRight = document.getElementById('navHintRight');

      let touchStartX = 0;
      let touchEndX = 0;
      let isDragging = false;
      let startTranslate = 0;

      function updatePage(page) {
        currentPage = Math.max(0, Math.min(page, totalPages - 1));
        wrapper.style.transform = 'translateX(' + (-currentPage * 50) + '%)';

        dots.forEach((dot, i) => {
          dot.classList.toggle('active', i === currentPage);
        });

        navHintLeft.classList.toggle('hidden', currentPage === 0);
        navHintRight.classList.toggle('hidden', currentPage === totalPages - 1);
      }

      // Touch events
      wrapper.addEventListener('touchstart', function(e) {
        touchStartX = e.touches[0].clientX;
        isDragging = true;
        startTranslate = -currentPage * 50;
        wrapper.style.transition = 'none';
      }, { passive: true });

      wrapper.addEventListener('touchmove', function(e) {
        if (!isDragging) return;
        touchEndX = e.touches[0].clientX;
        const diff = touchEndX - touchStartX;
        const percentMove = (diff / window.innerWidth) * 50;
        const newTranslate = startTranslate + percentMove;
        // Clamp to bounds with resistance
        const clampedTranslate = Math.max(-(totalPages - 1) * 50 - 10, Math.min(10, newTranslate));
        wrapper.style.transform = 'translateX(' + clampedTranslate + '%)';
      }, { passive: true });

      wrapper.addEventListener('touchend', function(e) {
        if (!isDragging) return;
        isDragging = false;
        wrapper.style.transition = 'transform 0.3s ease-out';

        const diff = touchEndX - touchStartX;
        const threshold = window.innerWidth * 0.2;

        if (Math.abs(diff) > threshold) {
          if (diff > 0 && currentPage > 0) {
            updatePage(currentPage - 1);
          } else if (diff < 0 && currentPage < totalPages - 1) {
            updatePage(currentPage + 1);
          } else {
            updatePage(currentPage);
          }
        } else {
          updatePage(currentPage);
        }

        touchStartX = 0;
        touchEndX = 0;
      });

      // Click on dots
      dots.forEach(dot => {
        dot.addEventListener('click', function() {
          const page = parseInt(this.dataset.page);
          updatePage(page);
        });
      });

      // Click on nav hints
      navHintLeft.addEventListener('click', function() {
        updatePage(currentPage - 1);
      });

      navHintRight.addEventListener('click', function() {
        updatePage(currentPage + 1);
      });

      // Keyboard navigation
      document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft') {
          updatePage(currentPage - 1);
        } else if (e.key === 'ArrowRight') {
          updatePage(currentPage + 1);
        }
      });

      // Initialize
      updatePage(0);

      // Auto-refresh every 3 seconds
      setTimeout(function() {
        // Preserve current page across refresh
        const url = new URL(window.location);
        url.searchParams.set('page', currentPage);
        window.location = url;
      }, 3000);

      // Restore page from URL
      const urlParams = new URLSearchParams(window.location.search);
      const savedPage = parseInt(urlParams.get('page')) || 0;
      if (savedPage !== 0) {
        updatePage(savedPage);
      }
    })();
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

  // Offline mode - no API key
  if (!CONFIG.apiKey) {
    return "🦎 I'm running in offline mode (no API key). I can handle quick stuff like greetings, time, reminders - but for real conversations, set ANTHROPIC_API_KEY!";
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
    console.warn("⚠️  ANTHROPIC_API_KEY is not set - running in offline mode (quick responses only)");
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

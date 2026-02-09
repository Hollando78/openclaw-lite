/**
 * Lizard-Brain - Mood, quick responses, budget management, and background loop
 */

// ============================================================================
// Config
// ============================================================================

export interface LizardBrainConfig {
  model: string;
  maxTokens: number;
  maxHistory: number;
  dailyTokenBudget: number;
  lizardInterval: number;
}

let _config: LizardBrainConfig;

export function initLizardBrain(config: LizardBrainConfig): void {
  _config = config;
  lizardBrain.tokens.budget = config.dailyTokenBudget;
}

// ============================================================================
// Types and State
// ============================================================================

type Reminder = {
  id: number;
  chatId: string;
  message: string;
  dueAt: number;
  setAt: number;
};

let _nextReminderId = 1;

export type LizardBrain = {
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

function getNextMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// Initialize lizard-brain state
export const lizardBrain: LizardBrain = {
  energy: 100,
  stress: 0,
  curiosity: 50,
  tokens: {
    used: 0,
    budget: 100000, // Overwritten by initLizardBrain
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

// ============================================================================
// Quick Response Patterns
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

function parseReminderAt(text: string): { minutes: number; task: string; timeStr: string } | null {
  // Match "remind me at 3pm to check oven" or "remind me at 15:00 to check oven"
  const match = text.match(/remind\s+me\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to\s+)?(.+)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();
  const task = match[4].trim();

  // Handle 12h format
  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;

  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, mins, 0, 0);

  // If the time already passed today, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const diffMs = target.getTime() - now.getTime();
  const minutes = Math.ceil(diffMs / 60000);

  const timeStr = `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;

  return { minutes, task, timeStr };
}

export function formatDuration(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h} hour${h !== 1 ? "s" : ""}`;
  }
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}

export function addReminder(chatId: string, message: string, minutes: number): Reminder {
  const reminder: Reminder = {
    id: _nextReminderId++,
    chatId,
    message,
    dueAt: Date.now() + minutes * 60 * 1000,
    setAt: Date.now(),
  };
  lizardBrain.proactive.pendingReminders.push(reminder);
  return reminder;
}

export function listReminders(chatId: string): Reminder[] {
  return lizardBrain.proactive.pendingReminders.filter(r => r.chatId === chatId);
}

export function cancelReminder(chatId: string, id: number): boolean {
  const idx = lizardBrain.proactive.pendingReminders.findIndex(r => r.chatId === chatId && r.id === id);
  if (idx === -1) return false;
  lizardBrain.proactive.pendingReminders.splice(idx, 1);
  return true;
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
  // Set reminder (countdown: "remind me in 30 min to call mom")
  {
    patterns: [/remind\s+me\s+in\s+\d+/i],
    response: (chatId, match) => {
      const text = match?.input || "";
      const parsed = parseReminderTime(text);
      if (!parsed) return null;

      const reminder = addReminder(chatId, parsed.task, parsed.minutes);
      return `⏰ Got it! I'll remind you in ${formatDuration(parsed.minutes)} to: ${parsed.task} [#${reminder.id}]`;
    },
  },
  // Set reminder (absolute: "remind me at 3pm to check oven")
  {
    patterns: [/remind\s+me\s+at\s+\d/i],
    response: (chatId, match) => {
      const text = match?.input || "";
      const parsed = parseReminderAt(text);
      if (!parsed) return null;

      const reminder = addReminder(chatId, parsed.task, parsed.minutes);
      return `⏰ Got it! I'll remind you at ${parsed.timeStr} to: ${parsed.task} [#${reminder.id}]`;
    },
  },
  // Catch-all for unrecognized "remind me" patterns
  {
    patterns: [/remind\s+me\s+/i],
    response: () => {
      return `I can help with reminders! Try:
• "remind me in 30 min to call mom"
• "remind me at 3pm to check oven"
• /remind daily 08:00 Write journal
• /remind weekly Mon 09:00 Standup
• /remind list — see pending reminders`;
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

export function tryQuickResponse(chatId: string, text: string): string | null {
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
// Budget-Aware API Parameters
// ============================================================================

export type BudgetAwareParams = {
  model: string;
  maxTokens: number;
  maxHistory: number;
  shouldBlock: boolean;
};

export function getBudgetAwareParams(): BudgetAwareParams {
  const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // 100%+ - Block API calls
  if (usage >= 1.0) {
    return {
      model: _config.model,
      maxTokens: _config.maxTokens,
      maxHistory: _config.maxHistory,
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
      model: _config.model,
      maxTokens: 1024,
      maxHistory: 10,
      shouldBlock: false,
    };
  }

  // 50-75% - Reduce history to 20 messages
  if (usage >= 0.5) {
    return {
      model: _config.model,
      maxTokens: _config.maxTokens,
      maxHistory: 20,
      shouldBlock: false,
    };
  }

  // 0-50% - Normal operation
  return {
    model: _config.model,
    maxTokens: _config.maxTokens,
    maxHistory: _config.maxHistory,
    shouldBlock: false,
  };
}

// ============================================================================
// Mood Modifiers
// ============================================================================

export function applyMoodModifiers(response: string): string {
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
// Background Loop
// ============================================================================

let _loopInterval: NodeJS.Timeout | null = null;
let _sendMessageFn: ((chatId: string, text: string) => Promise<void>) | null = null;
let _onTick: (() => Promise<void>) | null = null;
let _onCleanup: (() => void) | null = null;

export function startLizardLoop(
  sendMessage: (chatId: string, text: string) => Promise<void>,
  onTick?: () => Promise<void>,
  onCleanup?: () => void,
): void {
  _sendMessageFn = sendMessage;
  _onTick = onTick ?? null;
  _onCleanup = onCleanup ?? null;

  if (_loopInterval) {
    clearInterval(_loopInterval);
  }

  _loopInterval = setInterval(() => {
    runLizardLoop();
  }, _config.lizardInterval);

  console.log(`🦎 Lizard-brain loop started (every ${_config.lizardInterval / 1000}s)`);
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
  if (_sendMessageFn) {
    const now = Date.now();
    const dueReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt <= now);

    for (const reminder of dueReminders) {
      try {
        await _sendMessageFn(reminder.chatId, `⏰ *Reminder*: ${reminder.message}`);
        console.log(`[lizard] Sent reminder to ${reminder.chatId}: ${reminder.message}`);
      } catch (err) {
        console.error(`[lizard] Failed to send reminder:`, err);
      }
    }

    // Remove processed reminders
    lizardBrain.proactive.pendingReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt > now);
  }

  // 3.5. Calendar digests (via callback)
  if (_sendMessageFn && _onTick) {
    await _onTick();
  }

  // 3.6. Clean up expired state (via callback)
  if (_onCleanup) {
    _onCleanup();
  }

  // 4. Cleanup - Evict old tracking data (lastResponses)
  if (lizardBrain.lastResponses.size > 100) {
    const entries = [...lizardBrain.lastResponses.entries()];
    lizardBrain.lastResponses = new Map(entries.slice(-50));
  }

  // Update idle time
  // (idleSince is updated when messages are received, not here)
}

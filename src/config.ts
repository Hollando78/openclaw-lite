import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import "dotenv/config";

// ============================================================================
// Configuration
// ============================================================================

export const CONFIG = {
  // Auth state directory (WhatsApp session)
  authDir: process.env.OPENCLAW_AUTH_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "auth"),

  // Sessions directory (conversation history)
  sessionsDir: process.env.OPENCLAW_SESSIONS_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "sessions"),

  // Anthropic API key
  apiKey: process.env.ANTHROPIC_API_KEY || "",

  // Model to use (default: Haiku for cost savings, upgrades to smart model for complex tasks)
  model: process.env.OPENCLAW_MODEL || "claude-haiku-4-5-20251001",

  // Smart model for complex tasks (images, documents, tool use)
  smartModel: process.env.OPENCLAW_SMART_MODEL || "claude-sonnet-4-20250514",

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

  // Tavily API key for web search (optional)
  tavilyApiKey: process.env.TAVILY_API_KEY || "",

  // Google Drive OAuth (optional)
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",

  // GitHub integration (optional)
  githubToken: process.env.GITHUB_TOKEN || "",
  githubOwner: process.env.GITHUB_OWNER || "",

  // OpenAI API key (optional - for Whisper voice note transcription)
  openaiApiKey: process.env.OPENAI_API_KEY || "",
};

// Set system timezone if configured (must be before any Date usage)
if (process.env.OPENCLAW_TIMEZONE) {
  process.env.TZ = process.env.OPENCLAW_TIMEZONE;
}

// ============================================================================
// Types
// ============================================================================

export type ImageContent = { data: string; mimeType: string };

export type DocumentContent =
  | { kind: "pdf"; data: string }
  | { kind: "text"; data: string }
  | { kind: "image"; data: string; mimeType: string };

export type MediaContent =
  | { type: "image"; image: ImageContent }
  | { type: "document"; document: DocumentContent; fileName: string };

export type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type Session = {
  messages: Message[];
  lastActivity: number;
  conversationSummary?: string;  // Compressed summary of older messages
};

export type UserMemory = {
  facts: string[];           // Key facts about the user
  summary: string | null;    // Summary of older conversations
  summaryUpTo: number;       // Timestamp of last summarized message
  lastUpdated: number;
};

// ============================================================================
// Status Tracking (for kiosk display)
// ============================================================================

export const status = {
  state: "starting" as "starting" | "qr" | "connected" | "disconnected",
  qrCode: null as string | null,
  phoneNumber: null as string | null,
  startTime: Date.now(),
  messagesReceived: 0,
  messagesSent: 0,
  lastMessage: null as { from: string; preview: string; time: number } | null,
  errors: [] as Array<{ time: number; message: string }>,
  // Activity tracking for avatar animations
  activity: null as "receiving" | "thinking" | "sending" | null,
  activityUntil: 0,
};

export function addError(message: string) {
  status.errors.push({ time: Date.now(), message });
  if (status.errors.length > 10) {
    status.errors.shift();
  }
}

// ============================================================================
// sendMessageFn (getter/setter pattern for ESM live bindings)
// ============================================================================

let _sendMessageFn: ((chatId: string, text: string) => Promise<void>) | null = null;

export function getSendMessageFn(): ((chatId: string, text: string) => Promise<void>) | null {
  return _sendMessageFn;
}

export function setSendMessageFn(fn: ((chatId: string, text: string) => Promise<void>) | null): void {
  _sendMessageFn = fn;
}

// ============================================================================
// Claude API Client
// ============================================================================

let anthropic: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!anthropic) {
    if (!CONFIG.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    anthropic = new Anthropic({ apiKey: CONFIG.apiKey });
  }
  return anthropic;
}

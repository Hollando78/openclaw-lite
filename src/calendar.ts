/**
 * Calendar / Events System - Event storage, digests, and contact tagging
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ============================================================================
// Config
// ============================================================================

let _workspaceDir: string;

export function initCalendar(workspaceDir: string): void {
  _workspaceDir = workspaceDir;
}

// ============================================================================
// Pending Contact Tag State
// ============================================================================

export const pendingContactTag = new Map<string, { eventId: string; expiresAt: number }>();

export function setPendingContactTag(chatId: string, eventId: string): void {
  pendingContactTag.set(chatId, { eventId, expiresAt: Date.now() + 120_000 });
}

export function consumePendingContactTag(chatId: string): string | null {
  const pending = pendingContactTag.get(chatId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingContactTag.delete(chatId);
    return null;
  }
  pendingContactTag.delete(chatId);
  return pending.eventId;
}

// ============================================================================
// Pending Contact Add State
// ============================================================================

export const pendingContactAdd = new Map<string, { expiresAt: number }>();

export function setPendingContactAdd(chatId: string): void {
  pendingContactAdd.set(chatId, { expiresAt: Date.now() + 120_000 });
}

export function consumePendingContactAdd(chatId: string): boolean {
  const pending = pendingContactAdd.get(chatId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingContactAdd.delete(chatId);
    return false;
  }
  pendingContactAdd.delete(chatId);
  return true;
}

// ============================================================================
// Types
// ============================================================================

export type CalendarEvent = {
  id: string;
  title: string;
  recurrence: "daily" | "weekly" | "once";
  dayOfWeek?: number;       // 0=Sun..6=Sat (weekly only)
  time: string;             // "HH:MM" 24h
  date?: string;            // "YYYY-MM-DD" (once only)
  taggedUsers: Array<{ jid: string; name: string }>;
  createdBy: string;
  createdAt: number;
  chatId: string;
  actionable?: boolean;     // If true, bot processes this via Claude instead of just notifying
};

export type CalendarData = {
  events: CalendarEvent[];
  contacts: Array<{ jid: string; name: string }>;
  digestConfig: { dailyTime: string; weeklyDay: number; weeklyTime: string };
  lastDailyDigest: Record<string, number>;
  lastWeeklyDigest: Record<string, number>;
  lastActionableFired: Record<string, string>; // eventId -> last fired date "YYYY-MM-DD"
};

// ============================================================================
// Constants
// ============================================================================

export const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_NAMES_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// ============================================================================
// Persistence
// ============================================================================

function getCalendarPath(): string {
  return path.join(_workspaceDir, "calendar.json");
}

export function loadCalendar(): CalendarData {
  try {
    const data = fs.readFileSync(getCalendarPath(), "utf-8");
    const cal = JSON.parse(data);
    // Backward compat: add contacts array if missing
    if (!cal.contacts) cal.contacts = [];
    return cal;
  } catch {
    return {
      events: [],
      contacts: [],
      digestConfig: { dailyTime: "07:00", weeklyDay: 0, weeklyTime: "18:00" },
      lastDailyDigest: {},
      lastWeeklyDigest: {},
      lastActionableFired: {},
    };
  }
}

export function saveCalendar(cal: CalendarData): void {
  fs.writeFileSync(getCalendarPath(), JSON.stringify(cal));
}

export function generateEventId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ============================================================================
// vCard Parsing
// ============================================================================

export function parseVCard(vcard: string): { phoneNumber: string; name: string } | null {
  const fnMatch = vcard.match(/FN:(.+)/i);
  const name = fnMatch?.[1]?.trim() || "Unknown";

  // Prefer waid (WhatsApp ID) if present
  const waidMatch = vcard.match(/waid=(\d+)/i);
  if (waidMatch) {
    return { phoneNumber: waidMatch[1], name };
  }

  // Fall back to TEL field
  const telMatch = vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
  if (!telMatch) return null;

  const rawNumber = telMatch[1].replace(/[^0-9]/g, "");
  if (!rawNumber || rawNumber.length < 7) return null;

  return { phoneNumber: rawNumber, name };
}

export function vcardToJid(phoneNumber: string): string {
  return `${phoneNumber}@s.whatsapp.net`;
}

// ============================================================================
// Date/Time Utilities
// ============================================================================

function getTimeStr(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function isTimeWithinWindow(current: string, target: string, windowSeconds: number): boolean {
  const [ch, cm] = current.split(":").map(Number);
  const [th, tm] = target.split(":").map(Number);
  const currentSecs = ch * 3600 + cm * 60;
  const targetSecs = th * 3600 + tm * 60;
  const diff = Math.abs(currentSecs - targetSecs);
  return diff <= windowSeconds || (86400 - diff) <= windowSeconds;
}

// ============================================================================
// Event Collection
// ============================================================================

export function collectTodayEvents(events: CalendarEvent[], currentDay: number, todayStr: string): Record<string, CalendarEvent[]> {
  const result: Record<string, CalendarEvent[]> = {};

  for (const evt of events) {
    let isToday = false;
    if (evt.recurrence === "daily") isToday = true;
    else if (evt.recurrence === "weekly" && evt.dayOfWeek === currentDay) isToday = true;
    else if (evt.recurrence === "once" && evt.date === todayStr) isToday = true;

    if (isToday) {
      for (const user of evt.taggedUsers) {
        if (!result[user.jid]) result[user.jid] = [];
        result[user.jid].push(evt);
      }
    }
  }

  for (const jid of Object.keys(result)) {
    result[jid].sort((a, b) => a.time.localeCompare(b.time));
  }
  return result;
}

export function collectWeekEvents(events: CalendarEvent[], startDay: number, startDateStr: string): Record<string, Record<number, CalendarEvent[]>> {
  const result: Record<string, Record<number, CalendarEvent[]>> = {};
  const startDate = new Date(startDateStr + "T00:00:00");

  for (let d = 0; d < 7; d++) {
    const day = (startDay + d) % 7;
    const dateForDay = new Date(startDate.getTime() + d * 86400000);
    const dateStr = getDateStr(dateForDay);

    for (const evt of events) {
      let matches = false;
      if (evt.recurrence === "daily") matches = true;
      else if (evt.recurrence === "weekly" && evt.dayOfWeek === day) matches = true;
      else if (evt.recurrence === "once" && evt.date === dateStr) matches = true;

      if (matches) {
        for (const user of evt.taggedUsers) {
          if (!result[user.jid]) result[user.jid] = {};
          if (!result[user.jid][day]) result[user.jid][day] = [];
          result[user.jid][day].push(evt);
        }
      }
    }
  }

  for (const jid of Object.keys(result)) {
    for (const day of Object.keys(result[jid])) {
      result[jid][Number(day)].sort((a, b) => a.time.localeCompare(b.time));
    }
  }
  return result;
}

export function findUserName(events: CalendarEvent[], jid: string): string {
  for (const evt of events) {
    const user = evt.taggedUsers.find(u => u.jid === jid);
    if (user) return user.name;
  }
  return "there";
}

export function cleanupPastEvents(cal: CalendarData): boolean {
  const todayStr = getDateStr(new Date());
  const before = cal.events.length;
  cal.events = cal.events.filter(evt => {
    if (evt.recurrence !== "once") return true;
    return evt.date! >= todayStr;
  });
  return cal.events.length !== before;
}

// ============================================================================
// Digest Processing
// ============================================================================

export async function processCalendarDigests(
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<void> {
  const cal = loadCalendar();
  if (cal.events.length === 0) return;

  const now = new Date();
  const currentTime = getTimeStr(now);
  const currentDay = now.getDay();
  const todayStr = getDateStr(now);
  const nowMs = now.getTime();

  // --- Daily Digest ---
  if (isTimeWithinWindow(currentTime, cal.digestConfig.dailyTime, 60)) {
    const userEvents = collectTodayEvents(cal.events, currentDay, todayStr);
    let saved = false;

    for (const [jid, events] of Object.entries(userEvents)) {
      const lastSent = cal.lastDailyDigest[jid] || 0;
      if (todayStr === getDateStr(new Date(lastSent))) continue;

      const userName = findUserName(cal.events, jid);
      let msg = `📅 *Good morning, ${userName}!*\n\nHere's your schedule for today:\n\n`;
      for (const evt of events) {
        msg += `• *${evt.time}* - ${evt.title}\n`;
      }

      try {
        await sendMessage(jid, msg);
        cal.lastDailyDigest[jid] = nowMs;
        saved = true;
        console.log(`[calendar] Sent daily digest to ${jid}`);
      } catch (err) {
        console.error(`[calendar] Failed daily digest to ${jid}:`, err);
      }
    }
    if (saved) saveCalendar(cal);
  }

  // --- Weekly Digest ---
  if (currentDay === cal.digestConfig.weeklyDay && isTimeWithinWindow(currentTime, cal.digestConfig.weeklyTime, 60)) {
    // Start from tomorrow (next 7 days), not today
    const tomorrowMs = now.getTime() + 86400000;
    const tomorrowDay = (currentDay + 1) % 7;
    const tomorrowStr = getDateStr(new Date(tomorrowMs));
    const userWeekEvents = collectWeekEvents(cal.events, tomorrowDay, tomorrowStr);
    let saved = false;

    for (const [jid, dayMap] of Object.entries(userWeekEvents)) {
      const lastSent = cal.lastWeeklyDigest[jid] || 0;
      if (nowMs - lastSent < 23 * 60 * 60 * 1000) continue;

      const userName = findUserName(cal.events, jid);
      let msg = `📅 *Weekly Schedule, ${userName}!*\n\nHere's your week ahead:\n\n`;

      for (let d = 0; d < 7; d++) {
        const day = (tomorrowDay + d) % 7;
        const dateForDay = new Date(tomorrowMs + d * 86400000);
        const eventsForDay = dayMap[day] || [];
        if (eventsForDay.length === 0) continue;

        msg += `*${DAY_NAMES_FULL[day]} ${getDateStr(dateForDay)}*\n`;
        for (const evt of eventsForDay) {
          msg += `  • ${evt.time} - ${evt.title}\n`;
        }
        msg += `\n`;
      }

      try {
        await sendMessage(jid, msg);
        cal.lastWeeklyDigest[jid] = nowMs;
        saved = true;
        console.log(`[calendar] Sent weekly digest to ${jid}`);
      } catch (err) {
        console.error(`[calendar] Failed weekly digest to ${jid}:`, err);
      }
    }
    if (saved) saveCalendar(cal);
  }

  // Cleanup past one-time events
  if (cleanupPastEvents(cal)) {
    saveCalendar(cal);
    console.log("[calendar] Cleaned up past one-time events");
  }
}

/**
 * Find actionable events that are due right now (within a 60-second window)
 * and haven't fired yet today. Returns the events and marks them as fired.
 */
export function collectDueActionableEvents(): CalendarEvent[] {
  const cal = loadCalendar();
  const now = new Date();
  const currentTime = getTimeStr(now);
  const currentDay = now.getDay();
  const todayStr = getDateStr(now);
  const due: CalendarEvent[] = [];

  // Initialize lastActionableFired if missing (backwards compat)
  if (!cal.lastActionableFired) cal.lastActionableFired = {};

  for (const evt of cal.events) {
    if (!evt.actionable) continue;
    if (!isTimeWithinWindow(currentTime, evt.time, 60)) continue;

    // Check recurrence matches today
    let isToday = false;
    if (evt.recurrence === "daily") isToday = true;
    else if (evt.recurrence === "weekly" && evt.dayOfWeek === currentDay) isToday = true;
    else if (evt.recurrence === "once" && evt.date === todayStr) isToday = true;
    if (!isToday) continue;

    // Skip if already fired today
    if (cal.lastActionableFired[evt.id] === todayStr) continue;

    due.push(evt);
    cal.lastActionableFired[evt.id] = todayStr;
  }

  if (due.length > 0) {
    saveCalendar(cal);
  }

  return due;
}

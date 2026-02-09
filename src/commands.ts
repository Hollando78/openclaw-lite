import { CONFIG, status, getSendMessageFn } from "./config.js";
import { loadSession, clearSession } from "./session.js";
import { loadMemory, saveMemory, isValidUserFact } from "./memory.js";
import {
  lizardBrain,
  getBudgetAwareParams, addReminder, listReminders, cancelReminder, formatDuration,
} from "./lizard-brain.js";
import { formatUptime } from "./kiosk.js";
import {
  pendingContactTag, setPendingContactTag,
  pendingContactAdd, setPendingContactAdd,
  loadCalendar, saveCalendar, generateEventId,
  DAY_NAMES_SHORT, DAY_NAMES_FULL, DAY_MAP,
} from "./calendar.js";
import {
  startDeviceCodeFlow, pollForToken, isConnected,
  getConnectionStatus, clearToken,
} from "./gdrive.js";
import {
  isConnected as isGitHubConnected,
  getConnectionStatus as getGitHubConnectionStatus,
} from "./github.js";

// ============================================================================
// Command Handling
// ============================================================================

export function isCommand(text: string): boolean {
  return text.startsWith("/");
}

export function handleCommand(chatId: string, senderId: string, text: string): string | null {
  const [cmd, ...args] = text.slice(1).split(" ");
  const command = cmd?.toLowerCase();

  switch (command) {
    case "clear":
    case "reset":
      clearSession(chatId);
      return "🦞 Session cleared. Starting fresh!";

    case "help":
    case "commands":
      return `🦞 *ChadGPT Commands*

*General*
/help - Show this help
/commands - Same as /help
/clear - Clear conversation history
/status - Show bot status
/feed - Reset token budget & restore energy

*Memory*
/remember - Show what I remember about you
/forget - Clear all memories about you

*Reminders*
/remind in 30 min Call mom
/remind at 15:00 Check oven
/remind daily 08:00 Write journal
/remind weekly Mon 09:00 Standup
/remind list - Show pending reminders
/remind cancel <id> - Cancel a reminder
Or just say: "remind me in 30 min to..."

*Calendar & Events*
/calendar - Show all events
/event add daily HH:MM Title
/event add weekly Day HH:MM Title
/event add once YYYY-MM-DD HH:MM Title
/event remove <id> - Remove event
/event tag <id> - Tag a contact to event
/event digest daily HH:MM
/event digest weekly Day HH:MM
/skip - Cancel contact tagging/adding

*Contacts*
/contacts - List known contacts
/contacts add - Add a contact (share a contact card)
/contacts remove <name> - Remove a contact
/contacts rename <old> to <new> - Rename a contact
${CONFIG.googleClientId ? `
*Google Drive*
/gdrive setup - Connect Google Drive
/gdrive status - Check connection
/gdrive disconnect - Disconnect
` : ""}${CONFIG.githubToken ? `*GitHub*
/github status - Check GitHub connection
` : ""}
Just send a message to chat with me!`;

    case "status": {
      const session = loadSession(chatId);
      const tokenUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
      const budgetParams = getBudgetAwareParams();
      const moodEmoji = lizardBrain.energy < 30 ? "😴" : lizardBrain.stress > 50 ? "😰" : lizardBrain.curiosity > 80 ? "🤔" : "😊";

      return `🦞 *ChadGPT Status*

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
${(() => {
  const reminders = listReminders(chatId);
  if (reminders.length === 0) return "No pending reminders";
  return `Pending: ${reminders.length}\n` + reminders.map(r => {
    const minsLeft = Math.max(0, Math.ceil((r.dueAt - Date.now()) / 60000));
    return `  #${r.id}. "${r.message}" — in ${formatDuration(minsLeft)}`;
  }).join("\n");
})()}

Running on minimal hardware 💪`;
    }

    case "remember": {
      const mem = loadMemory(chatId);
      // Filter out any previously stored bad facts (self-referential, etc.)
      const validFacts = mem.facts.filter(f => isValidUserFact(f));
      // If we cleaned up bad facts, save the cleaned version
      if (validFacts.length !== mem.facts.length) {
        mem.facts = validFacts;
        saveMemory(chatId, mem);
      }
      if (validFacts.length === 0 && !mem.summary) {
        return "🧠 I don't have any memories about you yet. Keep chatting and I'll learn!";
      }
      let memoryReport = "🧠 *What I remember:*\n\n";
      if (validFacts.length > 0) {
        memoryReport += "*Facts:*\n" + validFacts.map(f => `• ${f}`).join("\n") + "\n\n";
      }
      if (mem.summary) {
        memoryReport += "*Our history:*\n" + mem.summary;
      }
      return memoryReport;
    }

    case "feed": {
      const prevUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
      lizardBrain.tokens.used = 0;
      lizardBrain.energy = 100;
      lizardBrain.stress = Math.max(0, lizardBrain.stress - 30);
      return `🦞 *nom nom nom* 🍤\n\nThat hit the spot! Token budget reset (was ${prevUsage}% used). Energy fully restored. I'm ready to go!`;
    }

    case "forget":
      saveMemory(chatId, { facts: [], summary: null, summaryUpTo: 0, lastUpdated: 0 });
      return "🧠 Done! I've forgotten everything about you. Fresh start!";

    case "remind":
    case "reminder":
    case "reminders": {
      const subCmd = args[0]?.toLowerCase();

      // /remind list (or /reminders with no args)
      if (!subCmd || subCmd === "list") {
        const reminders = listReminders(chatId);
        if (reminders.length === 0) {
          return "📋 No pending reminders. Set one with:\n• /remind in 30 min Call mom\n• /remind at 15:00 Check oven\n• /remind daily 08:00 Write journal";
        }
        let output = "📋 *Pending Reminders*\n\n";
        for (const r of reminders) {
          const minsLeft = Math.max(0, Math.ceil((r.dueAt - Date.now()) / 60000));
          output += `#${r.id}. "${r.message}" — in ${formatDuration(minsLeft)}\n`;
        }
        output += `\nCancel with: /remind cancel <id>`;
        return output;
      }

      // /remind cancel <id>
      if (subCmd === "cancel" || subCmd === "remove") {
        const id = parseInt(args[1], 10);
        if (isNaN(id)) return "Usage: `/remind cancel <id>`\nUse `/remind list` to see IDs.";
        if (cancelReminder(chatId, id)) {
          return `✅ Reminder #${id} cancelled.`;
        }
        return `Reminder #${id} not found. Use \`/remind list\` to see your reminders.`;
      }

      // /remind in <N> <min/hours> <task>
      if (subCmd === "in") {
        const amount = parseInt(args[1], 10);
        if (isNaN(amount)) return "Usage: `/remind in 30 min Call mom`";
        const unit = args[2]?.toLowerCase() || "";
        const task = args.slice(3).join(" ");
        if (!task) return "Usage: `/remind in 30 min Call mom`";

        let minutes = amount;
        if (unit.startsWith("h")) minutes = amount * 60;

        const reminder = addReminder(chatId, task, minutes);
        return `⏰ Got it! I'll remind you in ${formatDuration(minutes)} to: ${task} [#${reminder.id}]`;
      }

      // /remind at <HH:MM> <task>
      if (subCmd === "at") {
        const timeArg = args[1];
        const task = args.slice(2).join(" ");
        if (!timeArg || !task) return "Usage: `/remind at 15:00 Check oven` or `/remind at 3pm Check oven`";

        // Parse time: "15:00", "3pm", "3:30pm"
        const timeMatch = timeArg.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
        if (!timeMatch) return "Usage: `/remind at 15:00 Check oven` or `/remind at 3pm Check oven`";

        let hours = parseInt(timeMatch[1], 10);
        const mins = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3]?.toLowerCase();

        if (ampm === "pm" && hours < 12) hours += 12;
        if (ampm === "am" && hours === 12) hours = 0;

        if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return "Invalid time. Use HH:MM (24h) or HH:MMam/pm.";

        const now = new Date();
        const target = new Date(now);
        target.setHours(hours, mins, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);

        const diffMins = Math.ceil((target.getTime() - now.getTime()) / 60000);
        const timeStr = `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
        const reminder = addReminder(chatId, task, diffMins);
        return `⏰ Got it! I'll remind you at ${timeStr} to: ${task} [#${reminder.id}]`;
      }

      // /remind daily <HH:MM> <task> → bridge to calendar event
      if (subCmd === "daily") {
        const time = args[1];
        const task = args.slice(2).join(" ");
        if (!time || !task || !/^\d{2}:\d{2}$/.test(time)) {
          return "Usage: `/remind daily 08:00 Write journal`";
        }
        const id = generateEventId();
        const cal = loadCalendar();
        cal.events.push({
          id, title: task, recurrence: "daily", time,
          taggedUsers: [{ jid: senderId, name: senderId.replace(/@.*$/, "") }],
          createdBy: senderId, createdAt: Date.now(), chatId, actionable: true,
        });
        saveCalendar(cal);
        return `⏰ Daily reminder "${task}" at ${time} created! [${id}]\nI'll act on this every day at ${time}. Remove with: \`/event remove ${id}\``;
      }

      // /remind weekly <Day> <HH:MM> <task> → bridge to calendar event
      if (subCmd === "weekly") {
        const dayStr = args[1]?.toLowerCase();
        const dayOfWeek = DAY_MAP[dayStr];
        if (dayOfWeek === undefined) {
          return "Usage: `/remind weekly Mon 09:00 Standup`\nDays: Sun, Mon, Tue, Wed, Thu, Fri, Sat";
        }
        const time = args[2];
        const task = args.slice(3).join(" ");
        if (!time || !task || !/^\d{2}:\d{2}$/.test(time)) {
          return "Usage: `/remind weekly Mon 09:00 Standup`";
        }
        const id = generateEventId();
        const cal = loadCalendar();
        cal.events.push({
          id, title: task, recurrence: "weekly", dayOfWeek, time,
          taggedUsers: [{ jid: senderId, name: senderId.replace(/@.*$/, "") }],
          createdBy: senderId, createdAt: Date.now(), chatId, actionable: true,
        });
        saveCalendar(cal);
        return `⏰ Weekly reminder "${task}" every ${DAY_NAMES_SHORT[dayOfWeek]} at ${time} created! [${id}]\nI'll act on this every ${DAY_NAMES_SHORT[dayOfWeek]} at ${time}. Remove with: \`/event remove ${id}\``;
      }

      return `Usage:
/remind in 30 min Call mom
/remind at 15:00 Check oven
/remind daily 08:00 Write journal
/remind weekly Mon 09:00 Standup
/remind list - Show reminders
/remind cancel <id> - Cancel reminder

Or just say: "remind me in 30 min to call mom"`;
    }

    case "calendar": {
      const cal = loadCalendar();
      if (cal.events.length === 0) {
        return "📅 No events yet. Use `/event add` to create one!";
      }
      let output = "📅 *All Events*\n\n";
      for (const evt of cal.events) {
        const tagged = evt.taggedUsers.length > 0
          ? ` (${evt.taggedUsers.map(u => u.name).join(", ")})`
          : "";
        let schedule = "";
        if (evt.recurrence === "daily") schedule = `Daily at ${evt.time}`;
        else if (evt.recurrence === "weekly") schedule = `Every ${DAY_NAMES_SHORT[evt.dayOfWeek!]} at ${evt.time}`;
        else schedule = `${evt.date} at ${evt.time}`;
        output += `*${evt.title}* [${evt.id}]\n${schedule}${tagged}\n\n`;
      }
      const cfg = cal.digestConfig;
      output += `_Digests: daily ${cfg.dailyTime}, weekly ${DAY_NAMES_SHORT[cfg.weeklyDay]} ${cfg.weeklyTime}_`;
      return output;
    }

    case "event": {
      const subCmd = args[0]?.toLowerCase();

      if (subCmd === "add") {
        const recurrence = args[1]?.toLowerCase();

        if (recurrence === "daily") {
          const time = args[2];
          const title = args.slice(3).join(" ");
          if (!time || !title || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add daily HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "daily", time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Daily event "${title}" at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        if (recurrence === "weekly") {
          const dayStr = args[2]?.toLowerCase();
          const dayOfWeek = DAY_MAP[dayStr];
          if (dayOfWeek === undefined) {
            return "Usage: `/event add weekly Mon HH:MM Event title`\nDays: Sun, Mon, Tue, Wed, Thu, Fri, Sat";
          }
          const time = args[3];
          const title = args.slice(4).join(" ");
          if (!time || !title || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add weekly Mon HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "weekly", dayOfWeek, time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Weekly event "${title}" every ${DAY_NAMES_SHORT[dayOfWeek]} at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        if (recurrence === "once") {
          const date = args[2];
          const time = args[3];
          const title = args.slice(4).join(" ");
          if (!date || !time || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add once YYYY-MM-DD HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "once", date, time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Event "${title}" on ${date} at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        return "Usage: `/event add daily|weekly|once ...`\n\nExamples:\n`/event add daily 07:30 Take vitamins`\n`/event add weekly Mon 08:00 School run`\n`/event add once 2026-02-15 10:00 Dentist`";
      }

      if (subCmd === "remove") {
        const eventId = args[1];
        if (!eventId) return "Usage: `/event remove <id>`";
        const cal = loadCalendar();
        const idx = cal.events.findIndex(e => e.id === eventId);
        if (idx === -1) return `Event ${eventId} not found.`;
        const removed = cal.events.splice(idx, 1)[0];
        saveCalendar(cal);
        return `🗑️ Removed "${removed.title}" [${eventId}]`;
      }

      if (subCmd === "tag") {
        const eventId = args[1];
        if (!eventId) return "Usage: `/event tag <id>` then send a contact";
        const cal = loadCalendar();
        const evt = cal.events.find(e => e.id === eventId);
        if (!evt) return `Event ${eventId} not found.`;
        setPendingContactTag(chatId, eventId);
        return `Send me a contact to tag to "${evt.title}", or /skip to cancel.`;
      }

      if (subCmd === "digest") {
        const digestType = args[1]?.toLowerCase();
        const cal = loadCalendar();

        if (digestType === "daily") {
          const time = args[2];
          if (!time || !/^\d{2}:\d{2}$/.test(time)) return "Usage: `/event digest daily HH:MM`";
          cal.digestConfig.dailyTime = time;
          saveCalendar(cal);
          return `📬 Daily digest will be sent at ${time}.`;
        }

        if (digestType === "weekly") {
          const dayStr = args[2]?.toLowerCase();
          const dayOfWeek = DAY_MAP[dayStr];
          if (dayOfWeek === undefined) return "Usage: `/event digest weekly Sun HH:MM`";
          const time = args[3];
          if (!time || !/^\d{2}:\d{2}$/.test(time)) return "Usage: `/event digest weekly Sun HH:MM`";
          cal.digestConfig.weeklyDay = dayOfWeek;
          cal.digestConfig.weeklyTime = time;
          saveCalendar(cal);
          return `📬 Weekly digest will be sent on ${DAY_NAMES_FULL[dayOfWeek]}s at ${time}.`;
        }

        return "Usage:\n`/event digest daily HH:MM`\n`/event digest weekly Sun HH:MM`";
      }

      return "Usage: `/event add|remove|tag|digest ...`\nType `/help` for examples.";
    }

    case "gdrive": {
      const subCmd = args[0]?.toLowerCase();

      if (subCmd === "setup") {
        if (!CONFIG.googleClientId || !CONFIG.googleClientSecret) {
          return "Google Drive not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env";
        }
        const sendMessageFn = getSendMessageFn();
        // Start device code flow async
        (async () => {
          try {
            const flow = await startDeviceCodeFlow();
            await sendMessageFn?.(chatId,
              `🔗 *Google Drive Setup*\n\n` +
              `1. Open: ${flow.url}\n` +
              `2. Enter code: *${flow.userCode}*\n\n` +
              `Waiting for authorization...`
            );
            await pollForToken(flow.deviceCode, flow.interval);
            await sendMessageFn?.(chatId, "✅ Google Drive connected! You can now ask me to search, read, create, or update documents.");
          } catch (err) {
            await sendMessageFn?.(chatId, `❌ Google Drive setup failed: ${err}`);
          }
        })();
        return "⏳ Starting Google Drive setup..."; // Async flow will send follow-up messages
      }

      if (subCmd === "status") {
        return `🔗 Google Drive: ${getConnectionStatus()}`;
      }

      if (subCmd === "disconnect") {
        clearToken();
        return "🔗 Google Drive disconnected.";
      }

      return "Usage:\n`/gdrive setup` - Connect Google Drive\n`/gdrive status` - Check connection\n`/gdrive disconnect` - Disconnect";
    }

    case "github": {
      const subCmd = args[0]?.toLowerCase();

      if (subCmd === "status") {
        return `🔗 GitHub: ${getGitHubConnectionStatus()}`;
      }

      return "Usage:\n`/github status` - Check GitHub connection";
    }

    case "contacts":
    case "contact": {
      const subCmd = args[0]?.toLowerCase();

      // /contacts or /contacts list
      if (!subCmd || subCmd === "list") {
        const cal = loadCalendar();
        if (cal.contacts.length === 0) {
          return "📇 No contacts yet. Use `/contacts add` then share a WhatsApp contact card.";
        }
        let output = "📇 *Contacts*\n\n";
        for (const c of cal.contacts) {
          output += `• ${c.name} (${c.jid.replace(/@.*$/, "")})\n`;
        }
        return output;
      }

      // /contacts add
      if (subCmd === "add") {
        setPendingContactAdd(chatId);
        return "Send me a contact card to add, or /skip to cancel.";
      }

      // /contacts remove <name>
      if (subCmd === "remove" || subCmd === "delete") {
        const name = args.slice(1).join(" ").trim();
        if (!name) return "Usage: `/contacts remove <name>`";
        const cal = loadCalendar();
        const searchName = name.toLowerCase();
        const idx = cal.contacts.findIndex(c => c.name.toLowerCase() === searchName || c.name.toLowerCase().includes(searchName));
        if (idx === -1) return `Contact "${name}" not found. Use \`/contacts\` to see all contacts.`;
        const removed = cal.contacts.splice(idx, 1)[0];
        saveCalendar(cal);
        return `🗑️ Removed contact "${removed.name}".`;
      }

      // /contacts rename <old> to <new>
      if (subCmd === "rename") {
        const full = args.slice(1).join(" ");
        const toIdx = full.toLowerCase().indexOf(" to ");
        if (toIdx === -1) return "Usage: `/contacts rename <old name> to <new name>`";
        const oldName = full.slice(0, toIdx).trim();
        const newName = full.slice(toIdx + 4).trim();
        if (!oldName || !newName) return "Usage: `/contacts rename <old name> to <new name>`";

        const cal = loadCalendar();
        const searchName = oldName.toLowerCase();
        const contact = cal.contacts.find(c => c.name.toLowerCase() === searchName || c.name.toLowerCase().includes(searchName));
        if (!contact) return `Contact "${oldName}" not found. Use \`/contacts\` to see all contacts.`;

        const oldDisplayName = contact.name;
        contact.name = newName;

        // Also update taggedUsers across all events with the same JID
        for (const evt of cal.events) {
          for (const u of evt.taggedUsers) {
            if (u.jid === contact.jid) {
              u.name = newName;
            }
          }
        }

        saveCalendar(cal);
        return `✏️ Renamed "${oldDisplayName}" to "${newName}".`;
      }

      return "Usage: `/contacts list|add|remove|rename`\nType `/help` for details.";
    }

    case "skip":
      if (pendingContactTag.has(chatId)) {
        pendingContactTag.delete(chatId);
        return "Skipped contact tagging.";
      }
      if (pendingContactAdd.has(chatId)) {
        pendingContactAdd.delete(chatId);
        return "Skipped adding contact.";
      }
      return null;

    default:
      return null; // Not a recognized command, treat as regular message
  }
}

// ============================================================================
// Access Control
// ============================================================================

export function isAllowed(senderId: string): boolean {
  if (CONFIG.allowList.length === 0) {
    return true; // No allowlist = allow all
  }

  // Extract just the digits from sender ID (remove @s.whatsapp.net suffix and any non-digits)
  const senderDigits = senderId.replace(/@.*$/, "").replace(/[^0-9]/g, "");

  // Allowlist is pre-computed to digits at startup
  return CONFIG.allowList.includes(senderDigits);
}

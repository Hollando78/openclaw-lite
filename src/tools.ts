import Anthropic from "@anthropic-ai/sdk";
import { CONFIG, getSendMessageFn } from "./config.js";
import { addReminder, listReminders, cancelReminder, formatDuration } from "./lizard-brain.js";
import { loadMemory, saveMemory, isValidUserFact, sanitizeFact } from "./memory.js";
import {
  loadCalendar, saveCalendar, generateEventId,
  DAY_MAP, DAY_NAMES_SHORT,
} from "./calendar.js";
import {
  isConnected, searchFiles, listFiles, readDocAsText,
  createDoc, updateDoc, extractFileId, type DriveFile,
} from "./gdrive.js";
import {
  isConnected as isGitHubConnected,
  listRepos, createRepo, listIssues, createIssue, readIssue,
  commentOnIssue, closeIssue, listPullRequests, readFile as readGitHubFile,
  createOrUpdateFile,
  type GitHubRepo, type GitHubIssue, type GitHubComment, type GitHubPullRequest,
} from "./github.js";
import {
  loadLists, saveLists, findList, findItem, generateListId,
  formatList, formatAllLists, isListVisible,
} from "./lists.js";

// ============================================================================
// Web Search (Tavily)
// ============================================================================

export async function webSearch(query: string): Promise<string> {
  if (!CONFIG.tavilyApiKey) {
    return "Web search not available (no API key configured)";
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: CONFIG.tavilyApiKey,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      return "No results found.";
    }

    // Format results for Claude
    return results
      .map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
      .join("\n\n");
  } catch (err) {
    console.error("[search] Error:", err);
    return `Search failed: ${err}`;
  }
}

// ============================================================================
// Tool Definitions
// ============================================================================

const webSearchTool: Anthropic.Tool = {
  name: "web_search",
  description: "Search the web for current information. Use this when the user asks about recent events, news, current prices, weather, or anything that requires up-to-date information.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  },
};

const setReminderTool: Anthropic.Tool = {
  name: "set_reminder",
  description: "Set a reminder for the user. Use this when the user asks to be reminded about something, or when it would be helpful to offer a reminder (e.g. 'I have a meeting at 3pm' → offer to remind them). The reminder will fire in the current chat.",
  input_schema: {
    type: "object" as const,
    properties: {
      message: { type: "string", description: "The reminder message (e.g. 'Call the doctor')" },
      minutes: { type: "number", description: "Minutes from now until the reminder fires" },
    },
    required: ["message", "minutes"],
  },
};

const createEventTool: Anthropic.Tool = {
  name: "create_event",
  description: "Create a calendar event. Use this when the user mentions an appointment, meeting, recurring activity, or any scheduled event. Supports daily, weekly, and one-time events. Set actionable=true for recurring reminders where the bot should actively respond (e.g. 'write in journal daily') vs. just sending a notification.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Event title (e.g. 'Dentist appointment')" },
      recurrence: { type: "string", enum: ["daily", "weekly", "once"], description: "How often the event repeats" },
      time: { type: "string", description: "Time in HH:MM 24-hour format (e.g. '14:30')" },
      day_of_week: { type: "string", description: "Day of week for weekly events: sun, mon, tue, wed, thu, fri, sat" },
      date: { type: "string", description: "Date for one-time events in YYYY-MM-DD format (e.g. '2026-03-15')" },
      actionable: { type: "boolean", description: "If true, the bot will process this event through Claude when it fires (like a smart reminder). If false (default), it only appears in calendar digests." },
    },
    required: ["title", "recurrence", "time"],
  },
};

const rememberFactTool: Anthropic.Tool = {
  name: "remember_fact",
  description: "Store an important fact about the user for long-term memory. Use this when the user shares personal information worth remembering: their name, preferences, relationships, job, location, important dates, hobbies, etc. Only store facts about the user (the human), not about yourself.",
  input_schema: {
    type: "object" as const,
    properties: {
      fact: { type: "string", description: "A concise fact about the user (e.g. 'Has two kids named Max and Lily')" },
    },
    required: ["fact"],
  },
};

const listRemindersTool: Anthropic.Tool = {
  name: "list_reminders",
  description: "List the user's pending reminders. Use when the user asks what reminders they have, or when you need to reference existing reminders (e.g. before cancelling one).",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const cancelReminderTool: Anthropic.Tool = {
  name: "cancel_reminder",
  description: "Cancel a pending reminder by its ID. Use when the user asks to cancel or remove a reminder. Use list_reminders first if you need to find the ID.",
  input_schema: {
    type: "object" as const,
    properties: {
      reminder_id: { type: "number", description: "The reminder ID to cancel" },
    },
    required: ["reminder_id"],
  },
};

const listEventsTool: Anthropic.Tool = {
  name: "list_events",
  description: "List all calendar events. Use when the user asks about their schedule, upcoming events, or what's on their calendar.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const forgetFactTool: Anthropic.Tool = {
  name: "forget_fact",
  description: "Remove a specific fact from the user's long-term memory. Use when the user corrects outdated information (e.g. 'I moved to London' → forget the old city fact and remember the new one) or explicitly asks you to forget something.",
  input_schema: {
    type: "object" as const,
    properties: {
      fact: { type: "string", description: "The fact to remove (must match an existing stored fact, case-insensitive)" },
    },
    required: ["fact"],
  },
};

const tagEventTool: Anthropic.Tool = {
  name: "tag_event",
  description: "Tag a known contact to a calendar event. Only works for contacts who have been previously tagged to other events (their name and number are already known). Use list_events first to see existing events and their tagged contacts, then use this to tag a known contact to another event by name.",
  input_schema: {
    type: "object" as const,
    properties: {
      event_id: { type: "string", description: "The event ID to tag the contact to" },
      contact_name: { type: "string", description: "The contact's name (case-insensitive partial match against known contacts)" },
    },
    required: ["event_id", "contact_name"],
  },
};

const listContactsTool: Anthropic.Tool = {
  name: "list_contacts",
  description: "List all known contacts. Shows contacts from the standalone contacts list and from event tags. Use when the user asks about contacts, or before tagging someone to an event.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

const renameContactTool: Anthropic.Tool = {
  name: "rename_contact",
  description: "Rename a known contact. Updates the name in the contacts list and across all event tags. Use when the user corrects a contact's name.",
  input_schema: {
    type: "object" as const,
    properties: {
      old_name: { type: "string", description: "Current contact name (case-insensitive partial match)" },
      new_name: { type: "string", description: "New name for the contact" },
    },
    required: ["old_name", "new_name"],
  },
};

const addToListTool: Anthropic.Tool = {
  name: "add_to_list",
  description: "Add items to a named list. Creates the list automatically if it doesn't exist. Use when the user mentions adding to a shopping list, to-do list, grocery list, packing list, or any named list.",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list (e.g. 'Shopping', 'Groceries', 'Todo', 'Packing')" },
      items: { type: "array", items: { type: "string" }, description: "Items to add to the list" },
    },
    required: ["list_name", "items"],
  },
};

const removeFromListTool: Anthropic.Tool = {
  name: "remove_from_list",
  description: "Remove items from a named list by text match (case-insensitive partial match). Use when the user asks to remove or delete specific items from a list.",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list" },
      items: { type: "array", items: { type: "string" }, description: "Items to remove (matched by partial text)" },
    },
    required: ["list_name", "items"],
  },
};

const checkListItemTool: Anthropic.Tool = {
  name: "check_list_item",
  description: "Toggle an item's done/undone status on a list. Use when the user says they've done something, bought something, or wants to check/uncheck an item.",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list" },
      item: { type: "string", description: "Item text to match (case-insensitive partial match)" },
    },
    required: ["list_name", "item"],
  },
};

const showListTool: Anthropic.Tool = {
  name: "show_list",
  description: "Show a specific list's items or all lists. Use when the user asks what's on a list, asks to see their lists, or mentions checking a list.",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list to show (omit to show all lists)" },
    },
    required: [],
  },
};

const deleteListTool: Anthropic.Tool = {
  name: "delete_list",
  description: "Delete an entire list. Use when the user asks to delete, remove, or clear an entire list (not individual items).",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list to delete" },
    },
    required: ["list_name"],
  },
};

const shareListTool: Anthropic.Tool = {
  name: "share_list",
  description: "Share a list with a known contact. The contact will be notified and can view/edit the list. Use when the user says to share a list with someone.",
  input_schema: {
    type: "object" as const,
    properties: {
      list_name: { type: "string", description: "Name of the list to share" },
      contact_name: { type: "string", description: "Name of the contact to share with (case-insensitive partial match against known contacts)" },
    },
    required: ["list_name", "contact_name"],
  },
};

const gdriveTools: Anthropic.Tool[] = [
  {
    name: "gdrive_search",
    description: "Search Google Drive for files by name or content. Use when the user asks to find files in their Drive.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (file name or content keywords)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gdrive_list",
    description: "List recent files in Google Drive root or a specific folder.",
    input_schema: {
      type: "object" as const,
      properties: {
        folder_id: { type: "string", description: "Optional folder ID (omit for root)" },
      },
      required: [],
    },
  },
  {
    name: "gdrive_read",
    description: "Read the text content of a Google Doc. Use when the user asks to read, summarize, or analyze a document.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "Google Drive file ID or URL" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "gdrive_create_doc",
    description: "Create a new Google Doc with a title and content.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Document content (plain text)" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "gdrive_update_doc",
    description: "Update an existing Google Doc by appending or replacing content.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_id: { type: "string", description: "Google Drive file ID or URL" },
        content: { type: "string", description: "New content" },
        mode: { type: "string", enum: ["append", "replace"], description: "'append' to add to end, 'replace' to overwrite" },
      },
      required: ["file_id", "content", "mode"],
    },
  },
];

const githubTools: Anthropic.Tool[] = [
  {
    name: "github_list_repos",
    description: "List GitHub repositories for the authenticated user.",
    input_schema: {
      type: "object" as const,
      properties: {
        max_results: { type: "number", description: "Max repos to return (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "github_create_repo",
    description: "Create a new GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Optional description" },
        private: { type: "boolean", description: "Make repo private (default false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "github_list_issues",
    description: "List issues in a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state (default 'open')" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue description (markdown)" },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "github_read_issue",
    description: "Read an issue and its comments.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        issue_number: { type: "number", description: "Issue number" },
      },
      required: ["repo", "issue_number"],
    },
  },
  {
    name: "github_comment_issue",
    description: "Add a comment to an existing issue.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        issue_number: { type: "number", description: "Issue number" },
        body: { type: "string", description: "Comment text (markdown)" },
      },
      required: ["repo", "issue_number", "body"],
    },
  },
  {
    name: "github_close_issue",
    description: "Close an issue.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        issue_number: { type: "number", description: "Issue number" },
      },
      required: ["repo", "issue_number"],
    },
  },
  {
    name: "github_list_prs",
    description: "List pull requests in a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "PR state (default 'open')" },
      },
      required: ["repo"],
    },
  },
  {
    name: "github_read_file",
    description: "Read a file from a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        file_path: { type: "string", description: "Path to file (e.g. 'README.md' or 'src/index.ts')" },
        branch: { type: "string", description: "Branch name (default 'main')" },
      },
      required: ["repo", "file_path"],
    },
  },
  {
    name: "github_create_or_update_file",
    description: "Create a new file or update an existing file in a GitHub repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo name (e.g. 'myrepo' or 'owner/repo')" },
        file_path: { type: "string", description: "Path to file" },
        content: { type: "string", description: "File content" },
        message: { type: "string", description: "Commit message" },
        branch: { type: "string", description: "Branch name (default 'main')" },
      },
      required: ["repo", "file_path", "content", "message"],
    },
  },
];

// ============================================================================
// Tool Selection & Execution
// ============================================================================

export function getEnabledTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [setReminderTool, listRemindersTool, cancelReminderTool, createEventTool, listEventsTool, tagEventTool, listContactsTool, renameContactTool, rememberFactTool, forgetFactTool, addToListTool, removeFromListTool, checkListItemTool, showListTool, deleteListTool, shareListTool];
  if (CONFIG.tavilyApiKey) tools.push(webSearchTool);
  if (isConnected()) tools.push(...gdriveTools);
  if (isGitHubConnected()) tools.push(...githubTools);
  return tools;
}

export async function executeToolCall(toolUse: Anthropic.ToolUseBlock, chatId: string): Promise<string> {
  if (toolUse.name === "set_reminder") {
    const { message, minutes } = toolUse.input as { message: string; minutes: number };
    if (!message || !minutes || minutes <= 0) return "Invalid reminder: need a message and positive number of minutes.";
    const reminder = addReminder(chatId, message, minutes);
    console.log(`[reminder] Tool set reminder #${reminder.id}: "${message}" in ${minutes}min for ${chatId}`);
    return `Reminder #${reminder.id} set: "${message}" in ${formatDuration(minutes)}.`;
  }

  if (toolUse.name === "create_event") {
    const { title, recurrence, time, day_of_week, date, actionable } = toolUse.input as {
      title: string; recurrence: string; time: string; day_of_week?: string; date?: string; actionable?: boolean;
    };
    if (!title || !recurrence || !time) return "Invalid event: need title, recurrence, and time.";
    if (!/^\d{2}:\d{2}$/.test(time)) return "Invalid time format. Use HH:MM (e.g. '14:30').";
    const isActionable = actionable || false;

    if (recurrence === "weekly") {
      const dayOfWeek = day_of_week ? DAY_MAP[day_of_week.toLowerCase()] : undefined;
      if (dayOfWeek === undefined) return "Weekly events need a day_of_week (e.g. 'mon', 'tue').";
      const id = generateEventId();
      const cal = loadCalendar();
      cal.events.push({ id, title, recurrence: "weekly", dayOfWeek, time, taggedUsers: [], createdBy: chatId, createdAt: Date.now(), chatId, ...(isActionable && { actionable: true }) });
      saveCalendar(cal);
      console.log(`[calendar] Tool created weekly${isActionable ? " actionable" : ""} event "${title}" ${DAY_NAMES_SHORT[dayOfWeek]} ${time} [${id}]`);
      return `Event created: "${title}" every ${DAY_NAMES_SHORT[dayOfWeek]} at ${time}${isActionable ? " (actionable)" : ""} [${id}]. Remove with /event remove ${id}`;
    }

    if (recurrence === "once") {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "One-time events need a date in YYYY-MM-DD format.";
      const id = generateEventId();
      const cal = loadCalendar();
      cal.events.push({ id, title, recurrence: "once", date, time, taggedUsers: [], createdBy: chatId, createdAt: Date.now(), chatId, ...(isActionable && { actionable: true }) });
      saveCalendar(cal);
      console.log(`[calendar] Tool created one-time${isActionable ? " actionable" : ""} event "${title}" ${date} ${time} [${id}]`);
      return `Event created: "${title}" on ${date} at ${time}${isActionable ? " (actionable)" : ""} [${id}]. Remove with /event remove ${id}`;
    }

    if (recurrence === "daily") {
      const id = generateEventId();
      const cal = loadCalendar();
      cal.events.push({ id, title, recurrence: "daily", time, taggedUsers: [], createdBy: chatId, createdAt: Date.now(), chatId, ...(isActionable && { actionable: true }) });
      saveCalendar(cal);
      console.log(`[calendar] Tool created daily${isActionable ? " actionable" : ""} event "${title}" ${time} [${id}]`);
      return `Event created: "${title}" daily at ${time}${isActionable ? " (actionable)" : ""} [${id}]. Remove with /event remove ${id}`;
    }

    return "Invalid recurrence. Use 'daily', 'weekly', or 'once'.";
  }

  if (toolUse.name === "remember_fact") {
    const { fact } = toolUse.input as { fact: string };
    if (!fact || fact.trim().length === 0) return "No fact provided.";
    if (!isValidUserFact(fact)) return "That doesn't look like a valid user fact. Only store facts about the user.";
    const clean = sanitizeFact(fact);
    const memory = loadMemory(chatId);
    // Deduplicate: skip if already stored (case-insensitive)
    if (memory.facts.some(f => f.toLowerCase() === clean.toLowerCase())) {
      return `Already remembered: "${clean}"`;
    }
    memory.facts = [...memory.facts, clean].slice(-20); // Cap at 20 facts
    memory.lastUpdated = Date.now();
    saveMemory(chatId, memory);
    console.log(`[memory] Tool stored fact for ${chatId}: "${clean}"`);
    return `Remembered: "${clean}"`;
  }

  if (toolUse.name === "list_reminders") {
    const reminders = listReminders(chatId);
    if (reminders.length === 0) return "No pending reminders.";
    return reminders.map(r => {
      const minsLeft = Math.max(0, Math.ceil((r.dueAt - Date.now()) / 60000));
      return `#${r.id}. "${r.message}" — in ${formatDuration(minsLeft)}`;
    }).join("\n");
  }

  if (toolUse.name === "cancel_reminder") {
    const { reminder_id } = toolUse.input as { reminder_id: number };
    if (cancelReminder(chatId, reminder_id)) {
      console.log(`[reminder] Tool cancelled reminder #${reminder_id} for ${chatId}`);
      return `Reminder #${reminder_id} cancelled.`;
    }
    return `Reminder #${reminder_id} not found.`;
  }

  if (toolUse.name === "list_events") {
    const cal = loadCalendar();
    if (cal.events.length === 0) return "No calendar events.";
    return cal.events.map(evt => {
      const tagged = evt.taggedUsers.length > 0
        ? ` (${evt.taggedUsers.map(u => u.name).join(", ")})`
        : "";
      let schedule = "";
      if (evt.recurrence === "daily") schedule = `Daily at ${evt.time}`;
      else if (evt.recurrence === "weekly") schedule = `Every ${DAY_NAMES_SHORT[evt.dayOfWeek!]} at ${evt.time}`;
      else schedule = `${evt.date} at ${evt.time}`;
      return `"${evt.title}" [${evt.id}] — ${schedule}${tagged}${evt.actionable ? " (actionable)" : ""}`;
    }).join("\n");
  }

  if (toolUse.name === "tag_event") {
    const { event_id, contact_name } = toolUse.input as { event_id: string; contact_name: string };
    if (!event_id || !contact_name) return "Need both event_id and contact_name.";
    const cal = loadCalendar();
    const evt = cal.events.find(e => e.id === event_id);
    if (!evt) return `Event ${event_id} not found.`;

    // Build a set of all known contacts across all events + standalone contacts
    const knownContacts = new Map<string, { jid: string; name: string }>();
    for (const c of cal.contacts) {
      knownContacts.set(c.name.toLowerCase(), c);
    }
    for (const e of cal.events) {
      for (const u of e.taggedUsers) {
        if (!knownContacts.has(u.name.toLowerCase())) {
          knownContacts.set(u.name.toLowerCase(), u);
        }
      }
    }

    // Find by case-insensitive partial match
    const searchName = contact_name.trim().toLowerCase();
    let match: { jid: string; name: string } | undefined;
    for (const [name, contact] of knownContacts) {
      if (name === searchName || name.includes(searchName)) {
        match = contact;
        break;
      }
    }

    if (!match) {
      const names = [...knownContacts.values()].map(c => c.name);
      return names.length === 0
        ? "No known contacts. A contact must be shared via WhatsApp contact card first (using /event tag <id>)."
        : `Contact "${contact_name}" not found. Known contacts: ${names.join(", ")}`;
    }

    if (evt.taggedUsers.some(u => u.jid === match!.jid)) {
      return `${match.name} is already tagged to "${evt.title}".`;
    }

    evt.taggedUsers.push({ jid: match.jid, name: match.name });
    saveCalendar(cal);
    console.log(`[calendar] Tool tagged ${match.name} to event "${evt.title}" [${event_id}]`);
    return `Tagged ${match.name} to "${evt.title}".`;
  }

  if (toolUse.name === "forget_fact") {
    const { fact } = toolUse.input as { fact: string };
    if (!fact || fact.trim().length === 0) return "No fact provided.";
    const memory = loadMemory(chatId);
    const idx = memory.facts.findIndex(f => f.toLowerCase() === fact.trim().toLowerCase());
    if (idx === -1) {
      // Try partial match
      const partialIdx = memory.facts.findIndex(f => f.toLowerCase().includes(fact.trim().toLowerCase()));
      if (partialIdx === -1) return `No matching fact found. Current facts:\n${memory.facts.map(f => `• ${f}`).join("\n") || "(none)"}`;
      const removed = memory.facts.splice(partialIdx, 1)[0];
      memory.lastUpdated = Date.now();
      saveMemory(chatId, memory);
      console.log(`[memory] Tool removed fact for ${chatId}: "${removed}"`);
      return `Forgot: "${removed}"`;
    }
    const removed = memory.facts.splice(idx, 1)[0];
    memory.lastUpdated = Date.now();
    saveMemory(chatId, memory);
    console.log(`[memory] Tool removed fact for ${chatId}: "${removed}"`);
    return `Forgot: "${removed}"`;
  }

  if (toolUse.name === "list_contacts") {
    const cal = loadCalendar();
    // Merge standalone contacts + contacts from event tags
    const allContacts = new Map<string, { jid: string; name: string }>();
    for (const c of cal.contacts) {
      allContacts.set(c.jid, c);
    }
    for (const e of cal.events) {
      for (const u of e.taggedUsers) {
        if (!allContacts.has(u.jid)) {
          allContacts.set(u.jid, u);
        }
      }
    }
    if (allContacts.size === 0) return "No known contacts. Contacts can be added via /contacts add (share a WhatsApp contact card).";
    return [...allContacts.values()].map(c => `${c.name} (${c.jid.replace(/@.*$/, "")})`).join("\n");
  }

  if (toolUse.name === "rename_contact") {
    const { old_name, new_name } = toolUse.input as { old_name: string; new_name: string };
    if (!old_name || !new_name) return "Need both old_name and new_name.";
    const cal = loadCalendar();
    const searchName = old_name.trim().toLowerCase();
    const contact = cal.contacts.find(c => c.name.toLowerCase() === searchName || c.name.toLowerCase().includes(searchName));
    if (!contact) {
      const names = cal.contacts.map(c => c.name);
      return names.length === 0
        ? "No contacts to rename."
        : `Contact "${old_name}" not found. Known contacts: ${names.join(", ")}`;
    }
    const oldDisplayName = contact.name;
    contact.name = new_name.trim();
    // Propagate rename to all event tags with the same JID
    for (const evt of cal.events) {
      for (const u of evt.taggedUsers) {
        if (u.jid === contact.jid) {
          u.name = new_name.trim();
        }
      }
    }
    saveCalendar(cal);
    console.log(`[contacts] Tool renamed "${oldDisplayName}" to "${new_name.trim()}" for ${chatId}`);
    return `Renamed "${oldDisplayName}" to "${new_name.trim()}".`;
  }

  if (toolUse.name === "web_search") {
    const query = (toolUse.input as { query: string }).query;
    console.log(`[search] Searching: ${query}`);
    return await webSearch(query);
  }

  if (toolUse.name === "gdrive_search") {
    if (!isConnected()) return "Google Drive not connected. Use /gdrive setup first.";
    try {
      const { query } = toolUse.input as { query: string };
      console.log(`[gdrive] Searching: ${query}`);
      const files = await searchFiles(`fullText contains '${query}' or name contains '${query}'`);
      return files.length === 0
        ? "No files found."
        : files.map((f: DriveFile) => `${f.name} (${f.mimeType}) - ID: ${f.id}${f.webViewLink ? ` - ${f.webViewLink}` : ""}`).join("\n");
    } catch (err) { return `Drive search failed: ${err}`; }
  }

  if (toolUse.name === "gdrive_list") {
    if (!isConnected()) return "Google Drive not connected. Use /gdrive setup first.";
    try {
      const { folder_id } = toolUse.input as { folder_id?: string };
      console.log(`[gdrive] Listing files${folder_id ? ` in folder ${folder_id}` : ""}`);
      const files = await listFiles(folder_id);
      return files.length === 0
        ? "No files found."
        : files.map((f: DriveFile) => `${f.name} (${f.mimeType}) - ID: ${f.id}${f.size ? ` - ${(Number(f.size) / 1024).toFixed(1)}KB` : ""}`).join("\n");
    } catch (err) { return `Drive list failed: ${err}`; }
  }

  if (toolUse.name === "gdrive_read") {
    if (!isConnected()) return "Google Drive not connected. Use /gdrive setup first.";
    try {
      const { file_id } = toolUse.input as { file_id: string };
      const resolvedId = extractFileId(file_id) || file_id;
      console.log(`[gdrive] Reading doc: ${resolvedId}`);
      let text = await readDocAsText(resolvedId);
      if (text.length > 10000) text = text.slice(0, 10000) + "\n\n... (truncated at 10,000 chars)";
      return text || "(empty document)";
    } catch (err) { return `Failed to read document: ${err}`; }
  }

  if (toolUse.name === "gdrive_create_doc") {
    if (!isConnected()) return "Google Drive not connected. Use /gdrive setup first.";
    try {
      const { title, content } = toolUse.input as { title: string; content: string };
      console.log(`[gdrive] Creating doc: ${title}`);
      const result = await createDoc(title, content);
      return `Created "${title}"\nURL: ${result.url}\nID: ${result.id}`;
    } catch (err) { return `Failed to create document: ${err}`; }
  }

  if (toolUse.name === "gdrive_update_doc") {
    if (!isConnected()) return "Google Drive not connected. Use /gdrive setup first.";
    try {
      const { file_id, content, mode } = toolUse.input as { file_id: string; content: string; mode: "append" | "replace" };
      const resolvedId = extractFileId(file_id) || file_id;
      console.log(`[gdrive] Updating doc ${resolvedId} (${mode})`);
      await updateDoc(resolvedId, content, mode);
      return `Document updated (${mode}).`;
    } catch (err) { return `Failed to update document: ${err}`; }
  }

  if (toolUse.name === "github_list_repos") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { max_results } = toolUse.input as { max_results?: number };
      console.log(`[github] Listing repos`);
      const repos = await listRepos(max_results);
      return repos.length === 0
        ? "No repos found."
        : repos.map((r: GitHubRepo) => `${r.full_name}${r.private ? " [private]" : ""} - ${r.description || "No description"}\n${r.html_url}`).join("\n\n");
    } catch (err) { return `Failed to list repos: ${err}`; }
  }

  if (toolUse.name === "github_create_repo") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const input = toolUse.input as { name: string; description?: string; private?: boolean };
      console.log(`[github] Creating repo: ${input.name}`);
      const repo = await createRepo(input.name, input.description, input.private);
      return `Created ${repo.full_name}${repo.private ? " [private]" : ""}\n${repo.html_url}`;
    } catch (err) { return `Failed to create repo: ${err}`; }
  }

  if (toolUse.name === "github_list_issues") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, state } = toolUse.input as { repo: string; state?: "open" | "closed" | "all" };
      console.log(`[github] Listing issues in ${repo}`);
      const issues = await listIssues(repo, state);
      return issues.length === 0
        ? "No issues found."
        : issues.map((i: GitHubIssue) => `#${i.number} [${i.state}] ${i.title} (by ${i.user.login})\n${i.html_url}`).join("\n\n");
    } catch (err) { return `Failed to list issues: ${err}`; }
  }

  if (toolUse.name === "github_create_issue") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, title, body } = toolUse.input as { repo: string; title: string; body?: string };
      console.log(`[github] Creating issue in ${repo}: ${title}`);
      const issue = await createIssue(repo, title, body);
      return `Created issue #${issue.number}: ${issue.title}\n${issue.html_url}`;
    } catch (err) { return `Failed to create issue: ${err}`; }
  }

  if (toolUse.name === "github_read_issue") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, issue_number } = toolUse.input as { repo: string; issue_number: number };
      console.log(`[github] Reading issue #${issue_number} in ${repo}`);
      const { issue, comments } = await readIssue(repo, issue_number);
      let result = `#${issue.number} [${issue.state}] ${issue.title}\nBy ${issue.user.login} on ${issue.created_at.slice(0, 10)}\n\n${issue.body || "(no description)"}`;
      if (comments.length > 0) {
        result += "\n\nComments:\n" + comments.map((c: GitHubComment) => `@${c.user.login} (${c.created_at.slice(0, 10)}): ${c.body}`).join("\n\n");
      }
      if (result.length > 5000) result = result.slice(0, 5000) + "\n\n... (truncated)";
      return result;
    } catch (err) { return `Failed to read issue: ${err}`; }
  }

  if (toolUse.name === "github_comment_issue") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, issue_number, body } = toolUse.input as { repo: string; issue_number: number; body: string };
      console.log(`[github] Commenting on issue #${issue_number} in ${repo}`);
      await commentOnIssue(repo, issue_number, body);
      return `Comment added to issue #${issue_number}.`;
    } catch (err) { return `Failed to comment: ${err}`; }
  }

  if (toolUse.name === "github_close_issue") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, issue_number } = toolUse.input as { repo: string; issue_number: number };
      console.log(`[github] Closing issue #${issue_number} in ${repo}`);
      await closeIssue(repo, issue_number);
      return `Issue #${issue_number} closed.`;
    } catch (err) { return `Failed to close issue: ${err}`; }
  }

  if (toolUse.name === "github_list_prs") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, state } = toolUse.input as { repo: string; state?: "open" | "closed" | "all" };
      console.log(`[github] Listing PRs in ${repo}`);
      const prs = await listPullRequests(repo, state);
      return prs.length === 0
        ? "No pull requests found."
        : prs.map((p: GitHubPullRequest) => `#${p.number} [${p.state}] ${p.title} (by ${p.user.login})\n${p.html_url}`).join("\n\n");
    } catch (err) { return `Failed to list PRs: ${err}`; }
  }

  if (toolUse.name === "github_read_file") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, file_path, branch } = toolUse.input as { repo: string; file_path: string; branch?: string };
      console.log(`[github] Reading ${file_path} from ${repo}`);
      let content = await readGitHubFile(repo, file_path, branch);
      if (content.length > 10000) content = content.slice(0, 10000) + "\n\n... (truncated at 10,000 chars)";
      return content || "(empty file)";
    } catch (err) { return `Failed to read file: ${err}`; }
  }

  if (toolUse.name === "github_create_or_update_file") {
    if (!isGitHubConnected()) return "GitHub not configured. Set GITHUB_TOKEN and GITHUB_OWNER in .env";
    try {
      const { repo, file_path, content, message, branch } = toolUse.input as { repo: string; file_path: string; content: string; message: string; branch?: string };
      console.log(`[github] Writing ${file_path} to ${repo}`);
      const result = await createOrUpdateFile(repo, file_path, content, message, branch);
      return `File ${file_path} committed.\n${result.html_url}`;
    } catch (err) { return `Failed to write file: ${err}`; }
  }

  // ── List tools ──────────────────────────────────────────────────────

  if (toolUse.name === "add_to_list") {
    const { list_name, items } = toolUse.input as { list_name: string; items: string[] };
    if (!list_name) return "Need a list name.";
    if (!items || items.length === 0) return "Need at least one item to add.";
    const data = loadLists();
    let list = findList(data, list_name, chatId);
    let created = false;
    if (!list) {
      list = { id: generateListId(), name: list_name.trim(), items: [], createdBy: chatId, sharedWith: [], createdAt: Date.now() };
      data.lists.push(list);
      created = true;
    }
    for (const text of items) {
      if (text.trim()) {
        list.items.push({ id: generateListId(), text: text.trim(), done: false, addedAt: Date.now() });
      }
    }
    saveLists(data);
    console.log(`[lists] Added ${items.length} item(s) to "${list.name}"${created ? " (new list)" : ""}`);
    return `${created ? `Created "${list.name}" and added` : `Added`} ${items.length} item${items.length !== 1 ? "s" : ""} to "${list.name}" (${list.items.length} total).`;
  }

  if (toolUse.name === "remove_from_list") {
    const { list_name, items } = toolUse.input as { list_name: string; items: string[] };
    if (!list_name) return "Need a list name.";
    if (!items || items.length === 0) return "Need at least one item to remove.";
    const data = loadLists();
    const list = findList(data, list_name, chatId);
    if (!list) return `List "${list_name}" not found.`;
    const removed: string[] = [];
    for (const text of items) {
      const item = findItem(list, text);
      if (item) {
        list.items = list.items.filter(i => i.id !== item.id);
        removed.push(item.text);
      }
    }
    if (removed.length === 0) return `No matching items found in "${list.name}".`;
    saveLists(data);
    console.log(`[lists] Removed ${removed.length} item(s) from "${list.name}"`);
    return `Removed from "${list.name}": ${removed.join(", ")} (${list.items.length} remaining).`;
  }

  if (toolUse.name === "check_list_item") {
    const { list_name, item } = toolUse.input as { list_name: string; item: string };
    if (!list_name || !item) return "Need both list_name and item.";
    const data = loadLists();
    const list = findList(data, list_name, chatId);
    if (!list) return `List "${list_name}" not found.`;
    const found = findItem(list, item);
    if (!found) return `Item "${item}" not found in "${list.name}".`;
    found.done = !found.done;
    saveLists(data);
    console.log(`[lists] ${found.done ? "Checked" : "Unchecked"} "${found.text}" in "${list.name}"`);
    return `${found.done ? "☑" : "☐"} "${found.text}" ${found.done ? "done" : "undone"}.`;
  }

  if (toolUse.name === "show_list") {
    const { list_name } = toolUse.input as { list_name?: string };
    const data = loadLists();
    if (!list_name) return formatAllLists(data, chatId);
    const list = findList(data, list_name, chatId);
    if (!list) return `List "${list_name}" not found. ${formatAllLists(data, chatId)}`;
    return formatList(list);
  }

  if (toolUse.name === "delete_list") {
    const { list_name } = toolUse.input as { list_name: string };
    if (!list_name) return "Need a list name to delete.";
    const data = loadLists();
    const list = findList(data, list_name, chatId);
    if (!list) return `List "${list_name}" not found.`;
    data.lists = data.lists.filter(l => l.id !== list.id);
    saveLists(data);
    console.log(`[lists] Deleted list "${list.name}"`);
    return `Deleted list "${list.name}".`;
  }

  if (toolUse.name === "share_list") {
    const { list_name, contact_name } = toolUse.input as { list_name: string; contact_name: string };
    if (!list_name || !contact_name) return "Need both list_name and contact_name.";
    const data = loadLists();
    const list = findList(data, list_name, chatId);
    if (!list) return `List "${list_name}" not found.`;

    // Find contact from known contacts (calendar contacts + event tags)
    const cal = loadCalendar();
    const knownContacts = new Map<string, { jid: string; name: string }>();
    for (const c of cal.contacts) knownContacts.set(c.name.toLowerCase(), c);
    for (const e of cal.events) {
      for (const u of e.taggedUsers) {
        if (!knownContacts.has(u.name.toLowerCase())) knownContacts.set(u.name.toLowerCase(), u);
      }
    }

    const searchName = contact_name.trim().toLowerCase();
    let match: { jid: string; name: string } | undefined;
    for (const [name, contact] of knownContacts) {
      if (name === searchName || name.includes(searchName)) { match = contact; break; }
    }

    if (!match) {
      const names = [...knownContacts.values()].map(c => c.name);
      return names.length === 0
        ? "No known contacts. Add contacts via /contacts add first."
        : `Contact "${contact_name}" not found. Known contacts: ${names.join(", ")}`;
    }

    if (list.sharedWith.some(s => s.jid === match!.jid)) {
      return `"${list.name}" is already shared with ${match.name}.`;
    }

    list.sharedWith.push({ jid: match.jid, name: match.name });
    saveLists(data);
    console.log(`[lists] Shared "${list.name}" with ${match.name} (${match.jid})`);

    // Notify the contact
    const sendFn = getSendMessageFn();
    if (sendFn) {
      const itemCount = list.items.length;
      sendFn(match.jid, `📝 *${list.name}* list was shared with you (${itemCount} item${itemCount !== 1 ? "s" : ""}).\n\nSay "show my lists" or type /lists to see it.`).catch(err => {
        console.error(`[lists] Failed to notify ${match!.name}:`, err);
      });
    }

    return `Shared "${list.name}" with ${match.name}. They've been notified.`;
  }

  return `Unknown tool: ${toolUse.name}`;
}

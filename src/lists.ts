/**
 * Shared Lists — Persistent named lists with checkable items
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ============================================================================
// Config
// ============================================================================

let _workspaceDir: string;

export function initLists(workspaceDir: string): void {
  _workspaceDir = workspaceDir;
}

// ============================================================================
// Types
// ============================================================================

export type ListItem = {
  id: string;
  text: string;
  done: boolean;
  addedAt: number;
};

export type SharedList = {
  id: string;
  name: string;
  items: ListItem[];
  createdBy: string;           // chatId of creator
  sharedWith: Array<{ jid: string; name: string }>;
  createdAt: number;
};

export type ListsData = {
  lists: SharedList[];
};

// ============================================================================
// Persistence
// ============================================================================

function getListsPath(): string {
  return path.join(_workspaceDir, "lists.json");
}

export function loadLists(): ListsData {
  try {
    const data = fs.readFileSync(getListsPath(), "utf-8");
    const parsed = JSON.parse(data);
    // Backward compat: add missing fields
    for (const list of parsed.lists) {
      if (!list.createdBy) list.createdBy = "";
      if (!list.sharedWith) list.sharedWith = [];
    }
    return parsed;
  } catch {
    return { lists: [] };
  }
}

export function saveLists(data: ListsData): void {
  fs.writeFileSync(getListsPath(), JSON.stringify(data));
}

export function generateListId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ============================================================================
// Visibility
// ============================================================================

export function isListVisible(list: SharedList, chatId: string): boolean {
  // Visible if: creator, or shared with this chatId, or no creator set (legacy)
  if (!list.createdBy) return true;
  if (list.createdBy === chatId) return true;
  return list.sharedWith.some(s => s.jid === chatId);
}

export function getVisibleLists(data: ListsData, chatId: string): SharedList[] {
  return data.lists.filter(l => isListVisible(l, chatId));
}

// ============================================================================
// Helpers
// ============================================================================

export function findList(data: ListsData, name: string, chatId?: string): SharedList | undefined {
  const search = name.trim().toLowerCase();
  const pool = chatId ? getVisibleLists(data, chatId) : data.lists;
  // Exact match first
  const exact = pool.find(l => l.name.toLowerCase() === search);
  if (exact) return exact;
  // Partial match
  return pool.find(l => l.name.toLowerCase().includes(search));
}

export function findItem(list: SharedList, text: string): ListItem | undefined {
  const search = text.trim().toLowerCase();
  const exact = list.items.find(i => i.text.toLowerCase() === search);
  if (exact) return exact;
  return list.items.find(i => i.text.toLowerCase().includes(search));
}

export function formatList(list: SharedList): string {
  const shared = list.sharedWith.length > 0
    ? ` (shared with ${list.sharedWith.map(s => s.name).join(", ")})`
    : "";
  if (list.items.length === 0) {
    return `*${list.name}*${shared} — empty`;
  }
  const lines = list.items.map(i => `${i.done ? "☑" : "☐"} ${i.text}`);
  const done = list.items.filter(i => i.done).length;
  const total = list.items.length;
  return `*${list.name}* (${done}/${total} done)${shared}\n${lines.join("\n")}`;
}

export function formatAllLists(data: ListsData, chatId?: string): string {
  const lists = chatId ? getVisibleLists(data, chatId) : data.lists;
  if (lists.length === 0) return "No lists yet.";
  return lists.map(l => {
    const done = l.items.filter(i => i.done).length;
    const total = l.items.length;
    const shared = l.sharedWith.length > 0
      ? ` (shared with ${l.sharedWith.map(s => s.name).join(", ")})`
      : "";
    return `• *${l.name}* — ${total} item${total !== 1 ? "s" : ""}${done > 0 ? ` (${done} done)` : ""}${shared}`;
  }).join("\n");
}

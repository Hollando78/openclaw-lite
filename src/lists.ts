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
    return JSON.parse(data);
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
// Helpers
// ============================================================================

export function findList(data: ListsData, name: string): SharedList | undefined {
  const search = name.trim().toLowerCase();
  // Exact match first
  const exact = data.lists.find(l => l.name.toLowerCase() === search);
  if (exact) return exact;
  // Partial match
  return data.lists.find(l => l.name.toLowerCase().includes(search));
}

export function findItem(list: SharedList, text: string): ListItem | undefined {
  const search = text.trim().toLowerCase();
  const exact = list.items.find(i => i.text.toLowerCase() === search);
  if (exact) return exact;
  return list.items.find(i => i.text.toLowerCase().includes(search));
}

export function formatList(list: SharedList): string {
  if (list.items.length === 0) {
    return `*${list.name}* — empty`;
  }
  const lines = list.items.map(i => `${i.done ? "☑" : "☐"} ${i.text}`);
  const done = list.items.filter(i => i.done).length;
  const total = list.items.length;
  return `*${list.name}* (${done}/${total} done)\n${lines.join("\n")}`;
}

export function formatAllLists(data: ListsData): string {
  if (data.lists.length === 0) return "No lists yet.";
  return data.lists.map(l => {
    const done = l.items.filter(i => i.done).length;
    const total = l.items.length;
    return `• *${l.name}* — ${total} item${total !== 1 ? "s" : ""}${done > 0 ? ` (${done} done)` : ""}`;
  }).join("\n");
}

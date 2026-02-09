/**
 * Google Drive/Docs Integration - OAuth2 device flow + REST API
 */

import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Types
// ============================================================================

export interface GDriveConfig {
  workspaceDir: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenData {
  refresh_token: string;
  access_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  size?: string;
}

// ============================================================================
// Module State
// ============================================================================

let _config: GDriveConfig;
let _oauth2Client: OAuth2Client | null = null;
let _tokenPath: string;

// ============================================================================
// Initialization
// ============================================================================

export function initGDrive(config: GDriveConfig): void {
  _config = config;
  _tokenPath = path.join(config.workspaceDir, "google-token.json");

  if (!config.clientId || !config.clientSecret) {
    return;
  }

  _oauth2Client = new OAuth2Client(config.clientId, config.clientSecret);
  loadToken();
}

// ============================================================================
// Token Management
// ============================================================================

function loadToken(): boolean {
  try {
    const data = fs.readFileSync(_tokenPath, "utf-8");
    const token: TokenData = JSON.parse(data);
    if (_oauth2Client && token.refresh_token) {
      _oauth2Client.setCredentials({
        refresh_token: token.refresh_token,
        access_token: token.access_token,
        expiry_date: token.expiry_date,
        token_type: token.token_type,
      });
      console.log("[gdrive] Loaded saved token");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function saveToken(token: TokenData): void {
  fs.mkdirSync(path.dirname(_tokenPath), { recursive: true });
  fs.writeFileSync(_tokenPath, JSON.stringify(token, null, 2));
  console.log("[gdrive] Token saved");
}

export function clearToken(): void {
  try { fs.unlinkSync(_tokenPath); } catch { /* ignore */ }
  if (_oauth2Client) _oauth2Client.setCredentials({});
  console.log("[gdrive] Token cleared");
}

async function getAccessToken(): Promise<string> {
  if (!_oauth2Client) throw new Error("Google Drive not initialized");
  if (!_oauth2Client.credentials.refresh_token) throw new Error("Google Drive not connected. Use /gdrive setup");

  const creds = _oauth2Client.credentials;

  // Refresh if expired or about to expire (60s buffer)
  if (!creds.access_token || !creds.expiry_date || Date.now() >= creds.expiry_date - 60_000) {
    const { credentials: fresh } = await _oauth2Client.refreshAccessToken();
    _oauth2Client.setCredentials(fresh);
    saveToken({
      refresh_token: fresh.refresh_token || creds.refresh_token!,
      access_token: fresh.access_token!,
      expiry_date: fresh.expiry_date!,
      token_type: fresh.token_type || "Bearer",
      scope: fresh.scope || "",
    });
  }

  return _oauth2Client.credentials.access_token!;
}

// ============================================================================
// OAuth2 Device Code Flow
// ============================================================================

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
];

export async function startDeviceCodeFlow(): Promise<{
  url: string; userCode: string; deviceCode: string; interval: number;
}> {
  if (!_config.clientId) throw new Error("Google OAuth not configured");

  const res = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: _config.clientId,
      scope: SCOPES.join(" "),
    }),
  });

  if (!res.ok) throw new Error(`Device code request failed: ${res.status}`);
  const data = await res.json() as {
    device_code: string; user_code: string; verification_url: string;
    expires_in: number; interval: number;
  };

  return {
    url: data.verification_url,
    userCode: data.user_code,
    deviceCode: data.device_code,
    interval: data.interval || 5,
  };
}

export async function pollForToken(deviceCode: string, interval: number): Promise<TokenData> {
  if (!_config.clientId || !_config.clientSecret) throw new Error("Google OAuth not configured");

  let pollInterval = interval;
  const maxAttempts = 60; // ~5 min max

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval * 1000));

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: _config.clientId,
        client_secret: _config.clientSecret,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await res.json() as Record<string, unknown>;

    if (res.ok) {
      const token: TokenData = {
        refresh_token: data.refresh_token as string,
        access_token: data.access_token as string,
        expiry_date: Date.now() + (data.expires_in as number) * 1000,
        token_type: (data.token_type as string) || "Bearer",
        scope: (data.scope as string) || "",
      };
      saveToken(token);
      if (_oauth2Client) {
        _oauth2Client.setCredentials({
          refresh_token: token.refresh_token,
          access_token: token.access_token,
          expiry_date: token.expiry_date,
        });
      }
      return token;
    }

    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { pollInterval += 5; continue; }
    throw new Error(`Authorization failed: ${data.error}`);
  }

  throw new Error("Device code flow timed out");
}

export function isConnected(): boolean {
  return _oauth2Client !== null && !!_oauth2Client.credentials.refresh_token;
}

export function getConnectionStatus(): string {
  if (!_oauth2Client) return "Not configured";
  if (!_oauth2Client.credentials.refresh_token) return "Not connected";
  return "Connected";
}

// ============================================================================
// REST API Helpers
// ============================================================================

async function driveRequest(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://www.googleapis.com/drive/v3/${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers as Record<string, string>, Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function docsRequest(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken();
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://docs.googleapis.com/v1/${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers as Record<string, string>,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================================
// Drive Operations
// ============================================================================

export async function searchFiles(query: string, pageSize: number = 10): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    orderBy: "modifiedTime desc",
  });
  const data = await driveRequest(`files?${params}`) as { files?: DriveFile[] };
  return data.files || [];
}

export async function listFiles(folderId?: string, pageSize: number = 20): Promise<DriveFile[]> {
  const q = folderId
    ? `'${folderId}' in parents and trashed=false`
    : "trashed=false";
  const params = new URLSearchParams({
    q,
    pageSize: String(pageSize),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    orderBy: "modifiedTime desc",
  });
  const data = await driveRequest(`files?${params}`) as { files?: DriveFile[] };
  return data.files || [];
}

// ============================================================================
// File Upload / Download (binary)
// ============================================================================

let _cachedFolderId: string | null = null;

async function getOrCreateFolder(): Promise<string> {
  // Check in-memory cache
  if (_cachedFolderId) return _cachedFolderId;

  // Check disk cache
  const cachePath = path.join(_config.workspaceDir, "drive-folder-id.txt");
  try {
    const cached = fs.readFileSync(cachePath, "utf-8").trim();
    if (cached) { _cachedFolderId = cached; return cached; }
  } catch { /* ignore */ }

  // Search for existing folder
  const existing = await searchFiles("name='ChadGPT Files' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if (existing.length > 0) {
    _cachedFolderId = existing[0].id;
    fs.writeFileSync(cachePath, existing[0].id);
    return existing[0].id;
  }

  // Create new folder
  const folder = await driveRequest("files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ChadGPT Files", mimeType: "application/vnd.google-apps.folder" }),
  }) as { id: string };

  _cachedFolderId = folder.id;
  fs.writeFileSync(cachePath, folder.id);
  console.log(`[gdrive] Created "ChadGPT Files" folder: ${folder.id}`);
  return folder.id;
}

export async function uploadFile(
  name: string, buffer: Buffer, mimeType: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const token = await getAccessToken();
  const folderId = await getOrCreateFolder();

  const boundary = "openclaw_" + Date.now();
  const metadata = JSON.stringify({ name, mimeType, parents: [folderId] });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive upload failed ${res.status}: ${errText.slice(0, 200)}`);
  }

  const result = await res.json() as { id: string; name: string; webViewLink?: string };
  console.log(`[gdrive] Uploaded "${name}" (${(buffer.length / 1024).toFixed(1)}KB) → ${result.id}`);
  return result;
}

export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const token = await getAccessToken();

  // Get metadata
  const meta = await driveRequest(`files/${fileId}?fields=name,mimeType,size`) as {
    name: string; mimeType: string; size?: string;
  };

  // Google Docs/Sheets/Slides need to be exported
  if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime = meta.mimeType.includes("document") ? "application/pdf"
      : meta.mimeType.includes("spreadsheet") ? "text/csv"
      : meta.mimeType.includes("presentation") ? "application/pdf"
      : "application/pdf";
    const exportName = meta.name + (exportMime === "text/csv" ? ".csv" : ".pdf");

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Drive export failed ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), name: exportName, mimeType: exportMime };
  }

  // Regular file download
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive download failed ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  console.log(`[gdrive] Downloaded "${meta.name}" (${(arrayBuffer.byteLength / 1024).toFixed(1)}KB)`);
  return { buffer: Buffer.from(arrayBuffer), name: meta.name, mimeType: meta.mimeType };
}

// ============================================================================
// Docs Operations
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function readDocAsText(fileId: string): Promise<string> {
  const doc = await docsRequest(`documents/${fileId}`) as any;
  let text = "";

  if (doc.body?.content) {
    for (const el of doc.body.content) {
      if (el.paragraph?.elements) {
        for (const run of el.paragraph.elements) {
          if (run.textRun?.content) text += run.textRun.content;
        }
      } else if (el.table?.tableRows) {
        for (const row of el.table.tableRows) {
          const cells: string[] = [];
          for (const cell of row.tableCells || []) {
            let cellText = "";
            for (const ce of cell.content || []) {
              if (ce.paragraph?.elements) {
                for (const run of ce.paragraph.elements) {
                  if (run.textRun?.content) cellText += run.textRun.content.trim();
                }
              }
            }
            cells.push(cellText);
          }
          text += cells.join(" | ") + "\n";
        }
        text += "\n";
      }
    }
  }

  return text.trim();
}

export async function createDoc(title: string, content: string): Promise<{ id: string; url: string }> {
  const doc = await docsRequest("documents", {
    method: "POST",
    body: JSON.stringify({ title }),
  }) as any;

  const docId = doc.documentId as string;

  if (content && content.trim().length > 0) {
    await docsRequest(`documents/${docId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text: content } }],
      }),
    });
  }

  return { id: docId, url: `https://docs.google.com/document/d/${docId}/edit` };
}

export async function updateDoc(fileId: string, content: string, mode: "append" | "replace"): Promise<void> {
  const doc = await docsRequest(`documents/${fileId}`) as any;
  const bodyContent = doc.body?.content;
  if (!bodyContent || bodyContent.length === 0) return;

  const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

  if (mode === "replace" && endIndex > 1) {
    await docsRequest(`documents/${fileId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [
          { deleteContentRange: { range: { startIndex: 1, endIndex } } },
          { insertText: { location: { index: 1 }, text: content } },
        ],
      }),
    });
  } else {
    // Append
    await docsRequest(`documents/${fileId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: Math.max(1, endIndex) }, text: "\n\n" + content } }],
      }),
    });
  }
}

// ============================================================================
// Utility
// ============================================================================

export function extractFileId(urlOrId: string): string | null {
  if (!urlOrId.includes("/")) return urlOrId;

  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/folders\/([a-zA-Z0-9_-]+)/,
  ];

  for (const p of patterns) {
    const m = urlOrId.match(p);
    if (m) return m[1];
  }
  return null;
}

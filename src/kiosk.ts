/**
 * Kiosk UI - Status page and animated lobster avatar
 */

import * as http from "http";

// ============================================================================
// Types
// ============================================================================

export interface KioskConfig {
  statusPort: number;
  statusBind: string;
  model: string;
}

export interface StatusState {
  state: "starting" | "qr" | "connected" | "disconnected";
  qrCode: string | null;
  phoneNumber: string | null;
  startTime: number;
  messagesReceived: number;
  messagesSent: number;
  lastMessage: { from: string; preview: string; time: number } | null;
  errors: Array<{ time: number; message: string }>;
  activity: "receiving" | "thinking" | "sending" | null;
  activityUntil: number;
}

export interface LizardBrainState {
  energy: number;
  stress: number;
  curiosity: number;
  tokens: { used: number; budget: number; resetAt: number };
  resources: { apiErrors: number };
  proactive: { pendingReminders: Array<unknown> };
}

// ============================================================================
// Module State
// ============================================================================

let _config: KioskConfig;
let _status: StatusState;
let _brain: LizardBrainState;
let _serverStarted = false;

export function initKiosk(config: KioskConfig, status: StatusState, brain: LizardBrainState): void {
  _config = config;
  _status = status;
  _brain = brain;
}

// ============================================================================
// Uptime
// ============================================================================

export function formatUptime(): string {
  const ms = Date.now() - _status.startTime;
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

export function startStatusServer() {
  if (_serverStarted) return; // Only start once
  _serverStarted = true;

  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ..._status,
        uptime: formatUptime(),
        lizardBrain: {
          energy: _brain.energy,
          stress: _brain.stress,
          curiosity: Math.round(_brain.curiosity),
          tokens: {
            used: _brain.tokens.used,
            budget: _brain.tokens.budget,
            usagePercent: Math.round((_brain.tokens.used / _brain.tokens.budget) * 100),
            resetAt: _brain.tokens.resetAt,
          },
          pendingReminders: _brain.proactive.pendingReminders.length,
          apiErrors: _brain.resources.apiErrors,
        },
      }));
      return;
    }

    // Serve kiosk HTML page
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateKioskHTML());
  });

  // Bind to localhost only - never expose to network
  server.listen(_config.statusPort, _config.statusBind, () => {
    const host = _config.statusBind === "0.0.0.0" ? "your-ip" : "localhost";
    console.log(`🖥️  Kiosk status page: http://${host}:${_config.statusPort}`);
  });
}

// ============================================================================
// HTML Generation
// ============================================================================

function generateKioskHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>ChadGPT</title>
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
// Avatar
// ============================================================================

function getAvatarState(): string {
  // Check transient activity states first (with expiry)
  if (_status.activity && Date.now() < _status.activityUntil) {
    return _status.activity;
  }
  _status.activity = null; // Clear expired activity

  const tokenUsage = _brain.tokens.used / _brain.tokens.budget;

  // Priority-based state selection
  if (_status.state === "disconnected") return "disconnected";
  if (_status.state === "qr") return "qr";
  if (tokenUsage >= 1.0) return "exhausted";
  if (tokenUsage >= 0.75) return "budget-warning";
  if (_brain.resources.apiErrors > 0) return "error";
  if (_brain.energy < 30) return "tired";
  if (_brain.stress > 50) return "stressed";
  if (_brain.curiosity > 80) return "curious";
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
  const qrSection = _status.qrCode && _status.state === "qr"
    ? `<div class="qr-overlay">
        <div class="qr-label">Scan with WhatsApp:</div>
        <pre class="qr-code">${escapeHtml(_status.qrCode)}</pre>
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
    "receiving": "Message received!",
    "thinking": "Thinking...",
    "sending": "Responding!",
  };
  return labels[state] || "Hello!";
}

// ============================================================================
// Status Page
// ============================================================================

function generateStatusPage(): string {
  const stateClass = _status.state === 'connected' ? 'status-connected' : _status.state === 'qr' ? 'status-qr' : 'status-disconnected';
  const stateText = {
    starting: "Starting...",
    qr: "Scan QR Code",
    connected: "Connected",
    disconnected: "Disconnected",
  }[_status.state];

  const stateIcon = {
    starting: '<svg class="icon icon-loading spin"><use href="#icon-loading"/></svg>',
    qr: '<svg class="icon"><use href="#icon-phone"/></svg>',
    connected: '<svg class="icon"><use href="#icon-check"/></svg>',
    disconnected: '<svg class="icon"><use href="#icon-error"/></svg>',
  }[_status.state];

  const tokenUsage = Math.round((_brain.tokens.used / _brain.tokens.budget) * 100);
  const tokenClass = tokenUsage >= 90 ? "critical" : tokenUsage >= 75 ? "low" : tokenUsage >= 50 ? "moderate" : "healthy";

  const moodIcon = _brain.energy < 30
    ? '<svg class="icon icon-mood"><use href="#icon-mood-tired"/></svg>'
    : _brain.stress > 50
    ? '<svg class="icon icon-mood"><use href="#icon-mood-stressed"/></svg>'
    : _brain.curiosity > 80
    ? '<svg class="icon icon-mood"><use href="#icon-mood-curious"/></svg>'
    : '<svg class="icon icon-mood"><use href="#icon-mood-happy"/></svg>';

  const lastMessageSection = _status.lastMessage
    ? `<div class="last-message">
        <div class="label">Last message:</div>
        <div class="message">"${escapeHtml(_status.lastMessage.preview)}"</div>
        <div class="time">${new Date(_status.lastMessage.time).toLocaleTimeString()}</div>
       </div>`
    : "";

  return `<div class="page status-page" data-page="1">
    <div class="page-header">
      <svg class="icon-lobster-small"><use href="#icon-lobster"/></svg>
      <span class="title">ChadGPT</span>
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
      ${_status.phoneNumber ? `
      <div class="status-row">
        <span class="status-label"><svg class="icon-sm"><use href="#icon-phone"/></svg> Phone</span>
        <span class="status-value">${escapeHtml(_status.phoneNumber!)}</span>
      </div>
      ` : ''}
      <div class="status-row">
        <span class="status-label">Model</span>
        <span class="status-value model-name">${escapeHtml(_config.model.split('/').pop() || _config.model)}</span>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${_status.messagesReceived}</div>
        <div class="stat-label">Received</div>
      </div>
      <div class="stat">
        <div class="stat-value">${_status.messagesSent}</div>
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
          <div class="mood-fill energy" style="width: ${_brain.energy}%"></div>
        </div>
        <span class="mood-value">${_brain.energy}%</span>
      </div>

      <div class="mood-bar">
        <span class="mood-label">Stress</span>
        <div class="mood-track">
          <div class="mood-fill stress" style="width: ${_brain.stress}%"></div>
        </div>
        <span class="mood-value">${_brain.stress}%</span>
      </div>

      <div class="mood-bar">
        <span class="mood-label">Curiosity</span>
        <div class="mood-track">
          <div class="mood-fill curiosity" style="width: ${Math.round(_brain.curiosity)}%"></div>
        </div>
        <span class="mood-value">${Math.round(_brain.curiosity)}%</span>
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
          <span>${_brain.tokens.used.toLocaleString()} used</span>
          <span>${_brain.tokens.budget.toLocaleString()} budget</span>
        </div>
      </div>

      ${_brain.proactive.pendingReminders.length > 0 ? `
      <div class="reminders-section">
        <svg class="icon-sm"><use href="#icon-clock"/></svg>
        <span>${_brain.proactive.pendingReminders.length} pending reminder${_brain.proactive.pendingReminders.length !== 1 ? 's' : ''}</span>
      </div>
      ` : ''}
    </div>

    ${lastMessageSection}
  </div>`;
}

// ============================================================================
// CSS
// ============================================================================

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

    /* Receiving state - perked up, antenna alert */
    [data-state="receiving"] .lobster-svg {
      animation: receiving-perk 0.3s ease-out forwards;
    }

    [data-state="receiving"] .antennae {
      animation: antenna-alert 0.2s ease-in-out infinite;
    }

    [data-state="receiving"] .eyes {
      animation: eyes-widen 0.3s ease-out forwards;
    }

    @keyframes receiving-perk {
      0% { transform: translateY(0) scale(1); }
      100% { transform: translateY(-8px) scale(1.05); }
    }

    @keyframes antenna-alert {
      0%, 100% { transform: rotate(-8deg); }
      50% { transform: rotate(8deg); }
    }

    @keyframes eyes-widen {
      0% { transform: scale(1); }
      100% { transform: scale(1.1); }
    }

    /* Thinking state - thoughtful, claw tapping */
    [data-state="thinking"] .lobster-svg {
      animation: thinking-bob 1.5s ease-in-out infinite;
    }

    [data-state="thinking"] .claw-right {
      animation: claw-tap 0.6s ease-in-out infinite;
      transform-origin: center center;
    }

    [data-state="thinking"] .eye-pupil {
      animation: eyes-thinking 2s ease-in-out infinite;
    }

    @keyframes thinking-bob {
      0%, 100% { transform: translateY(0) rotate(-1deg); }
      50% { transform: translateY(-3px) rotate(1deg); }
    }

    @keyframes claw-tap {
      0%, 100% { transform: rotate(0deg) translateY(0); }
      50% { transform: rotate(-15deg) translateY(3px); }
    }

    @keyframes eyes-thinking {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-2px) translateY(-1px); }
      75% { transform: translateX(2px) translateY(-1px); }
    }

    /* Sending state - bounce, gesturing */
    [data-state="sending"] .lobster-svg {
      animation: sending-bounce 0.4s ease-out;
    }

    [data-state="sending"] .claw-left,
    [data-state="sending"] .claw-right {
      animation: claw-gesture 0.3s ease-in-out infinite;
    }

    [data-state="sending"] .mouth-smile {
      animation: mouth-talk 0.2s ease-in-out infinite;
    }

    @keyframes sending-bounce {
      0% { transform: translateY(0) scale(1); }
      30% { transform: translateY(-10px) scale(1.05); }
      60% { transform: translateY(-5px) scale(1.02); }
      100% { transform: translateY(0) scale(1); }
    }

    @keyframes claw-gesture {
      0%, 100% { transform: rotate(-5deg); }
      50% { transform: rotate(10deg); }
    }

    @keyframes mouth-talk {
      0%, 100% { transform: scaleY(1); }
      50% { transform: scaleY(1.3); }
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

// ============================================================================
// JavaScript
// ============================================================================

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

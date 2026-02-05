# ChadGPT

**The same lobster, smaller shell.**

A WhatsApp AI assistant designed for low-resource devices like the Alcatel 1C (1GB RAM, 8-16GB storage). Powered by Claude with a lobster personality, calendar system, long-term memory, and an animated kiosk display.

## What is this?

ChadGPT (formerly OpenClaw Lite) is a stripped-down version of [OpenClaw](https://github.com/openclaw/openclaw) that:
- Runs on very limited hardware (Termux on cheap Android phones)
- Connects to WhatsApp via Baileys
- Uses Claude (Anthropic) for intelligence
- Handles images, documents (PDF, DOCX, text), and web search
- Remembers facts about users across conversations
- Manages calendars with scheduled digests
- Supports group chats (responds when mentioned)
- Includes an animated kiosk display with real-time updates and sound effects

## Requirements

- Node.js 20+ (works with Termux on Android)
- Anthropic API key
- ~150MB RAM at runtime
- ~100MB disk space

## Quick Start

```bash
# Clone
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite

# Install dependencies
npm install

# Configure
cp .env.example .env
nano .env  # Add your ANTHROPIC_API_KEY

# Run
npm run dev

# Scan the QR code with WhatsApp > Linked Devices > Link a Device
```

## Termux (Android) - Full Setup

```bash
# 1. Install Termux from F-Droid (not Play Store)
#    https://f-droid.org/en/packages/com.termux/

# 2. Update and install Node.js
pkg update && pkg upgrade -y
pkg install nodejs-lts git -y

# 3. Clone and install
git clone https://github.com/Hollando78/openclaw-lite
cd openclaw-lite
npm install

# 4. Configure
cp .env.example .env
nano .env
# Add: ANTHROPIC_API_KEY=sk-ant-your-key-here
# Save: Ctrl+O, Enter, Ctrl+X

# 5. Run
npm run dev
```

## Run Persistently (Termux)

### Option 1: Termux:Boot (Auto-start on reboot)

```bash
# Install Termux:Boot from F-Droid
# https://f-droid.org/en/packages/com.termux.boot/

# Create boot script
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/openclaw.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd ~/openclaw-lite
npm start >> ~/openclaw.log 2>&1 &
EOF
chmod +x ~/.termux/boot/openclaw.sh

# Open Termux:Boot once to enable auto-start
# Then reboot phone to test
```

### Option 2: tmux (Stay running when Termux closes)

```bash
# Install tmux
pkg install tmux

# Start in background session
tmux new -d -s openclaw 'cd ~/openclaw-lite && npm run dev'

# View logs
tmux attach -t openclaw

# Detach: Ctrl+B, then D
```

## Configuration

Set these in your `.env` file or as environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Your Anthropic API key |
| `OPENCLAW_MODEL` | No | `claude-sonnet-4-20250514` | Claude model to use |
| `OPENCLAW_MAX_TOKENS` | No | `4096` | Max tokens per response |
| `OPENCLAW_MAX_HISTORY` | No | `50` | Messages to keep in history |
| `OPENCLAW_ALLOW_LIST` | No | *(all)* | Comma-separated phone numbers |
| `OPENCLAW_OWNER` | No | - | Owner phone number for admin |
| `OPENCLAW_WORKSPACE_DIR` | No | `~/.openclaw-lite` | Directory for SOUL.md and config |
| `OPENCLAW_STATUS_PORT` | No | `8080` | Kiosk status server port |
| `OPENCLAW_STATUS_BIND` | No | `127.0.0.1` | Bind address (`0.0.0.0` for external access) |
| `OPENCLAW_DAILY_TOKEN_BUDGET` | No | `100000` | Daily token limit for API calls |
| `OPENCLAW_LIZARD_INTERVAL` | No | `30000` | Lizard-brain loop interval (ms) |
| `OPENCLAW_TIMEZONE` | No | *(system)* | Timezone override (e.g. `America/New_York`) |
| `TAVILY_API_KEY` | No | - | Tavily API key for web search |

## Commands

Send these to the bot in WhatsApp:

### General
| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` or `/reset` | Clear conversation history |
| `/status` | Show bot status (mood, tokens, uptime, reminders) |
| `/remember` | Show stored memories about you |
| `/forget` | Clear all stored memories |

### Calendar & Events
| Command | Description |
|---------|-------------|
| `/calendar` | Show all scheduled events |
| `/event add daily HH:MM Title` | Add a daily recurring event |
| `/event add weekly Day HH:MM Title` | Add a weekly event (Sun/Mon/Tue/Wed/Thu/Fri/Sat) |
| `/event add once YYYY-MM-DD HH:MM Title` | Add a one-time event |
| `/event remove <id>` | Remove an event by ID |
| `/event tag <id>` | Tag a contact to an event (then share the contact) |
| `/event digest daily HH:MM` | Set daily digest time |
| `/event digest weekly Day HH:MM` | Set weekly digest time |
| `/skip` | Cancel pending contact tagging |

## Features

### Image Understanding
Send any image and ChadGPT will analyze it. Add a caption to ask specific questions about the image.

### Document Processing
Send documents directly in WhatsApp:
- **PDF** (up to 10MB)
- **Word** (.docx, up to 5MB) - extracted to text
- **Text files** (up to 1MB) - .txt, .csv, .json, .xml, .html, .md, .py, .js, .ts, and more

### Web Search
When ChadGPT needs current information, it automatically searches the web using Tavily. Requires `TAVILY_API_KEY` in your `.env` file.

### Long-Term Memory
ChadGPT remembers facts about you across conversations:
- Automatically extracts key facts (name, preferences, interests, etc.) every 10 messages
- Summarizes older conversations to retain context
- Use `/remember` to see what it knows and `/forget` to clear it
- Stored per-user in `~/.openclaw-lite/memory/`

### Calendar & Digests
Schedule events and get automatic reminders:
- Daily, weekly, or one-time events
- Tag WhatsApp contacts to events (share their contact card)
- **Daily digest**: Morning schedule sent to tagged users (default 07:00)
- **Weekly digest**: Week-ahead sent on Sundays (default 18:00)
- Past one-time events auto-cleanup

### Group Chat
ChadGPT works in group chats but only responds when mentioned:
- @ mention the bot
- Or say "chadgpt" or "chad" in your message

### Reminders
Set reminders with natural language:
```
"remind me in 30 minutes to check the oven"
"remind me in 2 hours to call back"
```

## Custom Personality (SOUL.md)

Customize your bot's personality by creating a `SOUL.md` file:

```bash
mkdir -p ~/.openclaw-lite
cp SOUL.example.md ~/.openclaw-lite/SOUL.md
nano ~/.openclaw-lite/SOUL.md
```

The bot reloads SOUL.md every 60 seconds, so you can edit it without restarting.

Example SOUL.md:
```markdown
## Personality
- Friendly and helpful
- Speaks like a pirate
- Loves puns

## Tone
Keep it light and fun!
```

No SOUL.md? The bot uses a default lobster-themed personality.

## Kiosk Mode

ChadGPT includes an animated status dashboard for dedicated devices.

1. Start the bot normally
2. Open `http://localhost:8080` in a browser
3. Two-page swipeable interface:
   - **Avatar page** - Animated lobster with 12 emotional states (happy, tired, stressed, curious, thinking, etc.)
   - **Status page** - Connection status, message counts, mood bars, token budget

### Real-Time Updates
The kiosk uses Server-Sent Events (SSE) for live updates - no page refresh needed. Status values, mood bars, and avatar state all update in real-time.

### Sound Effects
Web Audio API synthesized sounds (no audio files):
- Chirp on message received
- Pop on message sent
- Chord on connection
- Buzz on error

Toggle with the mute button (top-right corner). Preference persists across page loads.

### Dedicated Kiosk Setup (Android)
1. Install [Fully Kiosk Browser](https://www.fully-kiosk.com/) (free version works)
2. Set it to load `http://localhost:8080`
3. Enable kiosk mode to lock the display

## Lizard-Brain

ChadGPT includes a lightweight "instinct layer" that runs beneath the Claude API, providing fast responses and resource awareness.

### Quick Responses (Skip API)

These patterns are handled instantly without calling Claude, saving tokens:

| Pattern | Examples | Response |
|---------|----------|----------|
| Greeting | "hi", "hello", "hey" | Random friendly greeting |
| Thanks | "thanks", "thx", "ty" | Random acknowledgment |
| Time | "what time is it" | Current time |
| Date | "what day is it" | Current date |
| How are you | "how are you" | Mood-aware response |
| Repeat | "what did you say" | Last response |
| Reminder | "remind me in 30 min to call mom" | Schedules reminder |

### Mood System

The bot tracks internal "mood" states that influence behavior:

- **Energy** (0-100): Depletes with activity, recovers over time. Low energy adds "*yawn*" to responses.
- **Stress** (0-100): Increases with errors/load, decays naturally. High stress triggers a "taking a breath" pause.
- **Curiosity** (0-100): Fluctuates over time. High curiosity adds follow-up questions.

### Token Budget

The bot tracks daily token usage and adjusts behavior to conserve resources:

| Usage | Behavior |
|-------|----------|
| 0-50% | Normal operation |
| 50-75% | Reduce conversation history to 20 messages |
| 75-90% | Reduce max tokens to 1024, history to 10 |
| 90-100% | Switch to Haiku model, max 500 tokens, history 5 |
| 100%+ | Block API calls, only quick responses work |

The budget resets at midnight.

## Architecture

```
src/
  index.ts          # Core: config, sessions, memory, Claude API, commands, WhatsApp connection
  kiosk.ts          # Kiosk UI: HTTP server, SSE, avatar SVG, status page, CSS, JS, sounds
  lizard-brain.ts   # Mood system, quick responses, token budget, reminders, background loop
  calendar.ts       # Events, digests, vCard parsing, contact tagging
```

## Resource Usage

### Memory (RAM)

| Component | Idle | Active |
|-----------|------|--------|
| Node.js runtime | ~30MB | ~40MB |
| Baileys (WhatsApp) | ~40MB | ~80MB |
| Anthropic SDK | ~5MB | ~10MB |
| Session cache | ~1MB | ~5MB |
| Lizard-brain state | ~15KB | ~20KB |
| **Total** | **~80MB** | **~150MB** |

### Disk

| Item | Size |
|------|------|
| node_modules | ~100MB |
| Application code | ~120KB |
| WhatsApp auth state | ~50KB |
| Session files (per chat) | ~2-10KB each |

### API Cost

| Usage | Estimate |
|-------|----------|
| Per message (Sonnet) | ~$0.003-0.01 |
| 100 messages/day | ~$0.30-1.00/day |
| Quick responses (lizard-brain) | $0.00 |

The lizard-brain handles greetings, thanks, time/date queries, and reminders without API calls, reducing costs for casual conversations.

### Alcatel 1C Fit

| Resource | Available | Used | Headroom |
|----------|-----------|------|----------|
| RAM | 1GB | ~150MB | ~850MB for Android |
| Storage | 8-16GB | ~100MB | Plenty |

## Security

- Prompt injection mitigation: memory facts sanitized, data framing in system prompt
- XSS prevention: HTML escaping on all user-controlled kiosk values
- Message size limits: 4,000 character cap on inbound messages
- Kiosk binds to localhost by default (not exposed to network)
- Access control via phone number allowlist

## Production Build

```bash
# Build TypeScript (faster startup)
npm run build

# Run compiled version
npm start
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| QR won't scan | Delete `~/.openclaw-lite/auth` and restart |
| "Logged out" | Delete auth folder, restart, re-scan QR |
| High memory | Reduce `OPENCLAW_MAX_HISTORY` to 20 |
| API errors | Check `ANTHROPIC_API_KEY` is valid |
| Termux killed | Enable "Acquire wakelock" in Termux notification |
| No web search | Set `TAVILY_API_KEY` in `.env` |

### Useful Commands

```bash
# Check if running
pgrep -f openclaw

# View logs (if using boot script)
tail -f ~/openclaw.log

# Stop
pkill -f openclaw

# Check memory usage
ps aux | grep node
```

## Compared to Full OpenClaw

| Feature | OpenClaw | ChadGPT |
|---------|----------|---------|
| WhatsApp | Yes | Yes |
| Telegram | Yes | No |
| Discord | Yes | No |
| Other channels | Yes | No |
| Browser tools | Yes | No |
| Canvas | Yes | No |
| TTS | Yes | No |
| Skills/plugins | Yes | No |
| Gateway server | Yes | No |
| Conversation memory | Yes | Yes |
| Long-term memory | No | Yes |
| Claude intelligence | Yes | Yes |
| Custom personality | Yes | Yes |
| Image understanding | Yes | Yes |
| Document processing | No | Yes |
| Web search | Yes | Yes |
| Calendar & events | No | Yes |
| Group chat support | No | Yes |
| Kiosk mode | No | Yes |
| Lizard-brain | No | Yes |
| Token budget management | No | Yes |
| Mood system | No | Yes |
| Reminders | No | Yes |
| Sound effects | No | Yes |
| RAM usage | 500-800MB | ~150MB |
| Install size | 1.5GB+ | ~100MB |

## License

MIT - Same as OpenClaw

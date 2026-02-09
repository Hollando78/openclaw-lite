#!/usr/bin/env node
/**
 * OpenClaw Lite - Minimal WhatsApp AI Assistant
 *
 * The same lobster, smaller shell. 🦞
 *
 * Designed for low-resource devices (1GB RAM, limited storage).
 * Uses Baileys for WhatsApp and Anthropic Claude for intelligence.
 */

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import Anthropic from "@anthropic-ai/sdk";
import qrcode from "qrcode-terminal";
import * as fs from "fs";
import * as path from "path";

import { CONFIG, status, addError, getClient, setSendMessageFn, setSendFileFn, setPendingUpload, pendingUploads, type MediaContent } from "./config.js";
import { downloadImage, downloadDocument, estimateDocumentTokens, downloadAudio, transcribeAudio } from "./media.js";
import { buildSystemPrompt } from "./soul.js";
import { addToSession, compressHistoryIfNeeded, getCompressedHistory, loadSession } from "./session.js";
import { buildMemoryContext, updateMemoryIfNeeded } from "./memory.js";
import { getEnabledTools, executeToolCall } from "./tools.js";
import { isCommand, handleCommand, isAllowed } from "./commands.js";

import { initKiosk, startStatusServer } from "./kiosk.js";
import {
  lizardBrain, initLizardBrain, tryQuickResponse,
  getBudgetAwareParams, applyMoodModifiers, startLizardLoop,
} from "./lizard-brain.js";
import {
  initCalendar, pendingContactTag, setPendingContactTag, consumePendingContactTag,
  pendingContactAdd, consumePendingContactAdd, setPendingContactAdd,
  loadCalendar, saveCalendar, parseVCard, vcardToJid,
  processCalendarDigests, collectDueActionableEvents,
} from "./calendar.js";
import {
  initGDrive, isConnected, getConnectionStatus,
} from "./gdrive.js";
import {
  initGitHub, isConnected as isGitHubConnected,
  getConnectionStatus as getGitHubConnectionStatus,
} from "./github.js";
import { initLists } from "./lists.js";

// ============================================================================
// Chat (Claude API orchestration)
// ============================================================================

async function chat(chatId: string, userMessage: string, media?: MediaContent): Promise<string> {
  const client = getClient();

  // Get budget-aware parameters
  const budgetParams = getBudgetAwareParams();

  // Upgrade to smart model for complex tasks (images, documents, tool use)
  const enabledTools = getEnabledTools();
  const needsSmartModel = !!media || enabledTools.length > 0;
  if (needsSmartModel && budgetParams.model === CONFIG.model) {
    budgetParams.model = CONFIG.smartModel;
  }

  // Block API calls if budget exhausted
  if (budgetParams.shouldBlock) {
    return "🔋 I've used up my thinking budget for today. Simple greetings and quick questions I can still handle, but for complex stuff, let's chat tomorrow! (Budget resets at midnight)";
  }

  // Offline mode - no API key
  if (!CONFIG.apiKey) {
    return "🦎 I'm running in offline mode (no API key). I can handle quick stuff like greetings, time, reminders - but for real conversations, set ANTHROPIC_API_KEY!";
  }

  // Add user message to history (text representation only)
  const historyText = media?.type === "document"
    ? `[Document: ${media.fileName}] ${userMessage || ""}`
    : media?.type === "image"
      ? userMessage || "[Image]"
      : userMessage;
  addToSession(chatId, "user", historyText);

  // Compress old messages if history is too long
  await compressHistoryIfNeeded(chatId);

  // Get compressed conversation history
  const { summary: conversationSummary, messages: history } = getCompressedHistory(chatId);

  // Update idle time and curiosity
  const idleTime = Date.now() - lizardBrain.proactive.idleSince;
  if (idleTime > 5 * 60 * 1000) {
    // Been idle for 5+ minutes, curiosity increases
    lizardBrain.curiosity = Math.min(100, lizardBrain.curiosity + 10);
  }
  lizardBrain.proactive.idleSince = Date.now();

  try {
    // Build message content (text-only, with image, or with document)
    let currentContent: Anthropic.MessageParam["content"];
    if (media?.type === "image") {
      currentContent = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: media.image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: media.image.data,
          },
        },
        { type: "text", text: userMessage || "What's in this image?" },
      ];
    } else if (media?.type === "document") {
      const doc = media.document;
      const defaultPrompt = `I've shared a file: "${media.fileName}". Please review it.`;

      if (doc.kind === "pdf") {
        currentContent = [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf" as const, data: doc.data },
            title: media.fileName,
          } as Anthropic.DocumentBlockParam,
          { type: "text", text: userMessage || defaultPrompt },
        ];
      } else if (doc.kind === "text") {
        currentContent = [
          {
            type: "document",
            source: { type: "text" as const, media_type: "text/plain" as const, data: doc.data },
            title: media.fileName,
          } as Anthropic.DocumentBlockParam,
          { type: "text", text: userMessage || defaultPrompt },
        ];
      } else if (doc.kind === "image") {
        currentContent = [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: doc.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: doc.data,
            },
          },
          { type: "text", text: userMessage || "What's in this image?" },
        ];
      } else {
        currentContent = userMessage || defaultPrompt;
      }
    } else {
      currentContent = userMessage;
    }

    // Build messages: history (text only) + current message (may have image)
    const historyMessages = history.slice(0, -1); // Exclude current (already added to session)
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages,
      { role: "user", content: currentContent },
    ];

    // Build system prompt with memory context and conversation summary
    let systemPrompt = buildSystemPrompt() + buildMemoryContext(chatId);
    if (conversationSummary) {
      systemPrompt += `\n\n## Earlier in this conversation\n${conversationSummary}`;
    }

    const response = await client.messages.create({
      model: budgetParams.model,
      max_tokens: budgetParams.maxTokens,
      system: systemPrompt,
      messages,
      tools: enabledTools.length > 0 ? enabledTools : undefined,
    });

    // Track token usage
    let totalTokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    lizardBrain.tokens.used += totalTokens;
    console.log(`[api] ${budgetParams.model} | in:${response.usage?.input_tokens} out:${response.usage?.output_tokens} | history:${messages.length}msg | budget:${Math.round(lizardBrain.tokens.used / lizardBrain.tokens.budget * 100)}%`);

    // Handle tool use loop
    let finalResponse = response;
    const toolMessages: Anthropic.MessageParam[] = [...messages];
    let toolRound = 0;
    const MAX_TOOL_ROUNDS = 15;
    while (finalResponse.stop_reason === "tool_use" && toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;
      const toolUse = finalResponse.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (!toolUse) break;

      const toolResult = await executeToolCall(toolUse, chatId);

      // Accumulate tool conversation history (so Claude sees prior tool results)
      toolMessages.push(
        { role: "assistant", content: finalResponse.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }] },
      );

      // Send tool result back to Claude with full tool history
      finalResponse = await client.messages.create({
        model: budgetParams.model,
        max_tokens: budgetParams.maxTokens,
        system: systemPrompt,
        messages: toolMessages,
        tools: enabledTools.length > 0 ? enabledTools : undefined,
      });

      // Track additional tokens
      const additionalTokens = (finalResponse.usage?.input_tokens || 0) + (finalResponse.usage?.output_tokens || 0);
      totalTokens += additionalTokens;
      lizardBrain.tokens.used += additionalTokens;
      console.log(`[api] tool-round:${toolRound} | in:${finalResponse.usage?.input_tokens} out:${finalResponse.usage?.output_tokens} | budget:${Math.round(lizardBrain.tokens.used / lizardBrain.tokens.budget * 100)}%`);
    }

    // Log token usage at budget thresholds
    const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
    if (usage >= 0.9) {
      console.log(`[lizard] ⚠️ Token budget at ${Math.round(usage * 100)}% (${lizardBrain.tokens.used}/${lizardBrain.tokens.budget})`);
    }

    // Decrease energy based on response complexity
    const energyCost = Math.min(10, Math.ceil(totalTokens / 500));
    lizardBrain.energy = Math.max(0, lizardBrain.energy - energyCost);

    // Reset API error count on success
    lizardBrain.resources.apiErrors = 0;

    // Extract text response from final response
    let assistantMessage = finalResponse.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Apply mood modifiers
    assistantMessage = applyMoodModifiers(assistantMessage);

    // Store last response for "what did you say" pattern
    lizardBrain.lastResponses.set(chatId, assistantMessage);

    // Add assistant response to history
    addToSession(chatId, "assistant", assistantMessage);

    return assistantMessage;
  } catch (err: any) {
    console.error("[claude] API error:", err);
    addError(`Claude API error: ${err}`);

    // Track API errors and increase stress
    lizardBrain.resources.apiErrors++;
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 15);

    // Check for rate limit headers
    if (err.status === 429) {
      const resetAt = err.headers?.["retry-after"];
      if (resetAt) {
        lizardBrain.resources.rateLimit.resetAt = Date.now() + parseInt(resetAt, 10) * 1000;
      }
      lizardBrain.stress = Math.min(100, lizardBrain.stress + 20);
    }

    throw err;
  }
}

// ============================================================================
// WhatsApp Connection
// ============================================================================

async function startWhatsApp(): Promise<void> {
  console.log("🦞 OpenClaw Lite starting...");
  console.log(`   Model: ${CONFIG.model}`);
  console.log(`   Auth dir: ${CONFIG.authDir}`);
  console.log(`   Sessions dir: ${CONFIG.sessionsDir}`);
  console.log(`   Workspace: ${CONFIG.workspaceDir}`);

  // Check for SOUL.md
  const soulPath = path.join(CONFIG.workspaceDir, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    console.log(`   Soul: ${soulPath} ✓`);
  } else {
    console.log(`   Soul: using default personality (create ${soulPath} to customize)`);
  }

  if (!CONFIG.apiKey) {
    console.warn("⚠️  ANTHROPIC_API_KEY is not set - running in offline mode (quick responses only)");
  }

  // Ensure directories exist
  fs.mkdirSync(CONFIG.authDir, { recursive: true });
  fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });

  // Initialize calendar & lists
  initCalendar(CONFIG.workspaceDir);
  initLists(CONFIG.workspaceDir);

  // Initialize Google Drive (if configured)
  if (CONFIG.googleClientId && CONFIG.googleClientSecret) {
    initGDrive({ workspaceDir: CONFIG.workspaceDir, clientId: CONFIG.googleClientId, clientSecret: CONFIG.googleClientSecret });
    console.log(`   Google Drive: ${getConnectionStatus()}`);
  }

  // Initialize GitHub (if configured)
  if (CONFIG.githubToken && CONFIG.githubOwner) {
    initGitHub({ token: CONFIG.githubToken, owner: CONFIG.githubOwner });
    console.log(`   GitHub: ${getGitHubConnectionStatus()}`);
  }

  // Initialize lizard-brain
  initLizardBrain({
    model: CONFIG.model,
    maxTokens: CONFIG.maxTokens,
    maxHistory: CONFIG.maxHistory,
    dailyTokenBudget: CONFIG.dailyTokenBudget,
    lizardInterval: CONFIG.lizardInterval,
  });

  // Initialize and start kiosk status server
  initKiosk(
    { statusPort: CONFIG.statusPort, statusBind: CONFIG.statusBind, model: CONFIG.model },
    status,
    lizardBrain
  );
  startStatusServer();

  // Load auth state
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);

  // Create socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We'll handle QR ourselves
    browser: ["OpenClaw Lite", "Chrome", "1.0.0"],
  });

  // Handle connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Generate QR once, use for both terminal and kiosk
      status.state = "qr";
      qrcode.generate(qr, { small: true }, (qrText: string) => {
        status.qrCode = qrText;
        console.log("\n📱 Scan this QR code with WhatsApp:\n");
        console.log(qrText);
        console.log("\n");
      });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      status.state = "disconnected";
      addError(`Connection closed: ${statusCode}`);

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        console.log("Logged out. Please delete auth folder and restart to re-link.");
      }
    } else if (connection === "open") {
      console.log("🦞 Connected to WhatsApp!");
      console.log("   Ready to receive messages.\n");
      status.state = "connected";
      status.qrCode = null;

      // Try to get phone number
      const user = sock.user;
      if (user?.id) {
        status.phoneNumber = user.id.split(":")[0] || user.id.split("@")[0] || null;
      }

      // Start lizard-brain background loop
      const sendMessageFn: (chatId: string, text: string) => Promise<void> = async (chatId, text) => {
        await sock.sendMessage(chatId, { text });
        status.messagesSent++;
        // Record bot-initiated messages (digests, reminders, etc.) in session
        // so Claude has context if the user replies to them
        addToSession(chatId, "assistant", text);
      };
      setSendMessageFn(sendMessageFn);

      setSendFileFn(async (chatId, buffer, fileName, mimeType, caption) => {
        if (mimeType.startsWith("image/")) {
          await sock.sendMessage(chatId, { image: buffer, caption });
        } else {
          await sock.sendMessage(chatId, { document: buffer, fileName, mimetype: mimeType, caption });
        }
        status.messagesSent++;
      });

      startLizardLoop(
        sendMessageFn,
        async () => {
          await processCalendarDigests(sendMessageFn);

          // Process actionable reminders (e.g. "/remind daily 20:00 Write journal entry")
          const dueActions = collectDueActionableEvents();
          for (const evt of dueActions) {
            const ownerJid = CONFIG.ownerNumber ? `${CONFIG.ownerNumber.replace(/[^0-9]/g, "")}@s.whatsapp.net` : null;
            const targetChat = ownerJid || evt.chatId;
            try {
              console.log(`[remind] Actionable reminder firing: "${evt.title}" → chat ${targetChat}`);
              const response = await chat(targetChat, evt.title);
              await sendMessageFn(targetChat, response);
            } catch (err) {
              console.error(`[remind] Failed to process actionable reminder "${evt.title}":`, err);
              // Fall back to a simple notification
              try {
                await sendMessageFn(targetChat, `⏰ *Reminder*: ${evt.title}`);
              } catch {}
            }
          }
        },
        () => {
          for (const [chatId, state] of pendingContactTag.entries()) {
            if (Date.now() > state.expiresAt) {
              pendingContactTag.delete(chatId);
            }
          }
          for (const [chatId, state] of pendingContactAdd.entries()) {
            if (Date.now() > state.expiresAt) {
              pendingContactAdd.delete(chatId);
            }
          }
          for (const [chatId, state] of pendingUploads.entries()) {
            if (Date.now() > state.expiresAt) {
              pendingUploads.delete(chatId);
            }
          }
        },
      );
    }
  });

  // Save credentials when updated
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip if not a regular message
      if (!msg.message) continue;

      // Skip messages from self
      if (msg.key.fromMe) continue;

      // Get chat ID and sender
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Get sender (for groups, this is the participant)
      const senderId = msg.key.participant || chatId;

      // Check access
      if (!isAllowed(senderId)) {
        console.log(`[blocked] Message from ${senderId} (not in allowlist)`);
        continue;
      }

      // Group chat handling: only respond when mentioned
      const isGroup = chatId.endsWith("@g.us");
      if (isGroup) {
        const botJid = sock.user?.id;
        // Normalize bot JID: strip the device suffix (e.g. "123:45@s.whatsapp.net" -> "123")
        const botNumber = botJid?.split(":")[0]?.split("@")[0] || "";
        const mentionedJids: string[] =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isMentioned = mentionedJids.some(jid => jid.split("@")[0] === botNumber);

        // Also check if the message text contains the bot name
        const msgText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";
        const nameMatch = /openclaw|chadgpt|chad/i.test(msgText);

        if (!isMentioned && !nameMatch) {
          continue; // Ignore group messages where bot is not mentioned
        }
        console.log(`[group] Bot mentioned in ${chatId} by ${senderId}`);
      }

      // Handle contact messages (for event tagging)
      const contactMsg = msg.message?.contactMessage;
      const contactsArrayMsg = msg.message?.contactsArrayMessage;

      if (contactMsg || contactsArrayMsg) {
        const eventId = consumePendingContactTag(chatId);
        const isContactAdd = !eventId && consumePendingContactAdd(chatId);

        if (!eventId && !isContactAdd) continue; // No pending state, ignore contact

        const contacts: Array<{ vcard: string; displayName: string }> = [];
        if (contactMsg?.vcard) {
          contacts.push({ vcard: contactMsg.vcard, displayName: contactMsg.displayName || "Unknown" });
        }
        if (contactsArrayMsg?.contacts) {
          for (const c of contactsArrayMsg.contacts) {
            if (c.vcard) {
              contacts.push({ vcard: c.vcard, displayName: c.displayName || "Unknown" });
            }
          }
        }

        if (eventId) {
          // Event tagging flow (existing behavior)
          const cal = loadCalendar();
          const evt = cal.events.find(e => e.id === eventId);
          if (!evt) {
            await sock.sendMessage(chatId, { text: `Event ${eventId} no longer exists.` });
            continue;
          }

          const taggedNames: string[] = [];
          for (const contact of contacts) {
            const parsed = parseVCard(contact.vcard);
            if (!parsed) {
              await sock.sendMessage(chatId, { text: `Could not parse phone number for ${contact.displayName}. Skipping.` });
              continue;
            }
            const jid = vcardToJid(parsed.phoneNumber);
            if (!evt.taggedUsers.some(u => u.jid === jid)) {
              evt.taggedUsers.push({ jid, name: parsed.name });
              taggedNames.push(parsed.name);
            }
          }

          saveCalendar(cal);

          if (taggedNames.length > 0) {
            await sock.sendMessage(chatId, {
              text: `👤 Tagged ${taggedNames.join(", ")} to "${evt.title}"!\n\nSend another contact to tag more, or /skip to finish.`,
            });
            setPendingContactTag(chatId, eventId);
          } else {
            await sock.sendMessage(chatId, { text: "No valid contacts were tagged." });
          }
        } else {
          // Contact add flow
          const cal = loadCalendar();
          const addedNames: string[] = [];

          for (const contact of contacts) {
            const parsed = parseVCard(contact.vcard);
            if (!parsed) {
              await sock.sendMessage(chatId, { text: `Could not parse phone number for ${contact.displayName}. Skipping.` });
              continue;
            }
            const jid = vcardToJid(parsed.phoneNumber);
            if (!cal.contacts.some(c => c.jid === jid)) {
              cal.contacts.push({ jid, name: parsed.name });
              addedNames.push(parsed.name);
            } else {
              await sock.sendMessage(chatId, { text: `${parsed.name} is already in contacts.` });
            }
          }

          saveCalendar(cal);

          if (addedNames.length > 0) {
            await sock.sendMessage(chatId, {
              text: `📇 Added ${addedNames.join(", ")} to contacts!\n\nSend another contact to add more, or /skip to finish.`,
            });
            setPendingContactAdd(chatId);
          } else {
            await sock.sendMessage(chatId, { text: "No new contacts were added." });
          }
        }
        continue;
      }

      // Extract text, image, document, and audio content
      const imageMessage = msg.message?.imageMessage;
      const docMessage =
        msg.message?.documentMessage ||
        (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage;
      const audioMessage = msg.message?.audioMessage;

      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        imageMessage?.caption ||
        docMessage?.caption ||
        (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      // Limit message size to prevent abuse / accidental huge pastes
      const MAX_MESSAGE_LENGTH = 4000;
      if (text.length > MAX_MESSAGE_LENGTH) {
        text = text.slice(0, MAX_MESSAGE_LENGTH) + "... (truncated)";
      }

      // In groups, strip @mention tags so Claude sees clean text
      if (isGroup && text) {
        text = text.replace(/@\d+/g, "").trim();
      }

      const hasImage = !!imageMessage;
      const hasDocument = !!docMessage;
      const hasAudio = !!audioMessage;

      // Skip if no text AND no media
      if (!text && !hasImage && !hasDocument && !hasAudio) continue;

      status.messagesReceived++;
      const mediaLabel = hasAudio
        ? `[Voice${audioMessage?.seconds ? ` ${audioMessage.seconds}s` : ""}]`
        : hasDocument
        ? `[Doc: ${docMessage?.fileName || "file"}]`
        : hasImage ? "[Image]" : "";
      status.lastMessage = {
        from: senderId.replace(/@.*$/, ""),
        preview: mediaLabel
          ? mediaLabel + " " + text.slice(0, 40)
          : text.slice(0, 50) + (text.length > 50 ? "..." : ""),
        time: Date.now(),
      };

      // Set receiving activity state
      status.activity = "receiving";
      status.activityUntil = Date.now() + 2000;

      console.log(`[message] ${senderId}: ${mediaLabel}${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);

      try {
        let response: string;
        let skippedApi = false;

        // Download image if present
        let mediaContent: MediaContent | undefined;
        if (hasImage) {
          console.log(`[image] Downloading image from ${senderId}`);
          const downloaded = await downloadImage(msg);
          if (downloaded) {
            mediaContent = { type: "image", image: downloaded };
            console.log(`[image] Downloaded ${(downloaded.data.length / 1024).toFixed(1)}KB`);
            // Store raw buffer for potential save-to-drive
            const imgMime = msg.message?.imageMessage?.mimetype || "image/jpeg";
            const imgExt = imgMime.includes("png") ? ".png" : imgMime.includes("webp") ? ".webp" : ".jpg";
            setPendingUpload(chatId, Buffer.from(downloaded.data, "base64"), `image${imgExt}`, imgMime);
          } else {
            await sock.sendMessage(chatId, { text: "🦞 Sorry, I couldn't process that image." });
            continue;
          }
        }

        // Download document if present
        if (hasDocument) {
          console.log(`[doc] Downloading "${docMessage?.fileName}" from ${senderId}`);
          // Store raw buffer for potential save-to-drive (before processing)
          try {
            const rawBuffer = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
            const docMime = docMessage?.mimetype || "application/octet-stream";
            const docName = docMessage?.fileName || "document";
            setPendingUpload(chatId, rawBuffer, docName, docMime);
          } catch { /* ignore - save-to-drive just won't work for this message */ }

          const result = await downloadDocument(msg);
          if (typeof result === "string") {
            // Document couldn't be processed for Claude analysis, but the raw buffer
            // may still be available for save_to_drive. Let text flow through to Claude
            // instead of hard-stopping, so tools can still work.
            if (!text) text = `[Document: ${docMessage?.fileName || "file"}] ${result}`;
            // Don't set mediaContent — Claude won't see doc content, but tools still work
          } else {
            mediaContent = { type: "document", document: result.content, fileName: result.fileName };
            console.log(`[doc] Processed ${result.fileName} (${result.content.kind})`);

            // Token budget pre-check for large documents
            // Don't block the message — just skip sending doc content to Claude
            // so save_to_drive and other tools can still work
            const estimatedTokens = estimateDocumentTokens(result.content);
            const projectedUsage = (lizardBrain.tokens.used + estimatedTokens) / lizardBrain.tokens.budget;
            if (projectedUsage > 0.9) {
              mediaContent = undefined; // drop the heavy content, keep the text flowing
              if (!text) text = `[Document: ${result.fileName}] (too large to analyze — budget low)`;
            }
          }
        }

        // Transcribe voice note if present
        if (hasAudio) {
          if (!CONFIG.openaiApiKey) {
            await sock.sendMessage(chatId, { text: "🦞 Voice notes require an OpenAI API key for transcription. Set OPENAI_API_KEY in .env" });
            continue;
          }
          console.log(`[voice] Downloading voice note from ${senderId} (${audioMessage?.seconds || "?"}s)`);
          const audioResult = await downloadAudio(msg);
          if (typeof audioResult === "string") {
            await sock.sendMessage(chatId, { text: `🦞 ${audioResult}` });
            continue;
          }
          console.log(`[voice] Transcribing ${(audioResult.buffer.length / 1024).toFixed(1)}KB audio...`);
          try {
            const transcription = await transcribeAudio(audioResult.buffer, audioResult.mimeType);
            if (!transcription || transcription.trim().length === 0) {
              await sock.sendMessage(chatId, { text: "🦞 I couldn't make out any words in that voice note." });
              continue;
            }
            console.log(`[voice] Transcribed: "${transcription.slice(0, 80)}${transcription.length > 80 ? "..." : ""}"`);
            // Prefix so Claude knows this was spoken, not typed
            text = `[Voice note]: ${transcription}`;
            // Rough token budget tracking for Whisper usage
            lizardBrain.tokens.used += 100;
          } catch (err) {
            console.error("[voice] Transcription failed:", err);
            await sock.sendMessage(chatId, { text: "🦞 Sorry, I couldn't transcribe that voice note." });
            continue;
          }
        }

        // Check for commands (skip media messages for commands)
        if (isCommand(text) && !mediaContent) {
          const cmdResponse = handleCommand(chatId, senderId, text);
          if (cmdResponse) {
            response = cmdResponse;
            skippedApi = true;
          } else {
            status.activity = "thinking";
            status.activityUntil = Date.now() + 30000;
            response = await chat(chatId, text);
          }
        } else if (!mediaContent) {
          // Check lizard-brain quick patterns first (text only, no media)
          const quickResponse = tryQuickResponse(chatId, text);
          if (quickResponse) {
            response = quickResponse;
            skippedApi = true;
            console.log(`[lizard] Quick response (skipped API)`);
          } else {
            status.activity = "thinking";
            status.activityUntil = Date.now() + 30000;
            response = await chat(chatId, text);
          }
        } else {
          // Media message - always use Claude API
          status.activity = "thinking";
          status.activityUntil = Date.now() + 30000;
          response = await chat(chatId, text, mediaContent);
        }

        // Store response for "what did you say" pattern (even for quick responses)
        lizardBrain.lastResponses.set(chatId, response);

        // Set sending activity state
        status.activity = "sending";
        status.activityUntil = Date.now() + 2000;

        // Send response
        await sock.sendMessage(chatId, { text: response });
        status.messagesSent++;
        console.log(`[reply] Sent ${response.length} chars${skippedApi ? " (no API)" : ""}`);

        // Record command/quick responses in session so Claude has context for follow-ups
        if (skippedApi) {
          addToSession(chatId, "user", text);
          addToSession(chatId, "assistant", response);
        }

        // Update long-term memory in background (only after API calls)
        if (!skippedApi) {
          updateMemoryIfNeeded(chatId).catch(err => {
            console.error("[memory] Background update failed:", err);
          });
        }
      } catch (err) {
        console.error("[error] Failed to process message:", err);
        addError(`Message processing error: ${err}`);

        // Increase stress on errors
        lizardBrain.stress = Math.min(100, lizardBrain.stress + 10);

        // Send error message
        await sock.sendMessage(chatId, {
          text: "🦞 Sorry, I encountered an error. Please try again.",
        });
      }
    }
  });
}

// ============================================================================
// Main
// ============================================================================

startWhatsApp().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

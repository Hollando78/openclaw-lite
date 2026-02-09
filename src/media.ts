import { downloadMediaMessage, type WAMessage } from "@whiskeysockets/baileys";
import mammoth from "mammoth";
import * as path from "path";
import { CONFIG, type ImageContent, type DocumentContent } from "./config.js";

// ============================================================================
// Image Processing
// ============================================================================

export async function downloadImage(msg: WAMessage): Promise<ImageContent | null> {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const mimeType = msg.message?.imageMessage?.mimetype || "image/jpeg";
    const base64 = (buffer as Buffer).toString("base64");
    return { data: base64, mimeType };
  } catch (err) {
    console.error("[image] Failed to download:", err);
    return null;
  }
}

// ============================================================================
// Document Processing
// ============================================================================

const DOC_SIZE_LIMITS: Record<string, number> = {
  pdf: 10 * 1024 * 1024,
  text: 1 * 1024 * 1024,
  docx: 5 * 1024 * 1024,
  image: 5 * 1024 * 1024,
};

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html", "text/xml",
  "application/json", "application/xml", "text/javascript", "application/javascript",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function downloadDocument(
  msg: WAMessage
): Promise<{ content: DocumentContent; fileName: string } | string> {
  const docMsg =
    msg.message?.documentMessage ||
    (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage;

  if (!docMsg) return "Could not read document message.";

  const mimeType = docMsg.mimetype || "application/octet-stream";
  const fileName = docMsg.fileName || "unknown";
  const fileSize = Number(docMsg.fileLength || 0);

  // Images sent as document attachments
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (fileSize > DOC_SIZE_LIMITS.image) {
      return `That image is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.image / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "image", data: (buffer as Buffer).toString("base64"), mimeType }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download image document:", err);
      return "Failed to download the image.";
    }
  }

  // PDF files
  if (mimeType === "application/pdf") {
    if (fileSize > DOC_SIZE_LIMITS.pdf) {
      return `That PDF is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.pdf / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "pdf", data: (buffer as Buffer).toString("base64") }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download PDF:", err);
      return "Failed to download the PDF.";
    }
  }

  // Text-based files
  if (TEXT_MIME_TYPES.has(mimeType) || fileName.match(/\.(txt|csv|json|xml|html|md|log|yml|yaml|toml|ini|cfg|conf|sh|py|js|ts)$/i)) {
    if (fileSize > DOC_SIZE_LIMITS.text) {
      return `That file is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max for text files is ${DOC_SIZE_LIMITS.text / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "text", data: (buffer as Buffer).toString("utf-8") }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download text file:", err);
      return "Failed to download the text file.";
    }
  }

  // Word documents (.docx)
  if (mimeType === DOCX_MIME_TYPE || fileName.match(/\.docx$/i)) {
    if (fileSize > DOC_SIZE_LIMITS.docx) {
      return `That Word document is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.docx / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      const result = await mammoth.extractRawText({ buffer: buffer as Buffer });
      if (!result.value || result.value.trim().length === 0) {
        return "That Word document appears to be empty or contains only images/charts (no extractable text).";
      }
      return { content: { kind: "text", data: result.value }, fileName };
    } catch (err) {
      console.error("[doc] Failed to process DOCX:", err);
      return "Failed to read the Word document. It might be corrupted or password-protected.";
    }
  }

  // Unsupported format
  const ext = path.extname(fileName).toLowerCase();
  return `I can't process ${ext || mimeType} files yet. I support: PDF, text files (.txt, .csv, .json, .xml, .html, .md), and Word (.docx).`;
}

export function estimateDocumentTokens(doc: DocumentContent): number {
  switch (doc.kind) {
    case "pdf": return Math.ceil(doc.data.length / 4);
    case "text": return Math.ceil(doc.data.length * 0.25);
    case "image": return 1600;
  }
}

// ============================================================================
// Audio / Voice Note Processing
// ============================================================================

const AUDIO_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB (Whisper API limit)

export type AudioContent = { buffer: Buffer; mimeType: string; seconds: number };

export async function downloadAudio(msg: WAMessage): Promise<AudioContent | string> {
  const audioMsg = msg.message?.audioMessage;
  if (!audioMsg) return "Could not read audio message.";

  const fileSize = Number(audioMsg.fileLength || 0);
  if (fileSize > AUDIO_SIZE_LIMIT) {
    return `That voice note is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is 25MB.`;
  }

  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const mimeType = audioMsg.mimetype || "audio/ogg";
    const seconds = Number(audioMsg.seconds || 0);
    return { buffer: buffer as Buffer, mimeType, seconds };
  } catch (err) {
    console.error("[audio] Failed to download:", err);
    return "Failed to download the voice note.";
  }
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  if (!CONFIG.openaiApiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  // Determine file extension from mime type
  const ext = mimeType.includes("ogg") ? "ogg"
    : mimeType.includes("mp4") ? "m4a"
    : mimeType.includes("mpeg") ? "mp3"
    : mimeType.includes("webm") ? "webm"
    : mimeType.includes("wav") ? "wav"
    : "ogg";

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CONFIG.openaiApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as { text: string };
  return data.text;
}

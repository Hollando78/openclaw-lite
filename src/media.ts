import { downloadMediaMessage, type WAMessage } from "@whiskeysockets/baileys";
import mammoth from "mammoth";
import * as path from "path";
import type { ImageContent, DocumentContent } from "./config.js";

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

import { z } from "zod";
import { prisma } from "@/lib/db";
import { geminiAnalyzeMedia, geminiGenerateText, isGeminiConfigured } from "@/lib/ai/gemini";
import { guardAiPrompt } from "@/lib/ai-usage-limit";

const draftItemSchema = z.object({
  productNameGuess: z.string().trim().min(1),
  quantity: z.coerce.number().finite(),
  unit: z.string().trim().optional().nullable(),
  unitCost: z.coerce.number().finite().optional().nullable(),
  batchNumber: z.string().trim().optional().nullable(),
  expiryDate: z.string().trim().optional().nullable(),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});

export const invoiceExtractionSchema = z.object({
  supplierNameGuess: z.string().trim().optional().nullable(),
  invoiceNumber: z.string().trim().optional().nullable(),
  items: z.array(draftItemSchema).min(1),
  confidenceOverall: z.coerce.number().min(0).max(1).default(0.5),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

export const inventoryReplySchema = z.object({
  transcript: z.string().trim().default(""),
  intent: z.enum(["add_stock", "answer_question", "confirm", "cancel", "other"]),
  productNameGuess: z.string().trim().optional().nullable(),
  quantity: z.coerce.number().finite().optional().nullable(),
  unitCost: z.coerce.number().finite().optional().nullable(),
  sellingPrice: z.coerce.number().finite().optional().nullable(),
  expiryDate: z.string().trim().optional().nullable(),
  batchNumber: z.string().trim().optional().nullable(),
  supplierNameGuess: z.string().trim().optional().nullable(),
});

export type InventoryReplyResult = z.infer<typeof inventoryReplySchema>;

export interface ExtractionResult<T> {
  ok: boolean;
  data: T | null;
  /** Set when guardAiPrompt blocked the call (usage limit) — surface to the user as-is. */
  limitMessage?: string;
  /** Set when Gemini responded but the JSON didn't parse/validate — ask user to resend. */
  parseError?: boolean;
}

async function guardBusinessAiUsage(businessId: string): Promise<string | null> {
  const subscription = await prisma.subscription.findUnique({ where: { businessId } });
  const check = await guardAiPrompt({ businessId, subscription });
  return check.allowed ? null : (check.message ?? "AI limit reached.");
}

function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const INVOICE_SYSTEM_PROMPT = `You are the vision engine for Zaplex, an inventory assistant used by Nigerian SME owners (pharmacies, wholesalers, retailers).

You will be shown a photo of a supplier invoice, delivery note, or handwritten purchase list. Extract every product line item you can read.

Nigerian pharmacy invoices are often handwritten with abbreviations (e.g. "PCM" or "Para" = Paracetamol, "Augmentin" = Amoxicillin-Clavulanate, "Amox" = Amoxicillin). Use domain knowledge to expand obvious abbreviations, but keep your best-guess literal product name if unsure.

Rules:
- Never invent a value you cannot read. If a field is illegible or absent, omit it — do not guess a number.
- Give each item a "confidence" from 0 to 1 reflecting how sure you are of the product name AND quantity together. Blurry handwriting, folded paper, or ambiguous abbreviations should lower confidence.
- If a line says "buy 10 get 1 free" or similar bonus wording, add the bonus units to quantity and note it isn't a separate line.
- Respond with ONLY a JSON object, no prose, matching exactly:
{
  "supplierNameGuess": string | null,
  "invoiceNumber": string | null,
  "items": [
    { "productNameGuess": string, "quantity": number, "unit": string | null, "unitCost": number | null, "batchNumber": string | null, "expiryDate": string | null, "confidence": number }
  ],
  "confidenceOverall": number
}`;

export async function extractInvoiceFromImage(
  businessId: string,
  mediaBase64: string,
  mimeType: string
): Promise<ExtractionResult<InvoiceExtraction>> {
  const limitMessage = await guardBusinessAiUsage(businessId);
  if (limitMessage) return { ok: false, data: null, limitMessage };

  if (!isGeminiConfigured()) {
    console.error("[extractInvoice] Gemini not configured");
    return { ok: false, data: null, limitMessage: "AI is not configured. Please add GEMINI_API_KEY." };
  }

  const raw = await geminiAnalyzeMedia({
    systemPrompt: INVOICE_SYSTEM_PROMPT,
    prompt: "Extract the invoice line items as JSON per the schema in your instructions.",
    mediaBase64,
    mimeType,
  });
  if (!raw) {
    console.error("[extractInvoice] Gemini returned null — API call failed");
    return { ok: false, data: null };
  }

  const json = extractJsonObject(raw);
  if (!json) {
    console.error("[extractInvoice] Could not parse JSON from Gemini response:", raw.slice(0, 300));
    return { ok: false, data: null, parseError: true };
  }

  const parsed = invoiceExtractionSchema.safeParse(json);
  if (!parsed.success) {
    console.error("[extractInvoice] Zod validation failed:", parsed.error.issues);
    return { ok: false, data: null, parseError: true };
  }

  return { ok: true, data: parsed.data };
}

const REPLY_JSON_SHAPE = `{ "transcript": string, "intent": "add_stock"|"answer_question"|"confirm"|"cancel"|"other", "productNameGuess": string | null, "quantity": number | null, "unitCost": number | null, "sellingPrice": number | null, "expiryDate": string | null, "batchNumber": string | null, "supplierNameGuess": string | null }`;

const VOICE_SYSTEM_PROMPT = `You are the voice engine for Zaplex, an inventory assistant used by Nigerian SME owners.

You will hear a short voice note from a shop owner or manager. They may speak English, Nigerian Pidgin, Yoruba, Igbo, Hausa, or a mix — transcribe and infer intent regardless of language, and regardless of background market/shop noise.

Common things they say:
- "We bought/got/received <quantity> <unit> of <product>" -> intent add_stock
- "Add another <quantity>" / "same again" -> intent add_stock, product name may be omitted (caller already knows the context)
- "Yes" / "confirm" / "correct" / "that's right" -> intent confirm
- "No" / "cancel" / "wrong" -> intent cancel
- A question about stock/price -> intent answer_question
- Anything else -> intent other

Respond with ONLY a JSON object, no prose, matching exactly:
${REPLY_JSON_SHAPE}`;

export async function parseVoiceInventoryCommand(
  businessId: string,
  mediaBase64: string,
  mimeType: string,
  draftContext?: string
): Promise<ExtractionResult<InventoryReplyResult>> {
  const limitMessage = await guardBusinessAiUsage(businessId);
  if (limitMessage) return { ok: false, data: null, limitMessage };

  if (!isGeminiConfigured()) {
    console.error("[parseVoice] Gemini not configured");
    return { ok: false, data: null, limitMessage: "AI is not configured. Please add GEMINI_API_KEY." };
  }

  const prompt = draftContext
    ? `Current draft context (what we already know, may be incomplete): ${draftContext}\n\nTranscribe the voice note and extract the JSON per the schema in your instructions.`
    : "Transcribe the voice note and extract the JSON per the schema in your instructions.";

  const raw = await geminiAnalyzeMedia({
    systemPrompt: VOICE_SYSTEM_PROMPT,
    prompt,
    mediaBase64,
    mimeType,
  });
  if (!raw) {
    console.error("[parseVoice] Gemini returned null — API call failed");
    return { ok: false, data: null };
  }

  const json = extractJsonObject(raw);
  if (!json) {
    console.error("[parseVoice] Could not parse JSON from response:", raw.slice(0, 300));
    return { ok: false, data: null, parseError: true };
  }

  const parsed = inventoryReplySchema.safeParse(json);
  if (!parsed.success) {
    console.error("[parseVoice] Zod validation failed:", parsed.error.issues);
    return { ok: false, data: null, parseError: true };
  }

  return { ok: true, data: parsed.data };
}

const TEXT_SYSTEM_PROMPT = `You are the text engine for Zaplex, an inventory assistant used by Nigerian SME owners.

You will read a short WhatsApp text message from a shop owner or manager, either starting a new inventory update or replying to a follow-up question about one. They may write in English, Nigerian Pidgin, or mix in Yoruba/Igbo/Hausa words.

Common things they say:
- "I got/bought/received <quantity> <unit> of <product>" -> intent add_stock
- "Add another <quantity>" / "same again" -> intent add_stock, product name may be omitted
- A reply giving a price ("150 each", "₦150") -> intent add_stock, fill unitCost or sellingPrice from context
- An expiry date or batch number reply -> intent add_stock, fill expiryDate/batchNumber
- "yes" / "confirm" / "correct" -> intent confirm
- "no" / "cancel" / "stop" -> intent cancel
- Anything else -> intent other

Respond with ONLY a JSON object, no prose, matching exactly:
${REPLY_JSON_SHAPE}`;

export async function parseTextInventoryCommand(
  businessId: string,
  text: string,
  draftContext?: string
): Promise<ExtractionResult<InventoryReplyResult>> {
  const limitMessage = await guardBusinessAiUsage(businessId);
  if (limitMessage) return { ok: false, data: null, limitMessage };

  if (!isGeminiConfigured()) return { ok: false, data: null };

  const userText = draftContext
    ? `Current draft context (what we already know, may be incomplete): ${draftContext}\n\nMessage: ${text}`
    : text;

  const raw = await geminiGenerateText({
    systemPrompt: TEXT_SYSTEM_PROMPT,
    contents: [{ role: "user", parts: [{ text: userText }] }],
    temperature: 0.2,
  });
  if (!raw) return { ok: false, data: null };

  const json = extractJsonObject(raw);
  if (!json) return { ok: false, data: null, parseError: true };

  const parsed = inventoryReplySchema.safeParse(json);
  if (!parsed.success) return { ok: false, data: null, parseError: true };

  return { ok: true, data: parsed.data };
}

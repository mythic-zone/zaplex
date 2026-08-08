import { prisma } from "@/lib/db";
import { Prisma, type Role } from "@prisma/client";
import {
  extractInvoiceFromImage,
  parseTextInventoryCommand,
  parseVoiceInventoryCommand,
  type InventoryReplyResult,
  type InvoiceExtraction,
} from "@/lib/ai/whatsapp-inventory/extraction";
import { matchProduct, matchSupplier, similarityScore, AUTO_MATCH_THRESHOLD } from "@/lib/ai/whatsapp-inventory/matching";
import { findHardIssues, findMissingFields, findPriceDeviations } from "@/lib/ai/whatsapp-inventory/validation";
import { commitInventoryDraft } from "@/lib/ai/whatsapp-inventory/commit";
import type { DraftItem, DraftState, MissingField, MissingFieldReason } from "@/lib/ai/whatsapp-inventory/types";

const DRAFT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ManagerInventoryInput {
  businessId: string;
  role: Role;
  userId?: string;
  employeeId?: string;
  phone: string;
  body: string;
  media?: { buffer: Buffer; contentType: string; storageUrl?: string | null };
  messageSid?: string;
}

function isImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}
function isAudio(contentType: string): boolean {
  return contentType.startsWith("audio/");
}

function toDraftState(row: { extractedItems: unknown; supplierGuess: unknown; }): DraftState {
  return {
    items: (row.extractedItems as DraftItem[]) ?? [],
    supplier: (row.supplierGuess as DraftState["supplier"]) ?? null,
  };
}

function summarizeDraftForPrompt(draft: DraftState, missing: MissingField[]): string {
  const items = draft.items
    .map((item, i) => `${i}: ${item.productNameGuess} x${item.quantity}${item.unitCost ? ` @₦${item.unitCost}` : ""}`)
    .join("; ");
  const missingText = missing.map((m) => `item ${m.itemIndex} needs ${m.reason}`).join("; ") || "nothing";
  return `Items so far: [${items}]. Still missing: ${missingText}.`;
}

const REASON_QUESTION: Record<MissingFieldReason, (name: string) => string> = {
  ambiguous_product: (name) =>
    `I couldn't confidently match "${name}" to a product in your inventory. Reply with the correct product name, or say NEW to add it as a new product.`,
  missing_unit_cost: (name) => `What did you pay per unit for *${name}*?`,
  missing_selling_price: (name) => `What should I set the selling price for *${name}* at?`,
  missing_expiry: (name) => `What's the expiry date for *${name}*?`,
  ambiguous_supplier: (name) => `Which supplier is this — "${name}" — an existing one, or should I add them as new?`,
  missing_quantity: (name) => `How many units of *${name}* came in?`,
};

function formatMissingFieldsMessage(missing: MissingField[]): string {
  const lines = missing.map((m) => REASON_QUESTION[m.reason](m.productNameGuess));
  return lines.join("\n");
}

function formatConfirmationSummary(draft: DraftState, priceWarnings: string[]): string {
  const lines = draft.items.map((item) => {
    const parts = [`• ${item.productNameGuess} x${item.quantity}`];
    if (item.unitCost != null) parts.push(`@₦${item.unitCost}`);
    if (item.expiryDate) parts.push(`exp ${item.expiryDate}`);
    return parts.join(" ");
  });
  const supplierLine = draft.supplier?.nameGuess
    ? `\nSupplier: ${draft.supplier.nameGuess}${draft.supplier.isNew ? " (new)" : ""}`
    : "";
  const warnings = priceWarnings.length ? `\n\n⚠️ ${priceWarnings.join("\n⚠️ ")}` : "";
  return `Here's what I'll add:\n${lines.join("\n")}${supplierLine}${warnings}\n\nReply *YES* to confirm, or tell me what to change.`;
}

async function resolveItemMatches(businessId: string, items: DraftItem[]): Promise<DraftItem[]> {
  const resolved: DraftItem[] = [];
  for (const item of items) {
    if (item.productId || item.isNewProduct) {
      resolved.push(item);
      continue;
    }
    const candidates = await matchProduct(businessId, item.productNameGuess);
    const top = candidates[0];
    if (top && top.score >= AUTO_MATCH_THRESHOLD) {
      resolved.push({ ...item, productId: top.item.id, isNewProduct: false });
    } else {
      resolved.push(item);
    }
  }
  return resolved;
}

async function resolveSupplierMatch(businessId: string, nameGuess?: string | null): Promise<DraftState["supplier"]> {
  if (!nameGuess?.trim()) return null;
  const candidates = await matchSupplier(businessId, nameGuess);
  const top = candidates[0];
  if (top && top.score >= AUTO_MATCH_THRESHOLD) {
    return { nameGuess, supplierId: top.item.id, isNew: false };
  }
  return { nameGuess, supplierId: null, isNew: true };
}

function findItemIndexForReply(
  draft: DraftState,
  missing: MissingField[],
  reason: MissingFieldReason,
  replyProductNameGuess?: string | null
): number | null {
  const candidates = missing.filter((m) => m.reason === reason).map((m) => m.itemIndex);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (replyProductNameGuess) {
    let best = -1;
    let bestScore = 0;
    for (const idx of candidates) {
      const score = similarityScore(draft.items[idx].productNameGuess, replyProductNameGuess);
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    if (bestScore > 0.4) return best;
  }
  return null;
}

async function applyReplyToDraft(
  businessId: string,
  draft: DraftState,
  missing: MissingField[],
  reply: InventoryReplyResult
): Promise<DraftState> {
  const items = draft.items.map((item) => ({ ...item }));

  const productIdx = findItemIndexForReply(draft, missing, "ambiguous_product", reply.productNameGuess);
  if (productIdx !== null) {
    const rawIsNew = /^(new|create new|it'?s new|make it new)$/i.test(reply.transcript.trim() || reply.productNameGuess || "");
    if (rawIsNew) {
      items[productIdx].isNewProduct = true;
    } else if (reply.productNameGuess) {
      const rematch = await matchProduct(businessId, reply.productNameGuess);
      const top = rematch[0];
      if (top && top.score >= AUTO_MATCH_THRESHOLD) {
        items[productIdx].productId = top.item.id;
        items[productIdx].isNewProduct = false;
      } else {
        items[productIdx].productNameGuess = reply.productNameGuess;
      }
    }
  }

  const costIdx = findItemIndexForReply(draft, missing, "missing_unit_cost", reply.productNameGuess);
  if (costIdx !== null && reply.unitCost != null) items[costIdx].unitCost = reply.unitCost;

  const sellIdx = findItemIndexForReply(draft, missing, "missing_selling_price", reply.productNameGuess);
  if (sellIdx !== null && reply.sellingPrice != null) items[sellIdx].sellingPrice = reply.sellingPrice;

  const expiryIdx = findItemIndexForReply(draft, missing, "missing_expiry", reply.productNameGuess);
  if (expiryIdx !== null && reply.expiryDate) items[expiryIdx].expiryDate = reply.expiryDate;
  if (expiryIdx !== null && reply.batchNumber) items[expiryIdx].batchNumber = reply.batchNumber;

  let supplier = draft.supplier;
  const supplierMissing = missing.some((m) => m.reason === "ambiguous_supplier");
  if (supplierMissing && reply.supplierNameGuess) {
    supplier = await resolveSupplierMatch(businessId, reply.supplierNameGuess);
  }

  return { ...draft, items, supplier };
}

async function upsertDraftRow(params: {
  businessId: string;
  phone: string;
  draft: DraftState;
  status: "COLLECTING" | "AWAITING_CONFIRMATION";
  missing: MissingField[];
  messageSid?: string;
  mediaUrl?: string | null;
  existingId?: string;
}) {
  const data = {
    businessId: params.businessId,
    phone: params.phone,
    status: params.status,
    extractedItems: params.draft.items as unknown as Prisma.InputJsonValue,
    supplierGuess: params.draft.supplier
      ? (params.draft.supplier as unknown as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    missingFields: params.missing as unknown as Prisma.InputJsonValue,
    sourceMessageSid: params.messageSid,
    mediaUrl: params.mediaUrl ?? undefined,
  };
  if (params.existingId) {
    return prisma.whatsAppInventoryDraft.update({ where: { id: params.existingId }, data });
  }
  return prisma.whatsAppInventoryDraft.create({ data });
}

async function findOpenDraft(businessId: string, phone: string) {
  const draft = await prisma.whatsAppInventoryDraft.findFirst({
    where: { businessId, phone, status: { in: ["COLLECTING", "AWAITING_CONFIRMATION"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!draft) return null;

  if (Date.now() - draft.updatedAt.getTime() > DRAFT_TIMEOUT_MS) {
    await prisma.whatsAppInventoryDraft.update({ where: { id: draft.id }, data: { status: "EXPIRED" } });
    return null;
  }
  return draft;
}

async function finalizeAndRespond(
  businessId: string,
  phone: string,
  draft: DraftState,
  existingId: string | undefined,
  messageSid: string | undefined,
  mediaUrl: string | null | undefined
): Promise<{ reply: string }> {
  const hardIssues = findHardIssues(draft.items);
  if (hardIssues.length > 0) {
    return { reply: hardIssues.map((i) => i.message).join("\n") };
  }

  const missing = await findMissingFields(businessId, draft.items);

  if (missing.length > 0) {
    await upsertDraftRow({ businessId, phone, draft, status: "COLLECTING", missing, messageSid, mediaUrl, existingId });
    return { reply: formatMissingFieldsMessage(missing) };
  }

  const deviations = await findPriceDeviations(businessId, draft.items);
  const warnings = deviations.map(
    (d) =>
      `${d.productName}: ₦${d.newPrice} is ${Math.round(d.deviation * 100)}% ${d.newPrice > d.previousPrice ? "above" : "below"} your usual ₦${d.previousPrice}.`
  );

  await upsertDraftRow({ businessId, phone, draft, status: "AWAITING_CONFIRMATION", missing: [], messageSid, mediaUrl, existingId });
  return { reply: formatConfirmationSummary(draft, warnings) };
}

const CONFIRM_RE = /^(yes|yeah|yep|confirm|correct|ok(ay)?|sure|that'?s right)\.?!?$/i;
const CANCEL_RE = /^(no|cancel|stop|wrong)\.?!?$/i;

export async function handleManagerInventoryMessage(
  input: ManagerInventoryInput
): Promise<{ reply: string }> {
  const { businessId, phone, body, media, messageSid, employeeId, userId } = input;
  const trimmedBody = body.trim();
  const openDraft = await findOpenDraft(businessId, phone);

  const mediaUrl: string | null | undefined = media?.storageUrl ?? null;

  // New invoice photo always starts a fresh draft (multi-photo invoices are a roadmap item).
  if (media && isImage(media.contentType)) {
    if (openDraft) {
      await prisma.whatsAppInventoryDraft.update({ where: { id: openDraft.id }, data: { status: "CANCELLED" } });
    }

    const base64 = media.buffer.toString("base64");
    const extraction = await extractInvoiceFromImage(businessId, base64, media.contentType);
    if (extraction.limitMessage) return { reply: extraction.limitMessage };
    if (!extraction.ok || !extraction.data) {
      const hint = extraction.parseError
        ? "I read the image but couldn't extract product lines from it."
        : "I couldn't read that invoice — the AI call may have failed.";
      return {
        reply: `${hint} Try sending a clearer, well-lit photo, or type the items instead — e.g. "I got 50 packs of Paracetamol at ₦150 each".`,
      };
    }

    const draft = await buildDraftFromExtraction(businessId, extraction.data);
    return finalizeAndRespond(businessId, phone, draft, undefined, messageSid, mediaUrl);
  }

  // Voice note: either the opening command, or a spoken reply to an open draft.
  if (media && isAudio(media.contentType)) {
    const base64 = media.buffer.toString("base64");
    const draftContext = openDraft
      ? summarizeDraftForPrompt(toDraftState(openDraft), (openDraft.missingFields as unknown as MissingField[]) ?? [])
      : undefined;

    const parsed = await parseVoiceInventoryCommand(businessId, base64, media.contentType, draftContext);
    if (parsed.limitMessage) return { reply: parsed.limitMessage };
    if (!parsed.ok || !parsed.data) {
      const hint = parsed.parseError
        ? "I heard the voice note but couldn't extract inventory details."
        : "Sorry, I couldn't process that voice note — the AI call may have failed.";
      return { reply: `${hint} Try again, or type it instead — e.g. "I got 50 packs of Panadol at ₦150 each".` };
    }

    return handleParsedReply(businessId, phone, openDraft, parsed.data, messageSid, mediaUrl, employeeId, userId);
  }

  // Text: either the opening command, or a typed reply to an open draft.
  if (!openDraft) {
    const parsed = await parseTextInventoryCommand(businessId, trimmedBody);
    if (parsed.limitMessage) return { reply: parsed.limitMessage };
    if (!parsed.ok || !parsed.data || parsed.data.intent !== "add_stock") {
      return {
        reply:
          'Hi! Send me a photo of an invoice, or tell me what stock came in — e.g. "I got 50 packs of Paracetamol at ₦150 each".',
      };
    }
    return handleParsedReply(businessId, phone, null, parsed.data, messageSid, mediaUrl, employeeId, userId);
  }

  if (CONFIRM_RE.test(trimmedBody)) {
    return handleConfirmOrCancel(businessId, phone, openDraft, "confirm", employeeId, userId);
  }
  if (CANCEL_RE.test(trimmedBody)) {
    return handleConfirmOrCancel(businessId, phone, openDraft, "cancel", employeeId, userId);
  }

  const missing = (openDraft.missingFields as unknown as MissingField[]) ?? [];
  const draftContext = summarizeDraftForPrompt(toDraftState(openDraft), missing);
  const parsed = await parseTextInventoryCommand(businessId, trimmedBody, draftContext);
  if (parsed.limitMessage) return { reply: parsed.limitMessage };
  if (!parsed.ok || !parsed.data) {
    return { reply: "Sorry, I didn't catch that. Could you rephrase?" };
  }

  return handleParsedReply(businessId, phone, openDraft, parsed.data, messageSid, mediaUrl, employeeId, userId);
}

async function buildDraftFromExtraction(businessId: string, extraction: InvoiceExtraction): Promise<DraftState> {
  const items = await resolveItemMatches(businessId, extraction.items);
  const supplier = await resolveSupplierMatch(businessId, extraction.supplierNameGuess);
  return { items, supplier, invoiceNumber: extraction.invoiceNumber ?? null };
}

async function buildDraftFromSingleReply(businessId: string, reply: InventoryReplyResult): Promise<DraftState | null> {
  if (!reply.productNameGuess?.trim()) return null;

  const item: DraftItem = {
    productNameGuess: reply.productNameGuess.trim(),
    quantity: reply.quantity ?? 0,
    unitCost: reply.unitCost ?? null,
    sellingPrice: reply.sellingPrice ?? null,
    batchNumber: reply.batchNumber ?? null,
    expiryDate: reply.expiryDate ?? null,
    confidence: 0.7,
  };
  const [resolved] = await resolveItemMatches(businessId, [item]);
  const supplier = await resolveSupplierMatch(businessId, reply.supplierNameGuess);
  return { items: [resolved], supplier };
}

async function handleParsedReply(
  businessId: string,
  phone: string,
  openDraft: Awaited<ReturnType<typeof findOpenDraft>>,
  reply: InventoryReplyResult,
  messageSid: string | undefined,
  mediaUrl: string | null | undefined,
  employeeId?: string,
  userId?: string
): Promise<{ reply: string }> {
  if (reply.intent === "cancel" && openDraft) {
    return handleConfirmOrCancel(businessId, phone, openDraft, "cancel", employeeId, userId);
  }

  if (!openDraft) {
    if (reply.intent !== "add_stock" || !reply.productNameGuess) {
      return {
        reply:
          'Hi! Send me a photo of an invoice, or tell me what stock came in — e.g. "I got 50 packs of Paracetamol at ₦150 each".',
      };
    }
    const draft = await buildDraftFromSingleReply(businessId, reply);
    if (!draft) return { reply: "Which product came in, and how many?" };
    return finalizeAndRespond(businessId, phone, draft, undefined, messageSid, mediaUrl);
  }

  if (reply.intent === "confirm" && openDraft.status === "AWAITING_CONFIRMATION") {
    return handleConfirmOrCancel(businessId, phone, openDraft, "confirm", employeeId, userId);
  }

  const draft = toDraftState(openDraft);
  const missing =
    openDraft.status === "COLLECTING"
      ? ((openDraft.missingFields as unknown as MissingField[]) ?? [])
      : await findMissingFields(businessId, draft.items);

  // No new product mentioned and draft has exactly one item — treat numeric fields as a correction to it.
  if (!reply.productNameGuess && draft.items.length === 1) {
    const item = { ...draft.items[0] };
    if (reply.quantity != null) item.quantity = reply.quantity;
    if (reply.unitCost != null) item.unitCost = reply.unitCost;
    if (reply.sellingPrice != null) item.sellingPrice = reply.sellingPrice;
    if (reply.expiryDate) item.expiryDate = reply.expiryDate;
    if (reply.batchNumber) item.batchNumber = reply.batchNumber;
    const updated = { ...draft, items: [item] };
    return finalizeAndRespond(businessId, phone, updated, openDraft.id, messageSid, mediaUrl);
  }

  const updated = await applyReplyToDraft(businessId, draft, missing, reply);
  return finalizeAndRespond(businessId, phone, updated, openDraft.id, messageSid, mediaUrl);
}

async function handleConfirmOrCancel(
  businessId: string,
  phone: string,
  draft: NonNullable<Awaited<ReturnType<typeof findOpenDraft>>>,
  action: "confirm" | "cancel",
  employeeId?: string,
  userId?: string
): Promise<{ reply: string }> {
  if (action === "cancel") {
    await prisma.whatsAppInventoryDraft.update({ where: { id: draft.id }, data: { status: "CANCELLED" } });
    return { reply: "No problem, cancelled. Send another invoice or tell me what came in whenever you're ready." };
  }

  if (draft.status !== "AWAITING_CONFIRMATION") {
    const missing = (draft.missingFields as unknown as MissingField[]) ?? [];
    return { reply: `Still need a bit more first:\n${formatMissingFieldsMessage(missing)}` };
  }

  const state = toDraftState(draft);
  const result = await commitInventoryDraft({
    businessId,
    draft: state,
    phone,
    employeeId,
    userId,
    messageSid: draft.sourceMessageSid ?? undefined,
    mediaUrl: draft.mediaUrl,
  });

  await prisma.whatsAppInventoryDraft.update({ where: { id: draft.id }, data: { status: "COMMITTED" } });

  const summary = result.productSummaries.join("\n");
  return {
    reply: `✅ Done! Inventory updated:\n${summary}${result.supplierCreated ? "\n\nAdded new supplier too." : ""}`,
  };
}

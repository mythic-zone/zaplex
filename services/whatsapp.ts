import OpenAI from "openai";
import { prisma } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { sendWhatsAppMessage, toWhatsAppAddress, fetchTwilioMedia } from "@/services/twilio";
import { normalizeNigerianPhone } from "@/lib/phone";
import { resolveManagerFromWhatsApp, type ResolvedWhatsAppManager } from "@/lib/whatsapp-auth";
import { uploadWhatsAppMedia } from "@/lib/whatsapp-media";
import { handleManagerInventoryMessage } from "@/lib/ai/whatsapp-inventory/conversation";

type WhatsAppProduct = {
  name: string;
  sellingPrice: { toString(): string };
  quantity: number;
};

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export interface WhatsAppInbound {
  from: string;
  to: string;
  body: string;
  messageSid?: string;
  mediaUrl?: string;
  mediaContentType?: string;
}

const INVENTORY_COMMAND_RE =
  /\b(add|stock|restock|received|bought|got|purchase[d]?)\b.{0,40}\b(pcs?|packs?|cartons?|units?|boxes?|bottles?|sachets?)\b/i;

function generateBusinessCode(businessName: string): string {
  const prefix = businessName
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 4)
    .toUpperCase()
    .padEnd(4, "X");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}${suffix}`;
}

export async function getOrCreateWhatsAppConfig(businessId: string) {
  const existing = await prisma.whatsAppConfig.findUnique({
    where: { businessId },
  });
  if (existing) return existing;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });
  if (!business) throw new Error("Business not found");

  let code = generateBusinessCode(business.name);
  let attempts = 0;
  while (attempts < 5) {
    const clash = await prisma.whatsAppConfig.findUnique({
      where: { businessCode: code },
    });
    if (!clash) break;
    code = generateBusinessCode(business.name);
    attempts++;
  }

  return prisma.whatsAppConfig.create({
    data: {
      businessId,
      businessCode: code,
      greetingMessage: `Hello! Welcome to ${business.name}. Ask us about products, prices, or opening hours. Example: "Do you have Paracetamol?"`,
      twilioNumber: process.env.TWILIO_WHATSAPP_NUMBER?.replace(/^whatsapp:/i, ""),
    },
  });
}

export async function resolveBusinessFromInbound(
  inbound: WhatsAppInbound
): Promise<{ businessId: string; cleanedBody: string } | null> {
  const toNormalized = inbound.to.replace(/^whatsapp:/i, "");

  // Route by Twilio "To" number mapped to business
  const byTwilio = await prisma.whatsAppConfig.findFirst({
    where: {
      isEnabled: true,
      OR: [
        { twilioNumber: toNormalized },
        { twilioNumber: inbound.to },
        { twilioNumber: `whatsapp:${toNormalized}` },
      ],
    },
  });
  if (byTwilio) {
    return { businessId: byTwilio.businessId, cleanedBody: inbound.body.trim() };
  }

  // Route by business code prefix: #ABCD1234 message or ABCD1234: message
  const codeMatch = inbound.body.match(/^[#]?([A-Z]{4}[A-Z0-9]{4})[:\s-]+(.+)$/i);
  if (codeMatch) {
    const config = await prisma.whatsAppConfig.findFirst({
      where: { businessCode: codeMatch[1].toUpperCase(), isEnabled: true },
    });
    if (config) {
      return { businessId: config.businessId, cleanedBody: codeMatch[2].trim() };
    }
  }

  // Route by known customer phone
  const customerPhone = inbound.from.replace(/^whatsapp:/i, "");
  const customer = await prisma.customer.findFirst({
    where: { phone: { contains: customerPhone.slice(-10) } },
    orderBy: { updatedAt: "desc" },
  });
  if (customer) {
    const config = await prisma.whatsAppConfig.findFirst({
      where: { businessId: customer.businessId, isEnabled: true },
    });
    if (config) {
      return { businessId: customer.businessId, cleanedBody: inbound.body.trim() };
    }
  }

  // Single-tenant fallback: only one enabled business
  const enabledConfigs = await prisma.whatsAppConfig.findMany({
    where: { isEnabled: true },
    take: 2,
  });
  if (enabledConfigs.length === 1) {
    return {
      businessId: enabledConfigs[0].businessId,
      cleanedBody: inbound.body.trim(),
    };
  }

  return null;
}

function searchProducts(products: WhatsAppProduct[], query: string): WhatsAppProduct[] {
  const terms = query
    .toLowerCase()
    .replace(/do you have|is there|any|available|in stock|price of|how much/gi, "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) return [];

  return products
    .filter((p) => {
      const name = p.name.toLowerCase();
      return terms.some((term) => name.includes(term));
    })
    .slice(0, 5);
}

function formatProductReply(
  products: WhatsAppProduct[],
  currency: string,
  businessName: string
): string {
  if (products.length === 0) {
    return `Sorry, we couldn't find that product at ${businessName}. Try another name or visit our shop.`;
  }

  const lines = products.map((p) => {
    const price = formatCurrency(Number(p.sellingPrice), currency);
    const stock =
      p.quantity > 0
        ? `${p.quantity} in stock`
        : "Out of stock — we can order for you";
    return `• *${p.name}* — ${price} (${stock})`;
  });

  return `Yes! Here's what we have at ${businessName}:\n\n${lines.join("\n")}\n\nReply with a product name for more details.`;
}

function formatHoursReply(businessName: string): string {
  return `${businessName} is open Mon–Sat, 8am–8pm. Sundays 10am–4pm. Visit us or order via WhatsApp!`;
}

function formatDebtReply(
  customerName: string,
  debt: number,
  currency: string
): string {
  if (debt <= 0) {
    return `Hi ${customerName}! You have no outstanding balance. Thank you for your patronage! 🙏`;
  }
  return `Hi ${customerName}, your outstanding balance is ${formatCurrency(debt, currency)}. Please make payment at your earliest convenience. Thank you!`;
}

async function generateAIReply(
  businessId: string,
  message: string,
  businessName: string,
  products: WhatsAppProduct[],
  currency: string
): Promise<string | null> {
  if (!openai) return null;

  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
  });
  const { guardAiPrompt } = await import("@/lib/ai-usage-limit");
  const limit = await guardAiPrompt({ businessId, subscription });
  if (!limit.allowed) {
    return limit.message ?? "AI limit reached for this shop's free trial.";
  }

  const productList = products
    .slice(0, 30)
    .map((p) => `${p.name}: ₦${Number(p.sellingPrice)}, qty ${p.quantity}`)
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a WhatsApp shop assistant for "${businessName}" in Nigeria. Answer customer questions briefly (under 300 chars when possible). Use ₦ for prices.

Available products:
${productList || "No products loaded"}

Rules:
- If asking about stock, check the product list
- Be friendly and professional
- Use WhatsApp formatting (*bold* for product names)
- If unsure, ask them to visit the shop`,
        },
        { role: "user", content: message },
      ],
      max_tokens: 250,
      temperature: 0.5,
    });
    return response.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export async function generateCustomerReply(
  businessId: string,
  message: string,
  customerPhone?: string
): Promise<string> {
  const [business, products, config] = await Promise.all([
    prisma.business.findUnique({ where: { id: businessId } }),
    prisma.product.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: "asc" },
      select: {
        name: true,
        sellingPrice: true,
        quantity: true,
        category: true,
      },
    }),
    prisma.whatsAppConfig.findUnique({ where: { businessId } }),
  ]);

  if (!business) return "Sorry, this business is unavailable right now.";

  const lower = message.toLowerCase().trim();

  // Greeting
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|salam|sannu)/i.test(lower)) {
    return (
      config?.greetingMessage ??
      `Hello! Welcome to ${business.name}. Ask us: "Do you have Paracetamol?" or "What are your prices?"`
    );
  }

  // Hours
  if (/open|close|hours|time|when/i.test(lower)) {
    return formatHoursReply(business.name);
  }

  // Debt / balance check for known customers
  if (customerPhone && /owe|debt|balance|credit|pay/i.test(lower)) {
    const phone = customerPhone.replace(/^whatsapp:/i, "");
    const customer = await prisma.customer.findFirst({
      where: {
        businessId,
        phone: { contains: phone.slice(-10) },
      },
    });
    if (customer) {
      return formatDebtReply(
        customer.name,
        Number(customer.debt),
        business.currency
      );
    }
  }

  // Stock / product queries
  if (
    /have|stock|available|price|cost|how much|do you sell|paracetamol|product/i.test(
      lower
    ) ||
    products.some((p) => lower.includes(p.name.toLowerCase().slice(0, 5)))
  ) {
    const matches = searchProducts(products, message);
    if (matches.length > 0) {
      return formatProductReply(matches, business.currency, business.name);
    }
  }

  // AI fallback
  const aiReply = await generateAIReply(
    businessId,
    message,
    business.name,
    products,
    business.currency
  );
  if (aiReply) return aiReply;

  return `Thanks for messaging ${business.name}! Ask about product availability (e.g. "Do you have Coke?") or visit us today.`;
}

export async function processInboundWhatsApp(inbound: WhatsAppInbound) {
  const manager = await resolveManagerFromWhatsApp(inbound.from);
  if (manager) {
    const phone = normalizeNigerianPhone(inbound.from);
    const openDraft = await prisma.whatsAppInventoryDraft.findFirst({
      where: { businessId: manager.businessId, phone, status: { in: ["COLLECTING", "AWAITING_CONFIRMATION"] } },
      select: { id: true },
    });
    const looksLikeInventoryCommand = INVENTORY_COMMAND_RE.test(inbound.body);

    if (inbound.mediaUrl || openDraft || looksLikeInventoryCommand) {
      return processManagerInventoryMessage(manager, phone, inbound);
    }
  }

  const resolved = await resolveBusinessFromInbound(inbound);
  const customerPhone = inbound.from.replace(/^whatsapp:/i, "");

  if (!resolved) {
    // Log unattributed message - can't reply without business context
    return { replied: false, reason: "no_business" };
  }

  const config = await prisma.whatsAppConfig.findUnique({
    where: { businessId: resolved.businessId },
  });

  if (!config?.isEnabled || !config.autoReplyEnabled) {
    await prisma.whatsAppMessage.create({
      data: {
        businessId: resolved.businessId,
        direction: "INBOUND",
        fromNumber: inbound.from,
        toNumber: inbound.to,
        body: inbound.body,
        customerPhone,
        status: "RECEIVED",
      },
    });
    return { replied: false, reason: "disabled" };
  }

  const inboundRecord = await prisma.whatsAppMessage.create({
    data: {
      businessId: resolved.businessId,
      direction: "INBOUND",
      fromNumber: inbound.from,
      toNumber: inbound.to,
      body: inbound.body,
      customerPhone,
      status: "RECEIVED",
    },
  });

  const reply = await generateCustomerReply(
    resolved.businessId,
    resolved.cleanedBody,
    inbound.from
  );

  const fromNumber = config.twilioNumber
    ? toWhatsAppAddress(config.twilioNumber)
    : undefined;

  const sendResult = await sendWhatsAppMessage(
    inbound.from,
    reply,
    fromNumber
  );

  await prisma.whatsAppMessage.create({
    data: {
      businessId: resolved.businessId,
      direction: "OUTBOUND",
      fromNumber: inbound.to,
      toNumber: inbound.from,
      body: reply,
      customerPhone,
      aiResponse: reply,
      status: sendResult.success ? "REPLIED" : "FAILED",
    },
  });

  if (sendResult.success) {
    await prisma.whatsAppMessage.update({
      where: { id: inboundRecord.id },
      data: { status: "REPLIED", aiResponse: reply },
    });
  }

  return {
    replied: sendResult.success,
    reply,
    error: sendResult.error,
    businessId: resolved.businessId,
  };
}

async function processManagerInventoryMessage(
  manager: ResolvedWhatsAppManager,
  phone: string,
  inbound: WhatsAppInbound
) {
  const config = await prisma.whatsAppConfig.findUnique({ where: { businessId: manager.businessId } });

  let media: { buffer: Buffer; contentType: string; storageUrl?: string | null } | undefined;
  if (inbound.mediaUrl && inbound.mediaContentType) {
    const fetched = await fetchTwilioMedia(inbound.mediaUrl);
    if (fetched) {
      const storageUrl = await uploadWhatsAppMedia(manager.businessId, fetched.buffer, fetched.contentType);
      media = { buffer: fetched.buffer, contentType: fetched.contentType, storageUrl };
    }
  }

  await prisma.whatsAppMessage.create({
    data: {
      businessId: manager.businessId,
      direction: "INBOUND",
      fromNumber: inbound.from,
      toNumber: inbound.to,
      body: inbound.body,
      customerPhone: phone,
      status: "RECEIVED",
      mediaUrl: media?.storageUrl ?? undefined,
      mediaType: inbound.mediaContentType,
      intent: "manager_inventory",
    },
  });

  const { reply } = await handleManagerInventoryMessage({
    businessId: manager.businessId,
    role: manager.role,
    employeeId: manager.employeeId,
    userId: manager.userId,
    phone,
    body: inbound.body,
    media,
    messageSid: inbound.messageSid,
  });

  const fromNumber = config?.twilioNumber ? toWhatsAppAddress(config.twilioNumber) : undefined;
  const sendResult = await sendWhatsAppMessage(inbound.from, reply, fromNumber);

  await prisma.whatsAppMessage.create({
    data: {
      businessId: manager.businessId,
      direction: "OUTBOUND",
      fromNumber: inbound.to,
      toNumber: inbound.from,
      body: reply,
      customerPhone: phone,
      aiResponse: reply,
      status: sendResult.success ? "REPLIED" : "FAILED",
      intent: "manager_inventory",
    },
  });

  return { replied: sendResult.success, reply, error: sendResult.error, businessId: manager.businessId };
}

/**
 * WhatsApp alert to the owner/manager when a POS sale completes. Fire-and-forget
 * from the caller — mirrors the existing non-blocking pattern for inbound messages.
 */
export async function notifyOwnerOfSale(
  businessId: string,
  sale: { total: number; paymentMethod: string; itemCount: number }
) {
  const config = await prisma.whatsAppConfig.findUnique({ where: { businessId } });
  if (!config?.saleAlertsEnabled || !config.ownerAlertPhone) return;

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { currency: true } });
  const amount = formatCurrency(sale.total, business?.currency ?? "NGN");
  const body = `💰 Sale completed — ${amount} (${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}) via ${sale.paymentMethod}.`;

  const fromNumber = config.twilioNumber ? toWhatsAppAddress(config.twilioNumber) : undefined;
  await sendWhatsAppMessage(config.ownerAlertPhone, body, fromNumber);
}

export async function getWhatsAppMessages(
  businessId: string,
  limit = 50
) {
  return prisma.whatsAppMessage.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function sendManualWhatsAppReply(
  businessId: string,
  toPhone: string,
  body: string
) {
  const config = await prisma.whatsAppConfig.findUnique({
    where: { businessId },
  });

  const fromNumber = config?.twilioNumber
    ? toWhatsAppAddress(config.twilioNumber)
    : undefined;

  const result = await sendWhatsAppMessage(toPhone, body, fromNumber);

  await prisma.whatsAppMessage.create({
    data: {
      businessId,
      direction: "OUTBOUND",
      fromNumber: fromNumber ?? process.env.TWILIO_WHATSAPP_NUMBER ?? "",
      toNumber: toWhatsAppAddress(toPhone),
      body,
      customerPhone: toPhone,
      status: result.success ? "REPLIED" : "FAILED",
    },
  });

  return result;
}

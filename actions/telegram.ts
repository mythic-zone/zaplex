"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getOrCreateWhatsAppConfig,
  sendManualTelegramReply,
} from "@/services/telegram-bot";
import { isTelegramConfigured } from "@/services/telegram";
import { getAppUrl } from "@/lib/env";
import { whatsappConfigSchema } from "@/lib/validations";

export async function getTelegramSettings() {
  const ctx = await requireBusinessContext();
  const config = await getOrCreateWhatsAppConfig(ctx.businessId);
  const telegramConfigured = isTelegramConfigured();
  const webhookUrl = `${getAppUrl()}/api/webhooks/telegram`;

  return {
    config,
    telegramConfigured,
    webhookUrl,
    businessName: ctx.business.name,
  };
}

export async function updateTelegramConfig(formData: FormData) {
  const ctx = await requireBusinessContext();

  const parsed = whatsappConfigSchema.safeParse({
    isEnabled: formData.get("isEnabled") === "true",
    autoReplyEnabled: formData.get("autoReplyEnabled") === "true",
    greetingMessage: formData.get("greetingMessage") || undefined,
    saleAlertsEnabled: formData.get("saleAlertsEnabled") === "true",
  });

  if (!parsed.success) {
    return { error: "Invalid configuration" };
  }

  await getOrCreateWhatsAppConfig(ctx.businessId);

  const config = await prisma.whatsAppConfig.update({
    where: { businessId: ctx.businessId },
    data: {
      isEnabled: parsed.data.isEnabled,
      autoReplyEnabled: parsed.data.autoReplyEnabled,
      greetingMessage: parsed.data.greetingMessage,
      saleAlertsEnabled: parsed.data.saleAlertsEnabled,
    },
  });

  revalidatePath("/whatsapp");
  return { success: true, config };
}

export async function sendTestTelegramMessage(chatId: string) {
  const ctx = await requireBusinessContext();
  const config = await getOrCreateWhatsAppConfig(ctx.businessId);

  if (!config.isEnabled) {
    return { error: "Enable Telegram AI first" };
  }

  const result = await sendManualTelegramReply(
    ctx.businessId,
    chatId,
    `✅ Test from ${ctx.business.name}!\n\nYour Telegram AI is working. Customers can ask: "Do you have Paracetamol?" and get instant stock replies.`
  );

  if (!result.success) {
    return { error: result.error ?? "Failed to send test message" };
  }

  revalidatePath("/whatsapp");
  return { success: true };
}

export async function simulateInboundMessage(message: string) {
  const ctx = await requireBusinessContext();
  const { generateCustomerReply } = await import("@/services/telegram-bot");

  const reply = await generateCustomerReply(ctx.businessId, message);

  await prisma.whatsAppMessage.create({
    data: {
      businessId: ctx.businessId,
      direction: "INBOUND",
      fromNumber: "simulator",
      toNumber: "simulator",
      body: message,
      customerPhone: "simulator",
      status: "REPLIED",
      aiResponse: reply,
    },
  });

  await prisma.whatsAppMessage.create({
    data: {
      businessId: ctx.businessId,
      direction: "OUTBOUND",
      fromNumber: "simulator",
      toNumber: "simulator",
      body: reply,
      customerPhone: "simulator",
      status: "REPLIED",
    },
  });

  revalidatePath("/whatsapp");
  return { reply };
}

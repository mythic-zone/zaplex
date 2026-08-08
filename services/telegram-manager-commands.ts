import { prisma } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { matchProduct, AUTO_MATCH_THRESHOLD } from "@/lib/ai/whatsapp-inventory/matching";
import { sendTelegramMessage } from "@/services/telegram";
import type { ResolvedTelegramManager } from "@/lib/telegram-auth";

interface CommandResult {
  handled: boolean;
  reply?: string;
}

const DELETE_RE =
  /^(delete|remove|drop)\s+(?:product\s+)?(.+)/i;

const CHECK_STOCK_RE =
  /^(?:how many|check stock|stock check|stock level|quantity|do we have|what'?s? left)\s*(?:of\s+|for\s+)?(.+)?/i;

const LOW_STOCK_RE =
  /^(?:low stock|what'?s? (?:low|running out)|reorder|expiring)/i;

const UPDATE_PRICE_RE =
  /^(?:change|update|set)\s+(?:the\s+)?(?:price\s+(?:of\s+|for\s+)?)?(.+?)\s+(?:price\s+)?(?:to|=|at)\s+[₦#N]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i;

const SALES_SUMMARY_RE =
  /^(?:how (?:did we|were sales)|today'?s? sales|sales today|sales summary|daily summary|how much (?:did we|have we) (?:made|sold)|what (?:did we|have we) sold)/i;

const DEBTS_RE =
  /^(?:who owes|debts?|outstanding|credit customers|unpaid|debtors)/i;

const PENDING_CONFIRMS = new Map<string, { action: string; productId: string; productName: string; extra?: Record<string, unknown> }>();

export async function handleManagerCommand(
  manager: ResolvedTelegramManager,
  chatId: string,
  body: string
): Promise<CommandResult> {
  const trimmed = body.trim();

  if (/^(yes|yeah|yep|confirm|ok(ay)?|sure)$/i.test(trimmed)) {
    return handlePendingConfirm(manager, chatId);
  }
  if (/^(no|cancel|never\s*mind)$/i.test(trimmed)) {
    return cancelPendingConfirm(chatId);
  }

  const del = trimmed.match(DELETE_RE);
  if (del) return handleDelete(manager, chatId, del[2].trim());

  const price = trimmed.match(UPDATE_PRICE_RE);
  if (price) return handleUpdatePrice(manager, chatId, price[1].trim(), price[2].replace(/,/g, ""));

  const stock = trimmed.match(CHECK_STOCK_RE);
  if (stock) return handleCheckStock(manager, chatId, stock[1]?.trim());

  if (LOW_STOCK_RE.test(trimmed)) return handleLowStock(manager);

  if (SALES_SUMMARY_RE.test(trimmed)) return handleSalesSummary(manager);

  if (DEBTS_RE.test(trimmed)) return handleDebts(manager);

  return { handled: false };
}

async function handleDelete(
  manager: ResolvedTelegramManager,
  chatId: string,
  nameGuess: string
): Promise<CommandResult> {
  const candidates = await matchProduct(manager.businessId, nameGuess);
  const top = candidates[0];
  if (!top || top.score < 0.4) {
    return { handled: true, reply: `I couldn't find a product matching "${nameGuess}". Check the name and try again.` };
  }

  if (top.score < AUTO_MATCH_THRESHOLD && candidates.length > 1) {
    const options = candidates
      .slice(0, 3)
      .map((c, i) => `${i + 1}. ${c.item.name}`)
      .join("\n");
    return {
      handled: true,
      reply: `Which product did you mean?\n${options}\n\nReply with the exact name to delete it.`,
    };
  }

  PENDING_CONFIRMS.set(chatId, {
    action: "delete",
    productId: top.item.id,
    productName: top.item.name,
  });

  return {
    handled: true,
    reply: `Are you sure you want to delete *${top.item.name}*? (${top.item.quantity} in stock)\n\nReply *YES* to confirm or *NO* to cancel.`,
  };
}

async function handleUpdatePrice(
  manager: ResolvedTelegramManager,
  chatId: string,
  nameGuess: string,
  priceStr: string
): Promise<CommandResult> {
  const newPrice = parseFloat(priceStr);
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    return { handled: true, reply: "That doesn't look like a valid price." };
  }

  const candidates = await matchProduct(manager.businessId, nameGuess);
  const top = candidates[0];
  if (!top || top.score < 0.4) {
    return { handled: true, reply: `I couldn't find a product matching "${nameGuess}".` };
  }

  if (top.score < AUTO_MATCH_THRESHOLD && candidates.length > 1) {
    const options = candidates
      .slice(0, 3)
      .map((c, i) => `${i + 1}. ${c.item.name}`)
      .join("\n");
    return {
      handled: true,
      reply: `Which product did you mean?\n${options}\n\nTry again with the exact name.`,
    };
  }

  const business = await prisma.business.findUnique({
    where: { id: manager.businessId },
    select: { currency: true },
  });
  const currency = business?.currency ?? "NGN";
  const oldPrice = Number(top.item.sellingPrice);

  PENDING_CONFIRMS.set(chatId, {
    action: "update_price",
    productId: top.item.id,
    productName: top.item.name,
    extra: { newPrice },
  });

  return {
    handled: true,
    reply: `Change *${top.item.name}* price from ${formatCurrency(oldPrice, currency)} → ${formatCurrency(newPrice, currency)}?\n\nReply *YES* to confirm or *NO* to cancel.`,
  };
}

async function handleCheckStock(
  manager: ResolvedTelegramManager,
  chatId: string,
  nameGuess?: string
): Promise<CommandResult> {
  if (!nameGuess) {
    const products = await prisma.product.findMany({
      where: { businessId: manager.businessId, isActive: true },
      orderBy: { quantity: "asc" },
      take: 10,
      select: { name: true, quantity: true, sellingPrice: true },
    });
    if (products.length === 0) {
      return { handled: true, reply: "No products in inventory yet." };
    }
    const business = await prisma.business.findUnique({
      where: { id: manager.businessId },
      select: { currency: true },
    });
    const currency = business?.currency ?? "NGN";
    const lines = products.map(
      (p) => `• *${p.name}* — ${p.quantity} in stock (${formatCurrency(Number(p.sellingPrice), currency)})`
    );
    return {
      handled: true,
      reply: `Stock levels (lowest first):\n\n${lines.join("\n")}`,
    };
  }

  const candidates = await matchProduct(manager.businessId, nameGuess);
  const top = candidates[0];
  if (!top || top.score < 0.4) {
    return { handled: true, reply: `I couldn't find a product matching "${nameGuess}".` };
  }

  const product = await prisma.product.findUnique({
    where: { id: top.item.id },
    select: {
      name: true,
      quantity: true,
      sellingPrice: true,
      purchasePrice: true,
      reorderLevel: true,
      expiryDate: true,
      category: true,
    },
  });
  if (!product) return { handled: true, reply: "Product not found." };

  const business = await prisma.business.findUnique({
    where: { id: manager.businessId },
    select: { currency: true },
  });
  const currency = business?.currency ?? "NGN";

  const lines = [
    `*${product.name}*`,
    `Quantity: ${product.quantity}`,
    `Selling price: ${formatCurrency(Number(product.sellingPrice), currency)}`,
    `Purchase price: ${formatCurrency(Number(product.purchasePrice), currency)}`,
    `Reorder level: ${product.reorderLevel}`,
  ];
  if (product.category) lines.push(`Category: ${product.category}`);
  if (product.expiryDate) lines.push(`Expiry: ${product.expiryDate.toISOString().slice(0, 10)}`);
  if (product.quantity <= product.reorderLevel) lines.push("\n⚠️ Below reorder level!");

  return { handled: true, reply: lines.join("\n") };
}

async function handleLowStock(manager: ResolvedTelegramManager): Promise<CommandResult> {
  const products = await prisma.product.findMany({
    where: {
      businessId: manager.businessId,
      isActive: true,
    },
    select: { name: true, quantity: true, reorderLevel: true },
  });

  const low = products
    .filter((p) => p.quantity <= p.reorderLevel)
    .sort((a, b) => a.quantity - b.quantity);

  if (low.length === 0) {
    return { handled: true, reply: "All products are above their reorder levels. Stock is healthy!" };
  }

  const lines = low.slice(0, 15).map((p) => {
    const status = p.quantity === 0 ? "OUT OF STOCK" : `${p.quantity} left (reorder at ${p.reorderLevel})`;
    return `• *${p.name}* — ${status}`;
  });
  const extra = low.length > 15 ? `\n\n…and ${low.length - 15} more.` : "";

  return {
    handled: true,
    reply: `⚠️ ${low.length} product${low.length === 1 ? "" : "s"} at or below reorder level:\n\n${lines.join("\n")}${extra}`,
  };
}

async function handleSalesSummary(manager: ResolvedTelegramManager): Promise<CommandResult> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const business = await prisma.business.findUnique({
    where: { id: manager.businessId },
    select: { currency: true },
  });
  const currency = business?.currency ?? "NGN";

  const sales = await prisma.sale.findMany({
    where: {
      businessId: manager.businessId,
      createdAt: { gte: today },
    },
    select: {
      total: true,
      profit: true,
      paymentMethod: true,
      items: { select: { quantity: true } },
    },
  });

  if (sales.length === 0) {
    return { handled: true, reply: "No sales recorded today yet." };
  }

  const totalRevenue = sales.reduce((sum, s) => sum + Number(s.total), 0);
  const totalProfit = sales.reduce((sum, s) => sum + Number(s.profit), 0);
  const totalItems = sales.reduce(
    (sum, s) => sum + s.items.reduce((is, i) => is + i.quantity, 0),
    0
  );

  const byMethod: Record<string, number> = {};
  for (const s of sales) {
    byMethod[s.paymentMethod] = (byMethod[s.paymentMethod] ?? 0) + Number(s.total);
  }
  const methodLines = Object.entries(byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([method, amount]) => `  ${method}: ${formatCurrency(amount, currency)}`);

  const lines = [
    `📊 *Today's Sales*`,
    ``,
    `Transactions: ${sales.length}`,
    `Items sold: ${totalItems}`,
    `Revenue: ${formatCurrency(totalRevenue, currency)}`,
    `Profit: ${formatCurrency(totalProfit, currency)}`,
    ``,
    `By payment method:`,
    ...methodLines,
  ];

  return { handled: true, reply: lines.join("\n") };
}

async function handleDebts(manager: ResolvedTelegramManager): Promise<CommandResult> {
  const business = await prisma.business.findUnique({
    where: { id: manager.businessId },
    select: { currency: true },
  });
  const currency = business?.currency ?? "NGN";

  const customers = await prisma.customer.findMany({
    where: {
      businessId: manager.businessId,
      debt: { gt: 0 },
    },
    orderBy: { debt: "desc" },
    take: 15,
    select: { name: true, phone: true, debt: true },
  });

  if (customers.length === 0) {
    return { handled: true, reply: "No outstanding debts. All clear!" };
  }

  const totalDebt = customers.reduce((sum, c) => sum + Number(c.debt), 0);
  const lines = customers.map((c) => {
    const phone = c.phone ? ` (${c.phone})` : "";
    return `• *${c.name}*${phone} — ${formatCurrency(Number(c.debt), currency)}`;
  });

  return {
    handled: true,
    reply: `💳 *Outstanding Debts*\n\nTotal: ${formatCurrency(totalDebt, currency)}\n\n${lines.join("\n")}`,
  };
}

async function handlePendingConfirm(
  manager: ResolvedTelegramManager,
  chatId: string
): Promise<CommandResult> {
  const pending = PENDING_CONFIRMS.get(chatId);
  if (!pending) return { handled: false };

  PENDING_CONFIRMS.delete(chatId);

  if (pending.action === "delete") {
    await prisma.product.update({
      where: { id: pending.productId },
      data: { isActive: false },
    });
    return { handled: true, reply: `✅ *${pending.productName}* has been deleted from your inventory.` };
  }

  if (pending.action === "update_price") {
    const newPrice = pending.extra?.newPrice as number;
    await prisma.product.update({
      where: { id: pending.productId },
      data: { sellingPrice: newPrice },
    });
    const business = await prisma.business.findUnique({
      where: { id: manager.businessId },
      select: { currency: true },
    });
    const currency = business?.currency ?? "NGN";
    return {
      handled: true,
      reply: `✅ *${pending.productName}* price updated to ${formatCurrency(newPrice, currency)}.`,
    };
  }

  return { handled: false };
}

function cancelPendingConfirm(chatId: string): CommandResult {
  const pending = PENDING_CONFIRMS.get(chatId);
  if (!pending) return { handled: false };
  PENDING_CONFIRMS.delete(chatId);
  return { handled: true, reply: "Cancelled." };
}

export async function checkAndAlertLowStock(
  businessId: string,
  productIds: string[]
) {
  if (productIds.length === 0) return;

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId, isActive: true },
    select: { name: true, quantity: true, reorderLevel: true },
  });

  const newlyLow = products.filter((p) => p.quantity > 0 && p.quantity <= p.reorderLevel);
  const outOfStock = products.filter((p) => p.quantity <= 0);

  if (newlyLow.length === 0 && outOfStock.length === 0) return;

  const owner = await prisma.membership.findFirst({
    where: { businessId, role: "OWNER", telegramId: { not: null } },
  });
  if (!owner?.telegramId) return;

  const lines: string[] = [];
  if (outOfStock.length > 0) {
    lines.push("🚨 *Out of stock:*");
    outOfStock.forEach((p) => lines.push(`• ${p.name}`));
  }
  if (newlyLow.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("⚠️ *Low stock:*");
    newlyLow.forEach((p) => lines.push(`• ${p.name} — ${p.quantity} left (reorder at ${p.reorderLevel})`));
  }

  await sendTelegramMessage(owner.telegramId, lines.join("\n"));
}

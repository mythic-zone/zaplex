import { prisma } from "@/lib/db";
import type { DraftItem, MissingField } from "@/lib/ai/whatsapp-inventory/types";

export const MAX_ITEMS_PER_COMMIT = 30;
/** Above this fraction deviation from the product's current purchase price, require an extra explicit confirm. */
export const PRICE_DEVIATION_THRESHOLD = 0.5;

export interface QuantityIssue {
  itemIndex: number;
  message: string;
}

/** Hard rejects — these always block a commit until the item is fixed or dropped. */
export function findHardIssues(items: DraftItem[]): QuantityIssue[] {
  const issues: QuantityIssue[] = [];
  items.forEach((item, itemIndex) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      issues.push({ itemIndex, message: `"${item.productNameGuess}" has an invalid quantity (${item.quantity}).` });
    }
  });
  if (items.length > MAX_ITEMS_PER_COMMIT) {
    issues.push({
      itemIndex: -1,
      message: `This invoice has ${items.length} items — that's more than I can safely process at once (max ${MAX_ITEMS_PER_COMMIT}). Please split it into smaller batches.`,
    });
  }
  return issues;
}

export async function findMissingFields(
  businessId: string,
  items: DraftItem[]
): Promise<MissingField[]> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { industry: true },
  });
  const isPharmacy = business?.industry === "PHARMACY";

  const missing: MissingField[] = [];
  items.forEach((item, itemIndex) => {
    if (!item.productId && !item.isNewProduct) {
      missing.push({ itemIndex, reason: "ambiguous_product", productNameGuess: item.productNameGuess });
      return;
    }
    if (item.isNewProduct && item.unitCost == null) {
      missing.push({ itemIndex, reason: "missing_unit_cost", productNameGuess: item.productNameGuess });
    }
    if (item.isNewProduct && item.sellingPrice == null) {
      missing.push({ itemIndex, reason: "missing_selling_price", productNameGuess: item.productNameGuess });
    }
    if (isPharmacy && !item.expiryDate) {
      missing.push({ itemIndex, reason: "missing_expiry", productNameGuess: item.productNameGuess });
    }
  });
  return missing;
}

/**
 * Items whose unit cost is a large jump from the product's current purchase
 * price. Not a hard block — the caller should ask for one extra explicit
 * confirmation ("that's 2x usual — still add?") rather than silently writing
 * a possibly-fraudulent or mis-read price.
 */
export async function findPriceDeviations(
  businessId: string,
  items: DraftItem[]
): Promise<{ itemIndex: number; productName: string; previousPrice: number; newPrice: number; deviation: number }[]> {
  const flagged: { itemIndex: number; productName: string; previousPrice: number; newPrice: number; deviation: number }[] = [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (!item.productId || item.unitCost == null) continue;

    const product = await prisma.product.findFirst({
      where: { id: item.productId, businessId },
      select: { name: true, purchasePrice: true },
    });
    if (!product) continue;

    const previousPrice = Number(product.purchasePrice);
    if (previousPrice <= 0) continue;

    const deviation = Math.abs(item.unitCost - previousPrice) / previousPrice;
    if (deviation > PRICE_DEVIATION_THRESHOLD) {
      flagged.push({
        itemIndex,
        productName: product.name,
        previousPrice,
        newPrice: item.unitCost,
        deviation,
      });
    }
  }

  return flagged;
}

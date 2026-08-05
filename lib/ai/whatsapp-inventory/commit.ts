import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { DraftState } from "@/lib/ai/whatsapp-inventory/types";

export interface CommitResult {
  productsCreated: number;
  productsRestocked: number;
  supplierCreated: boolean;
  productSummaries: string[];
}

/**
 * Writes an approved WhatsApp inventory draft to the database: creates new
 * products / restocks existing ones, records a StockAdjustment(PURCHASE) per
 * line item, links or creates the supplier, and logs one AuditLog row per
 * product so every AI-driven change stays explainable.
 */
export async function commitInventoryDraft(params: {
  businessId: string;
  draft: DraftState;
  phone: string;
  employeeId?: string;
  userId?: string;
  messageSid?: string;
  mediaUrl?: string | null;
}): Promise<CommitResult> {
  const { businessId, draft, phone, employeeId, userId, messageSid, mediaUrl } = params;
  const createdBy = userId ?? employeeId ?? phone;

  const result: CommitResult = {
    productsCreated: 0,
    productsRestocked: 0,
    supplierCreated: false,
    productSummaries: [],
  };

  await prisma.$transaction(async (tx) => {
    let supplierId: string | null = draft.supplier?.supplierId ?? null;

    if (draft.supplier?.isNew && draft.supplier.nameGuess) {
      const supplier = await tx.supplier.create({
        data: { businessId, name: draft.supplier.nameGuess },
      });
      supplierId = supplier.id;
      result.supplierCreated = true;
    }

    for (const item of draft.items) {
      const reason = `WhatsApp invoice${draft.invoiceNumber ? ` #${draft.invoiceNumber}` : ""} via ${phone}`;

      if (item.isNewProduct || !item.productId) {
        const product = await tx.product.create({
          data: {
            businessId,
            name: item.productNameGuess,
            supplierId,
            purchasePrice: item.unitCost ?? 0,
            sellingPrice: item.sellingPrice ?? 0,
            quantity: item.quantity,
            batchNumber: item.batchNumber ?? null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
          },
        });

        await tx.stockAdjustment.create({
          data: {
            productId: product.id,
            businessId,
            type: "PURCHASE",
            quantity: item.quantity,
            reason,
            createdBy,
          },
        });

        await tx.auditLog.create({
          data: {
            businessId,
            userId,
            action: "whatsapp_inventory_commit",
            entity: "Product",
            entityId: product.id,
            metadata: {
              phone,
              messageSid,
              mediaUrl,
              created: true,
              item,
              confidence: item.confidence,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        result.productsCreated++;
        result.productSummaries.push(`+${item.quantity} ${product.name} (new product)`);
      } else {
        const existing = await tx.product.findFirst({
          where: { id: item.productId, businessId },
        });
        if (!existing) continue;

        await tx.product.update({
          where: { id: existing.id },
          data: {
            quantity: existing.quantity + item.quantity,
            purchasePrice: item.unitCost ?? existing.purchasePrice,
            batchNumber: item.batchNumber ?? existing.batchNumber,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : existing.expiryDate,
            supplierId: supplierId ?? existing.supplierId,
          },
        });

        await tx.stockAdjustment.create({
          data: {
            productId: existing.id,
            businessId,
            type: "PURCHASE",
            quantity: item.quantity,
            reason,
            createdBy,
          },
        });

        await tx.auditLog.create({
          data: {
            businessId,
            userId,
            action: "whatsapp_inventory_commit",
            entity: "Product",
            entityId: existing.id,
            metadata: {
              phone,
              messageSid,
              mediaUrl,
              created: false,
              item,
              confidence: item.confidence,
              previousQuantity: existing.quantity,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        result.productsRestocked++;
        result.productSummaries.push(`+${item.quantity} ${existing.name} (now ${existing.quantity + item.quantity})`);
      }
    }
  });

  return result;
}

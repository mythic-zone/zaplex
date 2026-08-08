import { NextResponse } from "next/server";
import { requireBusinessDataAccess } from "@/lib/api-access";
import { prisma } from "@/lib/db";
import { allocateReceiptNumber } from "@/lib/receipt-number";
import { saleItemSchema } from "@/lib/validations";
import { notifyOwnerOfSale } from "@/services/telegram-bot";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** Dedicated sync schema — more tolerant than the POS form schema. */
const syncSaleSchema = z
  .object({
    items: z.array(saleItemSchema).min(1, "Add at least one item"),
    customerId: z.string().optional().nullable(),
    paymentMethod: z.enum(["CASH", "TRANSFER", "POS", "CREDIT"]),
    discount: z.coerce.number().min(0).optional().default(0),
    tax: z.coerce.number().min(0).optional().default(0),
    isCredit: z.boolean().optional(),
    clientSaleId: z.string().min(8).max(80),
    createdAt: z.string().optional(),
    deviceId: z.string().min(4).max(80).optional().nullable(),
    customer: z
      .object({
        name: z.string().min(1).max(120),
        phone: z.string().max(40).optional().nullable(),
        email: z
          .string()
          .max(120)
          .optional()
          .nullable()
          .transform((v) => (v && v.trim() ? v.trim() : null)),
      })
      .optional()
      .nullable(),
  })
  .superRefine((data, ctx) => {
    if (
      data.paymentMethod === "CREDIT" &&
      !data.customerId &&
      !data.customer?.name
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Credit sale needs a customer",
        path: ["customerId"],
      });
    }
  });

export async function POST(request: Request) {
  try {
    const ctx = await requireBusinessDataAccess(["sales"]);
    const body = await request.json();
    const parsed = syncSaleSchema.safeParse(body);

    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const firstField =
        Object.values(flat.fieldErrors).flat()[0] ??
        flat.formErrors[0] ??
        "Invalid sale sync payload";
      return NextResponse.json(
        {
          error: firstField,
          code: "VALIDATION_ERROR",
          details: flat.fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Ensure clientSaleId column exists (preview/prod schema drift).
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "clientSaleId" TEXT`
      );
    } catch {
      // Column may already exist or DB user lacks ALTER — continue.
    }

    const existing = await prisma.sale.findFirst({
      where: {
        businessId: ctx.businessId,
        clientSaleId: data.clientSaleId,
      },
      select: {
        id: true,
        receiptNumber: true,
        total: true,
      },
    });

    if (existing) {
      return NextResponse.json({
        ok: true,
        alreadySynced: true,
        saleId: existing.id,
        receiptNumber: existing.receiptNumber,
      });
    }

    let customerId = data.customerId;

    // Local-only customer ids won't exist on the server — create/find by phone.
    if (customerId) {
      const found = await prisma.customer.findFirst({
        where: { id: customerId, businessId: ctx.businessId },
        select: { id: true },
      });
      if (!found) {
        customerId = undefined;
      }
    }

    if (!customerId && data.customer?.name) {
      const phone = data.customer.phone?.trim() || null;
      if (phone) {
        const byPhone = await prisma.customer.findFirst({
          where: { businessId: ctx.businessId, phone },
          select: { id: true },
        });
        if (byPhone) customerId = byPhone.id;
      }

      if (!customerId) {
        const created = await prisma.customer.create({
          data: {
            businessId: ctx.businessId,
            name: data.customer.name.trim(),
            phone,
            email: data.customer.email?.trim() || null,
          },
        });
        customerId = created.id;
      }
    }

    if (data.paymentMethod === "CREDIT" && !customerId) {
      return NextResponse.json(
        { error: "Credit sale needs a customer on the shared shop database." },
        { status: 409 }
      );
    }

    try {
      const sale = await prisma.$transaction(async (tx) => {
        const productIds = data.items.map((i) => i.productId);
        const products = await tx.product.findMany({
          where: {
            id: { in: productIds },
            businessId: ctx.businessId,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            quantity: true,
            sellingPrice: true,
            purchasePrice: true,
          },
        });

        const productMap = new Map(products.map((p) => [p.id, p]));
        const missing = productIds.filter((id) => !productMap.has(id));
        if (missing.length > 0) {
          throw Object.assign(
            new Error(
              "Some products are only on this device. Add/sync products online first."
            ),
            { code: "MISSING_PRODUCTS", missing }
          );
        }

        let subtotal = 0;
        let totalCost = 0;
        const saleItems: {
          productId: string;
          quantity: number;
          cost: number;
          sellingPrice: number;
          total: number;
        }[] = [];

        for (const item of data.items) {
          const product = productMap.get(item.productId)!;
          const sellingPrice = Number(product.sellingPrice);
          const cost = Number(product.purchasePrice);
          const lineTotal = sellingPrice * item.quantity;
          subtotal += lineTotal;
          totalCost += cost * item.quantity;

          const stockUpdate = await tx.product.updateMany({
            where: {
              id: item.productId,
              businessId: ctx.businessId,
              quantity: { gte: item.quantity },
            },
            data: { quantity: { decrement: item.quantity } },
          });

          if (stockUpdate.count === 0) {
            throw Object.assign(
              new Error(
                `Stock conflict for ${product.name}. Cloud has ${product.quantity} left.`
              ),
              {
                code: "STOCK_CONFLICT",
                productId: product.id,
                available: product.quantity,
              }
            );
          }

          saleItems.push({
            productId: item.productId,
            quantity: item.quantity,
            cost,
            sellingPrice,
            total: lineTotal,
          });
        }

        const discount = data.discount ?? 0;
        const tax = data.tax ?? 0;
        const total = subtotal - discount + tax;
        const profit = total - totalCost - discount;
        const saleCreatedAt = data.createdAt
          ? new Date(data.createdAt)
          : new Date();
        const receiptNumber = await allocateReceiptNumber(
          tx,
          ctx.businessId,
          saleCreatedAt
        );

        const noteParts = [
          `offline-sync`,
          data.deviceId ? `device:${data.deviceId}` : null,
          `client:${data.clientSaleId}`,
        ].filter(Boolean);

        const newSale = await tx.sale.create({
          data: {
            businessId: ctx.businessId,
            customerId: customerId || null,
            clientSaleId: data.clientSaleId,
            receiptNumber,
            paymentMethod: data.paymentMethod,
            subtotal,
            discount,
            tax,
            total,
            profit,
            isCredit: data.paymentMethod === "CREDIT",
            notes: noteParts.join(" | "),
            createdBy: ctx.userId,
            createdAt: saleCreatedAt,
            items: { create: saleItems },
          },
          select: {
            id: true,
            receiptNumber: true,
            total: true,
          },
        });

        for (const item of data.items) {
          await tx.stockAdjustment.create({
            data: {
              productId: item.productId,
              businessId: ctx.businessId,
              type: "SALE",
              quantity: -item.quantity,
              createdBy: ctx.userId,
            },
          });
        }

        if (customerId) {
          if (data.paymentMethod === "CREDIT") {
            await tx.customer.updateMany({
              where: { id: customerId, businessId: ctx.businessId },
              data: {
                debt: { increment: total },
                lastPurchase: saleCreatedAt,
                lifetimeValue: { increment: total },
              },
            });
          } else {
            await tx.customer.updateMany({
              where: { id: customerId, businessId: ctx.businessId },
              data: {
                lastPurchase: saleCreatedAt,
                lifetimeValue: { increment: total },
              },
            });
          }
        }

        return newSale;
      });

      notifyOwnerOfSale(ctx.businessId, {
        total: Number(sale.total),
        paymentMethod: data.paymentMethod,
        itemCount: data.items.length,
      }).catch((err) => console.error("[notifyOwnerOfSale]", err));

      return NextResponse.json({
        ok: true,
        alreadySynced: false,
        saleId: sale.id,
        receiptNumber: sale.receiptNumber,
      });
    } catch (error) {
      const err = error as Error & {
        code?: string;
        missing?: string[];
        available?: number;
        productId?: string;
      };

      if (err.code === "STOCK_CONFLICT") {
        return NextResponse.json(
          {
            error: err.message,
            code: "STOCK_CONFLICT",
            productId: err.productId,
            available: err.available,
          },
          { status: 409 }
        );
      }

      if (err.code === "MISSING_PRODUCTS") {
        return NextResponse.json(
          {
            error: err.message,
            code: "MISSING_PRODUCTS",
            missing: err.missing,
          },
          { status: 409 }
        );
      }

      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      error instanceof Error &&
      error.message.includes("do not have access")
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    console.error("[api/sync/sales]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not sync sale",
      },
      { status: 500 }
    );
  }
}

/** Recent team sales for other devices (history + shared visibility). */
export async function GET(request: Request) {
  try {
    const ctx = await requireBusinessDataAccess(["sales"]);
    const url = new URL(request.url);
    const limit = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("limit") ?? "40") || 40)
    );

    const sales = await prisma.sale.findMany({
      where: { businessId: ctx.businessId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        clientSaleId: true,
        receiptNumber: true,
        paymentMethod: true,
        subtotal: true,
        discount: true,
        tax: true,
        total: true,
        profit: true,
        isCredit: true,
        notes: true,
        customerId: true,
        createdAt: true,
        items: {
          select: {
            productId: true,
            quantity: true,
            cost: true,
            sellingPrice: true,
            total: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      sales: sales.map((sale) => ({
        id: sale.clientSaleId || sale.id,
        cloudId: sale.id,
        clientSaleId: sale.clientSaleId,
        receiptNumber: sale.receiptNumber,
        paymentMethod: sale.paymentMethod,
        subtotal: Number(sale.subtotal),
        discount: Number(sale.discount),
        tax: Number(sale.tax),
        total: Number(sale.total),
        profit: Number(sale.profit),
        isCredit: sale.isCredit,
        notes: sale.notes,
        customerId: sale.customerId,
        createdAt: sale.createdAt.toISOString(),
        items: sale.items.map((item) => ({
          productId: item.productId,
          productName: item.product.name,
          quantity: item.quantity,
          cost: Number(item.cost),
          sellingPrice: Number(item.sellingPrice),
          total: Number(item.total),
        })),
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      error instanceof Error &&
      error.message.includes("do not have access")
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/sync/sales GET]", error);
    return NextResponse.json(
      { error: "Could not load team sales" },
      { status: 500 }
    );
  }
}

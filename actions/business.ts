"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@clerk/nextjs/server";
import { allocateReceiptNumber } from "@/lib/receipt-number";
import { prisma } from "@/lib/db";
import { updateProductImageUrl, getInventoryProduct, createInventoryProduct, updateInventoryProduct, deactivateInventoryProduct } from "@/lib/products";
import { readProductAttributesFromForm } from "@/lib/industries";
import { businessSchema, productSchema, expenseSchema, saleSchema, customerSchema, debtPaymentSchema, updateBusinessSchema } from "@/lib/validations";
import { syncClerkUser, requireBusinessContext, requireSectionAccess, hasPermission } from "@/lib/auth";
import { setActiveBusinessId } from "@/lib/active-business";
import {
  deleteProductImage,
  uploadProductImage,
  validateProductImageFile,
} from "@/lib/product-images";
import { Role, Prisma } from "@prisma/client";
import { abandonEmptyShellShopsForUser } from "@/lib/empty-shop";
import { notifyOwnerOfSale } from "@/services/whatsapp";

export async function createBusiness(formData: FormData) {
  try {
    const user = await currentUser();
    if (!user) {
      return { error: { _form: ["Please sign in again and retry."] } };
    }

    await syncClerkUser({
      id: user.id,
      emailAddresses: user.emailAddresses,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });

    const email = user.emailAddresses[0]?.emailAddress?.trim().toLowerCase();

    // If the user only has empty leftover shops (e.g. removed from a team but
    // still owning typo "ade pharmcy"), clear those so they can start fresh.
    await abandonEmptyShellShopsForUser(user.id);

    let existing = await prisma.membership.findFirst({
      where: { userId: user.id },
      select: { businessId: true, id: true },
    });

    // Recovery: shop still linked to a pre-Clerk-domain user id for this email.
    if (!existing && email) {
      const byEmail = await prisma.membership.findFirst({
        where: {
          user: { email: { equals: email, mode: "insensitive" } },
        },
        select: { businessId: true, id: true, userId: true },
        orderBy: { createdAt: "desc" },
      });
      if (byEmail) {
        if (byEmail.userId !== user.id) {
          await prisma.membership.update({
            where: { id: byEmail.id },
            data: { userId: user.id },
          });
        }
        existing = { businessId: byEmail.businessId, id: byEmail.id };
      }
    }

    if (existing) {
      await setActiveBusinessId(existing.businessId);
      revalidatePath("/dashboard");
      return { success: true, businessId: existing.businessId };
    }

    const parsed = businessSchema.safeParse({
      name: formData.get("name"),
      industry: formData.get("industry"),
      industryLabel: formData.get("industryLabel") || undefined,
      currency: formData.get("currency") || "NGN",
      address: formData.get("address") || undefined,
      phone: formData.get("phone") || undefined,
    });

    if (!parsed.success) {
      return { error: parsed.error.flatten().fieldErrors };
    }

    const baseData = {
      name: parsed.data.name,
      industry: parsed.data.industry,
      currency: parsed.data.currency,
      address: parsed.data.address,
      phone: parsed.data.phone,
      memberships: {
        create: {
          userId: user.id,
          role: Role.OWNER,
        },
      },
      subscription: {
        create: {
          plan: "STARTER" as const,
          status: "TRIAL" as const,
          currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      },
    };

    let business;
    try {
      business = await prisma.business.create({
        data: {
          ...baseData,
          industryLabel: parsed.data.industryLabel ?? null,
        },
      });
    } catch (createError) {
      // Older DBs may not have industryLabel yet — still create the shop.
      const detail =
        createError instanceof Error ? createError.message : String(createError);
      if (!/industryLabel|column.*does not exist|P2022/i.test(detail)) {
        throw createError;
      }
      business = await prisma.business.create({ data: baseData });
    }

    await prisma.auditLog.create({
      data: {
        businessId: business.id,
        userId: user.id,
        action: "business.created",
        entity: "business",
        entityId: business.id,
      },
    });

    await setActiveBusinessId(business.id);

    revalidatePath("/dashboard");
    return { success: true, businessId: business.id };
  } catch (error) {
    console.error("[createBusiness] failed:", error);
    return {
      error: {
        _form: [
          error instanceof Error
            ? error.message
            : "Could not create business. Check DATABASE_URL and Clerk keys on Vercel.",
        ],
      },
    };
  }
}

function formValue(value: FormDataEntryValue | null): string | undefined {
  if (value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function formatActionError(error: unknown, fallback: string): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return "A product with this SKU already exists";
    }
    if (error.code === "P2022") {
      return "Database update required. Tap Fix Database on the inventory screen, or run database/repair-product-schema.sql in Supabase.";
    }
  }
  if (error instanceof Error) {
    if (error.message.includes("Body exceeded") || error.message.includes("413")) {
      return "Image is too large. Use a file under 5 MB.";
    }
    if (process.env.NODE_ENV === "development") {
      return error.message;
    }
  }
  return fallback;
}

function formatFieldErrors(error: Record<string, string[] | undefined>): string {
  const message = Object.values(error).flat().find(Boolean);
  return message ?? "Please check your inputs";
}

async function applyProductImageFromForm(
  formData: FormData,
  businessId: string,
  productId: string,
  existingImageUrl: string | null
): Promise<{ imageUrl: string | null; unchanged: boolean; error?: string }> {
  const removeImage = formData.get("removeImage") === "true";
  const imageFile = formData.get("image");

  if (removeImage) {
    await deleteProductImage(existingImageUrl);
    return { imageUrl: null, unchanged: false };
  }

  if (!(imageFile instanceof File) || imageFile.size === 0) {
    return { imageUrl: existingImageUrl, unchanged: true };
  }

  const validationError = validateProductImageFile(imageFile);
  if (validationError) {
    return { imageUrl: existingImageUrl, unchanged: true, error: validationError };
  }

  try {
    if (existingImageUrl) {
      await deleteProductImage(existingImageUrl);
    }
    const imageUrl = await uploadProductImage(businessId, imageFile, productId);
    return { imageUrl, unchanged: false };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not upload image";
    return { imageUrl: existingImageUrl, unchanged: true, error: message };
  }
}

export async function createProduct(formData: FormData) {
  try {
    const user = await currentUser();
    if (!user) {
      return { error: "You must be signed in to add products" };
    }

    await syncClerkUser({
      id: user.id,
      emailAddresses: user.emailAddresses,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });

    const ctx = await requireSectionAccess("inventory");

    const parsed = productSchema.safeParse({
      name: formData.get("name"),
      sku: formValue(formData.get("sku")),
      barcode: formValue(formData.get("barcode")),
      category: formValue(formData.get("category")),
      purchasePrice: formData.get("purchasePrice"),
      sellingPrice: formData.get("sellingPrice"),
      unitsPerPack: formData.get("unitsPerPack") ?? "1",
      quantity: formData.get("quantity"),
      reorderLevel: formData.get("reorderLevel"),
      batchNumber: formValue(formData.get("batchNumber")),
      expiryDate: formValue(formData.get("expiryDate")),
      supplierId: formValue(formData.get("supplierId")),
    });

    if (!parsed.success) {
      return { error: formatFieldErrors(parsed.error.flatten().fieldErrors) };
    }

    const { expiryDate, sku, barcode, category, batchNumber, supplierId, ...rest } =
      parsed.data;

    let resolvedSupplierId: string | null = null;
    if (supplierId) {
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, businessId: ctx.businessId },
        select: { id: true },
      });
      if (!supplier) {
        return { error: "Selected supplier not found" };
      }
      resolvedSupplierId = supplier.id;
    }

    const attributes = readProductAttributesFromForm(
      ctx.business.industry,
      (name) => formValue(formData.get(name))
    );
    if (!attributes.success) {
      return { error: attributes.message };
    }

    const product = await createInventoryProduct({
      ...rest,
      sku: sku ?? null,
      barcode: barcode ?? null,
      category: category ?? null,
      batchNumber: batchNumber ?? null,
      supplierId: resolvedSupplierId,
      businessId: ctx.businessId,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      ...(attributes.attributes ? { attributes: attributes.attributes } : {}),
    });

    const imageResult = await applyProductImageFromForm(
      formData,
      ctx.businessId,
      product.id,
      null
    );

    if (imageResult.error) {
      revalidatePath("/inventory");
      return {
        success: true,
        product,
        warning: `Product saved, but image upload failed: ${imageResult.error}`,
      };
    }

    if (!imageResult.unchanged) {
      await updateProductImageUrl(product.id, ctx.businessId, imageResult.imageUrl);
    }

    revalidatePath("/inventory");
    return { success: true, product };
  } catch (error) {
    if (error instanceof Error && error.message.includes("access")) {
      return { error: error.message };
    }
    console.error("createProduct failed:", error);
    return {
      error: formatActionError(
        error,
        "Could not save product. Check your connection and try again."
      ),
    };
  }
}

export async function updateProduct(productId: string, formData: FormData) {
  try {
    const ctx = await requireSectionAccess("inventory");

    const existing = await getInventoryProduct(ctx.businessId, productId);
    if (!existing) {
      return { error: "Product not found" };
    }

    const parsed = productSchema.safeParse({
      name: formData.get("name"),
      sku: formValue(formData.get("sku")),
      barcode: formValue(formData.get("barcode")),
      category: formValue(formData.get("category")),
      purchasePrice: formData.get("purchasePrice"),
      sellingPrice: formData.get("sellingPrice"),
      unitsPerPack: formData.get("unitsPerPack") ?? "1",
      quantity: formData.get("quantity"),
      reorderLevel: formData.get("reorderLevel"),
      batchNumber: formValue(formData.get("batchNumber")),
      expiryDate: formValue(formData.get("expiryDate")),
      supplierId: formValue(formData.get("supplierId")),
    });

    if (!parsed.success) {
      return { error: formatFieldErrors(parsed.error.flatten().fieldErrors) };
    }

    const { expiryDate, sku, barcode, category, batchNumber, quantity, supplierId, ...rest } =
      parsed.data;

    let resolvedSupplierId: string | null = null;
    if (supplierId) {
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, businessId: ctx.businessId },
        select: { id: true },
      });
      if (!supplier) {
        return { error: "Selected supplier not found" };
      }
      resolvedSupplierId = supplier.id;
    }

    const quantityDelta = quantity - existing.quantity;

    const imageResult = await applyProductImageFromForm(
      formData,
      ctx.businessId,
      productId,
      existing.imageUrl
    );

    let imageWarning: string | undefined;
    if (imageResult.error) {
      imageWarning = `Product saved, but image upload failed: ${imageResult.error}`;
    }

    const attributes = readProductAttributesFromForm(
      ctx.business.industry,
      (name) => formValue(formData.get(name))
    );
    if (!attributes.success) {
      return { error: attributes.message };
    }

    await prisma.$transaction(async (tx) => {
      await updateInventoryProduct(
        productId,
        {
          ...rest,
          quantity,
          sku: sku ?? null,
          barcode: barcode ?? null,
          category: category ?? null,
          batchNumber: batchNumber ?? null,
          supplierId: resolvedSupplierId,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          ...(attributes.attributes ? { attributes: attributes.attributes } : {}),
        },
        tx
      );

      if (quantityDelta !== 0) {
        await tx.stockAdjustment.create({
          data: {
            productId,
            businessId: ctx.businessId,
            type: "MANUAL",
            quantity: quantityDelta,
            reason: "Inventory update",
            createdBy: ctx.userId,
          },
        });
      }
    });

    if (!imageResult.error && !imageResult.unchanged) {
      await updateProductImageUrl(productId, ctx.businessId, imageResult.imageUrl);
    }

    revalidatePath("/inventory");
    revalidatePath(`/inventory/${productId}`);
    return imageWarning
      ? { success: true, warning: imageWarning }
      : { success: true };
  } catch (error) {
    console.error("updateProduct failed:", error);
    return { error: formatActionError(error, "Could not update product") };
  }
}

export async function deleteProduct(productId: string) {
  try {
    const ctx = await requireSectionAccess("inventory");

    if (!hasPermission(ctx.role, [Role.OWNER, Role.MANAGER])) {
      return { error: "Only owners and managers can remove products" };
    }

    const deactivated = await deactivateInventoryProduct(
      ctx.businessId,
      productId
    );

    if (!deactivated) {
      return { error: "Product not found" };
    }

    if (deactivated.imageUrl) {
      await deleteProductImage(deactivated.imageUrl);
    }

    revalidatePath("/inventory");
    revalidatePath("/pos");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { success: true };
  } catch (error) {
    console.error("deleteProduct failed:", error);
    return { error: formatActionError(error, "Could not remove product") };
  }
}

export async function createExpense(formData: FormData) {
  const ctx = await requireSectionAccess("expenses");
  const parsed = expenseSchema.safeParse({
    category: formData.get("category"),
    amount: formData.get("amount"),
    description: formData.get("description") || undefined,
    date: formData.get("date") || undefined,
  });

  if (!parsed.success) {
    return { error: formatFieldErrors(parsed.error.flatten().fieldErrors) };
  }

  const expense = await prisma.expense.create({
    data: {
      businessId: ctx.businessId,
      category: parsed.data.category,
      amount: parsed.data.amount,
      description: parsed.data.description,
      date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
      createdBy: ctx.userId,
    },
    select: { id: true },
  });

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  return { success: true, expense };
}

export async function deleteExpense(expenseId: string) {
  try {
    const ctx = await requireSectionAccess("expenses");

    const expense = await prisma.expense.findFirst({
      where: { id: expenseId, businessId: ctx.businessId },
      select: { id: true },
    });

    if (!expense) {
      return { error: "Expense not found" };
    }

    await prisma.expense.delete({ where: { id: expenseId } });

    revalidatePath("/expenses");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { success: true };
  } catch (error) {
    console.error("deleteExpense failed:", error);
    return { error: "Could not delete expense" };
  }
}

export async function updateBusiness(formData: FormData) {
  try {
    const ctx = await requireSectionAccess("settings");

    const parsed = updateBusinessSchema.safeParse({
      name: formData.get("name"),
      industry: formData.get("industry"),
      industryLabel: formValue(formData.get("industryLabel")),
      currency: formData.get("currency") || "NGN",
      address: formValue(formData.get("address")),
      phone: formValue(formData.get("phone")),
    });

    if (!parsed.success) {
      return { error: formatFieldErrors(parsed.error.flatten().fieldErrors) };
    }

    try {
      await prisma.business.update({
        where: { id: ctx.businessId },
        data: {
          name: parsed.data.name,
          industry: parsed.data.industry,
          industryLabel: parsed.data.industryLabel ?? null,
          currency: parsed.data.currency,
          address: parsed.data.address ?? null,
          phone: parsed.data.phone ?? null,
        },
      });
    } catch (updateError) {
      const detail =
        updateError instanceof Error ? updateError.message : String(updateError);
      if (!/industryLabel|column.*does not exist|P2022/i.test(detail)) {
        throw updateError;
      }
      await prisma.business.update({
        where: { id: ctx.businessId },
        data: {
          name: parsed.data.name,
          industry: parsed.data.industry,
          currency: parsed.data.currency,
          address: parsed.data.address ?? null,
          phone: parsed.data.phone ?? null,
        },
      });
    }

    revalidatePath("/settings");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    console.error("updateBusiness failed:", error);
    return { error: "Could not update business profile" };
  }
}

export async function updateCustomer(
  customerId: string,
  data: { name: string; phone?: string; email?: string }
) {
  const ctx = await requireSectionAccess("customers");
  const parsed = customerSchema.safeParse(data);

  if (!parsed.success) {
    return {
      error:
        parsed.error.flatten().fieldErrors.name?.[0] ?? "Invalid customer data",
    };
  }

  const existing = await prisma.customer.findFirst({
    where: { id: customerId, businessId: ctx.businessId },
    select: { id: true },
  });

  if (!existing) {
    return { error: "Customer not found" };
  }

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: parsed.data.name,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
    },
  });

  revalidatePath("/customers");
  revalidatePath("/debts");
  return { success: true, customer };
}

export async function createSale(data: {
  items: { productId: string; quantity: number }[];
  paymentMethod: string;
  customerId?: string;
  discount?: number;
  tax?: number;
  isCredit?: boolean;
}) {
  const ctx = await requireSectionAccess("sales");
  const parsed = saleSchema.safeParse(data);

  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors.customerId?.[0] ?? "Invalid sale data" };
  }

  if (parsed.data.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: parsed.data.customerId, businessId: ctx.businessId },
    });
    if (!customer) {
      return { error: "Customer not found" };
    }
  }

  try {
    const sale = await prisma.$transaction(async (tx) => {
      const productIds = parsed.data.items.map((i) => i.productId);
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

      let subtotal = 0;
      let totalCost = 0;
      const saleItems: {
        productId: string;
        quantity: number;
        cost: number;
        sellingPrice: number;
        total: number;
      }[] = [];

      for (const item of parsed.data.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new Error("One or more products were not found");
        }

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
          throw new Error(`Insufficient stock for ${product.name}`);
        }

        saleItems.push({
          productId: item.productId,
          quantity: item.quantity,
          cost,
          sellingPrice,
          total: lineTotal,
        });
      }

      const discount = parsed.data.discount ?? 0;
      const tax = parsed.data.tax ?? 0;
      const total = subtotal - discount + tax;
      const profit = total - totalCost - discount;
      const saleCreatedAt = new Date();
      const receiptNumber = await allocateReceiptNumber(
        tx,
        ctx.businessId,
        saleCreatedAt
      );

      const newSale = await tx.sale.create({
        data: {
          businessId: ctx.businessId,
          customerId: parsed.data.customerId,
          receiptNumber,
          paymentMethod: parsed.data.paymentMethod,
          subtotal,
          discount,
          tax,
          total,
          profit,
          isCredit: parsed.data.paymentMethod === "CREDIT",
          dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
          createdBy: ctx.userId,
          createdAt: saleCreatedAt,
          items: { create: saleItems },
        },
        include: { items: true },
      });

      for (const item of parsed.data.items) {
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

      if (parsed.data.customerId) {
        if (parsed.data.paymentMethod === "CREDIT") {
          const updated = await tx.customer.updateMany({
            where: { id: parsed.data.customerId, businessId: ctx.businessId },
            data: {
              debt: { increment: total },
              lastPurchase: new Date(),
              lifetimeValue: { increment: total },
            },
          });
          if (updated.count === 0) {
            throw new Error("Customer not found");
          }
        } else {
          await tx.customer.updateMany({
            where: { id: parsed.data.customerId, businessId: ctx.businessId },
            data: {
              lastPurchase: new Date(),
              lifetimeValue: { increment: total },
            },
          });
        }
      }

      return newSale;
    });

    notifyOwnerOfSale(ctx.businessId, {
      total: Number(sale.total),
      paymentMethod: sale.paymentMethod,
      itemCount: sale.items.length,
    }).catch((err) => console.error("[notifyOwnerOfSale]", err));

    revalidatePath("/sales");
    revalidatePath("/sales/history");
    revalidatePath("/dashboard");
    revalidatePath("/inventory");
    revalidatePath("/customers");
    revalidatePath("/debts");
    return { success: true, sale };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not complete sale";
    return { error: message };
  }
}

export async function createCustomer(data: {
  name: string;
  phone?: string;
  email?: string;
}) {
  const ctx = await requireSectionAccess("customers");
  const parsed = customerSchema.safeParse(data);

  if (!parsed.success) {
    return { error: parsed.error.flatten().fieldErrors.name?.[0] ?? "Invalid customer data" };
  }

  const customer = await prisma.customer.create({
    data: {
      businessId: ctx.businessId,
      name: parsed.data.name,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
    },
  });

  revalidatePath("/customers");
  revalidatePath("/debts");
  return { success: true, customer };
}

export async function recordDebtPayment(data: {
  customerId: string;
  amount: number;
}) {
  const ctx = await requireSectionAccess("debts");
  const parsed = debtPaymentSchema.safeParse(data);

  if (!parsed.success) {
    return { error: "Invalid payment amount" };
  }

  const customer = await prisma.customer.findFirst({
    where: { id: parsed.data.customerId, businessId: ctx.businessId },
  });

  if (!customer) {
    return { error: "Customer not found" };
  }

  const currentDebt = Number(customer.debt);
  if (parsed.data.amount > currentDebt) {
    return { error: "Payment exceeds outstanding debt" };
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: { debt: { decrement: parsed.data.amount } },
  });

  revalidatePath("/debts");
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { success: true };
}

export async function addCustomerDebt(data: {
  customerId: string;
  amount: number;
}) {
  const ctx = await requireSectionAccess("debts");
  const parsed = debtPaymentSchema.safeParse(data);

  if (!parsed.success) {
    return { error: "Enter a valid customer and amount" };
  }

  const customer = await prisma.customer.findFirst({
    where: { id: parsed.data.customerId, businessId: ctx.businessId },
  });

  if (!customer) {
    return { error: "Customer not found" };
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: { debt: { increment: parsed.data.amount } },
  });

  revalidatePath("/debts");
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { success: true };
}

export async function sendAIMessage(
  message: string,
  history: { role: "user" | "assistant"; content: string }[] = []
) {
  const ctx = await requireSectionAccess("ai");
  const subscription = await prisma.subscription.findUnique({
    where: { businessId: ctx.businessId },
  });
  const { canAccessFeature } = await import("@/lib/subscription");
  if (!canAccessFeature(subscription, "ai")) {
    return {
      error:
        "AI Assistant requires an active subscription. Upgrade at Settings → Billing.",
    };
  }

  try {
    const { chatWithAI, isAIProviderConfigured } = await import("@/ai/assistant");
    const { getAiPromptUsage } = await import("@/lib/ai-usage-limit");

    const response = await chatWithAI(
      ctx.businessId,
      message,
      history,
      subscription
    );

    const usage = await getAiPromptUsage(ctx.businessId, subscription);
    const usagePayload = usage
      ? {
          dailyRemaining: usage.dailyRemaining,
          dailyLimit: usage.dailyLimit,
          tierLabel: usage.tierLabel,
        }
      : null;

    if (!isAIProviderConfigured()) {
      return {
        response,
        offline: true as const,
        usage: usagePayload,
      };
    }

    return { response, usage: usagePayload };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (/ai_prompt_logs|receiptNumber|schema|column|does not exist/i.test(detail)) {
      return {
        error:
          "Database schema needs a quick update. In Supabase SQL Editor, run the script database/repair-app-schema.sql (or redeploy with RUN_PRISMA_MIGRATE=true).",
      };
    }
    console.error("[sendAIMessage]", error);
    return {
      error: "Sorry, the AI assistant could not respond. Please try again.",
    };
  }
}

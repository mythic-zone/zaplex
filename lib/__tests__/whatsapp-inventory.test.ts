import { describe, expect, it, vi, beforeEach } from "vitest";
import { similarityScore, AUTO_MATCH_THRESHOLD } from "@/lib/ai/whatsapp-inventory/matching";
import {
  findHardIssues,
  findMissingFields,
  findPriceDeviations,
  MAX_ITEMS_PER_COMMIT,
  PRICE_DEVIATION_THRESHOLD,
} from "@/lib/ai/whatsapp-inventory/validation";
import { invoiceExtractionSchema, inventoryReplySchema } from "@/lib/ai/whatsapp-inventory/extraction";
import type { DraftItem } from "@/lib/ai/whatsapp-inventory/types";

const mockPrisma = vi.hoisted(() => ({
  business: { findUnique: vi.fn() },
  product: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

function item(overrides: Partial<DraftItem> = {}): DraftItem {
  return {
    productNameGuess: "Paracetamol 500mg",
    quantity: 10,
    confidence: 0.8,
    ...overrides,
  };
}

describe("similarityScore (fuzzy product/supplier matching)", () => {
  it("scores an exact match at 1", () => {
    expect(similarityScore("Paracetamol", "Paracetamol")).toBe(1);
  });

  it("scores case/punctuation-insensitive matches highly", () => {
    expect(similarityScore("Paracetamol 500mg", "paracetamol 500mg!")).toBeGreaterThan(AUTO_MATCH_THRESHOLD);
  });

  it("scores an abbreviation against the full name below the auto-match threshold", () => {
    const score = similarityScore("Para", "Paracetamol 500mg");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });

  it("scores unrelated names at 0", () => {
    expect(similarityScore("Amoxicillin", "Vitamin C")).toBe(0);
  });

  it("is symmetric-ish for substring containment", () => {
    const a = similarityScore("Amoxicillin 500mg", "Amoxicillin");
    const b = similarityScore("Amoxicillin", "Amoxicillin 500mg");
    expect(a).toBeCloseTo(b, 5);
  });
});

describe("findHardIssues", () => {
  it("rejects zero and negative quantities", () => {
    const issues = findHardIssues([item({ quantity: 0 }), item({ quantity: -5, productNameGuess: "X" })]);
    expect(issues).toHaveLength(2);
  });

  it("rejects non-finite quantities", () => {
    const issues = findHardIssues([item({ quantity: Number.NaN })]);
    expect(issues).toHaveLength(1);
  });

  it("accepts a normal positive quantity", () => {
    expect(findHardIssues([item({ quantity: 10 })])).toHaveLength(0);
  });

  it("flags an invoice with more items than the safety cap", () => {
    const items = Array.from({ length: MAX_ITEMS_PER_COMMIT + 1 }, (_, i) => item({ productNameGuess: `Item ${i}` }));
    const issues = findHardIssues(items);
    expect(issues.some((i) => i.itemIndex === -1)).toBe(true);
  });
});

describe("findMissingFields", () => {
  beforeEach(() => {
    mockPrisma.business.findUnique.mockReset();
  });

  it("requires expiry for pharmacy businesses even on a matched product", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ industry: "PHARMACY" });
    const missing = await findMissingFields("biz_1", [item({ productId: "p1", expiryDate: null })]);
    expect(missing.some((m) => m.reason === "missing_expiry")).toBe(true);
  });

  it("does not require expiry for non-pharmacy businesses", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ industry: "RETAIL" });
    const missing = await findMissingFields("biz_1", [item({ productId: "p1", expiryDate: null })]);
    expect(missing.some((m) => m.reason === "missing_expiry")).toBe(false);
  });

  it("flags an unmatched product as ambiguous instead of requiring cost/expiry", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ industry: "RETAIL" });
    const missing = await findMissingFields("biz_1", [item({ productId: undefined, isNewProduct: false })]);
    expect(missing).toEqual([
      { itemIndex: 0, reason: "ambiguous_product", productNameGuess: "Paracetamol 500mg" },
    ]);
  });

  it("requires unit cost and selling price for a brand-new product but not a restock", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ industry: "RETAIL" });
    const missing = await findMissingFields("biz_1", [
      item({ isNewProduct: true, unitCost: null, sellingPrice: null }),
    ]);
    const reasons = missing.map((m) => m.reason);
    expect(reasons).toContain("missing_unit_cost");
    expect(reasons).toContain("missing_selling_price");
  });

  it("does not require unit cost for a restock of an existing product", async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ industry: "RETAIL" });
    const missing = await findMissingFields("biz_1", [item({ productId: "p1", unitCost: null })]);
    expect(missing).toHaveLength(0);
  });
});

describe("findPriceDeviations", () => {
  beforeEach(() => {
    mockPrisma.product.findFirst.mockReset();
  });

  it("flags a unit cost more than the deviation threshold away from the product's usual price", async () => {
    mockPrisma.product.findFirst.mockResolvedValue({ name: "Paracetamol", purchasePrice: 100 });
    const flagged = await findPriceDeviations("biz_1", [item({ productId: "p1", unitCost: 250 })]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].deviation).toBeGreaterThan(PRICE_DEVIATION_THRESHOLD);
  });

  it("does not flag a small, normal price change", async () => {
    mockPrisma.product.findFirst.mockResolvedValue({ name: "Paracetamol", purchasePrice: 100 });
    const flagged = await findPriceDeviations("biz_1", [item({ productId: "p1", unitCost: 110 })]);
    expect(flagged).toHaveLength(0);
  });

  it("skips items with no matched product or no unit cost", async () => {
    const flagged = await findPriceDeviations("biz_1", [item({ productId: undefined, unitCost: 250 })]);
    expect(flagged).toHaveLength(0);
    expect(mockPrisma.product.findFirst).not.toHaveBeenCalled();
  });
});

describe("PRICE_DEVIATION_THRESHOLD", () => {
  it("is a meaningful fraction, not zero or absurdly high", () => {
    expect(PRICE_DEVIATION_THRESHOLD).toBeGreaterThan(0);
    expect(PRICE_DEVIATION_THRESHOLD).toBeLessThan(2);
  });
});

describe("invoiceExtractionSchema", () => {
  it("accepts a well-formed extraction", () => {
    const result = invoiceExtractionSchema.safeParse({
      supplierNameGuess: "Emzor",
      invoiceNumber: "INV-001",
      items: [{ productNameGuess: "Paracetamol", quantity: 50, confidence: 0.9 }],
      confidenceOverall: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an extraction with zero items", () => {
    const result = invoiceExtractionSchema.safeParse({ items: [], confidenceOverall: 0.5 });
    expect(result.success).toBe(false);
  });

  it("rejects an item missing a product name", () => {
    const result = invoiceExtractionSchema.safeParse({
      items: [{ quantity: 10, confidence: 0.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("clamps confidence defaults when the model omits it", () => {
    const result = invoiceExtractionSchema.safeParse({
      items: [{ productNameGuess: "X", quantity: 1 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0].confidence).toBe(0.5);
    }
  });

  it("rejects a confidence value outside 0-1", () => {
    const result = invoiceExtractionSchema.safeParse({
      items: [{ productNameGuess: "X", quantity: 1, confidence: 1.5 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("inventoryReplySchema", () => {
  it("accepts a minimal confirm reply", () => {
    const result = inventoryReplySchema.safeParse({ intent: "confirm" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown intent (guards against model drift/hallucination)", () => {
    const result = inventoryReplySchema.safeParse({ intent: "delete_everything" });
    expect(result.success).toBe(false);
  });

  it("accepts a full add_stock reply with all optional fields", () => {
    const result = inventoryReplySchema.safeParse({
      transcript: "I got 50 packs of Paracetamol at 150 each",
      intent: "add_stock",
      productNameGuess: "Paracetamol",
      quantity: 50,
      unitCost: 150,
      sellingPrice: 200,
      expiryDate: "2027-01-01",
      batchNumber: "B123",
      supplierNameGuess: "Emzor",
    });
    expect(result.success).toBe(true);
  });
});

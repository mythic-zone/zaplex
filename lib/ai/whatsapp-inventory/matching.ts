import { prisma } from "@/lib/db";

export interface MatchCandidate<T> {
  item: T;
  score: number;
}

/** Auto-link when the top match scores at or above this. Below it, ask the user to confirm. */
export const AUTO_MATCH_THRESHOLD = 0.72;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(name: string): string[] {
  return normalize(name)
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * Small pure token-overlap + substring scorer. No fuzzy-match library exists
 * in this repo and none is needed — a business has dozens to low hundreds of
 * products/suppliers, not a search-index-scale problem.
 */
export function similarityScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  if (na.includes(nb) || nb.includes(na)) {
    const longer = Math.max(na.length, nb.length);
    const shorter = Math.min(na.length, nb.length);
    // Weighted heavily by length ratio: a short abbreviation ("Para") should
    // score low enough to trigger a confirmation question rather than silently
    // auto-matching, while a near-full-word prefix ("Amoxicillin" of
    // "Amoxicillin 500mg") scores high enough to auto-link.
    return 0.5 + 0.45 * (shorter / longer);
  }

  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap++;
    else if ([...tb].some((other) => other.length > 3 && t.length > 3 && (other.startsWith(t) || t.startsWith(other)))) {
      overlap += 0.6;
    }
  }

  return overlap / Math.max(ta.size, tb.size);
}

function rank<T>(items: T[], nameOf: (item: T) => string, query: string, limit: number): MatchCandidate<T>[] {
  return items
    .map((item) => ({ item, score: similarityScore(nameOf(item), query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function matchProduct(businessId: string, nameGuess: string, limit = 3) {
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true },
    select: {
      id: true,
      name: true,
      sku: true,
      purchasePrice: true,
      sellingPrice: true,
      quantity: true,
      supplierId: true,
    },
  });
  return rank(products, (p) => p.name, nameGuess, limit);
}

export async function matchSupplier(businessId: string, nameGuess: string, limit = 3) {
  const suppliers = await prisma.supplier.findMany({
    where: { businessId },
    select: { id: true, name: true, contact: true },
  });
  return rank(suppliers, (s) => s.name, nameGuess, limit);
}

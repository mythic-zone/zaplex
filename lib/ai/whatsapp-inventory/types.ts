export interface DraftItem {
  productNameGuess: string;
  productId?: string | null;
  isNewProduct?: boolean;
  quantity: number;
  unit?: string | null;
  unitCost?: number | null;
  /** Only meaningful (and required) for brand-new products — existing products already have one. */
  sellingPrice?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  confidence: number;
}

export interface DraftSupplierGuess {
  nameGuess: string;
  supplierId?: string | null;
  isNew: boolean;
}

export interface DraftState {
  items: DraftItem[];
  supplier?: DraftSupplierGuess | null;
  invoiceNumber?: string | null;
}

export type MissingFieldReason =
  | "ambiguous_product"
  | "missing_unit_cost"
  | "missing_selling_price"
  | "missing_expiry"
  | "ambiguous_supplier"
  | "missing_quantity";

export interface MissingField {
  itemIndex: number;
  reason: MissingFieldReason;
  productNameGuess: string;
}

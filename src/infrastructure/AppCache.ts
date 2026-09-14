import type { PosCategory, PosProduct, PosAddition, PosSauce, PosCombo } from "../features/pos/PosService";
import type { DeliveryType, BusinessConfig } from "../features/config/BusinessConfigService";

const TTL_DEFAULT = 5 * 60 * 1000;
const TTL_PRINTERS = 5 * 60 * 1000;

type Entry<T> = { data: T; ts: number };

function fresh<T>(entry: Entry<T> | null, ttl = TTL_DEFAULT): T | null {
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) return null;
  return entry.data;
}

class AppCache {
  private categories: Entry<PosCategory[]> | null = null;
  private products: Map<string, Entry<PosProduct[]>> = new Map();
  private combos: Entry<PosCombo[]> | null = null;
  private additions: Entry<PosAddition[]> | null = null;
  private sauces: Entry<{ items: PosSauce[]; max: number }> | null = null;
  private deliveryTypes: Entry<DeliveryType[]> | null = null;
  private businessConfig: Entry<BusinessConfig> | null = null;
  private printers: Entry<string[]> | null = null;

  getCategories() { return fresh(this.categories); }
  setCategories(data: PosCategory[]) { this.categories = { data, ts: Date.now() }; }

  getProducts(categoryId: string | null) { return fresh(this.products.get(categoryId ?? "__all__") ?? null); }
  setProducts(categoryId: string | null, data: PosProduct[]) { this.products.set(categoryId ?? "__all__", { data, ts: Date.now() }); }

  getCombos() { return fresh(this.combos); }
  setCombos(data: PosCombo[]) { this.combos = { data, ts: Date.now() }; }

  getAdditions() { return fresh(this.additions); }
  setAdditions(data: PosAddition[]) { this.additions = { data, ts: Date.now() }; }

  getSauces() { return fresh(this.sauces); }
  setSauces(data: { items: PosSauce[]; max: number }) { this.sauces = { data, ts: Date.now() }; }

  getDeliveryTypes() { return fresh(this.deliveryTypes); }
  setDeliveryTypes(data: DeliveryType[]) { this.deliveryTypes = { data, ts: Date.now() }; }

  getBusinessConfig() { return fresh(this.businessConfig); }
  setBusinessConfig(data: BusinessConfig) { this.businessConfig = { data, ts: Date.now() }; }

  getPrinters() { return fresh(this.printers, TTL_PRINTERS); }
  setPrinters(data: string[]) { this.printers = { data, ts: Date.now() }; }

  invalidate(key: "categories" | "products" | "combos" | "additions" | "sauces" | "deliveryTypes" | "businessConfig" | "printers") {
    if (key === "categories") this.categories = null;
    else if (key === "products") { this.products.clear(); this.combos = null; }
    else if (key === "combos") this.combos = null;
    else if (key === "additions") this.additions = null;
    else if (key === "sauces") this.sauces = null;
    else if (key === "deliveryTypes") this.deliveryTypes = null;
    else if (key === "businessConfig") this.businessConfig = null;
    else if (key === "printers") this.printers = null;
  }

  invalidateAll() {
    this.categories = null;
    this.products.clear();
    this.combos = null;
    this.additions = null;
    this.sauces = null;
    this.deliveryTypes = null;
    this.businessConfig = null;
    this.printers = null;
  }
}

export const appCache = new AppCache();

import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { jsPDF } from "jspdf";
import { appConfig } from "../../config/AppConfig";
import { sessionContext } from "../../core/session/SessionContext";
import { tenantRepository } from "../../infrastructure/sqlite/repositories";
import { databaseManager } from "../../infrastructure/sqlite/DatabaseManager";
import { syncQueueRepository } from "../../infrastructure/sqlite/repositories";
import type { CashSession } from "../cashregister/CashRegisterService";
import type { DeliveryType } from "../config/BusinessConfigService";
import type { PosAddition, PosSauce } from "./PosService";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SalePaymentMethod = "CASH" | "CARD" | "SPLIT";

export type SaleRequest = {
  cash: CashSession;
  items: SaleItemRequest[];
  paymentMethod: SalePaymentMethod;
  total: number;
  /** Only for CASH and SPLIT */
  cashGiven?: number;
  changeGiven?: number;
  /** Only for SPLIT */
  cashAmount?: number;
  cardAmount?: number;
  notes?: string;
  delivery?: {
    type: DeliveryType;
    paymentMethod: SalePaymentMethod;
  };
};

export type SaleItemRequest = {
  key: string;
  name: string;
  price: number;
  originalPrice: number;
  quantity: number;
  kind: "product" | "combo";
  selectedOption: string | null;
  note: string;
  additions: Record<string, number>;
  sauces: string[];
  /** Only for combos */
  children: SaleChildRequest[];
  /** Metadata needed for stock deduction */
  productId: string;
  categoryName: string | null;
};

export type SaleChildRequest = {
  productId: string;
  name: string;
  quantity: number;
  additions: Record<string, number>;
  sauces: string[];
  selectedOption: string | null;
};

export type SaleResult = {
  saleId: string;
  invoiceNumber: string;
  changeGiven: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

async function nextInvoiceNumber(database: Awaited<ReturnType<typeof databaseManager.database>>, tenantId: string): Promise<string> {
  const today = new Date();
  const prefix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const rows = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM sales WHERE tenant_id=$1 AND invoice_number LIKE $2",
    [tenantId, `${prefix}%`],
  );
  const seq = (Number(rows[0]?.count ?? 0) + 1).toString().padStart(4, "0");
  return `${prefix}${seq}`;
}

async function deductProductStock(
  database: Awaited<ReturnType<typeof databaseManager.database>>,
  tenantId: string,
  userId: string,
  userName: string,
  productId: string,
  productName: string,
  quantity: number,
  invoiceNumber: string,
) {
  // Capa 1: stock directo del producto
  const stockRows = await database.select<{ stock: number | null }[]>(
    "SELECT stock FROM products WHERE id=$1 AND stock IS NOT NULL",
    [productId],
  );
  if (stockRows.length > 0) {
    const before = Number(stockRows[0].stock ?? 0);
    const after = before - quantity;
    await database.execute("UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock IS NOT NULL", [quantity, productId]);
    await database.execute(
      "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'PRODUCT',$5,$6,$7,$8,$9,$10)",
      [crypto.randomUUID(), tenantId, userId, userName, productId, `${productName} [Factura ${invoiceNumber}]`, -quantity, before, after, now()],
    );
    await syncQueueRepository.enqueue("products", productId, "UPDATE", { id: productId, stock: after, updated_at: now() });
  }

  // Capa 2: insumos vinculados al producto
  const supplies = await database.select<{ supply_id: string; name: string; quantity_per_sale: number }[]>(
    "SELECT ps.supply_id, s.name, ps.quantity_per_sale FROM product_supplies ps JOIN supplies s ON s.id=ps.supply_id WHERE ps.product_id=$1",
    [productId],
  );
  for (const link of supplies) {
    const toDeduct = Number(link.quantity_per_sale) * quantity;
    const supplyRows = await database.select<{ stock: number }[]>("SELECT stock FROM supplies WHERE id=$1", [link.supply_id]);
    const supplyBefore = Number(supplyRows[0]?.stock ?? 0);
    const supplyAfter = supplyBefore - toDeduct;
    await database.execute("UPDATE supplies SET stock=stock-$1,updated_at=$2 WHERE id=$3", [toDeduct, now(), link.supply_id]);
    await database.execute(
      "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'SUPPLY',$5,$6,$7,$8,$9,$10)",
      [crypto.randomUUID(), tenantId, userId, userName, link.supply_id, `${link.name} (${productName}) [Factura ${invoiceNumber}]`, -toDeduct, supplyBefore, supplyAfter, now()],
    );
    await syncQueueRepository.enqueue("supplies", link.supply_id, "UPDATE", { id: link.supply_id, stock: supplyAfter, updated_at: now() });
  }
}

async function deductAdditionStock(
  database: Awaited<ReturnType<typeof databaseManager.database>>,
  tenantId: string,
  userId: string,
  userName: string,
  additionId: string,
  additionName: string,
  qty: number,
  invoiceNumber: string,
) {
  // qty = item.quantity * addition.quantity
  const qpsRows = await database.select<{ quantity_per_sale: number | null; stock: number | null }[]>(
    "SELECT quantity_per_sale, stock FROM additions WHERE id=$1",
    [additionId],
  );
  const qps = Number(qpsRows[0]?.quantity_per_sale ?? 1) || 1;
  const toDeduct = qps * qty;

  // Capa 1: stock directo de la adicion
  if (qpsRows[0]?.stock !== null && qpsRows[0]?.stock !== undefined) {
    const before = Number(qpsRows[0].stock);
    const after = before - toDeduct;
    await database.execute("UPDATE additions SET stock=stock-$1 WHERE id=$2 AND stock IS NOT NULL", [toDeduct, additionId]);
    await database.execute(
      "INSERT INTO stock_logs(id,tenant_id,user_id,user_name,item_type,item_id,item_name,delta,stock_before,stock_after,created_at) VALUES($1,$2,$3,$4,'ADDITION',$5,$6,$7,$8,$9,$10)",
      [crypto.randomUUID(), tenantId, userId, userName, additionId, `${additionName} [Factura ${invoiceNumber}]`, -toDeduct, before, after, now()],
    );
  }

}

// ---------------------------------------------------------------------------
// SaleService
// ---------------------------------------------------------------------------

class SaleService {
  private session() {
    const s = sessionContext.current();
    if (!s) throw new Error("No hay una sesion activa.");
    return s;
  }

  async confirm(req: SaleRequest, allAdditions: PosAddition[], allSauces: PosSauce[]): Promise<SaleResult> {
    const session = this.session();
    const { tenantId, user } = session;
    const userId = user.id;
    const userName = user.display_name || user.username;
    const database = await databaseManager.database();

    const saleId = crypto.randomUUID();
    const createdAt = now();
    const invoiceNumber = await nextInvoiceNumber(database, tenantId);
    const isDelivery = !!req.delivery;
    const deliveryPrice = req.delivery?.type.price ?? null;
    const cashGiven = req.cashGiven ?? null;
    const changeGiven = req.changeGiven ?? null;
    const cashAmount = req.paymentMethod === "SPLIT" ? (req.cashAmount ?? null) : null;
    const cardAmount = req.paymentMethod === "SPLIT" ? (req.cardAmount ?? null) : null;

    // Step 1: INSERT sale
    await database.execute(
      `INSERT INTO sales(
        id, tenant_id, user_id, cash_session_id, total, payment_method,
        cash_given, change_given, invoice_number, notes, created_at,
        is_delivery, table_order_id, cash_amount, card_amount,
        discount_type, discount_value, subtotal,
        delivery_price, client_name,
        collected_by_user_id, collected_by_display_name,
        delivery_type_id, delivery_type_name
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,
        $12,NULL,$13,$14,
        NULL,NULL,$15,
        $16,NULL,
        $17,$18,
        $19,$20
      )`,
      [
        saleId, tenantId, userId, req.cash.id, req.total, req.paymentMethod,
        cashGiven, changeGiven, invoiceNumber, req.notes ?? null, createdAt,
        isDelivery ? 1 : 0, cashAmount, cardAmount,
        req.total, // subtotal = total (sin descuento a nivel de venta)
        deliveryPrice,
        userId, userName,
        req.delivery?.type.id ?? null, req.delivery?.type.name ?? null,
      ],
    );

    // Step 2: Enqueue sale FIRST so FK order is correct when SyncService processes
    await syncQueueRepository.enqueue("sales", saleId, "INSERT", {
      id: saleId, tenant_id: tenantId, user_id: userId, cash_session_id: req.cash.id,
      total: req.total, payment_method: req.paymentMethod,
      cash_given: cashGiven, change_given: changeGiven, invoice_number: invoiceNumber,
      notes: req.notes ?? null, created_at: createdAt,
      is_delivery: isDelivery ? 1 : 0, table_order_id: null,
      cash_amount: cashAmount, card_amount: cardAmount,
      discount_type: null, discount_value: null, subtotal: req.total,
      delivery_price: deliveryPrice ?? 0, client_name: null,
      collected_by_user_id: userId, collected_by_display_name: userName,
      delivery_type_id: req.delivery?.type.id ?? null,
      delivery_type_name: req.delivery?.type.name ?? null,
    });

    // Step 3: INSERT sale_items + adiciones + salsas + descuento de stock
    for (const item of req.items) {
      if (item.kind === "combo") {
        // Parent combo item (sin product_id propio, usa el key como referencia)
        const parentId = crypto.randomUUID();
        await database.execute(
          `INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id,combo_sale_item_id,original_unit_price,category_name)
           VALUES($1,$2,NULL,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL)`,
          [parentId, saleId, item.name, item.quantity, item.price, item.price * item.quantity, item.note || null],
        );
        // Enqueue sale_item BEFORE children (FK order)
        await syncQueueRepository.enqueue("sale_items", parentId, "INSERT", {
          id: parentId, sale_id: saleId, product_id: null, product_name: item.name,
          quantity: item.quantity, unit_price: item.price, subtotal: item.price * item.quantity,
          notes: item.note || null, selected_option: null, combo_id: null, combo_sale_item_id: null,
          original_unit_price: null, category_name: null,
        });

        // Combo children
        for (const child of item.children) {
          const childId = crypto.randomUUID();
          await database.execute(
            `INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id,combo_sale_item_id,original_unit_price,category_name)
             VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,NULL,$9,NULL,NULL)`,
            [childId, saleId, child.productId, child.name, child.quantity, 0, 0, child.selectedOption, parentId],
          );
          await syncQueueRepository.enqueue("sale_items", childId, "INSERT", {
            id: childId, sale_id: saleId, product_id: child.productId, product_name: child.name,
            quantity: child.quantity, unit_price: 0, subtotal: 0, notes: null,
            selected_option: child.selectedOption, combo_id: null, combo_sale_item_id: parentId,
            original_unit_price: null, category_name: null,
          });
          await this.insertAdditionsAndSauces(database, childId, child.additions, child.sauces, allAdditions, allSauces, item.quantity);
          // Stock: hijos de combo no descuentan stock directo (igual que Java)
        }
      } else {
        // Producto normal
        const saleItemId = crypto.randomUUID();
        const hasDiscount = item.price !== item.originalPrice;
        await database.execute(
          `INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id,combo_sale_item_id,original_unit_price,category_name)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10,$11)`,
          [
            saleItemId, saleId, item.productId, item.name, item.quantity,
            item.price, item.price * item.quantity, item.note || null,
            item.selectedOption,
            hasDiscount ? item.originalPrice : null,
            item.categoryName,
          ],
        );
        await syncQueueRepository.enqueue("sale_items", saleItemId, "INSERT", {
          id: saleItemId, sale_id: saleId, product_id: item.productId, product_name: item.name,
          quantity: item.quantity, unit_price: item.price, subtotal: item.price * item.quantity,
          notes: item.note || null, selected_option: item.selectedOption, combo_id: null, combo_sale_item_id: null,
          original_unit_price: hasDiscount ? item.originalPrice : null, category_name: item.categoryName,
        });
        await this.insertAdditionsAndSauces(database, saleItemId, item.additions, item.sauces, allAdditions, allSauces, item.quantity);
        // Descuento de stock (solo productos, no hijos de combo)
        await deductProductStock(database, tenantId, userId, userName, item.productId, item.name, item.quantity, invoiceNumber);
        // Descuento de stock de adiciones
        for (const [additionId, qty] of Object.entries(item.additions)) {
          if (qty <= 0) continue;
          const addition = allAdditions.find((a) => a.id === additionId);
          if (!addition) continue;
          await deductAdditionStock(database, tenantId, userId, userName, additionId, addition.name, item.quantity * qty, invoiceNumber);
        }
      }
    }

    return { saleId, invoiceNumber, changeGiven: req.changeGiven ?? 0 };
  }

  private async insertAdditionsAndSauces(
    database: Awaited<ReturnType<typeof databaseManager.database>>,
    saleItemId: string,
    additions: Record<string, number>,
    sauces: string[],
    allAdditions: PosAddition[],
    allSauces: PosSauce[],
    itemQuantity: number,
  ) {
    for (const [additionId, qty] of Object.entries(additions)) {
      if (qty <= 0) continue;
      const addition = allAdditions.find((a) => a.id === additionId);
      if (!addition) continue;
      const addId = crypto.randomUUID();
      await database.execute(
        "INSERT INTO sale_item_additions(id,sale_item_id,addition_id,addition_name,price,quantity) VALUES($1,$2,$3,$4,$5,$6)",
        [addId, saleItemId, additionId, addition.name, addition.price, qty],
      );
      await syncQueueRepository.enqueue("sale_item_additions", addId, "INSERT", {
        id: addId, sale_item_id: saleItemId, addition_id: additionId,
        addition_name: addition.name, price: addition.price, quantity: qty,
      });
    }
    for (const sauceId of sauces) {
      const sauce = allSauces.find((s) => s.id === sauceId);
      if (!sauce) continue;
      const sauceRowId = crypto.randomUUID();
      await database.execute(
        "INSERT INTO sale_item_sauces(id,sale_item_id,sauce_id,sauce_name) VALUES($1,$2,$3,$4)",
        [sauceRowId, saleItemId, sauceId, sauce.name],
      );
      await syncQueueRepository.enqueue("sale_item_sauces", sauceRowId, "INSERT", {
        id: sauceRowId, sale_item_id: saleItemId, sauce_id: sauceId, sauce_name: sauce.name,
      });
    }
  }

  async openCashDrawer(printerName: string): Promise<void> {
    try {
      await invoke("open_cash_drawer", { printerName });
    } catch {
      // Non-fatal: la venta ya quedo guardada
    }
  }

  async generateAndSaveInvoice(
    result: SaleResult,
    req: SaleRequest,
    sessionNumber: number,
    bizSettings: { name: string; address: string; phone: string; taxId: string; invoiceFooter: string; logoPath: string | null },
    allAdditions: PosAddition[],
    allSauces: PosSauce[],
    openFile = true,
  ): Promise<void> {
    const session = this.session();
    const { tenantId, user } = session;
    const userName = user.display_name || user.username;

    // Fetch tenant slug for QR
    const tenant = await tenantRepository.get(tenantId).catch(() => null);
    const slug = tenant?.slug ?? null;

    const PT_WIDTH = 164;
    const MARGIN = 8;
    const CONTENT_WIDTH = PT_WIDTH - MARGIN * 2;
    const LINE_H = 9; // line height in pt
    const DIVIDER = "--------------------------------";

    // --- First pass: measure content to get final height ---
    // We render twice: once to measure, once to the final correctly-sized doc.
    // jsPDF does not support dynamic page height natively, so we render to a tall
    // page first, measure y, then re-render to the exact height.

    const render = async (doc: jsPDF) => {
      let y = MARGIN + 4;

      const setStyle = (size: number, bold: boolean) => {
        doc.setFontSize(size);
        doc.setFont("helvetica", bold ? "bold" : "normal");
      };
      const centerText = (text: string, size: number, bold = false) => {
        setStyle(size, bold);
        doc.text(text, PT_WIDTH / 2, y, { align: "center" });
        y += LINE_H;
      };
      const leftText = (text: string, size = 7, bold = false) => {
        setStyle(size, bold);
        // wrap long text within content width
        const lines = doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
        doc.text(lines, MARGIN, y);
        y += LINE_H * lines.length;
      };
      const rowText = (leftStr: string, rightStr: string, size = 7, bold = false) => {
        setStyle(size, bold);
        const maxLeft = CONTENT_WIDTH - doc.getTextWidth(rightStr) - 2;
        const truncated = doc.splitTextToSize(leftStr, maxLeft)[0] as string;
        doc.text(truncated, MARGIN, y);
        if (rightStr) doc.text(rightStr, PT_WIDTH - MARGIN, y, { align: "right" });
        y += LINE_H;
      };
      const divider = () => { leftText(DIVIDER, 7, false); };
      const gap = (pt = 3) => { y += pt; };

      // --- Logo (PDF only) ---
      if (bizSettings.logoPath) {
        try {
          const logoBytes = await readFile(bizSettings.logoPath);
          const base64 = btoa(String.fromCharCode(...logoBytes));
          const ext = bizSettings.logoPath.split(".").pop()?.toLowerCase() ?? "png";
          const mime = ext === "jpg" || ext === "jpeg" ? "JPEG" : "PNG";
          const MAX_W = 120;
          // Add image centered; jsPDF will auto-scale
          doc.addImage(`data:image/${mime.toLowerCase()};base64,${base64}`, mime, (PT_WIDTH - MAX_W) / 2, y, MAX_W, 0);
          // Advance y by image rendered height (approximate: 30pt default if unknown)
          y += 34;
          gap(2);
        } catch { /* logo opcional, skip */ }
      }

      // --- Bloque 1: Encabezado ---
      if (bizSettings.name) centerText(bizSettings.name, 11, true);
      if (bizSettings.address) centerText(bizSettings.address, 7);
      if (bizSettings.phone) centerText(`Tel: ${bizSettings.phone}`, 7);
      if (bizSettings.taxId) centerText(`NIT: ${bizSettings.taxId}`, 7);
      divider();

      // --- Bloque 2: Meta ---
      const dateStr = new Intl.DateTimeFormat("es-CO", {
        timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
      }).format(new Date());
      leftText(`Factura #: ${result.invoiceNumber}`);
      leftText(`Fecha:     ${dateStr}`);
      leftText(`Atendido:  ${userName}`);
      leftText(`Cobrado:   ${userName}`);
      leftText(`Caja #${sessionNumber}`);
      divider();

      // --- Bloque 3: Items (agrupados) ---
      type GroupKey = string;
      type Group = { item: SaleItemRequest; quantity: number };
      const groups = new Map<GroupKey, Group>();
      for (const item of req.items) {
        let key: GroupKey;
        if (item.kind === "combo") {
          key = `combo|${item.key}`;
        } else {
          const addKey = Object.entries(item.additions)
            .filter(([, q]) => q > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, q]) => `${id}:${q}`)
            .join(",");
          key = `${item.productId}|${item.selectedOption ?? ""}|${addKey}`;
        }
        const existing = groups.get(key);
        if (existing) existing.quantity += item.quantity;
        else groups.set(key, { item, quantity: item.quantity });
      }

      for (const { item, quantity } of groups.values()) {
        const itemTotal = item.price * quantity;
        rowText(`${quantity}x ${item.name}`, money(itemTotal), 7, true);

        if (item.kind === "product" && item.price !== item.originalPrice) {
          leftText(`   Precio original: ${money(item.originalPrice)}`);
        }
        if (item.selectedOption) leftText(`   >> ${item.selectedOption}`);

        for (const [addId, qty] of Object.entries(item.additions)) {
          if (qty <= 0) continue;
          const addition = allAdditions.find((a) => a.id === addId);
          if (!addition) continue;
          const label = qty > 1 ? `   + ${qty}x ${addition.name}` : `   + ${addition.name}`;
          rowText(label, addition.price > 0 ? `+${money(addition.price * qty)}` : "");
        }
        if (item.sauces.length > 0) {
          const names = item.sauces.map((id) => allSauces.find((s) => s.id === id)?.name ?? "").filter(Boolean);
          leftText(`   Salsas: ${names.join(", ")}`);
        }
        if (item.note) leftText(`   Nota: ${item.note}`);

        // Combo children
        for (const child of item.children) {
          leftText(`  - ${child.quantity > 1 ? `${child.quantity}x ` : ""}${child.name}`);
          if (child.selectedOption) leftText(`      >> ${child.selectedOption}`);
          for (const [addId, qty] of Object.entries(child.additions)) {
            if (qty <= 0) continue;
            const addition = allAdditions.find((a) => a.id === addId);
            if (!addition) continue;
            rowText(`      + ${qty > 1 ? `${qty}x ` : ""}${addition.name}`, addition.price > 0 ? `+${money(addition.price * qty)}` : "");
          }
          if (child.sauces.length > 0) {
            const names = child.sauces.map((id) => allSauces.find((s) => s.id === id)?.name ?? "").filter(Boolean);
            leftText(`      Salsas: ${names.join(", ")}`);
          }
        }
      }

      // --- Bloque 4: Total ---
      divider();
      rowText("TOTAL", money(req.total), 11, true);
      gap(2);

      // --- Bloque 5: Pago ---
      leftText(`Pago:      ${payLabel(req.paymentMethod)}`);
      if (req.paymentMethod === "SPLIT") {
        leftText(`  Efectivo: ${money(req.cashAmount ?? 0)}`);
        leftText(`  Tarjeta:  ${money(req.cardAmount ?? 0)}`);
      }
      if (req.cashGiven != null) {
        leftText(`Recibido:  ${money(req.cashGiven)}`);
        leftText(`Cambio:    ${money(req.changeGiven ?? 0)}`);
      }

      // --- Bloque 6: Domicilio ---
      if (req.delivery) {
        gap(2);
        leftText("*** DOMICILIO ***", 7, true);
        if (req.delivery.type.price > 0) rowText("Precio domicilio:", money(req.delivery.type.price));
        leftText(`Pago domicilio:  ${payLabel(req.delivery.paymentMethod)}`);
      }

      // --- Bloque 7: Notas generales ---
      if (req.notes) { gap(2); leftText(`Nota: ${req.notes}`); }

      // --- Bloque 8: Pie ---
      divider();
      centerText(bizSettings.invoiceFooter || "Gracias por su compra!", 7);
      gap(LINE_H * 4); // feed space

      // --- QR (PDF only) ---
      if (slug) {
        const qrUrl = `${appConfig.baseUrl()}/${slug}/f/${result.saleId}`;
        try {
          const dataUrl = await qrToDataUrl(qrUrl, 120);
          const QR_SIZE = 60;
          doc.addImage(dataUrl, "PNG", (PT_WIDTH - QR_SIZE) / 2, y, QR_SIZE, QR_SIZE);
          y += QR_SIZE + 3;
          centerText("Ver factura digital", 7);
        } catch { /* QR opcional, no bloquea */ }
      }

      return y;
    };

    // First pass on a tall page to measure
    const measDoc = new jsPDF({ unit: "pt", format: [PT_WIDTH, 2000], orientation: "portrait" });
    const finalY = await render(measDoc);
    const pageHeight = finalY + MARGIN;

    // Second pass on correctly-sized page
    const doc = new jsPDF({ unit: "pt", format: [PT_WIDTH, pageHeight], orientation: "portrait" });
    await render(doc);

    const uint8 = new Uint8Array(doc.output("arraybuffer"));
    const fileName = `${result.invoiceNumber}.pdf`;
    const folder = `facturas/caja-${sessionNumber}`;
    await mkdir(folder, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeFile(`${folder}/${fileName}`, uint8, { baseDir: BaseDirectory.AppData });

    if (openFile) {
      try {
        await invoke("save_and_open_invoice_pdf", { sessionNumber, fileName, bytes: Array.from(uint8) });
      } catch { /* Non-fatal: archivo ya guardado */ }
    }
  }

  buildWhatsAppUrl(
    phone: string,
    businessName: string,
    invoiceNumber: string,
    req: SaleRequest,
    allAdditions: PosAddition[],
    allSauces: PosSauce[],
  ): string {
    const normalizePhone = (p: string) => {
      const digits = p.replace(/\D/g, "");
      return digits.length === 10 && digits.startsWith("3") ? `57${digits}` : digits;
    };

    const lines: string[] = [
      `*${businessName}*`,
      req.delivery ? "*Pedido Domicilio*" : "*Pedido*",
      `Factura #${invoiceNumber}`,
    ];

    for (const item of req.items) {
      const itemTotal = item.price * item.quantity;
      lines.push(`${item.quantity}x ${item.name}  ${money(itemTotal)}`);
      if (item.selectedOption) lines.push(`   >> ${item.selectedOption}`);
      for (const [addId, qty] of Object.entries(item.additions)) {
        if (qty <= 0) continue;
        const addition = allAdditions.find((a) => a.id === addId);
        if (!addition) continue;
        const addTotal = addition.price * qty;
        lines.push(`   + ${qty}x ${addition.name}${addTotal > 0 ? `  +${money(addTotal)}` : ""}`);
      }
      if (item.sauces.length > 0) {
        const names = item.sauces.map((id) => allSauces.find((s) => s.id === id)?.name ?? "").filter(Boolean);
        lines.push(`   Salsas: ${names.join(", ")}`);
      }
      if (item.note) lines.push(`   Nota: ${item.note}`);
      for (const child of item.children) {
        lines.push(`  - ${child.quantity > 1 ? `${child.quantity}x ` : ""}${child.name}`);
        if (child.selectedOption) lines.push(`     >> ${child.selectedOption}`);
        for (const [addId, qty] of Object.entries(child.additions)) {
          if (qty <= 0) continue;
          const addition = allAdditions.find((a) => a.id === addId);
          if (!addition) continue;
          lines.push(`     + ${qty}x ${addition.name}`);
        }
        if (child.sauces.length > 0) {
          const names = child.sauces.map((id) => allSauces.find((s) => s.id === id)?.name ?? "").filter(Boolean);
          lines.push(`     Salsas: ${names.join(", ")}`);
        }
      }
    }

    if (req.delivery) {
      lines.push(`Domicilio: ${money(req.delivery.type.price)}`);
    }
    lines.push(`*TOTAL: ${money(req.total)}*`);
    lines.push(`Pago: ${payLabel(req.paymentMethod)}`);
    if (req.paymentMethod === "CASH" && req.cashGiven != null) {
      lines.push(`Recibido: ${money(req.cashGiven)} / Cambio: ${money(req.changeGiven ?? 0)}`);
    }
    if (req.paymentMethod === "SPLIT") {
      lines.push(`  Efectivo: ${money(req.cashAmount ?? 0)} / Tarjeta: ${money(req.cardAmount ?? 0)}`);
    }
    if (req.notes) lines.push(`Notas: ${req.notes}`);

    const text = encodeURIComponent(lines.join("\n"));
    return `https://wa.me/${normalizePhone(phone)}?text=${text}`;
  }
}

// Genera un QR como data URL usando un canvas offscreen del DOM.
// qrcode.react exporta QRCodeSVG/QRCodeCanvas basados en la lib interna `qr.js`.
// En lugar de depender de eso, usamos una implementacion minima de QR via fetch
// a la Google Charts API si hay red, o dejamos el QR en blanco si no hay.
// Como el QR es opcional y el PDF ya se guarda, esto es non-fatal.
async function qrToDataUrl(text: string, size: number): Promise<string> {
  // Usar QRCodeCanvas de qrcode.react renderizando en un div temporal del DOM
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const { QRCodeCanvas } = await import("qrcode.react");

  return new Promise<string>((resolve, reject) => {
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(
      createElement(QRCodeCanvas, {
        value: text,
        size,
        onLoad: () => {
          try {
            const canvas = container.querySelector("canvas");
            if (!canvas) { reject(new Error("canvas not found")); return; }
            resolve(canvas.toDataURL("image/png"));
          } catch (e) { reject(e); } finally {
            root.unmount();
            document.body.removeChild(container);
          }
        },
      } as Parameters<typeof QRCodeCanvas>[0]),
    );
    // Fallback timeout
    setTimeout(() => {
      try {
        const canvas = container.querySelector("canvas");
        if (canvas) resolve(canvas.toDataURL("image/png"));
        else reject(new Error("timeout"));
      } catch (e) { reject(e); } finally {
        try { root.unmount(); document.body.removeChild(container); } catch { /* ignore */ }
      }
    }, 500);
  });
}

function money(value: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

function payLabel(method: SalePaymentMethod) {
  return method === "CASH" ? "Efectivo" : method === "CARD" ? "Tarjeta" : "Dividido";
}

export const saleService = new SaleService();

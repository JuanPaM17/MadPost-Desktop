-- Fase 1: soporte para insumos opcionales (preguntar al vender)

-- product_supplies: modo de descuento por vínculo
ALTER TABLE product_supplies ADD COLUMN deduct_mode TEXT NOT NULL DEFAULT 'always';

-- sale_item_supplies: trazabilidad de qué insumos se descontaron o se skipearon por venta
CREATE TABLE IF NOT EXISTS sale_item_supplies (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  supply_id UUID REFERENCES supplies(id) ON DELETE SET NULL,
  supply_name TEXT NOT NULL,
  deducted BOOLEAN NOT NULL DEFAULT true,
  quantity_deducted NUMERIC NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- stock_logs: columna reason para registrar skips con trazabilidad
ALTER TABLE stock_logs ADD COLUMN reason TEXT;

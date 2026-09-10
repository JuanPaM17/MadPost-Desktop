use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;

use super::{broadcast, ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/sales", get(list_sales).post(create_sale))
        .route("/api/v1/sales/{id}", get(get_sale))
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreateSaleBody {
    #[serde(rename = "paymentMethod")]
    payment_method: Option<String>,
    total: f64,
    #[serde(rename = "cashGiven")]
    cash_given: Option<f64>,
    #[serde(rename = "cashAmount")]
    cash_amount: Option<f64>,
    #[serde(rename = "cardAmount")]
    card_amount: Option<f64>,
    #[serde(rename = "deliveryTypeId")]
    delivery_type_id: Option<String>,
    #[serde(rename = "isDelivery")]
    is_delivery: Option<bool>,
    #[serde(rename = "deliveryFee")]
    delivery_fee: Option<f64>,
    notes: Option<String>,
    #[serde(rename = "clientName")]
    client_name: Option<String>,
    items: Vec<SaleItemInput>,
}

#[derive(Deserialize)]
struct SaleItemInput {
    #[serde(rename = "productId")]
    product_id: Option<String>,
    #[serde(rename = "productName")]
    product_name: String,
    quantity: f64,
    #[serde(rename = "unitPrice")]
    unit_price: f64,
    subtotal: f64,
    #[serde(rename = "selectedOption")]
    selected_option: Option<String>,
    notes: Option<String>,
    #[serde(rename = "categoryName")]
    category_name: Option<String>,
    #[serde(rename = "comboId")]
    combo_id: Option<String>,
    #[serde(rename = "comboSaleItemId")]
    combo_sale_item_id: Option<String>,
    additions: Option<Vec<SaleAdditionInput>>,
    sauces: Option<Vec<SaleSauceInput>>,
}

#[derive(Deserialize)]
struct SaleAdditionInput {
    #[serde(rename = "additionId")]
    addition_id: Option<String>,
    #[serde(rename = "additionName")]
    addition_name: String,
    price: f64,
    quantity: f64,
}

#[derive(Deserialize)]
struct SaleSauceInput {
    #[serde(rename = "sauceId")]
    sauce_id: Option<String>,
    #[serde(rename = "sauceName")]
    sauce_name: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_db(db_path: &str) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open(db_path).map_err(|e| e.to_string())
}

fn new_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static C: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let c = C.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:032x}{:016x}", t, c)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn err500(msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg.into() })))
}

fn err409(msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::CONFLICT, Json(serde_json::json!({ "error": msg.into() })))
}

fn next_invoice_number(conn: &rusqlite::Connection, tenant_id: &str, now: &str) -> String {
    let today = &now[..10];
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sales WHERE tenant_id=?1 AND created_at >= ?2",
        rusqlite::params![tenant_id, format!("{today}T00:00:00")],
        |r| r.get(0),
    ).unwrap_or(0);
    format!("{}-{:04}", today, count + 1)
}

// ---------------------------------------------------------------------------
// POST /api/v1/sales
// ---------------------------------------------------------------------------

async fn create_sale(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateSaleBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let user_name = user.username.clone();
    let ctx = context.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;

        // Validar caja abierta
        let session_id: String = conn.query_row(
            "SELECT id FROM cash_sessions WHERE tenant_id=?1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1",
            rusqlite::params![tenant_id],
            |r| r.get(0),
        ).optional().map_err(|e| err500(e.to_string()))?
            .ok_or_else(|| err409("No hay caja abierta."))?;

        // Resolver domicilio
        let (delivery_type_name, delivery_price) = if let Some(dtid) = body.delivery_type_id.as_deref().filter(|s| !s.is_empty()) {
            let row = conn.query_row(
                "SELECT name, price FROM delivery_types WHERE id=?1",
                rusqlite::params![dtid],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, f64>(1)?)),
            ).optional().map_err(|e| err500(e.to_string()))?;
            match row {
                Some((name, price)) => (name, price),
                None => (None, 0.0),
            }
        } else if body.is_delivery.unwrap_or(false) {
            (None, body.delivery_fee.unwrap_or(0.0))
        } else {
            (None, 0.0)
        };

        let is_delivery = delivery_type_name.is_some() || body.is_delivery.unwrap_or(false);
        let payment_method = body.payment_method.as_deref().unwrap_or("CASH");
        let payment_method_db = if payment_method == "SPLIT" { "CASH" } else { payment_method };
        let cash_given = body.cash_given.unwrap_or(0.0);
        let cash_amount = body.cash_amount.unwrap_or(if payment_method_db == "CASH" { body.total } else { 0.0 });
        let card_amount = body.card_amount.unwrap_or(if payment_method_db == "CARD" { body.total } else { 0.0 });
        let change_given = (cash_given - cash_amount).max(0.0);

        let now = now_iso();
        let sale_id = new_uuid();
        let invoice_number = next_invoice_number(&conn, &tenant_id, &now);

        conn.execute(
            "INSERT INTO sales(id,tenant_id,user_id,cash_session_id,total,payment_method,cash_given,change_given,invoice_number,notes,created_at,is_delivery,table_order_id,cash_amount,card_amount,delivery_price,client_name,collected_by_user_id,collected_by_display_name,delivery_type_id,delivery_type_name,subtotal) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            rusqlite::params![
                sale_id, tenant_id, user_id, session_id,
                body.total, payment_method_db,
                cash_given, change_given, invoice_number,
                body.notes.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
                now, if is_delivery { 1 } else { 0 },
                cash_amount, card_amount, delivery_price,
                body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
                user_id, user_name,
                body.delivery_type_id.as_deref().filter(|s| !s.is_empty()),
                delivery_type_name,
                body.total, // subtotal = total antes de delivery
            ],
        ).map_err(|e| err500(e.to_string()))?;

        // Insertar items
        for item in &body.items {
            let item_id = new_uuid();
            conn.execute(
                "INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id,combo_sale_item_id,original_unit_price,category_name) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                rusqlite::params![
                    item_id, sale_id, item.product_id, item.product_name,
                    item.quantity, item.unit_price, item.subtotal,
                    item.notes.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
                    item.selected_option, item.combo_id, item.combo_sale_item_id,
                    item.unit_price, // original_unit_price
                    item.category_name,
                ],
            ).map_err(|e| err500(e.to_string()))?;

            for add in item.additions.as_deref().unwrap_or(&[]) {
                if add.quantity <= 0.0 { continue; }
                conn.execute(
                    "INSERT INTO sale_item_additions(id,sale_item_id,addition_id,addition_name,price,quantity) VALUES(?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![new_uuid(), item_id, add.addition_id, add.addition_name, add.price, add.quantity],
                ).map_err(|e| err500(e.to_string()))?;
            }
            for sauce in item.sauces.as_deref().unwrap_or(&[]) {
                conn.execute(
                    "INSERT INTO sale_item_sauces(id,sale_item_id,sauce_id,sauce_name) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![new_uuid(), item_id, sauce.sauce_id, sauce.sauce_name],
                ).map_err(|e| err500(e.to_string()))?;
            }
        }

        broadcast(&ctx, serde_json::json!({ "type": "SALE_CREATED", "tableId": null, "orderId": null, "saleId": sale_id }));

        Ok(serde_json::json!({ "id": sale_id, "invoiceNumber": invoice_number }))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::CREATED, Json(v)).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/sales
// ---------------------------------------------------------------------------

async fn list_sales(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let role = user.role.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;

        let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = if role == "SELLER" {
            (
                "SELECT s.id, s.invoice_number, s.total, s.payment_method, s.created_at, s.is_delivery, s.client_name, \
                 COALESCE(u.display_name, u.username) AS user_display_name, \
                 s.collected_by_display_name \
                 FROM sales s LEFT JOIN users u ON u.id=s.user_id \
                 WHERE s.tenant_id=?1 AND s.user_id=?2 ORDER BY s.created_at DESC".to_string(),
                vec![Box::new(tenant_id), Box::new(user_id)],
            )
        } else {
            (
                "SELECT s.id, s.invoice_number, s.total, s.payment_method, s.created_at, s.is_delivery, s.client_name, \
                 COALESCE(u.display_name, u.username) AS user_display_name, \
                 s.collected_by_display_name \
                 FROM sales s LEFT JOIN users u ON u.id=s.user_id \
                 WHERE s.tenant_id=?1 ORDER BY s.created_at DESC".to_string(),
                vec![Box::new(tenant_id)],
            )
        };

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows: Result<Vec<Value>, _> = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(serde_json::json!({
                "id":                     r.get::<_, String>(0)?,
                "invoiceNumber":          r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                "total":                  r.get::<_, f64>(2)?,
                "paymentMethod":          r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt":              r.get::<_, String>(4)?,
                "isDelivery":             r.get::<_, i64>(5)? != 0,
                "clientName":             r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                "userDisplayName":        r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                "collectedByDisplayName": r.get::<_, Option<String>>(8)?.unwrap_or_default(),
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();

        Ok(Value::Array(rows?))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/sales/{id}
// ---------------------------------------------------------------------------

async fn get_sale(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(sale_id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Option<Value>, String> {
        let conn = open_db(&db_path)?;

        // Cabecera de la venta
        let sale = conn.query_row(
            "SELECT s.id, s.invoice_number, s.total, s.payment_method, s.created_at, s.is_delivery, \
             s.client_name, s.notes, \
             COALESCE(u.display_name, u.username) AS user_display_name, \
             s.collected_by_display_name, \
             cs.session_number, \
             s.cash_given, s.change_given, s.cash_amount, s.card_amount, \
             s.subtotal, s.discount_type, s.discount_value \
             FROM sales s \
             LEFT JOIN users u ON u.id=s.user_id \
             LEFT JOIN cash_sessions cs ON cs.id=s.cash_session_id \
             WHERE s.id=?1 AND s.tenant_id=?2",
            rusqlite::params![sale_id, tenant_id],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<f64>>(11)?,
                r.get::<_, Option<f64>>(12)?,
                r.get::<_, Option<f64>>(13)?,
                r.get::<_, Option<f64>>(14)?,
                r.get::<_, Option<f64>>(15)?,
                r.get::<_, Option<String>>(16)?,
                r.get::<_, Option<f64>>(17)?,
            )),
        ).optional().map_err(|e| e.to_string())?;

        let Some(s) = sale else { return Ok(None); };

        // Items
        let mut stmt = conn.prepare(
            "SELECT id, product_id, product_name, quantity, unit_price, subtotal, notes, \
             selected_option, original_unit_price, combo_id, combo_sale_item_id \
             FROM sale_items WHERE sale_id=?1 ORDER BY rowid ASC"
        ).map_err(|e| e.to_string())?;

        let item_rows: Vec<(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<f64>, Option<String>, Option<String>)> = {
            let collected: Result<Vec<_>, _> = stmt.query_map(rusqlite::params![sale_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?,
                    r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?))
            }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
            collected?
        };

        let mut items_json = vec![];
        for item in &item_rows {
            // Adiciones
            let mut astmt = conn.prepare(
                "SELECT addition_name, price, quantity FROM sale_item_additions WHERE sale_item_id=?1"
            ).map_err(|e| e.to_string())?;
            let additions: Vec<Value> = {
                let r: Result<Vec<_>, _> = astmt.query_map(rusqlite::params![item.0], |r| {
                    Ok(serde_json::json!({
                        "additionName": r.get::<_, String>(0)?,
                        "price":        r.get::<_, f64>(1)?,
                        "quantity":     r.get::<_, f64>(2)?,
                    }))
                }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
                r?
            };

            // Salsas
            let mut sstmt = conn.prepare(
                "SELECT sauce_name FROM sale_item_sauces WHERE sale_item_id=?1"
            ).map_err(|e| e.to_string())?;
            let sauces: Vec<Value> = {
                let r: Result<Vec<_>, _> = sstmt.query_map(rusqlite::params![item.0], |r| {
                    Ok(serde_json::json!({ "sauceName": r.get::<_, String>(0)? }))
                }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
                r?
            };

            let mut item_json = serde_json::json!({
                "id":               item.0,
                "productId":        item.1.clone().unwrap_or_default(),
                "productName":      item.2,
                "quantity":         item.3,
                "unitPrice":        item.4,
                "subtotal":         item.5,
                "notes":            item.6.clone().unwrap_or_default(),
                "selectedOption":   item.7.clone().unwrap_or_default(),
                "comboId":          item.9.clone().unwrap_or_default(),
                "comboSaleItemId":  item.10.clone().unwrap_or_default(),
                "additions":        additions,
                "sauces":           sauces,
            });

            // originalUnitPrice solo si difiere del unitPrice (habia descuento)
            if let Some(orig) = item.8 {
                if (orig - item.4).abs() > 0.01 {
                    item_json["originalUnitPrice"] = serde_json::json!(orig);
                }
            }

            items_json.push(item_json);
        }

        Ok(Some(serde_json::json!({
            "id":                     s.0,
            "invoiceNumber":          s.1.unwrap_or_default(),
            "total":                  s.2,
            "paymentMethod":          s.3.unwrap_or_default(),
            "createdAt":              s.4,
            "isDelivery":             s.5 != 0,
            "clientName":             s.6.unwrap_or_default(),
            "notes":                  s.7.unwrap_or_default(),
            "userDisplayName":        s.8.unwrap_or_default(),
            "collectedByDisplayName": s.9.unwrap_or_default(),
            "cashSessionNumber":      s.10.unwrap_or(0),
            "cashGiven":              s.11.unwrap_or(0.0),
            "changeGiven":            s.12.unwrap_or(0.0),
            "cashAmount":             s.13.unwrap_or(0.0),
            "cardAmount":             s.14.unwrap_or(0.0),
            "subtotal":               s.15.unwrap_or(s.2),
            "discountType":           s.16.unwrap_or_default(),
            "discountValue":          s.17.unwrap_or(0.0),
            "items":                  items_json,
        })))
    }).await;

    match result {
        Ok(Ok(Some(v))) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Venta no encontrada." }))).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

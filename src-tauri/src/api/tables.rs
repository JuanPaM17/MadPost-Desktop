use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Extension, Json, Router,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::{broadcast, ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/tables", get(get_tables))
        .route("/api/v1/tables/{id}", get(get_table))
        .route("/api/v1/tables/{id}/order", get(get_order).post(open_order))
        .route("/api/v1/tables/{id}/order/clients", post(add_client))
        .route("/api/v1/tables/{id}/order/items", post(add_items))
        .route("/api/v1/tables/{id}/order/items/{item_id}", delete(delete_item))
        .route("/api/v1/tables/{id}/order/items/{item_id}/notes", patch(patch_item_notes))
        .route("/api/v1/tables/{id}/order/pay", post(pay_order))
        .route("/api/v1/tables/{id}/order/cancel", post(cancel_order))
        .route("/api/v1/tables/{id}/order/delivery", patch(patch_delivery))
        .route("/api/v1/tables/{id}/order/card", patch(patch_card))
        .route("/api/v1/tables/{id}/order/clients/{client_id}/name", patch(patch_client_name))
        .route("/api/v1/tables/{id}/order/clients/{client_id}/notes", patch(patch_client_notes))
        .route("/api/v1/tables/{id}/order/clients/{client_id}", delete(cancel_client))
        .route("/api/v1/tables/{id}/order/transfer/items", post(transfer_items))
        .route("/api/v1/tables/{id}/order/transfer/client", post(transfer_client))
        .route("/api/v1/tables/{id}/order/comanda", post(send_comanda))
        .route("/api/v1/tables/{id}/order/comandas", get(list_comandas))
        .route("/api/v1/tables/{id}/order/comandas/{comanda_id}/reprint", post(reprint_comanda))
        .route("/api/v1/tables/{id}/order/receipts", get(list_receipts))
        .route("/api/v1/tables/{id}/order/receipts/{sale_id}/print", post(print_receipt))
}

// ---------------------------------------------------------------------------
// Tipos de request/response
// ---------------------------------------------------------------------------

#[derive(Deserialize)] struct OpenOrderBody { client_name: Option<String> }
#[derive(Deserialize)] struct AddClientBody { client_name: Option<String> }
#[derive(Deserialize)] struct AddItemsBody { client_id: Option<String>, items: Vec<ItemInput> }
#[derive(Deserialize)] struct ItemInput {
    product_id: Option<String>,
    product_name: String,
    unit_price: f64,
    quantity: f64,
    selected_option: Option<String>,
    notes: Option<String>,
    combo_id: Option<String>,
    combo_parent_item_id: Option<String>,
    additions: Option<Vec<AdditionInput>>,
    sauces: Option<Vec<SauceInput>>,
}
#[derive(Deserialize)] struct AdditionInput { addition_id: Option<String>, addition_name: String, price: f64, quantity: f64 }
#[derive(Deserialize)] struct SauceInput { sauce_id: Option<String>, sauce_name: String }
#[derive(Deserialize)] struct PayBody {
    client_id: Option<String>,
    payment_method: String,
    cash_given: Option<f64>,
    cash_amount: Option<f64>,
    card_amount: Option<f64>,
    delivery_type_id: Option<String>,
    client_name: Option<String>,
}
#[derive(Deserialize)] struct PatchDeliveryBody { client_id: String, delivery_type_id: Option<String> }
#[derive(Deserialize)] struct PatchCardBody { client_id: String, is_card: bool }
#[derive(Deserialize)] struct PatchNameBody { client_name: Option<String> }
#[derive(Deserialize)] struct PatchNotesBody { notes: Option<String> }
#[derive(Deserialize)] struct TransferItemsBody { dest_table_id: String, item_ids: Vec<String> }
#[derive(Deserialize)] struct TransferClientBody { dest_table_id: String, client_id: String }
#[derive(Deserialize)] struct SendComandaBody { client_id: Option<String> }

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type DbResult<T> = Result<T, String>;

fn open_db(db_path: &str) -> DbResult<Connection> {
    Connection::open(db_path).map_err(|e| e.to_string())
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

fn err404(msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": msg.into() })))
}

// ---------------------------------------------------------------------------
// Funciones de lectura compartidas (se llaman desde spawn_blocking)
// ---------------------------------------------------------------------------

fn db_open_cash_session(conn: &Connection, tenant_id: &str) -> DbResult<Option<String>> {
    conn.query_row(
        "SELECT id FROM cash_sessions WHERE tenant_id=?1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1",
        rusqlite::params![tenant_id],
        |r| r.get::<_, String>(0),
    ).optional().map_err(|e| e.to_string())
}

fn db_open_order(conn: &Connection, table_id: &str) -> DbResult<Option<(String, String, String, String, String, Option<String>, String, i64)>> {
    // id, tenant_id, table_id, user_id, cash_session_id, client_name, opened_at, comanda_sent
    conn.query_row(
        "SELECT id, tenant_id, table_id, user_id, cash_session_id, client_name, opened_at, COALESCE(comanda_sent,0) FROM table_orders WHERE table_id=?1 AND status='OPEN' LIMIT 1",
        rusqlite::params![table_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    ).optional().map_err(|e| e.to_string())
}

fn db_table(conn: &Connection, table_id: &str) -> DbResult<Option<(String, String, Option<String>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<String>, Option<String>, i64)>> {
    // id, name, shape, pos_x, pos_y, width, height, type, floor, active
    conn.query_row(
        "SELECT id, name, shape, pos_x, pos_y, width, height, type, floor, COALESCE(active,1) FROM restaurant_tables WHERE id=?1",
        rusqlite::params![table_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
    ).optional().map_err(|e| e.to_string())
}

fn db_clients(conn: &Connection, order_id: &str) -> DbResult<Vec<(String, Option<String>, i64, String, Option<String>, Option<String>, i64)>> {
    // id, client_name, client_number, status, notes, delivery_type_id, is_card
    let mut stmt = conn.prepare(
        "SELECT id, client_name, client_number, status, notes, delivery_type_id, COALESCE(is_card,0) FROM table_order_clients WHERE table_order_id=?1 ORDER BY client_number ASC"
    ).map_err(|e| e.to_string())?;
    let rows: DbResult<Vec<_>> = stmt.query_map(rusqlite::params![order_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
    }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
    rows
}

fn db_items_for_order(conn: &Connection, order_id: &str) -> DbResult<Vec<(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>)>> {
    // id, product_id, product_name, quantity, unit_price, subtotal, notes, selected_option, combo_id, table_order_client_id
    let mut stmt = conn.prepare(
        "SELECT i.id, i.product_id, i.product_name, i.quantity, i.unit_price, i.subtotal, i.notes, i.selected_option, i.combo_id, i.table_order_client_id
         FROM table_order_items i
         WHERE i.table_order_id=?1
           AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (
             SELECT id FROM table_order_clients WHERE table_order_id=?1 AND status='CANCELLED'
           ))
         ORDER BY i.rowid ASC"
    ).map_err(|e| e.to_string())?;
    let rows: DbResult<Vec<(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>)>> =
        stmt.query_map(rusqlite::params![order_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
    rows
}

fn db_item_additions(conn: &Connection, item_id: &str) -> DbResult<Vec<(Option<String>, String, f64, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT addition_id, addition_name, price, quantity FROM table_order_item_additions WHERE table_order_item_id=?1"
    ).map_err(|e| e.to_string())?;
    let rows: DbResult<Vec<(Option<String>, String, f64, f64)>> =
        stmt.query_map(rusqlite::params![item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
    rows
}

fn db_item_sauces(conn: &Connection, item_id: &str) -> DbResult<Vec<(Option<String>, String)>> {
    let mut stmt = conn.prepare(
        "SELECT sauce_id, sauce_name FROM table_order_item_sauces WHERE table_order_item_id=?1"
    ).map_err(|e| e.to_string())?;
    let rows: DbResult<Vec<(Option<String>, String)>> =
        stmt.query_map(rusqlite::params![item_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
    rows
}

fn build_item_json(conn: &Connection, item: &(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>)) -> DbResult<Value> {
    let additions = db_item_additions(conn, &item.0)?;
    let sauces = db_item_sauces(conn, &item.0)?;
    Ok(serde_json::json!({
        "id": item.0,
        "productId": item.1.clone().unwrap_or_default(),
        "productName": item.2,
        "quantity": item.3,
        "unitPrice": item.4,
        "subtotal": item.5,
        "notes": item.6.clone().unwrap_or_default(),
        "selectedOption": item.7.clone().unwrap_or_default(),
        "comboId": item.8.clone().unwrap_or_default(),
        "clientId": item.9.clone().unwrap_or_default(),
        "additions": additions.iter().map(|(aid, aname, price, qty)| serde_json::json!({
            "additionId": aid.clone().unwrap_or_default(),
            "additionName": aname,
            "price": price,
            "quantity": qty,
        })).collect::<Vec<_>>(),
        "sauces": sauces.iter().map(|(sid, sname)| serde_json::json!({
            "sauceId": sid.clone().unwrap_or_default(),
            "sauceName": sname,
        })).collect::<Vec<_>>(),
    }))
}

fn build_order_json(conn: &Connection, order_id: &str, table_id: &str, table_name: &str, opened_at: &str) -> DbResult<Value> {
    let clients = db_clients(conn, order_id)?;
    let all_items = db_items_for_order(conn, order_id)?;

    let has_comanda: i64 = conn.query_row(
        "SELECT COUNT(*) FROM comandas WHERE table_order_id=?1",
        rusqlite::params![order_id],
        |r| r.get(0),
    ).unwrap_or(0);

    let mut total = 0.0f64;
    let mut clients_json = vec![];
    for (cid, cname, cnum, cstatus, cnotes, cdelivery_type_id, is_card) in &clients {
        if cstatus == "CANCELLED" { continue; }
        let client_items: Vec<_> = all_items.iter().filter(|i| i.9.as_deref() == Some(cid.as_str())).collect();
        let client_total: f64 = client_items.iter().map(|i| i.5).sum();
        total += client_total;
        let mut items_json = vec![];
        for item in &client_items {
            items_json.push(build_item_json(conn, item)?);
        }
        let display_name = cname.clone().unwrap_or_else(|| format!("Cliente {cnum}"));
        clients_json.push(serde_json::json!({
            "id": cid,
            "clientName": cname.clone().unwrap_or_default(),
            "clientNumber": cnum,
            "status": cstatus,
            "displayName": display_name,
            "total": client_total,
            "isDelivery": cdelivery_type_id.is_some(),
            "deliveryTypeId": cdelivery_type_id.clone().unwrap_or_default(),
            "isCard": *is_card != 0,
            "notes": cnotes.clone().unwrap_or_default(),
            "items": items_json,
        }));
    }

    Ok(serde_json::json!({
        "id": order_id,
        "tableId": table_id,
        "tableName": table_name,
        "status": "OPEN",
        "openedAt": opened_at,
        "total": total,
        "hasComanda": has_comanda > 0,
        "clients": clients_json,
    }))
}

fn build_comanda_lines(
    comanda_id: &str,
    comanda_number: i64,
    table_name: &str,
    created_at: &str,
    client_name: Option<&str>,
    conn: &Connection,
) -> DbResult<Vec<String>> {
    let mut lines = vec![];
    lines.push(format!("COMANDA #{}", if comanda_number > 0 { comanda_number.to_string() } else { "COMPLETA".to_string() }));
    lines.push(table_name.to_string());
    lines.push(created_at[..16].replace('T', " "));
    lines.push("--------------------------------".to_string());
    if let Some(name) = client_name { if !name.is_empty() { lines.push(format!("Cliente: {name}")); } }
    lines.push("--------------------------------".to_string());

    let mut stmt = conn.prepare(
        "SELECT product_name, quantity, additions_text, sauces_text, notes, selected_option, combo_parent_id, id FROM comanda_items WHERE comanda_id=?1 ORDER BY rowid ASC"
    ).map_err(|e| e.to_string())?;
    let items: Vec<(String, f64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String)> =
        stmt.query_map(rusqlite::params![comanda_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok()).collect();

    let roots: Vec<_> = items.iter().filter(|i| i.6.is_none()).collect();
    let children: Vec<_> = items.iter().filter(|i| i.6.is_some()).collect();

    for root in &roots {
        let qty = if root.1 != 1.0 { format!("{}x ", root.1 as i64) } else { String::new() };
        lines.push(format!("{}{}", qty, root.0));
        if let Some(opt) = &root.5 { if !opt.is_empty() { lines.push(format!("   >> {opt}")); } }
        if let Some(add) = &root.2 { if !add.is_empty() { lines.push(format!("   + {add}")); } }
        if let Some(sac) = &root.3 { if !sac.is_empty() { lines.push(format!("   Salsas: {sac}")); } }
        if let Some(notes) = &root.4 { if !notes.is_empty() { lines.push(format!("   * {notes}")); } }
        for child in children.iter().filter(|c| c.6.as_deref() == Some(root.7.as_str())) {
            let cqty = if child.1 != 1.0 { format!("{}x ", child.1 as i64) } else { String::new() };
            lines.push(format!("   - {}{}", cqty, child.0));
            if let Some(opt) = &child.5 { if !opt.is_empty() { lines.push(format!("      >> {opt}")); } }
            if let Some(add) = &child.2 { if !add.is_empty() { lines.push(format!("      + {add}")); } }
        }
    }
    lines.push("--------------------------------".to_string());
    Ok(lines)
}

// ---------------------------------------------------------------------------
// GET /tables
// ---------------------------------------------------------------------------

async fn get_tables(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Value> {
        let conn = open_db(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, shape, pos_x, pos_y, width, height, type, floor FROM restaurant_tables WHERE tenant_id=?1 AND COALESCE(active,1)=1 AND COALESCE(type,'TABLE')='TABLE' ORDER BY name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let tables: Vec<(String, String, Option<String>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> =
            stmt.query_map(rusqlite::params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
                .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

        let mut result = vec![];
        for (tid, tname, shape, pos_x, pos_y, width, height) in tables {
            let order = db_open_order(&conn, &tid)?;
            let entry = if let Some((oid, _, _, _, _, _, opened_at, comanda_sent)) = &order {
                let clients = db_clients(&conn, oid)?;
                let active_clients: Vec<_> = clients.iter().filter(|c| c.3 != "CANCELLED").collect();
                let client_names: Vec<String> = active_clients.iter().map(|c| {
                    c.1.clone().unwrap_or_else(|| format!("Cliente {}", c.2))
                }).collect();
                serde_json::json!({
                    "id": tid, "name": tname, "shape": shape.unwrap_or_default(),
                    "posX": pos_x.unwrap_or(0.0), "posY": pos_y.unwrap_or(0.0),
                    "width": width.unwrap_or(100.0), "height": height.unwrap_or(100.0),
                    "status": "OPEN", "activeOrderId": oid,
                    "clientCount": active_clients.len(), "openedAt": opened_at,
                    "hasComanda": *comanda_sent != 0,
                    "clientNames": client_names,
                })
            } else {
                serde_json::json!({
                    "id": tid, "name": tname, "shape": shape.unwrap_or_default(),
                    "posX": pos_x.unwrap_or(0.0), "posY": pos_y.unwrap_or(0.0),
                    "width": width.unwrap_or(100.0), "height": height.unwrap_or(100.0),
                    "status": "FREE", "activeOrderId": null,
                    "clientCount": 0, "openedAt": null,
                    "hasComanda": false, "clientNames": [],
                })
            };
            result.push(entry);
        }
        Ok(Value::Array(result))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /tables/{id}
// ---------------------------------------------------------------------------

async fn get_table(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Option<Value>> {
        let conn = open_db(&db_path)?;
        let table = db_table(&conn, &table_id)?;
        let Some((tid, tname, shape, pos_x, pos_y, width, height, ttype, floor, active)) = table else {
            return Ok(None);
        };
        if ttype.as_deref() != Some("TABLE") && ttype.is_some() { return Ok(None); }
        let _ = (tenant_id, active, floor);

        let order = db_open_order(&conn, &tid)?;
        let order_json = if let Some((oid, _, _, _, _, _, opened_at, _)) = &order {
            Some(build_order_json(&conn, oid, &tid, &tname, opened_at)?)
        } else { None };

        Ok(Some(serde_json::json!({
            "id": tid, "name": tname,
            "shape": shape.unwrap_or_default(),
            "posX": pos_x.unwrap_or(0.0), "posY": pos_y.unwrap_or(0.0),
            "width": width.unwrap_or(100.0), "height": height.unwrap_or(100.0),
            "status": if order.is_some() { "OPEN" } else { "FREE" },
            "order": order_json,
        })))
    }).await;

    match result {
        Ok(Ok(Some(v))) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Ok(None)) => err404("Mesa no encontrada.").into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /tables/{id}/order
// ---------------------------------------------------------------------------

async fn get_order(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Value> {
        let conn = open_db(&db_path)?;
        let table = db_table(&conn, &table_id)?;
        let tname = table.as_ref().map(|t| t.1.clone()).unwrap_or_default();

        let order = db_open_order(&conn, &table_id)?;
        if let Some((oid, _, _, _, _, _, opened_at, _)) = &order {
            let order_json = build_order_json(&conn, oid, &table_id, &tname, opened_at)?;
            Ok(serde_json::json!({ "status": "OPEN", "tableId": table_id, "order": order_json }))
        } else {
            Ok(serde_json::json!({ "status": "FREE", "tableId": table_id, "order": null }))
        }
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order
// ---------------------------------------------------------------------------

async fn open_order(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<OpenOrderBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;

        let session_id = db_open_cash_session(&conn, &tenant_id)
            .map_err(|e| err500(e))?
            .ok_or_else(|| err409("No hay caja abierta."))?;

        if db_open_order(&conn, &table_id).map_err(|e| err500(e))?.is_some() {
            return Err(err409("La mesa ya tiene una orden abierta."));
        }

        let table = db_table(&conn, &table_id).map_err(|e| err500(e))?
            .ok_or_else(|| err404("Mesa no encontrada."))?;
        let tname = table.1;

        let order_id = new_uuid();
        let client_id = new_uuid();
        let now = now_iso();
        let client_name = body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());

        conn.execute(
            "INSERT INTO table_orders(id,tenant_id,table_id,user_id,cash_session_id,client_name,status,opened_at) VALUES(?1,?2,?3,?4,?5,?6,'OPEN',?7)",
            rusqlite::params![order_id, tenant_id, table_id, user_id, session_id, client_name, now],
        ).map_err(|e| err500(e.to_string()))?;

        conn.execute(
            "INSERT INTO table_order_clients(id,table_order_id,client_name,client_number,status,created_at) VALUES(?1,?2,?3,1,'ACTIVE',?4)",
            rusqlite::params![client_id, order_id, client_name, now],
        ).map_err(|e| err500(e.to_string()))?;

        let order = build_order_json(&conn, &order_id, &table_id, &tname, &now).map_err(|e| err500(e))?;
        Ok(order)
    }).await;

    match result {
        Ok(Ok(v)) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/clients
// ---------------------------------------------------------------------------

async fn add_client(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<AddClientBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;
        let order = db_open_order(&conn, &table_id).map_err(|e| err500(e))?
            .ok_or_else(|| err409("La mesa no tiene orden abierta."))?;
        let order_id = order.0;

        let max_n: i64 = conn.query_row(
            "SELECT COALESCE(MAX(client_number),0) FROM table_order_clients WHERE table_order_id=?1",
            rusqlite::params![order_id],
            |r| r.get(0),
        ).map_err(|e| err500(e.to_string()))?;

        let client_id = new_uuid();
        let now = now_iso();
        let client_name = body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
        let next_n = max_n + 1;

        conn.execute(
            "INSERT INTO table_order_clients(id,table_order_id,client_name,client_number,status,created_at) VALUES(?1,?2,?3,?4,'ACTIVE',?5)",
            rusqlite::params![client_id, order_id, client_name, next_n, now],
        ).map_err(|e| err500(e.to_string()))?;

        Ok(serde_json::json!({ "clientId": client_id, "clientNumber": next_n }))
    }).await;

    match result {
        Ok(Ok(v)) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/items
// ---------------------------------------------------------------------------

async fn add_items(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<AddItemsBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(Value, String), (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;
        let order = db_open_order(&conn, &table_id).map_err(|e| err500(e))?
            .ok_or_else(|| err409("La mesa no tiene orden abierta."))?;
        let order_id = order.0;

        // Resolver client_id: si no viene, usar el primer cliente activo
        let client_id = if let Some(cid) = body.client_id {
            Some(cid)
        } else {
            conn.query_row(
                "SELECT id FROM table_order_clients WHERE table_order_id=?1 AND status='ACTIVE' ORDER BY client_number ASC LIMIT 1",
                rusqlite::params![order_id],
                |r| r.get::<_, String>(0),
            ).optional().map_err(|e| err500(e.to_string()))?
        };

        let now = now_iso();
        let mut added = 0usize;
        // Mapa de item_id_input -> item_id_db (para combos)
        let mut parent_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

        for item in &body.items {
            let item_id = new_uuid();
            let additions = item.additions.as_deref().unwrap_or(&[]);
            let sauces = item.sauces.as_deref().unwrap_or(&[]);
            let additions_total: f64 = additions.iter().map(|a| a.price * a.quantity).sum();
            let subtotal = (item.unit_price + additions_total) * item.quantity;

            // Si tiene combo_parent_item_id, resolverlo
            let db_parent_id = item.combo_parent_item_id.as_ref()
                .and_then(|pid| parent_map.get(pid).cloned());

            conn.execute(
                "INSERT INTO table_order_items(id,table_order_id,product_id,product_name,quantity,unit_price,subtotal,added_at,selected_option,table_order_client_id,combo_id,combo_table_order_item_id,original_unit_price) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                rusqlite::params![
                    item_id, order_id, item.product_id, item.product_name,
                    item.quantity, item.unit_price, subtotal, now,
                    item.selected_option, client_id, item.combo_id, db_parent_id,
                    item.unit_price,
                ],
            ).map_err(|e| err500(e.to_string()))?;

            for addition in additions {
                if addition.quantity <= 0.0 { continue; }
                conn.execute(
                    "INSERT INTO table_order_item_additions(id,table_order_item_id,addition_id,addition_name,price,quantity) VALUES(?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![new_uuid(), item_id, addition.addition_id, addition.addition_name, addition.price, addition.quantity],
                ).map_err(|e| err500(e.to_string()))?;
            }
            for sauce in sauces {
                conn.execute(
                    "INSERT INTO table_order_item_sauces(id,table_order_item_id,sauce_id,sauce_name) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![new_uuid(), item_id, sauce.sauce_id, sauce.sauce_name],
                ).map_err(|e| err500(e.to_string()))?;
            }

            // Si el input tiene un id (para que los hijos puedan referenciar al padre), registrarlo
            if item.combo_id.is_some() {
                parent_map.insert(item_id.clone(), item_id.clone());
            }
            added += 1;
        }

        Ok((serde_json::json!({ "added": added }), order_id))
    }).await;

    match result {
        Ok(Ok((v, order_id))) => {
            broadcast(&context, serde_json::json!({ "type": "ORDER_ITEM_ADDED", "tableId": table_id_bc, "orderId": order_id, "saleId": null }));
            (StatusCode::OK, Json(v)).into_response()
        }
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// DELETE /tables/{id}/order/items/{item_id}
// ---------------------------------------------------------------------------

async fn delete_item(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, item_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        // Borrar hijos de combo
        let children: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM table_order_items WHERE combo_table_order_item_id=?1").map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt.query_map(rusqlite::params![item_id], |r| r.get(0)).map_err(|e| e.to_string())?
                .filter_map(|r| r.ok()).collect();
            rows
        };
        for child in &children {
            conn.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=?1", rusqlite::params![child]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=?1", rusqlite::params![child]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM table_order_items WHERE id=?1", rusqlite::params![child]).map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM table_order_item_additions WHERE table_order_item_id=?1", rusqlite::params![item_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM table_order_item_sauces WHERE table_order_item_id=?1", rusqlite::params![item_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM table_order_items WHERE id=?1", rusqlite::params![item_id]).map_err(|e| e.to_string())?;
        Ok(())
    }).await;

    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /tables/{id}/order/items/{item_id}/notes
// ---------------------------------------------------------------------------

async fn patch_item_notes(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, item_id)): Path<(String, String)>,
    Json(body): Json<PatchNotesBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = open_db(&db_path)?;
        let now = now_iso();
        conn.execute(
            "UPDATE table_order_items SET notes=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![body.notes.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()), now, item_id],
        ).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }).await;
    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/pay
// ---------------------------------------------------------------------------

async fn pay_order(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<PayBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let collector_id = user.user_id.clone();
    let collector_name = user.username.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(Value, String, bool), (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;

        let order = db_open_order(&conn, &table_id).map_err(|e| err500(e))?
            .ok_or_else(|| err409("La mesa no tiene orden abierta."))?;
        let (order_id, _otenant, _otable, order_user_id, cash_session_id, _, _opened_at, _) = order;

        // Resolver delivery type
        let (delivery_type_name, delivery_price) = if let Some(dtid) = &body.delivery_type_id {
            if dtid.is_empty() {
                (None::<String>, 0.0f64)
            } else {
                let row = conn.query_row(
                    "SELECT name, price FROM delivery_types WHERE id=?1",
                    rusqlite::params![dtid],
                    |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, f64>(1)?)),
                ).optional().map_err(|e| err500(e.to_string()))?;
                match row {
                    Some((name, price)) => (name, price),
                    None => (None, 0.0),
                }
            }
        } else {
            (None, 0.0)
        };

        let now = now_iso();
        // Numero de factura: contar ventas del dia + 1
        let today = &now[..10];
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sales WHERE tenant_id=?1 AND created_at >= ?2",
            rusqlite::params![tenant_id, format!("{today}T00:00:00")],
            |r| r.get(0),
        ).unwrap_or(0);
        let invoice_number = format!("{}-{:04}", today, count + 1);

        let sale_id = new_uuid();
        let payment_method = if body.payment_method == "SPLIT" { "CASH" } else { &body.payment_method };

        // Si client_id viene → cobrar solo ese cliente
        if let Some(client_id) = &body.client_id {
            let client_items: Vec<_> = {
                let all = db_items_for_order(&conn, &order_id).map_err(|e| err500(e))?;
                all.into_iter().filter(|i| i.9.as_deref() == Some(client_id.as_str())).collect()
            };
            let total: f64 = client_items.iter().map(|i| i.5).sum();
            let is_delivery = delivery_type_name.is_some();

            conn.execute(
                "INSERT INTO sales(id,tenant_id,user_id,cash_session_id,total,payment_method,cash_given,change_given,invoice_number,created_at,is_delivery,table_order_id,cash_amount,card_amount,delivery_price,client_name,collected_by_user_id,collected_by_display_name,delivery_type_id,delivery_type_name,subtotal) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
                rusqlite::params![
                    sale_id, tenant_id, order_user_id, cash_session_id,
                    total + delivery_price, payment_method,
                    body.cash_given.unwrap_or(0.0),
                    (body.cash_given.unwrap_or(0.0) - total - delivery_price).max(0.0),
                    invoice_number, now, if is_delivery { 1 } else { 0 },
                    order_id,
                    body.cash_amount.unwrap_or(if payment_method == "CASH" { total } else { 0.0 }),
                    body.card_amount.unwrap_or(if payment_method == "CARD" { total } else { 0.0 }),
                    delivery_price,
                    body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
                    collector_id, collector_name,
                    body.delivery_type_id.as_deref().filter(|s| !s.is_empty()),
                    delivery_type_name,
                    total,
                ],
            ).map_err(|e| err500(e.to_string()))?;

            // Insertar sale_items
            for item in &client_items {
                let si_id = new_uuid();
                conn.execute(
                    "INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![si_id, sale_id, item.1, item.2, item.3, item.4, item.5, item.6, item.7, item.8],
                ).map_err(|e| err500(e.to_string()))?;
                let additions = db_item_additions(&conn, &item.0).map_err(|e| err500(e))?;
                for (aid, aname, price, qty) in &additions {
                    conn.execute(
                        "INSERT INTO sale_item_additions(id,sale_item_id,addition_id,addition_name,price,quantity) VALUES(?1,?2,?3,?4,?5,?6)",
                        rusqlite::params![new_uuid(), si_id, aid, aname, price, qty],
                    ).map_err(|e| err500(e.to_string()))?;
                }
                let sauces = db_item_sauces(&conn, &item.0).map_err(|e| err500(e))?;
                for (sid, sname) in &sauces {
                    conn.execute(
                        "INSERT INTO sale_item_sauces(id,sale_item_id,sauce_id,sauce_name) VALUES(?1,?2,?3,?4)",
                        rusqlite::params![new_uuid(), si_id, sid, sname],
                    ).map_err(|e| err500(e.to_string()))?;
                }
            }

            // Marcar cliente PAID
            conn.execute("UPDATE table_order_clients SET status='PAID' WHERE id=?1", rusqlite::params![client_id])
                .map_err(|e| err500(e.to_string()))?;

            // Verificar si cerrar la orden
            let pending: i64 = conn.query_row(
                "SELECT COUNT(*) FROM table_order_clients WHERE table_order_id=?1 AND status='ACTIVE'",
                rusqlite::params![order_id],
                |r| r.get(0),
            ).unwrap_or(0);
            let order_closed_by_client = pending == 0;
            if order_closed_by_client {
                conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, order_id])
                    .map_err(|e| err500(e.to_string()))?;
            }
            let sid = sale_id.clone();
            return Ok((serde_json::json!({ "saleId": sale_id, "invoiceNumber": invoice_number }), sid, order_closed_by_client));
        } else {
            // Cobrar toda la orden
            let all_items = db_items_for_order(&conn, &order_id).map_err(|e| err500(e))?;
            let total: f64 = all_items.iter().map(|i| i.5).sum();
            let is_delivery = delivery_type_name.is_some();

            conn.execute(
                "INSERT INTO sales(id,tenant_id,user_id,cash_session_id,total,payment_method,cash_given,change_given,invoice_number,created_at,is_delivery,table_order_id,cash_amount,card_amount,delivery_price,client_name,collected_by_user_id,collected_by_display_name,delivery_type_id,delivery_type_name,subtotal) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
                rusqlite::params![
                    sale_id, tenant_id, order_user_id, cash_session_id,
                    total + delivery_price, payment_method,
                    body.cash_given.unwrap_or(0.0),
                    (body.cash_given.unwrap_or(0.0) - total - delivery_price).max(0.0),
                    invoice_number, now, if is_delivery { 1 } else { 0 },
                    order_id,
                    body.cash_amount.unwrap_or(if payment_method == "CASH" { total } else { 0.0 }),
                    body.card_amount.unwrap_or(if payment_method == "CARD" { total } else { 0.0 }),
                    delivery_price,
                    body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()),
                    collector_id, collector_name,
                    body.delivery_type_id.as_deref().filter(|s| !s.is_empty()),
                    delivery_type_name,
                    total,
                ],
            ).map_err(|e| err500(e.to_string()))?;

            for item in &all_items {
                let si_id = new_uuid();
                conn.execute(
                    "INSERT INTO sale_items(id,sale_id,product_id,product_name,quantity,unit_price,subtotal,notes,selected_option,combo_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![si_id, sale_id, item.1, item.2, item.3, item.4, item.5, item.6, item.7, item.8],
                ).map_err(|e| err500(e.to_string()))?;
                let additions = db_item_additions(&conn, &item.0).map_err(|e| err500(e))?;
                for (aid, aname, price, qty) in &additions {
                    conn.execute(
                        "INSERT INTO sale_item_additions(id,sale_item_id,addition_id,addition_name,price,quantity) VALUES(?1,?2,?3,?4,?5,?6)",
                        rusqlite::params![new_uuid(), si_id, aid, aname, price, qty],
                    ).map_err(|e| err500(e.to_string()))?;
                }
                let sauces = db_item_sauces(&conn, &item.0).map_err(|e| err500(e))?;
                for (sid, sname) in &sauces {
                    conn.execute(
                        "INSERT INTO sale_item_sauces(id,sale_item_id,sauce_id,sauce_name) VALUES(?1,?2,?3,?4)",
                        rusqlite::params![new_uuid(), si_id, sid, sname],
                    ).map_err(|e| err500(e.to_string()))?;
                }
            }
            conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, order_id])
                .map_err(|e| err500(e.to_string()))?;

        }

        let sid = sale_id.clone();
        Ok((serde_json::json!({ "saleId": sale_id, "invoiceNumber": invoice_number }), sid, true))
    }).await;

    match result {
        Ok(Ok((v, sale_id, order_closed))) => {
            broadcast(&context, serde_json::json!({ "type": "SALE_CREATED", "tableId": null, "orderId": null, "saleId": sale_id }));
            if order_closed {
                broadcast(&context, serde_json::json!({ "type": "TABLE_CLOSED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            } else {
                broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            }
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/cancel
// ---------------------------------------------------------------------------

async fn cancel_order(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        let order = db_open_order(&conn, &table_id)?
            .ok_or_else(|| "La mesa no tiene orden abierta.".to_string())?;
        let order_id = order.0;
        let now = now_iso();
        conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, order_id])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO audit_log(id,tenant_id,user_id,user_name,action,entity_type,entity_id,details,created_at) VALUES(?1,?2,?3,?4,'CANCELAR_MESA','MESA',?5,'Cancelado desde movil',?6)",
            rusqlite::params![new_uuid(), tenant_id, user_id, "", table_id, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await;

    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_CLOSED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /tables/{id}/order/delivery
// ---------------------------------------------------------------------------

async fn patch_delivery(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<PatchDeliveryBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "UPDATE table_order_clients SET delivery_type_id=?1 WHERE id=?2",
            rusqlite::params![body.delivery_type_id.as_deref().filter(|s| !s.is_empty()), body.client_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await;
    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /tables/{id}/order/card
// ---------------------------------------------------------------------------

async fn patch_card(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<PatchCardBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "UPDATE table_order_clients SET is_card=?1 WHERE id=?2",
            rusqlite::params![if body.is_card { 1 } else { 0 }, body.client_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await;
    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /tables/{id}/order/clients/{client_id}/name y /notes
// ---------------------------------------------------------------------------

async fn patch_client_name(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, client_id)): Path<(String, String)>,
    Json(body): Json<PatchNameBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "UPDATE table_order_clients SET client_name=?1 WHERE id=?2",
            rusqlite::params![body.client_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()), client_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await;
    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

async fn patch_client_notes(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, client_id)): Path<(String, String)>,
    Json(body): Json<PatchNotesBody>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "UPDATE table_order_clients SET notes=?1 WHERE id=?2",
            rusqlite::params![body.notes.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()), client_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await;
    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// DELETE /tables/{id}/order/clients/{client_id}
// ---------------------------------------------------------------------------

async fn cancel_client(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, client_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<bool> {
        let conn = open_db(&db_path)?;
        let now = now_iso();
        conn.execute("UPDATE table_order_clients SET status='CANCELLED' WHERE id=?1", rusqlite::params![client_id])
            .map_err(|e| e.to_string())?;

        // Verificar si cerrar la orden
        let mut order_closed = false;
        let order = db_open_order(&conn, &table_id)?;
        if let Some((order_id, _, _, _, _, _, _, _)) = order {
            let active: i64 = conn.query_row(
                "SELECT COUNT(*) FROM table_order_clients WHERE table_order_id=?1 AND status='ACTIVE'",
                rusqlite::params![order_id],
                |r| r.get(0),
            ).unwrap_or(0);
            if active == 0 {
                conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, order_id])
                    .map_err(|e| e.to_string())?;
                order_closed = true;
            }
        }

        conn.execute(
            "INSERT INTO audit_log(id,tenant_id,user_id,user_name,action,entity_type,entity_id,details,created_at) VALUES(?1,?2,?3,'','CANCELAR_CLIENTE','MESA',?4,'Cancelado desde movil',?5)",
            rusqlite::params![new_uuid(), tenant_id, user_id, client_id, now],
        ).map_err(|e| e.to_string())?;
        Ok(order_closed)
    }).await;

    match result {
        Ok(Ok(order_closed)) => {
            if order_closed {
                broadcast(&context, serde_json::json!({ "type": "TABLE_CLOSED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            } else {
                broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            }
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/transfer/items
// ---------------------------------------------------------------------------

async fn transfer_items(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<TransferItemsBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let dest_id_bc = body.dest_table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        let src_order = db_open_order(&conn, &table_id)?
            .ok_or_else(|| "La mesa origen no tiene orden abierta.".to_string())?;
        let src_order_id = src_order.0;

        // Abrir o reutilizar orden en destino
        let dest_order_id = ensure_order(&conn, &body.dest_table_id, &tenant_id, &user_id, &src_order.4)?;

        let now = now_iso();
        for item_id in &body.item_ids {
            conn.execute(
                "UPDATE table_order_items SET table_order_id=?1, updated_at=?2 WHERE id=?3",
                rusqlite::params![dest_order_id, now, item_id],
            ).map_err(|e| e.to_string())?;
        }

        // Cerrar origen si queda sin clientes activos con items
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*) FROM table_order_items WHERE table_order_id=?1",
            rusqlite::params![src_order_id],
            |r| r.get(0),
        ).unwrap_or(0);
        if remaining == 0 {
            conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, src_order_id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }).await;

    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": dest_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/transfer/client
// ---------------------------------------------------------------------------

async fn transfer_client(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<TransferClientBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let user_id = user.user_id.clone();
    let db_path = context.db_path.clone();
    let table_id_bc = table_id.clone();
    let dest_id_bc = body.dest_table_id.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<()> {
        let conn = open_db(&db_path)?;
        let src_order = db_open_order(&conn, &table_id)?
            .ok_or_else(|| "La mesa origen no tiene orden abierta.".to_string())?;
        let src_order_id = src_order.0;

        let dest_order_id = ensure_order(&conn, &body.dest_table_id, &tenant_id, &user_id, &src_order.4)?;
        let now = now_iso();

        // Mover cliente
        conn.execute(
            "UPDATE table_order_clients SET table_order_id=?1 WHERE id=?2",
            rusqlite::params![dest_order_id, body.client_id],
        ).map_err(|e| e.to_string())?;
        // Mover sus items
        conn.execute(
            "UPDATE table_order_items SET table_order_id=?1, updated_at=?2 WHERE table_order_client_id=?3",
            rusqlite::params![dest_order_id, now, body.client_id],
        ).map_err(|e| e.to_string())?;

        // Cerrar origen si no quedan clientes activos
        let active: i64 = conn.query_row(
            "SELECT COUNT(*) FROM table_order_clients WHERE table_order_id=?1 AND status='ACTIVE'",
            rusqlite::params![src_order_id],
            |r| r.get(0),
        ).unwrap_or(0);
        if active == 0 {
            conn.execute("UPDATE table_orders SET status='CLOSED', closed_at=?1 WHERE id=?2", rusqlite::params![now, src_order_id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }).await;

    match result {
        Ok(Ok(())) => {
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": table_id_bc, "orderId": null, "saleId": null }));
            broadcast(&context, serde_json::json!({ "type": "TABLE_UPDATED", "tableId": dest_id_bc, "orderId": null, "saleId": null }));
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

fn ensure_order(conn: &Connection, table_id: &str, tenant_id: &str, user_id: &str, cash_session_id: &str) -> DbResult<String> {
    if let Some(order) = db_open_order(conn, table_id)? {
        return Ok(order.0);
    }
    let order_id = new_uuid();
    let client_id = new_uuid();
    let now = now_iso();
    conn.execute(
        "INSERT INTO table_orders(id,tenant_id,table_id,user_id,cash_session_id,status,opened_at) VALUES(?1,?2,?3,?4,?5,'OPEN',?6)",
        rusqlite::params![order_id, tenant_id, table_id, user_id, cash_session_id, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO table_order_clients(id,table_order_id,client_name,client_number,status,created_at) VALUES(?1,?2,NULL,1,'ACTIVE',?3)",
        rusqlite::params![client_id, order_id, now],
    ).map_err(|e| e.to_string())?;
    Ok(order_id)
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/comanda
// ---------------------------------------------------------------------------

async fn send_comanda(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
    Json(body): Json<SendComandaBody>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, Json<Value>)> {
        let conn = open_db(&db_path).map_err(|e| err500(e))?;
        let order = db_open_order(&conn, &table_id).map_err(|e| err500(e))?
            .ok_or_else(|| err409("La mesa no tiene orden abierta."))?;
        let order_id = order.0;

        let table = db_table(&conn, &table_id).map_err(|e| err500(e))?;
        let table_name = table.as_ref().map(|t| t.1.clone()).unwrap_or_default();

        // Obtener ultima comanda
        let last_time: Option<String> = conn.query_row(
            "SELECT MAX(created_at) FROM comandas WHERE table_order_id=?1",
            rusqlite::params![order_id],
            |r| r.get(0),
        ).optional().map_err(|e| err500(e.to_string()))?.flatten();

        // Items nuevos desde ultima comanda
        let items = get_new_items(&conn, &order_id, last_time.as_deref(), body.client_id.as_deref())
            .map_err(|e| err500(e))?;

        let root_count = {
            // Re-query para contar raices sin combo_parent
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM table_order_items i WHERE i.table_order_id=?1 AND i.combo_table_order_item_id IS NULL AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (SELECT id FROM table_order_clients WHERE table_order_id=?1 AND status='CANCELLED'))",
                rusqlite::params![order_id],
                |r| r.get(0),
            ).unwrap_or(0);
            count
        };
        if root_count == 0 {
            return Ok(serde_json::json!({ "ok": false, "message": "No hay productos nuevos para enviar a cocina." }));
        }

        let comanda_id = new_uuid();
        let now = now_iso();
        let comanda_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM comandas WHERE table_order_id=?1",
            rusqlite::params![order_id],
            |r| r.get(0),
        ).unwrap_or(0);
        let comanda_number = comanda_count + 1;

        let client_name: Option<String> = body.client_id.as_ref().and_then(|cid| {
            conn.query_row(
                "SELECT client_name FROM table_order_clients WHERE id=?1",
                rusqlite::params![cid],
                |r| r.get(0),
            ).optional().ok().flatten()
        });

        conn.execute(
            "INSERT INTO comandas(id,tenant_id,table_order_id,table_name,comanda_number,created_at,client_id,client_name,is_delivery,delivery_price) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,0)",
            rusqlite::params![comanda_id, tenant_id, order_id, table_name, comanda_number, now, body.client_id, client_name],
        ).map_err(|e| err500(e.to_string()))?;

        // Guardar comanda_items
        save_comanda_items(&conn, &comanda_id, &items).map_err(|e| err500(e))?;

        // Marcar comanda_sent
        conn.execute("UPDATE table_orders SET comanda_sent=1 WHERE id=?1", rusqlite::params![order_id])
            .map_err(|e| err500(e.to_string()))?;

        // Intentar imprimir (no bloqueante — retorna ok:true aunque falle la impresión)
        let kitchen_printer: Option<String> = conn.query_row(
            "SELECT printer_kitchen FROM tenants WHERE id=?1",
            rusqlite::params![tenant_id],
            |r| r.get(0),
        ).optional().map_err(|e| err500(e.to_string()))?.flatten();

        let (printed, print_error): (bool, Option<String>) = if let Some(printer) = kitchen_printer.filter(|p| !p.is_empty()) {
            let lines = build_comanda_lines(&comanda_id, comanda_number, &table_name, &now, client_name.as_deref(), &conn)
                .unwrap_or_default();
            // La impresión se delega al comando Tauri — desde la API REST no podemos invocar comandos Tauri directamente.
            // Se marca como no impresa con un mensaje informativo.
            let _ = (printer, lines);
            (false, Some("Impresion desde API movil no disponible; use la app de escritorio para reimprimir.".to_string()))
        } else {
            (false, Some("No hay impresora de cocina configurada.".to_string()))
        };

        Ok(serde_json::json!({
            "ok": true,
            "comandaNumber": comanda_number,
            "itemCount": root_count,
            "printed": printed,
            "printError": print_error,
        }))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

fn get_new_items(conn: &Connection, order_id: &str, since: Option<&str>, client_id: Option<&str>) -> DbResult<Vec<(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>)>> {
    let time_filter = if since.is_some() { "AND COALESCE(i.updated_at, i.added_at) > ?2" } else { "" };
    let sql = format!(
        "SELECT i.id, i.product_id, i.product_name, i.quantity, i.unit_price, i.subtotal, i.notes, i.selected_option, i.combo_id, i.table_order_client_id \
         FROM table_order_items i \
         WHERE i.table_order_id=?1 \
           AND (i.table_order_client_id IS NULL OR i.table_order_client_id NOT IN (SELECT id FROM table_order_clients WHERE table_order_id=?1 AND status='CANCELLED')) \
           {time_filter} \
         ORDER BY COALESCE(i.updated_at, i.added_at) ASC"
    );
    type Row = (String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<Row> = if let Some(t) = since {
        let collected: DbResult<Vec<Row>> = stmt.query_map(rusqlite::params![order_id, t], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
        collected?
    } else {
        let collected: DbResult<Vec<Row>> = stmt.query_map(rusqlite::params![order_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
        collected?
    };

    // Filtrar por cliente si se especifica
    if let Some(cid) = client_id {
        Ok(rows.into_iter().filter(|r| r.9.as_deref() == Some(cid)).collect())
    } else {
        Ok(rows)
    }
}

fn save_comanda_items(conn: &Connection, comanda_id: &str, items: &[(String, Option<String>, String, f64, f64, f64, Option<String>, Option<String>, Option<String>, Option<String>)]) -> DbResult<()> {
    let roots: Vec<_> = items.iter().collect(); // simplificado — no hay combo tracking aqui
    for item in &roots {
        let additions = db_item_additions(conn, &item.0)?;
        let sauces = db_item_sauces(conn, &item.0)?;
        let add_text = if additions.is_empty() { None } else {
            Some(additions.iter().map(|(_, n, _, q)| if *q > 1.0 { format!("x{} {}", *q as i64, n) } else { n.clone() }).collect::<Vec<_>>().join(", "))
        };
        let sac_text = if sauces.is_empty() { None } else {
            Some(sauces.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>().join(", "))
        };
        conn.execute(
            "INSERT INTO comanda_items(id,comanda_id,product_name,quantity,additions_text,sauces_text,notes,selected_option,subtotal,combo_parent_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)",
            rusqlite::params![new_uuid(), comanda_id, item.2, item.3, add_text, sac_text, item.6, item.7, item.5],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GET /tables/{id}/order/comandas
// ---------------------------------------------------------------------------

async fn list_comandas(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Value> {
        let conn = open_db(&db_path)?;
        let order = db_open_order(&conn, &table_id)?;
        let Some((order_id, _, _, _, _, _, _, _)) = order else {
            return Ok(Value::Array(vec![]));
        };
        let mut stmt = conn.prepare(
            "SELECT c.id, c.comanda_number, c.created_at, (SELECT COUNT(*) FROM comanda_items WHERE comanda_id=c.id AND combo_parent_id IS NULL) AS item_count FROM comandas c WHERE c.table_order_id=?1 ORDER BY c.comanda_number ASC"
        ).map_err(|e| e.to_string())?;
        let rows: Vec<Value> = stmt.query_map(rusqlite::params![order_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "number": r.get::<_, i64>(1)?,
                "createdAt": r.get::<_, String>(2)?,
                "itemCount": r.get::<_, i64>(3)?,
            }))
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(Value::Array(rows))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/comandas/{comanda_id}/reprint
// ---------------------------------------------------------------------------

async fn reprint_comanda(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((table_id, comanda_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Value> {
        let conn = open_db(&db_path)?;
        let kitchen_printer: Option<String> = conn.query_row(
            "SELECT printer_kitchen FROM tenants WHERE id=?1",
            rusqlite::params![tenant_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?.flatten();

        if kitchen_printer.as_deref().map_or(true, |p| p.is_empty()) {
            return Ok(serde_json::json!({ "ok": false, "message": "No hay impresora de cocina configurada." }));
        }

        let row = conn.query_row(
            "SELECT id, comanda_number, created_at, client_name FROM comandas WHERE id=?1",
            rusqlite::params![comanda_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)),
        ).optional().map_err(|e| e.to_string())?;

        let Some((cid, cnum, created_at, client_name)) = row else {
            return Ok(serde_json::json!({ "ok": false, "message": "Comanda no encontrada." }));
        };

        let table_name: String = conn.query_row(
            "SELECT COALESCE(rt.name,'') FROM comandas c LEFT JOIN restaurant_tables rt ON rt.id=(SELECT table_id FROM table_orders WHERE id=c.table_order_id LIMIT 1) WHERE c.id=?1",
            rusqlite::params![cid],
            |r| r.get(0),
        ).unwrap_or_default();

        let _lines = build_comanda_lines(&cid, cnum, &table_name, &created_at, client_name.as_deref(), &conn)?;
        let _ = table_id;
        // Impresión desde API REST no disponible directamente (requiere IPC Tauri)
        Ok(serde_json::json!({ "ok": false, "printError": "Impresion desde API movil no disponible; use la app de escritorio." }))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /tables/{id}/order/receipts
// ---------------------------------------------------------------------------

async fn list_receipts(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(table_id): Path<String>,
) -> impl IntoResponse {
    let _ = user;
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> DbResult<Value> {
        let conn = open_db(&db_path)?;
        let order = db_open_order(&conn, &table_id)?;
        let Some((order_id, _, _, _, _, _, _, _)) = order else {
            return Ok(Value::Array(vec![]));
        };
        let mut stmt = conn.prepare(
            "SELECT id, invoice_number, total, created_at FROM sales WHERE table_order_id=?1 ORDER BY created_at ASC"
        ).map_err(|e| e.to_string())?;
        let rows: Vec<Value> = stmt.query_map(rusqlite::params![order_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "invoiceNumber": r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                "total": r.get::<_, f64>(2)?,
                "createdAt": r.get::<_, String>(3)?,
            }))
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(Value::Array(rows))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// POST /tables/{id}/order/receipts/{sale_id}/print
// ---------------------------------------------------------------------------

async fn print_receipt(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path((_table_id, _sale_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let _ = (user, context);
    // Impresión de recibo requiere IPC Tauri — no disponible desde API REST
    (StatusCode::OK, Json(serde_json::json!({
        "ok": false,
        "printError": "Impresion desde API movil no disponible; use la app de escritorio."
    })))
}

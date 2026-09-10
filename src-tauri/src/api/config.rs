use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Extension, Json, Router};
use rusqlite::OptionalExtension;
use super::{ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/config/max-sauces", get(max_sauces))
        .route("/api/v1/config/delivery-types", get(delivery_types))
}

async fn max_sauces(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let val: Option<i64> = conn.query_row(
            "SELECT max_sauces FROM tenants WHERE id=?1",
            rusqlite::params![tenant_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?.flatten();
        Ok(val.unwrap_or(3))
    }).await;

    match result {
        Ok(Ok(n)) => (StatusCode::OK, Json(serde_json::json!({ "maxSauces": n }))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

async fn delivery_types(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, name, price, sort_order FROM delivery_types \
             WHERE tenant_id=?1 ORDER BY sort_order, name COLLATE NOCASE",
        ).map_err(|e| e.to_string())?;
        let rows: Vec<serde_json::Value> = stmt.query_map(
            rusqlite::params![tenant_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
            )),
        ).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|(id, name, price, sort_order)| serde_json::json!({
            "id": id,
            "name": name.unwrap_or_default(),
            "price": price,
            "sortOrder": sort_order,
        }))
        .collect();
        Ok::<Vec<serde_json::Value>, String>(rows)
    }).await;

    match result {
        Ok(Ok(payload)) => (StatusCode::OK, Json(serde_json::Value::Array(payload))).into_response(),
        Ok(Err(msg)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

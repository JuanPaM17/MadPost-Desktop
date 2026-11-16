use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Extension, Json, Router};
use rusqlite::OptionalExtension;
use super::{ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/dashboard/summary", get(summary))
}

async fn summary(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Caja abierta
        let cash = conn.query_row(
            "SELECT cs.id, cs.session_number, COALESCE(u.display_name, u.username) \
             FROM cash_sessions cs \
             LEFT JOIN users u ON u.id = cs.user_id \
             WHERE cs.tenant_id=?1 AND cs.status='OPEN' \
             ORDER BY cs.opened_at DESC LIMIT 1",
            rusqlite::params![tenant_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            )),
        ).optional().map_err(|e| e.to_string())?;

        // Productos activos
        let active_products: i64 = conn.query_row(
            "SELECT COUNT(*) FROM products WHERE tenant_id=?1 AND COALESCE(active,1)=1",
            rusqlite::params![tenant_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        // Total de mesas
        let total_tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM restaurant_tables WHERE tenant_id=?1 AND COALESCE(active,1)=1",
            rusqlite::params![tenant_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        // Mesas con orden abierta
        let tables_with_open_orders: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT rt.id) \
             FROM restaurant_tables rt \
             INNER JOIN table_orders tor ON tor.table_id = rt.id AND tor.status='OPEN' \
             WHERE rt.tenant_id=?1 AND COALESCE(rt.active,1)=1",
            rusqlite::params![tenant_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        let cash_json = match cash {
            None => serde_json::json!({ "open": false }),
            Some((id, session_number, opened_by)) => serde_json::json!({
                "open": true,
                "id": id,
                "sessionNumber": session_number,
                "openedBy": opened_by,
            }),
        };

        Ok(serde_json::json!({
            "cash": cash_json,
            "activeProducts": active_products,
            "totalTables": total_tables,
            "tablesWithOpenOrders": tables_with_open_orders,
        }))
    }).await;

    match result {
        Ok(Ok(payload)) => (StatusCode::OK, Json(payload)).into_response(),
        Ok(Err(msg)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

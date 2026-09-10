use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Extension, Json, Router};
use rusqlite::OptionalExtension;
use super::{ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/cash/session/current", get(session_current))
}

async fn session_current(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let row = conn.query_row(
            "SELECT id, session_number, opened_at FROM cash_sessions \
             WHERE tenant_id=?1 AND status='OPEN' ORDER BY opened_at DESC LIMIT 1",
            rusqlite::params![tenant_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            )),
        ).optional().map_err(|e| e.to_string())?;

        Ok::<serde_json::Value, String>(match row {
            None => serde_json::json!({ "open": false }),
            Some((id, session_number, opened_at)) => serde_json::json!({
                "open": true,
                "id": id,
                "sessionNumber": session_number,
                "openedAt": opened_at,
            }),
        })
    }).await;

    match result {
        Ok(Ok(payload)) => (StatusCode::OK, Json(payload)).into_response(),
        Ok(Err(msg)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

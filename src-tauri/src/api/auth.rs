use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::{get, post}, Json, Router};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use super::{ApiContext, JwtClaims, JWT_EXPIRY_SECS, make_jwt};

#[derive(Deserialize)]
struct LoginBody { username: String, password: String }

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/auth/ping", get(ping))
        .route("/api/v1/auth/login", post(login))
}

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn login(
    State(context): State<ApiContext>,
    Json(body): Json<LoginBody>,
) -> impl IntoResponse {
    let username = body.username.trim().to_lowercase();
    let password = body.password.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, username, password_hash, display_name, role FROM users \
             WHERE tenant_id=?1 AND LOWER(username)=?2 AND active=1 LIMIT 1",
        ).map_err(|e| e.to_string())?;
        let row = stmt.query_row(
            rusqlite::params![context.tenant_id, username],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            )),
        ).optional().map_err(|e| e.to_string())?;

        let (user_id, uname, pw_hash, display_name, role) = match row {
            Some(r) => r,
            None => return Err("Usuario o contrasena incorrectos.".to_string()),
        };

        if !bcrypt::verify(&password, &pw_hash).unwrap_or(false) {
            return Err("Usuario o contrasena incorrectos.".to_string());
        }

        let exp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() + JWT_EXPIRY_SECS;

        let claims = JwtClaims {
            sub: user_id.clone(),
            username: uname.clone(),
            role: role.clone(),
            tenant_id: context.tenant_id.clone(),
            exp,
        };

        let token = make_jwt(&claims, &context.jwt_secret)
            .ok_or_else(|| "No fue posible generar el token.".to_string())?;

        Ok(serde_json::json!({
            "token": token,
            "userId": user_id,
            "username": uname,
            "displayName": display_name.unwrap_or_else(|| uname.clone()),
            "role": role,
            "tenantId": context.tenant_id,
        }))
    }).await;

    match result {
        Ok(Ok(payload)) => (StatusCode::OK, Json(payload)).into_response(),
        Ok(Err(msg)) => (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": msg }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

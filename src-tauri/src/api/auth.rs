use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::{get, patch, post}, Extension, Json, Router};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use super::{ApiContext, AuthUser, JwtClaims, JWT_EXPIRY_SECS, make_jwt};

#[derive(Deserialize)]
struct LoginBody { username: String, password: String }

#[derive(Deserialize)]
struct UpdateProfileBody {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    username: Option<String>,
    #[serde(rename = "currentPassword")]
    current_password: Option<String>,
    #[serde(rename = "newPassword")]
    new_password: Option<String>,
}

pub fn public_router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/auth/ping", get(ping))
        .route("/api/v1/auth/login", post(login))
}

pub fn protected_router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/auth/profile", get(get_profile).patch(update_profile))
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

// ---------------------------------------------------------------------------
// GET /api/v1/auth/profile  (requiere JWT)
// ---------------------------------------------------------------------------

async fn get_profile(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let user_id = user.user_id.clone();
    let tenant_id = user.tenant_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        let (username, display_name, role): (String, Option<String>, String) = conn
            .query_row(
                "SELECT username, display_name, role FROM users WHERE id=?1 AND tenant_id=?2 LIMIT 1",
                rusqlite::params![user_id, tenant_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "username": username,
            "displayName": display_name.unwrap_or_else(|| username.clone()),
            "role": role,
        }))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/auth/profile  (requiere JWT)
// ---------------------------------------------------------------------------

async fn update_profile(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<UpdateProfileBody>,
) -> impl IntoResponse {
    let user_id = user.user_id.clone();
    let tenant_id = user.tenant_id.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;

        // Cargar usuario actual
        let (current_hash, current_username, current_display): (String, String, Option<String>) = conn
            .query_row(
                "SELECT password_hash, username, display_name FROM users WHERE id=?1 AND tenant_id=?2 LIMIT 1",
                rusqlite::params![user_id, tenant_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;

        // Si quiere cambiar password, verificar la actual
        let new_hash = if let Some(ref new_pw) = body.new_password {
            if new_pw.len() < 4 {
                return Err("La contrasena debe tener al menos 4 caracteres.".to_string());
            }
            let cur_pw = body.current_password.as_deref().unwrap_or("");
            if !bcrypt::verify(cur_pw, &current_hash).unwrap_or(false) {
                return Err("La contrasena actual es incorrecta.".to_string());
            }
            let hash = bcrypt::hash(new_pw, bcrypt::DEFAULT_COST)
                .map_err(|e| e.to_string())?;
            Some(hash)
        } else {
            None
        };

        let new_username = body.username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&current_username)
            .to_lowercase();

        let new_display = body.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or(current_display);

        if let Some(ref hash) = new_hash {
            conn.execute(
                "UPDATE users SET username=?1, display_name=?2, password_hash=?3 WHERE id=?4 AND tenant_id=?5",
                rusqlite::params![new_username, new_display, hash, user_id, tenant_id],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE users SET username=?1, display_name=?2 WHERE id=?3 AND tenant_id=?4",
                rusqlite::params![new_username, new_display, user_id, tenant_id],
            ).map_err(|e| e.to_string())?;
        }

        Ok(serde_json::json!({
            "username": new_username,
            "displayName": new_display,
        }))
    }).await;

    match result {
        Ok(Ok(payload)) => (StatusCode::OK, Json(payload)).into_response(),
        Ok(Err(msg)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({ "error": msg }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

use axum::{extract::{Path, State}, http::StatusCode, response::IntoResponse, routing::{get, patch, post}, Extension, Json, Router};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use super::{ApiContext, AuthUser, JwtClaims, JWT_EXPIRY_SECS, make_jwt};

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchDeviceBody {
    alias: Option<String>,
    status: Option<String>,
}

#[derive(Serialize)]
struct DeviceRow {
    id: String,
    alias: String,
    status: String,
    last_ip: Option<String>,
    last_seen_at: Option<String>,
    registered_at: String,
}

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
        .route("/api/v1/auth/device-status", get(device_status))
}

pub fn protected_router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/auth/profile", get(get_profile).patch(update_profile))
        .route("/api/v1/devices", get(list_devices))
        .route("/api/v1/devices/{id}", patch(patch_device).delete(delete_device))
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
    let device_id = body.device_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;

        // Si viene deviceId, verificar/registrar el dispositivo antes de validar credenciales
        if let Some(ref did) = device_id {
            let did = did.trim().to_string();
            if did.is_empty() {
                return Err("deviceId invalido.".to_string());
            }
            let status: Option<String> = conn.query_row(
                "SELECT status FROM mobile_devices WHERE id=?1 AND tenant_id=?2 LIMIT 1",
                rusqlite::params![did, context.tenant_id],
                |r| r.get(0),
            ).optional().map_err(|e| e.to_string())?;

            match status.as_deref() {
                None => {
                    // Primer intento — registrar como pending
                    let now = chrono::Utc::now().to_rfc3339();
                    conn.execute(
                        "INSERT INTO mobile_devices(id, tenant_id, status, registered_at) VALUES(?1, ?2, 'pending', ?3)",
                        rusqlite::params![did, context.tenant_id, now],
                    ).map_err(|e| e.to_string())?;
                    return Ok(serde_json::json!({ "requiresApproval": true }));
                }
                Some("pending") => {
                    return Ok(serde_json::json!({ "requiresApproval": true }));
                }
                Some("revoked") => {
                    return Err("Este dispositivo ha sido revocado.".to_string());
                }
                _ => {} // approved — continuar con login normal
            }
        }

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

        // Actualizar last_seen_at del dispositivo si aplica
        if let Some(ref did) = device_id {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = conn.execute(
                "UPDATE mobile_devices SET last_seen_at=?1 WHERE id=?2 AND tenant_id=?3",
                rusqlite::params![now, did, context.tenant_id],
            );
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
        Ok(Ok(payload)) => {
            if payload.get("requiresApproval").and_then(|v| v.as_bool()).unwrap_or(false) {
                (StatusCode::ACCEPTED, Json(payload)).into_response()
            } else {
                (StatusCode::OK, Json(payload)).into_response()
            }
        }
        Ok(Err(msg)) => {
            let status = if msg.contains("revocado") { StatusCode::FORBIDDEN } else { StatusCode::UNAUTHORIZED };
            (status, Json(serde_json::json!({ "error": msg }))).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/auth/device-status?deviceId=xxx  (publico)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DeviceStatusQuery { #[serde(rename = "deviceId")] device_id: String }

async fn device_status(
    State(context): State<ApiContext>,
    axum::extract::Query(query): axum::extract::Query<DeviceStatusQuery>,
) -> impl IntoResponse {
    let device_id = query.device_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        let status: Option<String> = conn.query_row(
            "SELECT status FROM mobile_devices WHERE id=?1 AND tenant_id=?2 LIMIT 1",
            rusqlite::params![device_id, context.tenant_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        Ok::<String, String>(status.unwrap_or_else(|| "unknown".to_string()))
    }).await;
    match result {
        Ok(Ok(status)) => (StatusCode::OK, Json(serde_json::json!({ "status": status }))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/devices  (admin)
// ---------------------------------------------------------------------------

async fn list_devices(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    if user.role != "ADMIN" && user.role != "SUPERADMIN" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Sin permiso." }))).into_response();
    }
    let tenant_id = user.tenant_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, alias, status, last_ip, last_seen_at, registered_at FROM mobile_devices WHERE tenant_id=?1 ORDER BY registered_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![tenant_id], |r| Ok(DeviceRow {
            id: r.get(0)?,
            alias: r.get(1)?,
            status: r.get(2)?,
            last_ip: r.get(3)?,
            last_seen_at: r.get(4)?,
            registered_at: r.get(5)?,
        })).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();
        Ok::<Vec<DeviceRow>, String>(rows)
    }).await;
    match result {
        Ok(Ok(rows)) => (StatusCode::OK, Json(serde_json::json!(rows))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// PATCH /api/v1/devices/:id  (admin)
// ---------------------------------------------------------------------------

async fn patch_device(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<String>,
    Json(body): Json<PatchDeviceBody>,
) -> impl IntoResponse {
    if user.role != "ADMIN" && user.role != "SUPERADMIN" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Sin permiso." }))).into_response();
    }
    let tenant_id = user.tenant_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        if let Some(ref alias) = body.alias {
            conn.execute(
                "UPDATE mobile_devices SET alias=?1 WHERE id=?2 AND tenant_id=?3",
                rusqlite::params![alias.trim(), id, tenant_id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(ref status) = body.status {
            if status != "approved" && status != "revoked" && status != "pending" {
                return Err("Status invalido.".to_string());
            }
            conn.execute(
                "UPDATE mobile_devices SET status=?1 WHERE id=?2 AND tenant_id=?3",
                rusqlite::params![status, id, tenant_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }).await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Ok(Err(e)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({ "error": e }))).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": "Error interno." }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/devices/:id  (admin)
// ---------------------------------------------------------------------------

async fn delete_device(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if user.role != "ADMIN" && user.role != "SUPERADMIN" {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Sin permiso." }))).into_response();
    }
    let tenant_id = user.tenant_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&context.db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM mobile_devices WHERE id=?1 AND tenant_id=?2",
            rusqlite::params![id, tenant_id],
        ).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }).await;
    match result {
        Ok(Ok(())) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
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

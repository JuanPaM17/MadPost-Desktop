pub mod auth;
pub mod cash;
pub mod catalog;
pub mod config;
pub mod dashboard;
pub mod sales;
pub mod tables;

use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::IntoResponse,
    Json,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex}};

// ---------------------------------------------------------------------------
// Tipos compartidos
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ApiContext {
    pub tenant_id: String,
    pub tenant_name: String,
    pub tenant_address: String,
    pub db_path: String,
    pub jwt_secret: String,
    pub clients: Arc<Mutex<HashMap<String, WsClientInfo>>>,
    pub broadcast_tx: tokio::sync::broadcast::Sender<String>,
}

#[derive(Clone, Serialize)]
pub struct WsClientInfo {
    pub ip: String,
    pub connected_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub tenant_id: String,
    pub exp: u64,
}

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_id: String,
    pub username: String,
    pub role: String,
    pub tenant_id: String,
}

pub const JWT_EXPIRY_SECS: u64 = 60 * 60 * 24 * 30;

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

pub async fn auth_middleware(
    State(context): State<ApiContext>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> impl IntoResponse {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);

    let claims = match token.and_then(|t| verify_jwt(&t, &context.jwt_secret)) {
        Some(c) => c,
        None => return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Token invalido o expirado." })),
        ).into_response(),
    };

    // Si viene X-Device-Id, verificar que el dispositivo este aprobado
    if let Some(device_id) = req.headers().get("x-device-id").and_then(|v| v.to_str().ok()).map(str::to_string) {
        let db_path = context.db_path.clone();
        let tenant_id = claims.tenant_id.clone();
        let status = tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path).ok()?;
            conn.query_row(
                "SELECT status FROM mobile_devices WHERE id=?1 AND tenant_id=?2 LIMIT 1",
                rusqlite::params![device_id, tenant_id],
                |r| r.get::<_, String>(0),
            ).optional().ok()?
        }).await.unwrap_or(None);

        match status.as_deref() {
            Some("approved") => {}
            Some("revoked") => return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "Dispositivo revocado." })),
            ).into_response(),
            _ => return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Dispositivo no autorizado." })),
            ).into_response(),
        }
    }

    req.extensions_mut().insert(AuthUser {
        user_id: claims.sub,
        username: claims.username,
        role: claims.role,
        tenant_id: claims.tenant_id,
    });
    next.run(req).await.into_response()
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

pub fn verify_jwt(token: &str, secret: &str) -> Option<JwtClaims> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    decode::<JwtClaims>(token, &key, &Validation::default())
        .ok()
        .map(|d| d.claims)
}

pub fn make_jwt(claims: &JwtClaims, secret: &str) -> Option<String> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// WS broadcast helper
// ---------------------------------------------------------------------------

/// Envia un evento JSON a todos los clientes WebSocket conectados.
/// Los 7 tipos de evento siguen el esquema Java WsEvent: { type, tableId, orderId, saleId }.
pub fn broadcast(context: &ApiContext, event: serde_json::Value) {
    let _ = context.broadcast_tx.send(event.to_string());
}

// ---------------------------------------------------------------------------
// Stub para endpoints sin implementar
// ---------------------------------------------------------------------------

pub async fn not_implemented() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "not_implemented",
            "message": "Este endpoint esta registrado, pero su servicio aun no esta disponible."
        })),
    )
}

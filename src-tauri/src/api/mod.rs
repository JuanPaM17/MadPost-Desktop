pub mod auth;
pub mod cash;
pub mod catalog;
pub mod config;
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
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex}};

// ---------------------------------------------------------------------------
// Tipos compartidos
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ApiContext {
    pub tenant_id: String,
    pub tenant_name: String,
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

    match token.and_then(|t| verify_jwt(&t, &context.jwt_secret)) {
        Some(claims) => {
            req.extensions_mut().insert(AuthUser {
                user_id: claims.sub,
                username: claims.username,
                role: claims.role,
                tenant_id: claims.tenant_id,
            });
            next.run(req).await.into_response()
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Token invalido o expirado." })),
        )
            .into_response(),
    }
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

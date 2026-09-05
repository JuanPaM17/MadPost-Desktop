use axum::{
    extract::{connect_info::ConnectInfo, ws::{WebSocket, WebSocketUpgrade}, State},
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use std::{collections::HashMap, net::{SocketAddr, TcpListener, UdpSocket}, sync::{Arc, Mutex}};
use tokio::sync::oneshot;
use tower_http::cors::{Any, CorsLayer};

const API_PORT: u16 = 8765;

#[derive(Default)]
pub struct MobileRuntimeState {
    api: Mutex<Option<ApiHandle>>,
    mdns: Mutex<Option<MdnsHandle>>,
    clients: Arc<Mutex<HashMap<String, WsClientInfo>>>,
}

struct ApiHandle { shutdown: oneshot::Sender<()> }
struct MdnsHandle { daemon: ServiceDaemon, fullname: String }

#[derive(Serialize)]
pub struct NativeResult { pub active: bool, pub message: String }

#[derive(Clone, Serialize)]
pub struct WsClientInfo { pub ip: String, pub connected_at: String }
#[derive(Serialize)]
pub struct MobileApiStatus { pub active: bool, pub port: u16, pub local_ip: Option<String>, pub clients: Vec<WsClientInfo> }

#[derive(Clone)]
struct ApiContext { tenant_id: String, tenant_name: String, clients: Arc<Mutex<HashMap<String, WsClientInfo>>> }

pub fn start_api(state: &MobileRuntimeState, tenant_id: String, tenant_name: String) -> NativeResult {
    let mut api = match state.api.lock() { Ok(value) => value, Err(_) => return NativeResult { active: false, message: "API state lock unavailable".to_string() } };
    if api.is_some() { return NativeResult { active: true, message: format!("MadPost API already listening on 0.0.0.0:{API_PORT}") }; }
    let listener = match TcpListener::bind(("0.0.0.0", API_PORT)) {
        Ok(listener) => listener,
        Err(error) => return NativeResult { active: false, message: format!("MadPost API not started on port {API_PORT}: {error}") },
    };
    if let Err(error) = listener.set_nonblocking(true) {
        return NativeResult { active: false, message: format!("MadPost API socket setup failed: {error}") };
    }
    let (shutdown, receiver) = oneshot::channel::<()>();
    let context = ApiContext { tenant_id, tenant_name, clients: Arc::clone(&state.clients) };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) { Ok(value) => value, Err(error) => { eprintln!("MadPost API listener conversion failed: {error}"); return; } };
        if let Err(error) = axum::serve(listener, router(context).into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async { let _ = receiver.await; }).await {
            eprintln!("MadPost API server error: {error}");
        }
    });
    *api = Some(ApiHandle { shutdown });
    NativeResult { active: true, message: format!("MadPost API listening on http://0.0.0.0:{API_PORT}/") }
}

pub fn api_status(state: &MobileRuntimeState) -> MobileApiStatus {
    let active = state.api.lock().map(|api| api.is_some()).unwrap_or(false);
    let mut clients = state.clients.lock().map(|clients| clients.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    clients.sort_by(|left, right| left.ip.cmp(&right.ip));
    MobileApiStatus { active, port: API_PORT, local_ip: local_ipv4(), clients }
}

pub fn stop_api(state: &MobileRuntimeState) -> NativeResult {
    let mut api = match state.api.lock() { Ok(value) => value, Err(_) => return NativeResult { active: false, message: "API state lock unavailable".to_string() } };
    if let Some(handle) = api.take() { let _ = handle.shutdown.send(()); if let Ok(mut clients) = state.clients.lock() { clients.clear(); } NativeResult { active: false, message: "MadPost API stopped".to_string() } }
    else { NativeResult { active: false, message: "MadPost API was not running".to_string() } }
}

pub fn publish_mdns(state: &MobileRuntimeState, tenant_id: String, tenant_name: String) -> NativeResult {
    let mut mdns = match state.mdns.lock() { Ok(value) => value, Err(_) => return NativeResult { active: false, message: "mDNS state lock unavailable".to_string() } };
    if mdns.is_some() { return NativeResult { active: true, message: "mDNS service already published".to_string() }; }
    let daemon = match ServiceDaemon::new() { Ok(value) => value, Err(error) => return NativeResult { active: false, message: format!("mDNS not published: {error}") } };
    let safe_name: String = tenant_name.chars().map(|character| if character.is_ascii_alphanumeric() { character } else { '-' }).collect();
    let instance_name = format!("MadPost-{}", safe_name.trim_matches('-'));
    let mut properties = HashMap::new();
    properties.insert("version".to_string(), env!("CARGO_PKG_VERSION").to_string());
    properties.insert("tenantId".to_string(), tenant_id);
    properties.insert("tenantName".to_string(), tenant_name);
    let service = match ServiceInfo::new("_madpost._tcp.local.", &instance_name, "madpost.local.", "", API_PORT, properties) {
        Ok(value) => value,
        Err(error) => return NativeResult { active: false, message: format!("mDNS service configuration failed: {error}") },
    };
    let fullname = service.get_fullname().to_string();
    match daemon.register(service) {
        Ok(_) => { *mdns = Some(MdnsHandle { daemon, fullname }); NativeResult { active: true, message: format!("mDNS published: {instance_name} on port {API_PORT}") } }
        Err(error) => NativeResult { active: false, message: format!("mDNS not published: {error}") },
    }
}

pub fn unpublish_mdns(state: &MobileRuntimeState) -> NativeResult {
    let mut mdns = match state.mdns.lock() { Ok(value) => value, Err(_) => return NativeResult { active: false, message: "mDNS state lock unavailable".to_string() } };
    if let Some(handle) = mdns.take() {
        let _ = handle.daemon.unregister(&handle.fullname);
        let _ = handle.daemon.shutdown();
        NativeResult { active: false, message: "mDNS unpublished".to_string() }
    } else { NativeResult { active: false, message: "mDNS was not published".to_string() } }
}

fn router(context: ApiContext) -> Router {
    Router::new()
        .route("/api/v1/auth/ping", get(ping))
        .route("/api/v1/auth/login", post(not_implemented))
        .route("/api/v1/catalog/categories", get(not_implemented))
        .route("/api/v1/catalog/products", get(not_implemented))
        .route("/api/v1/catalog/additions", get(not_implemented))
        .route("/api/v1/catalog/combos", get(not_implemented))
        .route("/api/v1/catalog/sauces", get(not_implemented))
        .route("/api/v1/config/max-sauces", get(not_implemented))
        .route("/api/v1/config/delivery-types", get(not_implemented))
        .route("/api/v1/cash/session/current", get(not_implemented))
        .route("/api/v1/sales", get(not_implemented).post(not_implemented))
        .route("/api/v1/sales/{id}", get(not_implemented))
        .route("/api/v1/tables", get(not_implemented))
        .route("/api/v1/tables/{id}", get(not_implemented))
        .route("/api/v1/tables/{id}/order", get(not_implemented).post(not_implemented))
        .route("/api/v1/tables/{id}/order/clients", post(not_implemented))
        .route("/api/v1/tables/{id}/order/items", post(not_implemented))
        .route("/api/v1/tables/{id}/order/items/{item_id}", axum::routing::delete(not_implemented).patch(not_implemented))
        .route("/api/v1/tables/{id}/order/pay", post(not_implemented))
        .route("/api/v1/tables/{id}/order/cancel", post(not_implemented))
        .route("/api/v1/tables/{id}/order/delivery", patch(not_implemented))
        .route("/api/v1/tables/{id}/order/clients/{client_id}/name", patch(not_implemented))
        .route("/api/v1/tables/{id}/order/clients/{client_id}/notes", patch(not_implemented))
        .route("/api/v1/tables/{id}/order/clients/{client_id}", axum::routing::delete(not_implemented))
        .route("/api/v1/tables/{id}/order/card", patch(not_implemented))
        .route("/api/v1/tables/{id}/order/transfer/items", post(not_implemented))
        .route("/api/v1/tables/{id}/order/transfer/client", post(not_implemented))
        .route("/api/v1/tables/{id}/order/comanda", post(not_implemented))
        .route("/api/v1/tables/{id}/order/comandas", get(not_implemented))
        .route("/api/v1/tables/{id}/order/comandas/{comanda_id}/reprint", post(not_implemented))
        .route("/api/v1/tables/{id}/order/receipts", get(not_implemented))
        .route("/api/v1/tables/{id}/order/receipts/{sale_id}/print", post(not_implemented))
        .route("/ws", get(websocket))
        .with_state(context)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE]).allow_headers(Any))
}

async fn websocket(State(context): State<ApiContext>, ConnectInfo(address): ConnectInfo<SocketAddr>, socket: WebSocketUpgrade) -> impl IntoResponse {
    socket.on_upgrade(move |socket| websocket_session(socket, context, address))
}

async fn websocket_session(mut socket: WebSocket, context: ApiContext, address: SocketAddr) {
    let ip = address.ip().to_string();
    if let Ok(mut clients) = context.clients.lock() { clients.insert(ip.clone(), WsClientInfo { ip: ip.clone(), connected_at: chrono::Utc::now().to_rfc3339() }); }
    while socket.recv().await.is_some() {}
    if let Ok(mut clients) = context.clients.lock() { clients.remove(&ip); }
}

fn local_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    address.is_ipv4().then_some(address.to_string())
}

async fn ping(State(context): State<ApiContext>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "tenantId": context.tenant_id, "tenantName": context.tenant_name }))
}

async fn not_implemented() -> impl IntoResponse {
    (StatusCode::NOT_IMPLEMENTED, Json(serde_json::json!({ "error": "not_implemented", "message": "Este endpoint esta registrado, pero su servicio aun no esta disponible." })))
}

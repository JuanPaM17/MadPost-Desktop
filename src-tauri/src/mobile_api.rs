use axum::{
    extract::{connect_info::ConnectInfo, ws::{Message, WebSocket, WebSocketUpgrade}, Query, State},
    http::Method,
    middleware,
    response::IntoResponse,
    routing::get,
    Router,
};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::{SocketAddr, TcpListener, UdpSocket}, sync::{Arc, Mutex}};
use tokio::sync::{broadcast, oneshot};
use tower_http::cors::{Any, CorsLayer};

use crate::api::{auth_middleware, verify_jwt, ApiContext, WsClientInfo};

const API_PORT: u16 = 8765;

// ---------------------------------------------------------------------------
// Estado en memoria del servidor y mDNS
// ---------------------------------------------------------------------------

pub struct MobileRuntimeState {
    api: Mutex<Option<ApiHandle>>,
    mdns: Mutex<Option<MdnsHandle>>,
    clients: Arc<Mutex<HashMap<String, WsClientInfo>>>,
    jwt_secret: Mutex<Option<String>>,
    broadcast_tx: broadcast::Sender<String>,
}

impl Default for MobileRuntimeState {
    fn default() -> Self {
        let (broadcast_tx, _) = broadcast::channel(64);
        Self {
            api: Mutex::new(None),
            mdns: Mutex::new(None),
            clients: Arc::new(Mutex::new(HashMap::new())),
            jwt_secret: Mutex::new(None),
            broadcast_tx,
        }
    }
}

struct ApiHandle { shutdown: oneshot::Sender<()> }
struct MdnsHandle { daemon: ServiceDaemon, fullname: String }

#[derive(Serialize)]
pub struct NativeResult { pub active: bool, pub message: String }

#[derive(Serialize)]
pub struct MobileApiStatus {
    pub active: bool,
    pub port: u16,
    pub local_ip: Option<String>,
    pub clients: Vec<WsClientInfo>,
}

#[derive(Deserialize)]
struct WsQueryParams { token: Option<String> }

// ---------------------------------------------------------------------------
// Ciclo de vida del servidor
// ---------------------------------------------------------------------------

pub fn start_api(state: &MobileRuntimeState, tenant_id: String, tenant_name: String) -> NativeResult {
    let mut api = match state.api.lock() {
        Ok(v) => v,
        Err(_) => return NativeResult { active: false, message: "API state lock unavailable".to_string() },
    };
    if api.is_some() {
        return NativeResult { active: true, message: format!("MadPost API already listening on 0.0.0.0:{API_PORT}") };
    }

    let jwt_secret = {
        let mut guard = match state.jwt_secret.lock() {
            Ok(v) => v,
            Err(_) => return NativeResult { active: false, message: "JWT secret lock unavailable".to_string() },
        };
        if guard.is_none() {
            let bytes: Vec<u8> = (0..32).map(|_| rand_byte()).collect();
            *guard = Some(hex_encode(&bytes));
        }
        guard.clone().unwrap()
    };

    let db_path = match std::env::var("APPDATA") {
        Ok(appdata) => format!("{}\\com.madpost.desktop\\madpost.db", appdata),
        Err(_) => return NativeResult { active: false, message: "APPDATA not available".to_string() },
    };

    let listener = match TcpListener::bind(("0.0.0.0", API_PORT)) {
        Ok(l) => l,
        Err(e) => return NativeResult { active: false, message: format!("MadPost API not started on port {API_PORT}: {e}") },
    };
    if let Err(e) = listener.set_nonblocking(true) {
        return NativeResult { active: false, message: format!("MadPost API socket setup failed: {e}") };
    }

    let (shutdown, receiver) = oneshot::channel::<()>();
    let context = ApiContext {
        tenant_id,
        tenant_name,
        db_path,
        jwt_secret,
        clients: Arc::clone(&state.clients),
        broadcast_tx: state.broadcast_tx.clone(),
    };

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => { eprintln!("MadPost API listener conversion failed: {e}"); return; }
        };
        if let Err(e) = axum::serve(
            listener,
            router(context).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async { let _ = receiver.await; })
        .await
        {
            eprintln!("MadPost API server error: {e}");
        }
    });

    *api = Some(ApiHandle { shutdown });
    NativeResult { active: true, message: format!("MadPost API listening on http://0.0.0.0:{API_PORT}/") }
}

pub fn stop_api(state: &MobileRuntimeState) -> NativeResult {
    let mut api = match state.api.lock() {
        Ok(v) => v,
        Err(_) => return NativeResult { active: false, message: "API state lock unavailable".to_string() },
    };
    if let Some(handle) = api.take() {
        let _ = handle.shutdown.send(());
        if let Ok(mut clients) = state.clients.lock() { clients.clear(); }
        NativeResult { active: false, message: "MadPost API stopped".to_string() }
    } else {
        NativeResult { active: false, message: "MadPost API was not running".to_string() }
    }
}

pub fn api_status(state: &MobileRuntimeState) -> MobileApiStatus {
    let active = state.api.lock().map(|a| a.is_some()).unwrap_or(false);
    let mut clients = state.clients.lock()
        .map(|c| c.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    clients.sort_by(|a, b| a.ip.cmp(&b.ip));
    MobileApiStatus { active, port: API_PORT, local_ip: local_ipv4(), clients }
}

// ---------------------------------------------------------------------------
// mDNS
// ---------------------------------------------------------------------------

pub fn publish_mdns(state: &MobileRuntimeState, tenant_id: String, tenant_name: String) -> NativeResult {
    let mut mdns = match state.mdns.lock() {
        Ok(v) => v,
        Err(_) => return NativeResult { active: false, message: "mDNS state lock unavailable".to_string() },
    };
    if mdns.is_some() {
        return NativeResult { active: true, message: "mDNS service already published".to_string() };
    }
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => return NativeResult { active: false, message: format!("mDNS not published: {e}") },
    };
    let safe_name: String = tenant_name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let instance_name = format!("MadPost-{}", safe_name.trim_matches('-'));
    let mut properties = HashMap::new();
    properties.insert("version".to_string(), env!("CARGO_PKG_VERSION").to_string());
    properties.insert("tenantId".to_string(), tenant_id);
    properties.insert("tenantName".to_string(), tenant_name);
    let service = match ServiceInfo::new("_madpost._tcp.local.", &instance_name, "madpost.local.", "", API_PORT, properties) {
        Ok(s) => s,
        Err(e) => return NativeResult { active: false, message: format!("mDNS service configuration failed: {e}") },
    };
    let fullname = service.get_fullname().to_string();
    match daemon.register(service) {
        Ok(_) => {
            *mdns = Some(MdnsHandle { daemon, fullname });
            NativeResult { active: true, message: format!("mDNS published: {instance_name} on port {API_PORT}") }
        }
        Err(e) => NativeResult { active: false, message: format!("mDNS not published: {e}") },
    }
}

pub fn unpublish_mdns(state: &MobileRuntimeState) -> NativeResult {
    let mut mdns = match state.mdns.lock() {
        Ok(v) => v,
        Err(_) => return NativeResult { active: false, message: "mDNS state lock unavailable".to_string() },
    };
    if let Some(handle) = mdns.take() {
        let _ = handle.daemon.unregister(&handle.fullname);
        let _ = handle.daemon.shutdown();
        NativeResult { active: false, message: "mDNS unpublished".to_string() }
    } else {
        NativeResult { active: false, message: "mDNS was not published".to_string() }
    }
}

// ---------------------------------------------------------------------------
// Router principal
// ---------------------------------------------------------------------------

fn router(context: ApiContext) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers(Any);

    let public = crate::api::auth::router()
        .route("/ws", get(websocket));

    let protected = crate::api::catalog::router()
        .merge(crate::api::config::router())
        .merge(crate::api::cash::router())
        .merge(crate::api::sales::router())
        .merge(crate::api::tables::router())
        .layer(middleware::from_fn_with_state(context.clone(), auth_middleware));

    public.merge(protected).with_state(context).layer(cors)
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

async fn websocket(
    State(context): State<ApiContext>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    Query(params): Query<WsQueryParams>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    let token_valid = params.token
        .as_deref()
        .and_then(|t| verify_jwt(t, &context.jwt_secret))
        .is_some();

    if !token_valid {
        return (axum::http::StatusCode::UNAUTHORIZED, "Token invalido o expirado.").into_response();
    }

    upgrade.on_upgrade(move |socket| websocket_session(socket, context, address)).into_response()
}

async fn websocket_session(mut socket: WebSocket, context: ApiContext, address: SocketAddr) {
    let ip = address.ip().to_string();
    if let Ok(mut clients) = context.clients.lock() {
        clients.insert(ip.clone(), WsClientInfo { ip: ip.clone(), connected_at: chrono::Utc::now().to_rfc3339() });
    }

    let mut rx = context.broadcast_tx.subscribe();

    loop {
        tokio::select! {
            // Mensajes entrantes del cliente (solo para detectar desconexion)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            // Eventos del broadcast channel -> enviar al cliente
            event = rx.recv() => {
                match event {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }

    if let Ok(mut clients) = context.clients.lock() { clients.remove(&ip); }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

fn local_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    address.is_ipv4().then_some(address.to_string())
}

fn rand_byte() -> u8 {
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let c = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ((t ^ (c as u32).wrapping_mul(0x9e3779b9)) & 0xff) as u8
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

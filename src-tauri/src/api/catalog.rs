use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Extension, Json, Router,
};
use rusqlite::Connection;
use serde_json::Value;

use super::{ApiContext, AuthUser};

pub fn router() -> Router<ApiContext> {
    Router::new()
        .route("/api/v1/catalog/categories", get(categories))
        .route("/api/v1/catalog/products", get(products))
        .route("/api/v1/catalog/additions", get(additions))
        .route("/api/v1/catalog/combos", get(combos))
        .route("/api/v1/catalog/sauces", get(sauces))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_db(db_path: &str) -> Result<Connection, String> {
    Connection::open(db_path).map_err(|e| e.to_string())
}

fn err500(msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg.into() })))
}

// ---------------------------------------------------------------------------
// GET /catalog/categories
// ---------------------------------------------------------------------------

async fn categories(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, COALESCE(show_additions,0), COALESCE(show_sauces,0), COALESCE(sort_order,0) \
             FROM categories \
             WHERE tenant_id=?1 AND COALESCE(hidden,0)=0 \
             ORDER BY sort_order, name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let rows: Result<Vec<Value>, String> = stmt.query_map(rusqlite::params![tenant_id], |r| {
            Ok(serde_json::json!({
                "id":           r.get::<_, String>(0)?,
                "name":         r.get::<_, String>(1)?,
                "showAdditions": r.get::<_, i64>(2)? != 0,
                "showSauces":    r.get::<_, i64>(3)? != 0,
                "sortOrder":     r.get::<_, i64>(4)?,
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();

        Ok(Value::Array(rows?))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /catalog/products
// ---------------------------------------------------------------------------

async fn products(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;

        // Productos activos con su categoria
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.category_id, COALESCE(c.name,'') AS category_name, \
             p.price, p.description, p.stock \
             FROM products p \
             LEFT JOIN categories c ON c.id=p.category_id \
             WHERE p.tenant_id=?1 AND COALESCE(p.active,1)=1 \
             ORDER BY c.sort_order, p.name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let product_rows: Vec<(String, String, Option<String>, String, f64, Option<String>, Option<f64>)> = {
            let r: Result<Vec<_>, String> = stmt.query_map(rusqlite::params![tenant_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
            r?
        };

        let mut result = vec![];
        for (pid, name, cat_id, cat_name, price, description, stock) in product_rows {
            // Opciones activas del producto
            let mut ostmt = conn.prepare(
                "SELECT id, name FROM product_options WHERE product_id=?1 AND COALESCE(active,1)=1 ORDER BY sort_order, name COLLATE NOCASE"
            ).map_err(|e| e.to_string())?;
            let options: Vec<Value> = {
                let r: Result<Vec<_>, String> = ostmt.query_map(rusqlite::params![pid], |r| {
                    Ok(serde_json::json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)? }))
                }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
                r?
            };

            result.push(serde_json::json!({
                "id":           pid,
                "name":         name,
                "categoryId":   cat_id.unwrap_or_default(),
                "categoryName": cat_name,
                "price":        price,
                "active":       true,
                "description":  description,
                "stock":        stock,
                "options":      options,
            }));
        }

        Ok(Value::Array(result))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /catalog/additions
// ---------------------------------------------------------------------------

async fn additions(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, price, stock FROM additions \
             WHERE tenant_id=?1 AND COALESCE(active,1)=1 \
             ORDER BY name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let rows: Result<Vec<Value>, String> = stmt.query_map(rusqlite::params![tenant_id], |r| {
            Ok(serde_json::json!({
                "id":     r.get::<_, String>(0)?,
                "name":   r.get::<_, String>(1)?,
                "price":  r.get::<_, f64>(2)?,
                "stock":  r.get::<_, Option<f64>>(3)?,
                "active": true,
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();

        Ok(Value::Array(rows?))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /catalog/combos
// ---------------------------------------------------------------------------

async fn combos(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;

        let mut cstmt = conn.prepare(
            "SELECT id, name, price FROM combos \
             WHERE tenant_id=?1 AND COALESCE(active,1)=1 \
             ORDER BY name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let combo_rows: Vec<(String, String, f64)> = {
            let r: Result<Vec<_>, String> = cstmt.query_map(rusqlite::params![tenant_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
            r?
        };

        let mut result = vec![];
        for (combo_id, combo_name, price) in combo_rows {
            // Items del combo con flags de la categoria del producto
            let mut istmt = conn.prepare(
                "SELECT ci.product_id, p.name, ci.quantity, \
                 COALESCE(cat.show_additions,0), COALESCE(cat.show_sauces,0) \
                 FROM combo_items ci \
                 JOIN products p ON p.id=ci.product_id \
                 LEFT JOIN categories cat ON cat.id=p.category_id \
                 WHERE ci.combo_id=?1 \
                 ORDER BY ci.rowid ASC"
            ).map_err(|e| e.to_string())?;

            let items: Vec<Value> = {
                let r: Result<Vec<_>, String> = istmt.query_map(rusqlite::params![combo_id], |r| {
                    Ok(serde_json::json!({
                        "productId":     r.get::<_, String>(0)?,
                        "productName":   r.get::<_, String>(1)?,
                        "quantity":      r.get::<_, f64>(2)?,
                        "showAdditions": r.get::<_, i64>(3)? != 0,
                        "showSauces":    r.get::<_, i64>(4)? != 0,
                    }))
                }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();
                r?
            };

            result.push(serde_json::json!({
                "id":     combo_id,
                "name":   combo_name,
                "price":  price,
                "active": true,
                "items":  items,
            }));
        }

        Ok(Value::Array(result))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /catalog/sauces
// ---------------------------------------------------------------------------

async fn sauces(
    State(context): State<ApiContext>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    let tenant_id = user.tenant_id.clone();
    let db_path = context.db_path.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let conn = open_db(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, name FROM sauces \
             WHERE tenant_id=?1 AND COALESCE(active,1)=1 \
             ORDER BY name COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;

        let rows: Result<Vec<Value>, String> = stmt.query_map(rusqlite::params![tenant_id], |r| {
            Ok(serde_json::json!({
                "id":     r.get::<_, String>(0)?,
                "name":   r.get::<_, String>(1)?,
                "active": true,
            }))
        }).map_err(|e| e.to_string())?.map(|r| r.map_err(|e| e.to_string())).collect();

        Ok(Value::Array(rows?))
    }).await;

    match result {
        Ok(Ok(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(Err(e)) => err500(e).into_response(),
        Err(_) => err500("Error interno.").into_response(),
    }
}

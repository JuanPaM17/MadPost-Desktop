use chrono::{Local, Utc};
use hmac::{Hmac, Mac};
use reqwest::blocking::Client;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{env, fs, path::{Path, PathBuf}};

type HmacSha256 = Hmac<Sha256>;

pub fn run(args: &[String]) -> Result<(), String> {
    let app_data = app_data_dir()?;
    let backups = app_data.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let upload_only = args.iter().any(|arg| arg == "--upload-pending");
    if !upload_only {
        let name = format!("madpost_backup_{}.db", Local::now().format("%Y%m%d_%H%M%S"));
        fs::copy(app_data.join("madpost.db"), backups.join(&name)).map_err(|e| format!("No se pudo copiar SQLite: {e}"))?;
        log_line(&app_data, &format!("Backup CLI creo copia local: {name}"));
    }
    if let Some(r2) = R2Client::from_embedded() {
        if let Some(slug) = tenant_slug(&app_data.join("madpost.db")) {
            for entry in fs::read_dir(&backups).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
                if backup_name(name) {
                    let key = format!("{slug}/prd/backups/{name}");
                    if let Err(error) = r2.put_object(&key, &fs::read(&path).map_err(|e| e.to_string())?) { log_line(&app_data, &format!("Backup CLI no pudo subir {name}: {error}")); }
                }
            }
        } else { log_line(&app_data, "Backup CLI omitio R2: tenant slug no disponible."); }
    } else { log_line(&app_data, "Backup CLI omitio R2: credenciales no configuradas."); }
    purge_local(&backups, &app_data)?;
    Ok(())
}

fn app_data_dir() -> Result<PathBuf, String> { Ok(PathBuf::from(env::var("APPDATA").map_err(|_| "APPDATA no disponible")?).join("com.madpost.desktop")) }
fn backup_name(name: &str) -> bool { name.starts_with("madpost_backup_") && name.ends_with(".db") }
fn tenant_slug(db_path: &Path) -> Option<String> {
    let connection = Connection::open(db_path).ok()?;
    connection.query_row("SELECT t.slug FROM licenses_cache l JOIN tenants t ON t.id = l.tenant_id ORDER BY l.validated_at DESC LIMIT 1", [], |row| row.get(0)).ok()
}
fn purge_local(backups: &Path, app_data: &Path) -> Result<(), String> {
    let cutoff = Utc::now().timestamp() - 7 * 24 * 60 * 60;
    for entry in fs::read_dir(backups).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if backup_name(path.file_name().and_then(|value| value.to_str()).unwrap_or_default()) {
            if path.metadata().map_err(|e| e.to_string())?.modified().ok().and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok()).map(|value| (value.as_secs() as i64) < cutoff).unwrap_or(false) {
                let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string(); fs::remove_file(&path).map_err(|e| e.to_string())?; log_line(app_data, &format!("Backup CLI purgo copia antigua: {name}"));
            }
        }
    }
    Ok(())
}
fn log_line(app_data: &Path, message: &str) { let logs = app_data.join("logs"); let _ = fs::create_dir_all(&logs); let file = logs.join(format!("madpost-{}.log", Local::now().format("%Y-%m-%d"))); let _ = std::io::Write::write_all(&mut fs::OpenOptions::new().create(true).append(true).open(file).unwrap(), format!("[{}] [BackupMain] {message}\n", Utc::now().to_rfc3339()).as_bytes()); }

struct R2Client { endpoint: String, access_key: String, secret: String, bucket: String, region: String, client: Client }
impl R2Client {
    fn from_embedded() -> Option<Self> { let endpoint = option_env!("MADPOST_R2_ENDPOINT")?.to_string(); let access_key = option_env!("MADPOST_R2_ACCESS_KEY_ID")?.to_string(); let secret = option_env!("MADPOST_R2_SECRET_ACCESS_KEY")?.to_string(); let bucket = option_env!("MADPOST_R2_BUCKET")?.to_string(); if endpoint.is_empty() || access_key.is_empty() || secret.is_empty() || bucket.is_empty() { return None; } Some(Self { endpoint: endpoint.trim_end_matches('/').to_string(), access_key, secret, bucket, region: option_env!("MADPOST_R2_REGION").unwrap_or("auto").to_string(), client: Client::new() }) }
    fn put_object(&self, key: &str, data: &[u8]) -> Result<(), String> {
        let date = Utc::now(); let date_stamp = date.format("%Y%m%d").to_string(); let amz_date = date.format("%Y%m%dT%H%M%SZ").to_string(); let payload_hash = hash(data); let host = self.endpoint.trim_start_matches("https://").trim_start_matches("http://"); let encoded = encode_key(key); let canonical_headers = format!("content-type:application/octet-stream\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"); let signed = "content-type;host;x-amz-content-sha256;x-amz-date"; let canonical = format!("PUT\n/{}/{}\n\n{}\n{}\n{}", self.bucket, encoded, canonical_headers, signed, payload_hash); let auth = self.authorization("PUT", &canonical, signed, &date_stamp, &amz_date)?; let response = self.client.put(format!("{}/{}/{}", self.endpoint, self.bucket, encoded)).header("Content-Type", "application/octet-stream").header("x-amz-content-sha256", payload_hash).header("x-amz-date", amz_date).header("Authorization", auth).body(data.to_vec()).send().map_err(|e| e.to_string())?; if !response.status().is_success() { return Err(format!("R2 devolvio {}", response.status())); } Ok(())
    }
    fn authorization(&self, _method: &str, canonical: &str, signed: &str, date_stamp: &str, amz_date: &str) -> Result<String, String> { let scope = format!("{date_stamp}/{}/s3/aws4_request", self.region); let string = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hash(canonical.as_bytes())); let mut key = hmac(format!("AWS4{}", self.secret).as_bytes(), date_stamp)?; key = hmac(&key, &self.region)?; key = hmac(&key, "s3")?; key = hmac(&key, "aws4_request")?; Ok(format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}", self.access_key, hex(&hmac(&key, &string)?))) }
}
fn hmac(key: &[u8], value: &str) -> Result<Vec<u8>, String> { let mut mac = HmacSha256::new_from_slice(key).map_err(|e| e.to_string())?; mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec()) }
fn hash(value: &[u8]) -> String { hex(&Sha256::digest(value)) }
fn hex(value: &[u8]) -> String { value.iter().map(|byte| format!("{byte:02x}")).collect() }
fn encode_key(key: &str) -> String { key.split('/').map(|segment| percent_encode(segment)).collect::<Vec<_>>().join("/") }
fn percent_encode(value: &str) -> String { value.bytes().map(|byte| if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect() }

use chrono::{Local, Utc};
use rusqlite::Connection;
use std::{env, fs, path::{Path, PathBuf}};
use crate::r2_native::R2Client;

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

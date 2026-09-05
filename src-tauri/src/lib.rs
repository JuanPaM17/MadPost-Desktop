mod backup_cli;
mod r2_native;
mod mobile_api;
mod update_installer;
use serde::Serialize;
use std::{env, fs, process::Command};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(mobile_api::MobileRuntimeState::default())
        .invoke_handler(tauri::generate_handler![get_hostname, ensure_scheduled_tasks_registered, start_mobile_api, stop_mobile_api, mobile_api_status, publish_mdns, unpublish_mdns, install_update, open_help_url, save_export_file, list_printers, store_logo, open_backups_folder, r2_configuration, r2_test_connection, r2_list_objects, r2_put_object, r2_delete_object])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn run_backup_cli(args: &[String]) -> Result<(), String> { backup_cli::run(args) }

#[tauri::command]
fn get_hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-device".to_string())
}

#[tauri::command]
fn start_mobile_api(state: tauri::State<'_, mobile_api::MobileRuntimeState>, tenant_id: String, tenant_name: String) -> mobile_api::NativeResult {
    mobile_api::start_api(&state, tenant_id, tenant_name)
}

#[tauri::command]
fn stop_mobile_api(state: tauri::State<'_, mobile_api::MobileRuntimeState>) -> mobile_api::NativeResult { mobile_api::stop_api(&state) }
#[tauri::command]
fn mobile_api_status(state: tauri::State<'_, mobile_api::MobileRuntimeState>) -> mobile_api::MobileApiStatus { mobile_api::api_status(&state) }

#[tauri::command]
fn publish_mdns(state: tauri::State<'_, mobile_api::MobileRuntimeState>, tenant_id: String, tenant_name: String) -> mobile_api::NativeResult {
    mobile_api::publish_mdns(&state, tenant_id, tenant_name)
}

#[tauri::command]
fn unpublish_mdns(state: tauri::State<'_, mobile_api::MobileRuntimeState>) -> mobile_api::NativeResult { mobile_api::unpublish_mdns(&state) }

#[tauri::command]
fn install_update(app: tauri::AppHandle, download_url: String) -> update_installer::UpdateInstallResult {
    update_installer::install_and_exit(app, download_url)
}

#[tauri::command]
fn open_help_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("La URL de ayuda no es valida".to_string()); }
    Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_export_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No se selecciono un archivo de destino.".to_string());
    }
    fs::write(path, bytes).map_err(|error| format!("No fue posible guardar el archivo: {error}"))
}

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"])
        .output()
        .map_err(|error| format!("No fue posible consultar las impresoras: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let virtual_printers = ["microsoft print to pdf", "microsoft xps document writer", "onenote", "fax", "adobe pdf", "cutepdf", "bullzip", "dopdf", "pdfcreator", "pdf24", "nitro pdf", "foxit pdf"];
    Ok(String::from_utf8_lossy(&output.stdout).lines().map(str::trim).filter(|name| !name.is_empty()).filter(|name| { let normalized = name.to_lowercase(); !virtual_printers.iter().any(|virtual_name| normalized.contains(virtual_name)) }).map(str::to_string).collect())
}

#[tauri::command]
fn store_logo(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let source = std::path::Path::new(&source_path);
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "gif"].contains(&extension.as_str()) { return Err("Selecciona una imagen PNG, JPG o GIF.".to_string()); }
    let logos_dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("logos");
    fs::create_dir_all(&logos_dir).map_err(|error| error.to_string())?;
    let target = logos_dir.join(format!("logo.{extension}"));
    fs::copy(source, &target).map_err(|error| format!("No fue posible copiar el logo: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn open_backups_folder(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("backups");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Command::new("explorer.exe").arg(directory).spawn().map(|_| ()).map_err(|error| format!("No fue posible abrir la carpeta de copias: {error}"))
}

#[tauri::command]
fn r2_configuration() -> r2_native::R2ConnectionCheck { r2_native::configuration_status() }
#[tauri::command]
fn r2_test_connection() -> r2_native::R2ConnectionCheck { r2_native::configuration_check() }
#[tauri::command]
fn r2_list_objects(prefix: String) -> Result<String, String> { r2_native::list_objects(prefix) }
#[tauri::command]
fn r2_put_object(key: String, body: Vec<u8>) -> Result<(), String> { r2_native::put_object(key, body) }
#[tauri::command]
fn r2_delete_object(key: String) -> Result<(), String> { r2_native::delete_object(key) }

#[derive(Serialize)]
struct TaskRegistrationResult { skipped: bool, messages: Vec<String> }

#[tauri::command]
fn ensure_scheduled_tasks_registered() -> TaskRegistrationResult {
    if cfg!(debug_assertions) {
        return TaskRegistrationResult { skipped: true, messages: vec!["Skipped task registration: development build".to_string()] };
    }
    let executable = match env::current_exe() { Ok(path) => path, Err(error) => return TaskRegistrationResult { skipped: true, messages: vec![format!("Skipped task registration: executable path unavailable: {error}")] } };
    let mut messages = Vec::new();
    let _ = Command::new("schtasks").args(["/delete", "/f", "/tn", "MadPost Backup 23h30"]).output();
    for (name, time) in [("MadPost Backup 14h", "14:00"), ("MadPost Backup 23h", "23:00")] {
        let xml_path = env::temp_dir().join(format!("madpost-task-{}.xml", time.replace(':', "")));
        let executable = xml_escape(&executable.to_string_lossy());
        let xml = format!(r#"<?xml version="1.0" encoding="UTF-16"?><Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><CalendarTrigger><StartBoundary>2025-01-01T{time}:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT1H</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>{executable}</Command><Arguments>--backup</Arguments></Exec></Actions></Task>"#);
        let mut bytes = vec![0xFF, 0xFE];
        for unit in xml.encode_utf16() { bytes.extend_from_slice(&unit.to_le_bytes()); }
        if let Err(error) = fs::write(&xml_path, bytes) { messages.push(format!("{name}: failed writing XML: {error}")); continue; }
        match Command::new("schtasks").args(["/create", "/f", "/tn", name, "/xml", &xml_path.to_string_lossy()]).output() {
            Ok(output) if output.status.success() => messages.push(format!("{name}: registered")),
            Ok(output) => messages.push(format!("{name}: schtasks failed: {}", String::from_utf8_lossy(&output.stderr).trim())),
            Err(error) => messages.push(format!("{name}: could not run schtasks: {error}")),
        }
        let _ = fs::remove_file(xml_path);
    }
    TaskRegistrationResult { skipped: false, messages }
}

fn xml_escape(value: &str) -> String { value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }

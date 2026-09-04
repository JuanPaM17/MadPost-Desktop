mod backup_cli;
mod mobile_api;
mod update_installer;
use serde::Serialize;
use std::{env, fs, process::Command};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .manage(mobile_api::MobileRuntimeState::default())
        .invoke_handler(tauri::generate_handler![get_hostname, ensure_scheduled_tasks_registered, start_mobile_api, stop_mobile_api, publish_mdns, unpublish_mdns, install_update, open_help_url])
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

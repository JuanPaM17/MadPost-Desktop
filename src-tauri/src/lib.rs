mod api;
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
        .invoke_handler(tauri::generate_handler![get_hostname, ensure_scheduled_tasks_registered, start_mobile_api, stop_mobile_api, mobile_api_status, publish_mdns, unpublish_mdns, check_for_update, list_releases, install_update, open_help_url, save_export_file, save_and_open_cash_close_pdf, save_and_open_invoice_pdf, open_cash_drawer, print_comanda, list_printers, store_logo, open_backups_folder, r2_configuration, r2_test_connection, r2_list_objects, r2_put_object, r2_delete_object, export_db_backup, restore_db_backup, exit_app])
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
async fn check_for_update() -> update_installer::UpdateCheckResult {
    tauri::async_runtime::spawn_blocking(update_installer::check_update).await
        .unwrap_or_else(|_| update_installer::UpdateCheckResult {
            state: "unavailable".into(),
            message: "No pudimos conectarnos para buscar actualizaciones.".into(),
            update: None,
        })
}
#[tauri::command]
async fn list_releases() -> Vec<update_installer::ReleaseEntry> {
    tauri::async_runtime::spawn_blocking(update_installer::list_releases).await.unwrap_or_default()
}

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
    fs::write(&path, bytes).map_err(|error| format!("No fue posible guardar el archivo: {error}"))?;
    Command::new("explorer.exe").arg(&path).spawn().map_err(|error| format!("No fue posible abrir el archivo: {error}"))?;
    Ok(())
}

#[tauri::command]
fn save_and_open_cash_close_pdf(app: tauri::AppHandle, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if !file_name.starts_with("cierre-caja-") || !file_name.ends_with(".pdf") || file_name.contains(['/', '\\']) {
        return Err("El nombre del reporte no es valido.".to_string());
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("cierres");
    fs::create_dir_all(&directory).map_err(|error| format!("No fue posible crear la carpeta de cierres: {error}"))?;
    let target = directory.join(&file_name);
    fs::write(&target, bytes).map_err(|error| format!("No fue posible guardar el PDF: {error}"))?;
    Command::new("explorer.exe").arg(&target).spawn().map_err(|error| format!("No fue posible abrir el PDF: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn save_and_open_invoice_pdf(app: tauri::AppHandle, session_number: u32, file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if !file_name.ends_with(".pdf") || file_name.contains(['/', '\\']) {
        return Err("El nombre de la factura no es valido.".to_string());
    }
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("facturas").join(format!("caja-{session_number}"));
    fs::create_dir_all(&directory).map_err(|e| format!("No fue posible crear la carpeta de facturas: {e}"))?;
    let target = directory.join(&file_name);
    fs::write(&target, bytes).map_err(|e| format!("No fue posible guardar la factura: {e}"))?;
    Command::new("explorer.exe").arg(&target).spawn().map_err(|e| format!("No fue posible abrir la factura: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn print_comanda(printer_name: String, lines: Vec<String>) -> Result<(), String> {
    let mut bytes: Vec<u8> = Vec::new();
    // ESC/POS init
    bytes.extend_from_slice(&[0x1B, 0x40]);
    // Center alignment
    bytes.extend_from_slice(&[0x1B, 0x61, 0x01]);
    for (i, line) in lines.iter().enumerate() {
        // Bold on for first 3 lines (header: comanda number, table name, timestamp)
        let bold = i < 3;
        if bold { bytes.extend_from_slice(&[0x1B, 0x45, 0x01]); }
        // Left alignment after header
        if i == 3 { bytes.extend_from_slice(&[0x1B, 0x61, 0x00]); }
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        if bold { bytes.extend_from_slice(&[0x1B, 0x45, 0x00]); }
    }
    // Feed and cut
    bytes.extend_from_slice(&[0x1B, 0x64, 0x04]);
    bytes.extend_from_slice(&[0x1D, 0x56, 0x41, 0x00]);
    send_raw_to_printer(&printer_name, &bytes)
}

#[tauri::command]
fn open_cash_drawer(printer_name: String) -> Result<(), String> {
    // ESC/POS pulse drawer pin 2: ESC p m t1 t2
    let pulse: &[u8] = &[0x1B, 0x70, 0x00, 0x19, 0xFA];
    send_raw_to_printer(&printer_name, pulse)
}

fn send_raw_to_printer(printer_name: &str, data: &[u8]) -> Result<(), String> {
    use std::ffi::CString;
    use std::ptr;

    #[allow(non_camel_case_types)]
    type HANDLE = *mut std::ffi::c_void;
    #[allow(non_camel_case_types)]
    type BOOL = i32;
    #[allow(non_camel_case_types)]
    type DWORD = u32;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct DOC_INFO_1A {
        pDocName: *const i8,
        pOutputFile: *const i8,
        pDatatype: *const i8,
    }

    #[link(name = "winspool", kind = "dylib")]
    extern "system" {
        fn OpenPrinterA(name: *const i8, handle: *mut HANDLE, defaults: *mut std::ffi::c_void) -> BOOL;
        fn StartDocPrinterA(handle: HANDLE, level: DWORD, info: *const DOC_INFO_1A) -> DWORD;
        fn StartPagePrinter(handle: HANDLE) -> BOOL;
        fn WritePrinter(handle: HANDLE, buf: *const std::ffi::c_void, count: DWORD, written: *mut DWORD) -> BOOL;
        fn EndPagePrinter(handle: HANDLE) -> BOOL;
        fn EndDocPrinter(handle: HANDLE) -> BOOL;
        fn ClosePrinter(handle: HANDLE) -> BOOL;
    }

    let name_c = CString::new(printer_name).map_err(|e| e.to_string())?;
    let doc_name = CString::new("ESC/POS").unwrap();
    let datatype = CString::new("RAW").unwrap();

    unsafe {
        let mut handle: HANDLE = ptr::null_mut();
        if OpenPrinterA(name_c.as_ptr(), &mut handle, ptr::null_mut()) == 0 {
            return Err(format!("No se pudo abrir la impresora '{printer_name}'"));
        }
        let doc = DOC_INFO_1A { pDocName: doc_name.as_ptr(), pOutputFile: ptr::null(), pDatatype: datatype.as_ptr() };
        if StartDocPrinterA(handle, 1, &doc) == 0 { ClosePrinter(handle); return Err("StartDocPrinter fallo".into()); }
        if StartPagePrinter(handle) == 0 { EndDocPrinter(handle); ClosePrinter(handle); return Err("StartPagePrinter fallo".into()); }
        let mut written: DWORD = 0;
        WritePrinter(handle, data.as_ptr() as *const _, data.len() as DWORD, &mut written);
        EndPagePrinter(handle);
        EndDocPrinter(handle);
        ClosePrinter(handle);
    }
    Ok(())
}

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"])
        .creation_flags(CREATE_NO_WINDOW)
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
    // Registro de tareas de Windows deshabilitado.
    // El backup se ejecuta en background mientras la app esta abierta (BackupService en JS).
    TaskRegistrationResult { skipped: true, messages: vec!["Task registration disabled: backup runs in-app".to_string()] }
}


#[tauri::command]
fn export_db_backup(dest_path: String) -> Result<(), String> {
    let src = std::path::PathBuf::from(env::var("APPDATA").map_err(|_| "APPDATA no disponible".to_string())?)
        .join("com.madpost.desktop").join("madpost.db");
    fs::copy(&src, &dest_path).map_err(|e| format!("No fue posible exportar la base de datos: {e}"))?;
    Ok(())
}

#[tauri::command]
fn restore_db_backup(src_path: String) -> Result<(), String> {
    let dest = std::path::PathBuf::from(env::var("APPDATA").map_err(|_| "APPDATA no disponible".to_string())?)
        .join("com.madpost.desktop").join("madpost.db");
    fs::copy(&src_path, &dest).map_err(|e| format!("No fue posible restaurar la base de datos: {e}"))?;
    Ok(())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.restart();
}


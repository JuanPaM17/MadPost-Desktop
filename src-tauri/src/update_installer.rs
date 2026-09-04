use reqwest::{blocking::Client, header::{ACCEPT, AUTHORIZATION}};
use serde::Serialize;
use serde_json::Value;
use std::{env, fs, path::PathBuf, process::Command, thread, time::Duration};

#[derive(Serialize)]
pub struct UpdateInstallResult { pub started: bool, pub message: String }

pub fn install_and_exit(app: tauri::AppHandle, download_url: String) -> UpdateInstallResult {
    if cfg!(debug_assertions) {
        return UpdateInstallResult { started: false, message: "Update installation skipped: development build".to_string() };
    }
    if download_url.trim().is_empty() {
        return UpdateInstallResult { started: false, message: "Update installation failed: EXE installer asset unavailable".to_string() };
    }
    let _ = backup_current_version();
    let installer_path = match download_asset(&download_url, "MadPost-update-", true) {
        Ok(path) => path,
        Err(error) => return UpdateInstallResult { started: false, message: format!("Update download failed: {error}") },
    };
    let executable = match env::current_exe() {
        Ok(path) => path,
        Err(error) => return UpdateInstallResult { started: false, message: format!("Update installer failed: executable path unavailable: {error}") },
    };
    let bat_path = env::temp_dir().join(format!("MadPost-update-{}.bat", chrono::Utc::now().timestamp_millis()));
    let script = format!(
        "@echo off\r\nstart /wait \"\" \"{}\" /S\r\nif exist \"{}\" start \"\" \"{}\"\r\ndel /f /q \"{}\"\r\n",
        installer_path.display(), executable.display(), executable.display(), bat_path.display()
    );
    if let Err(error) = fs::write(&bat_path, script) {
        return UpdateInstallResult { started: false, message: format!("Update installer failed writing launcher: {error}") };
    }
    if let Err(error) = Command::new("cmd").args(["/c", &bat_path.to_string_lossy()]).spawn() {
        let _ = fs::remove_file(&bat_path);
        return UpdateInstallResult { started: false, message: format!("Update installer failed launching: {error}") };
    }
    thread::spawn(move || { thread::sleep(Duration::from_millis(150)); app.exit(0); });
    UpdateInstallResult { started: true, message: "Installer started; closing MadPost".to_string() }
}

fn backup_current_version() -> Result<(), String> {
    let repo = github_repo()?;
    let release_url = format!("https://api.github.com/repos/{repo}/releases/tags/v{}", env!("CARGO_PKG_VERSION"));
    let release = get_json(&release_url, false)?;
    let download_url = exe_asset_url(&repo, &release).ok_or_else(|| "Current release has no EXE installer asset".to_string())?;
    let backup_dir = app_data_dir().join("backups");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let destination = backup_dir.join(format!("MadPost-v{}.exe", env!("CARGO_PKG_VERSION")));
    let bytes = get_bytes(&download_url, true)?;
    fs::write(destination, bytes).map_err(|error| error.to_string())
}

fn download_asset(url: &str, prefix: &str, binary: bool) -> Result<PathBuf, String> {
    let bytes = get_bytes(url, binary)?;
    let path = env::temp_dir().join(format!("{}{}.exe", prefix, chrono::Utc::now().timestamp_millis()));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

fn get_json(url: &str, binary: bool) -> Result<Value, String> {
    let bytes = get_bytes(url, binary)?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn get_bytes(url: &str, binary: bool) -> Result<Vec<u8>, String> {
    let client = Client::builder().timeout(Duration::from_secs(if binary { 300 } else { 10 })).build().map_err(|error| error.to_string())?;
    let mut request = client.get(url).header(ACCEPT, if binary { "application/octet-stream" } else { "application/vnd.github+json" }).header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = github_token() { request = request.header(AUTHORIZATION, format!("Bearer {token}")); }
    let response = request.send().map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("GitHub returned HTTP {}", response.status())); }
    response.bytes().map(|value| value.to_vec()).map_err(|error| error.to_string())
}

fn exe_asset_url(repo: &str, release: &Value) -> Option<String> {
    release.get("assets")?.as_array()?.iter().find_map(|asset| {
        let name = asset.get("name")?.as_str()?;
        if !name.to_lowercase().ends_with(".exe") { return None; }
        let asset_id = asset.get("id")?.as_i64()?;
        Some(format!("https://api.github.com/repos/{repo}/releases/assets/{asset_id}"))
    })
}

fn github_repo() -> Result<&'static str, String> {
    let repo = option_env!("MADPOST_GITHUB_REPO").unwrap_or("");
    if repo.is_empty() { Err("github.repo is not configured".to_string()) } else { Ok(repo) }
}
fn github_token() -> Option<&'static str> { option_env!("MADPOST_GITHUB_TOKEN").filter(|token| !token.is_empty()) }
fn app_data_dir() -> PathBuf { env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| env::temp_dir()).join("com.madpost.desktop") }

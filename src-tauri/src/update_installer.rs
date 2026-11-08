use reqwest::{blocking::Client, header::{ACCEPT, AUTHORIZATION}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, fs, path::PathBuf, process::Command, thread, time::Duration};

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub state: String,   // "upToDate" | "available" | "unavailable"
    pub message: String,
    pub update: Option<UpdateCheckInfo>,
}

#[derive(Serialize)]
pub struct UpdateCheckInfo {
    pub version: String,
    #[serde(rename = "releaseUrl")]
    pub release_url: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(rename = "releaseNotes")]
    pub release_notes: String,
    pub forced: bool,
}

#[derive(Deserialize)]
struct UpdateConfig { #[serde(rename = "latestVersion")] latest_version: String, #[serde(rename = "minimumVersion")] minimum_version: String }

pub fn check_update(prerelease_access: bool) -> UpdateCheckResult {
    if cfg!(debug_assertions) {
        return UpdateCheckResult { state: "upToDate".into(), message: "Estas usando una version de desarrollo.".into(), update: None };
    }
    let repo = match github_repo() {
        Ok(r) => r,
        Err(_) => return UpdateCheckResult { state: "unavailable".into(), message: "No pudimos consultar actualizaciones ahora. Puedes seguir trabajando con normalidad.".into(), update: None },
    };

    let config_url = format!("https://raw.githubusercontent.com/{repo}/main/update-config.json");
    let config: UpdateConfig = match get_json(&config_url, false) {
        Ok(v) => match serde_json::from_value(v) {
            Ok(c) => c,
            Err(_) => return UpdateCheckResult { state: "unavailable".into(), message: "No pudimos consultar actualizaciones ahora. Puedes seguir trabajando con normalidad.".into(), update: None },
        },
        Err(_) => return UpdateCheckResult { state: "unavailable".into(), message: "No pudimos consultar actualizaciones ahora. Puedes seguir trabajando con normalidad.".into(), update: None },
    };

    let current = env!("CARGO_PKG_VERSION");
    let forced = is_newer(&config.minimum_version, current);

    // Con acceso a pre-releases: buscar en el listado completo el release mas reciente (incluye pre-releases)
    // Sin acceso: solo consultar /releases/latest que GitHub solo retorna releases oficiales
    let (release_url, release_notes, download_url, latest_version, is_prerelease) = if prerelease_access {
        let releases_url = format!("https://api.github.com/repos/{repo}/releases?per_page=10");
        match get_json(&releases_url, false) {
            Ok(list) => {
                let arr = list.as_array().cloned().unwrap_or_default();
                // El primero no-draft es el mas reciente (GitHub los retorna por fecha desc)
                match arr.iter().find(|r| r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false) == false) {
                    Some(release) => {
                        let url = release.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let notes = release.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let dl = exe_asset_url(repo, release);
                        let tag = release.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").trim_start_matches('v').to_string();
                        let pre = release.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false);
                        (url, notes, dl, tag, pre)
                    }
                    None => (String::new(), String::new(), None, config.latest_version.clone(), false),
                }
            }
            Err(_) => (String::new(), String::new(), None, config.latest_version.clone(), false),
        }
    } else {
        let releases_url = format!("https://api.github.com/repos/{repo}/releases/latest");
        match get_json(&releases_url, false) {
            Ok(release) => {
                let url = release.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let notes = release.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let dl = exe_asset_url(repo, &release);
                (url, notes, dl, config.latest_version.clone(), false)
            }
            Err(_) => (String::new(), String::new(), None, config.latest_version.clone(), false),
        }
    };

    let update_available = is_newer(&latest_version, current);

    if !forced && !update_available {
        return UpdateCheckResult { state: "upToDate".into(), message: "Tienes la version mas reciente instalada.".into(), update: None };
    }

    let prerelease_label = if is_prerelease { " (Pre-release)" } else { "" };
    UpdateCheckResult {
        state: "available".into(),
        message: if forced { "Esta version ya no es compatible. Debes actualizar para continuar.".into() } else { format!("Hay una actualizacion disponible{prerelease_label} para descargar.") },
        update: Some(UpdateCheckInfo { version: format!("{latest_version}{prerelease_label}"), release_url, download_url, release_notes, forced }),
    }
}

#[derive(Serialize)]
pub struct ReleaseEntry { pub version: String, pub date: String, pub notes: String }

pub fn list_releases(prerelease_access: bool) -> Vec<ReleaseEntry> {
    let repo = match github_repo() { Ok(r) => r, Err(_) => return vec![] };
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=30");
    let releases: Value = match get_json(&url, false) { Ok(v) => v, Err(_) => return vec![] };
    let arr = match releases.as_array() { Some(a) => a, None => return vec![] };
    arr.iter().filter_map(|r| {
        let is_draft = r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
        if is_draft { return None; }
        let is_prerelease = r.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false);
        if is_prerelease && !prerelease_access { return None; }
        let tag = r.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
        let version_base = tag.trim_start_matches('v').to_string();
        let version = if is_prerelease { format!("{version_base} (Pre-release)") } else { version_base };
        let date = r.get("published_at").and_then(|v| v.as_str()).map(|s| s.get(..10).unwrap_or(s).to_string()).unwrap_or_default();
        let notes = r.get("body").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        Some(ReleaseEntry { version, date, notes })
    }).collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Option<[u64; 3]> {
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() < 3 { return None; }
        Some([parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?])
    };
    let (l, c) = match (parse(latest), parse(current)) { (Some(l), Some(c)) => (l, c), _ => return false };
    for i in 0..3 { if l[i] > c[i] { return true; } if l[i] < c[i] { return false; } }
    false
}

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
    let mut request = client.get(url)
        .header("User-Agent", "MadPost-Desktop")
        .header(ACCEPT, if binary { "application/octet-stream" } else { "application/vnd.github+json" })
        .header("X-GitHub-Api-Version", "2022-11-28");
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

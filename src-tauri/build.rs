use std::{fs, path::Path};

fn main() {
    let env_path = Path::new("..").join(".env");
    println!("cargo:rerun-if-changed={}", env_path.display());
    let source = fs::read_to_string(&env_path).unwrap_or_default();
    for (source_key, rust_key) in [
        ("r2.endpoint", "MADPOST_R2_ENDPOINT"),
        ("r2.access_key_id", "MADPOST_R2_ACCESS_KEY_ID"),
        ("r2.secret_access_key", "MADPOST_R2_SECRET_ACCESS_KEY"),
        ("r2.bucket", "MADPOST_R2_BUCKET"),
        ("r2.region", "MADPOST_R2_REGION"),
        ("github.repo", "MADPOST_GITHUB_REPO"),
        ("github.token", "MADPOST_GITHUB_TOKEN"),
    ] {
        let value = source.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == source_key).then(|| value.trim().to_string())
        }).unwrap_or_default();
        println!("cargo:rustc-env={rust_key}={value}");
    }
    tauri_build::build()
}

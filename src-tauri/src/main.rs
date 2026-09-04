#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--backup" || arg == "--upload-pending") {
        if let Err(error) = madpost_desktop_lib::run_backup_cli(&args) { eprintln!("BackupMain error: {error}"); std::process::exit(1); }
        return;
    }
    madpost_desktop_lib::run();
}

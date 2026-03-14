use crate::settings::{
    get_server_dir, get_steamcmd_dir, init_cache, save_settings, Settings,
};
use anyhow::{Context, Result};
use futures::StreamExt;
use reqwest;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::signal;
use tokio::time::timeout;

const SERVER_APP_ID: &str = "1874900";

fn get_steamcmd_url() -> &'static str {
    if cfg!(windows) {
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip"
    } else {
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz"
    }
}

fn get_steamcmd_bin(steamcmd_dir: &PathBuf) -> PathBuf {
    if cfg!(windows) {
        steamcmd_dir.join("steamcmd.exe")
    } else {
        steamcmd_dir.join("steamcmd.sh")
    }
}

async fn download_file(url: &str, dest: &PathBuf) -> Result<()> {
    println!("Downloading from {}...", url);
    
    let response = reqwest::get(url).await
        .with_context(|| format!("Failed to download from {}", url))?;
    
    if !response.status().is_success() {
        anyhow::bail!("Download failed: HTTP {}", response.status());
    }
    
    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    
    // Ensure parent directory exists
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).await
            .with_context(|| format!("Failed to create directory {}", parent.display()))?;
    }
    
    let mut file = std::fs::File::create(dest)
        .with_context(|| format!("Failed to create file {}", dest.display()))?;
    
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| "Failed to download chunk")?;
        file.write_all(&chunk)
            .with_context(|| "Failed to write chunk")?;
        downloaded += chunk.len() as u64;
        
        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64) * 100.0;
            print!("\rProgress: {:.1}%", percent);
            std::io::stdout().flush().ok();
        }
    }
    println!(); // New line after progress
    
    Ok(())
}

async fn extract_archive(archive: &PathBuf, dest: &PathBuf) -> Result<()> {
    println!("Extracting archive...");
    
    if cfg!(windows) {
        // Use tar on Windows (included in modern Windows)
        let status = Command::new("tar")
            .args(["-xf", archive.to_str().unwrap()])
            .current_dir(dest)
            .status()
            .await
            .context("Failed to run tar command")?;
        
        if !status.success() {
            anyhow::bail!("Failed to extract archive");
        }
    } else {
        // Use tar on Linux
        let status = Command::new("tar")
            .args(["-xzf", archive.to_str().unwrap()])
            .current_dir(dest)
            .status()
            .await
            .context("Failed to run tar command")?;
        
        if !status.success() {
            anyhow::bail!("Failed to extract archive");
        }
        
        // Make steamcmd.sh executable
        let steamcmd_sh = dest.join("steamcmd.sh");
        if steamcmd_sh.exists() {
            let _ = Command::new("chmod")
                .args(["+x", steamcmd_sh.to_str().unwrap()])
                .status()
                .await;
        }
    }
    
    Ok(())
}

/// Run a command with graceful shutdown on Ctrl+C
/// Returns Ok(exit_status) if command completed, Err if interrupted
async fn run_command_with_interrupt(
    cmd: &PathBuf,
    args: &[&str],
    description: &str,
) -> Result<std::process::ExitStatus> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("Failed to spawn {}", description))?;
    
    let _pid = child.id().unwrap_or(0);
    
    tokio::select! {
        // Wait for process to complete normally
        result = child.wait() => {
            result.context(format!("{} process failed", description))
        }
        
        // Handle Ctrl+C
        _ = signal::ctrl_c() => {
            println!("\n\nInterrupting {}...", description);
            
            // Try to kill the process gracefully
            match child.kill().await {
                Ok(_) => {
                    // Wait up to 5 seconds for process to exit
                    match timeout(Duration::from_secs(5), child.wait()).await {
                        Ok(Ok(_)) => println!("Process terminated."),
                        Ok(Err(e)) => eprintln!("Error waiting for process: {}", e),
                        Err(_) => println!("Process did not exit in time, but will be cleaned up by OS."),
                    }
                }
                Err(e) => {
                    eprintln!("Failed to terminate process: {}", e);
                }
            }
            
            anyhow::bail!("Setup cancelled by user");
        }
    }
}

async fn install_steamcmd() -> Result<PathBuf> {
    let steamcmd_dir = get_steamcmd_dir()?;
    let steamcmd_bin = get_steamcmd_bin(&steamcmd_dir);
    
    if steamcmd_bin.exists() {
        println!("SteamCMD already installed at {}", steamcmd_dir.display());
        return Ok(steamcmd_bin);
    }
    
    println!("Installing SteamCMD...");
    
    // Download SteamCMD
    let url = get_steamcmd_url();
    let archive_name = if cfg!(windows) { "steamcmd.zip" } else { "steamcmd_linux.tar.gz" };
    let archive_path = steamcmd_dir.join(archive_name);
    
    download_file(url, &archive_path).await?;
    
    // Extract archive
    extract_archive(&archive_path, &steamcmd_dir).await?;
    
    // Clean up archive
    let _ = fs::remove_file(&archive_path).await;
    
    println!("SteamCMD installed at {}", steamcmd_dir.display());
    Ok(steamcmd_bin)
}

async fn install_server(steamcmd_bin: &PathBuf) -> Result<PathBuf> {
    let server_dir = get_server_dir()?;
    
    println!("Installing Arma Reforger Server...");
    println!("This may take a while...");
    println!("(Press Ctrl+C to cancel)\n");
    
    // SteamCMD may update itself on first run and exit, so we run it twice
    // First run: Let SteamCMD update itself (ignore exit code for update)
    println!("[1/2] Updating SteamCMD...");
    let _ = run_command_with_interrupt(
        steamcmd_bin,
        &["+quit"],
        "SteamCMD update"
    ).await;
    
    // Second run: Actually install the server
    println!("[2/2] Downloading Arma Reforger Server (AppID {})...", SERVER_APP_ID);
    let status = run_command_with_interrupt(
        steamcmd_bin,
        &[
            "+force_install_dir",
            server_dir.to_str().unwrap(),
            "+login",
            "anonymous",
            "+app_update",
            SERVER_APP_ID,
            "validate",
            "+quit",
        ],
        "Arma Reforger Server installation"
    ).await?;
    
    if !status.success() {
        anyhow::bail!("SteamCMD failed to install server (exit code: {:?})", status.code());
    }
    
    // Find the server binary
    let binary_name = if cfg!(windows) {
        "ArmaReforgerServer.exe"
    } else {
        "ArmaReforgerServer"
    };
    
    let server_binary = server_dir.join(binary_name);
    
    if !server_binary.exists() {
        anyhow::bail!("Server binary not found after installation at {}", server_binary.display());
    }
    
    println!("Server installed at {}", server_binary.display());
    Ok(server_binary)
}

pub async fn run() -> Result<()> {
    println!("=== Arma Reforger Dedicated Server Setup ===\n");
    
    // Initialize cache directory structure
    init_cache().context("Failed to initialize cache directory")?;
    
    // Install SteamCMD
    let steamcmd_bin = install_steamcmd().await?;
    
    // Install Arma server
    let server_binary = install_server(&steamcmd_bin).await?;
    
    // Update settings
    let mut settings = Settings::default();
    settings.server_bin = Some(server_binary);
    save_settings(&settings).context("Failed to save settings")?;
    
    println!("\n=== Setup complete ===");
    println!("\nNext steps:");
    println!("  arma-test-server start --fresh     Start with a fresh Conflict map");
    println!("  arma-test-server start --save X    Start with a saved state");
    println!("  arma-test-server saves list        List available saves");
    
    Ok(())
}

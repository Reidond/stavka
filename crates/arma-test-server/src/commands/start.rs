use crate::settings::{
    get_addons_dir, get_profile_dir, get_server_binary, load_settings, get_cache_dir
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::signal;
use tokio::time::timeout;
use walkdir::WalkDir;

/// Mod name used for the Stavka test scenario; must match addon folder name.
const STAVKA_TEST_MOD: &str = "StavkaTest";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    #[serde(rename = "bindAddress")]
    bind_address: String,
    #[serde(rename = "bindPort")]
    bind_port: u16,
    #[serde(rename = "publicAddress")]
    public_address: String,
    #[serde(rename = "publicPort")]
    public_port: u16,
    rcon: RconConfig,
    a2s: A2sConfig,
    game: GameConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RconConfig {
    address: String,
    port: u16,
    password: String,
    #[serde(rename = "maxClients")]
    max_clients: u8,
    permission: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct A2sConfig {
    address: String,
    port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GameConfig {
    name: String,
    password: String,
    #[serde(rename = "passwordAdmin")]
    password_admin: String,
    #[serde(rename = "scenarioId")]
    scenario_id: String,
    #[serde(rename = "maxPlayers")]
    max_players: u8,
    visible: bool,
    #[serde(rename = "supportedPlatforms")]
    supported_platforms: Vec<String>,
    #[serde(rename = "gameProperties")]
    game_properties: GameProperties,
    mods: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GameProperties {
    #[serde(rename = "serverMaxViewDistance")]
    server_max_view_distance: u32,
    #[serde(rename = "serverMinGrassDistance")]
    server_min_grass_distance: u32,
    #[serde(rename = "networkViewDistance")]
    network_view_distance: u32,
    #[serde(rename = "disableThirdPerson")]
    disable_third_person: bool,
    #[serde(rename = "fastValidation")]
    fast_validation: bool,
    #[serde(rename = "battlEye")]
    battl_eye: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_address: "0.0.0.0".to_string(),
            bind_port: 2302,
            public_address: "127.0.0.1".to_string(),
            public_port: 2302,
            rcon: RconConfig {
                address: "127.0.0.1".to_string(),
                port: 19999,
                password: "stavka".to_string(),
                max_clients: 2,
                permission: "admin".to_string(),
            },
            a2s: A2sConfig {
                address: "0.0.0.0".to_string(),
                port: 17777,
            },
            game: GameConfig {
                name: "Stavka Local Test".to_string(),
                password: "".to_string(),
                password_admin: "stavka".to_string(),
                scenario_id: "{68B1A0F0C0DE0002}Missions/StavkaTest_Conflict.conf".to_string(),
                max_players: 4,
                visible: true,
                supported_platforms: vec!["PLATFORM_PC".to_string()],
                game_properties: GameProperties {
                    server_max_view_distance: 2500,
                    server_min_grass_distance: 50,
                    network_view_distance: 1500,
                    disable_third_person: false,
                    fast_validation: true,
                    battl_eye: false,
                },
                mods: vec![],
            },
        }
    }
}

async fn get_mod_names(addons_dir: &PathBuf) -> Result<Vec<String>> {
    let mut mod_names = Vec::new();
    
    if !addons_dir.exists() {
        return Ok(mod_names);
    }
    
    for entry in WalkDir::new(addons_dir)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_dir() && path != addons_dir.as_path() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                mod_names.push(name.to_string());
            }
        }
    }
    
    Ok(mod_names)
}

/// Find workspace root: directory that contains mods/StavkaTest (with addon.gproj).
fn find_workspace_root() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        let mod_path = current.join("mods").join(STAVKA_TEST_MOD);
        if mod_path.join("addon.gproj").exists() {
            return Some(current);
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// Ensure StavkaTest mod is linked into addons dir (junction on Windows, symlink on Unix).
/// No-op if workspace not found or link already correct.
fn ensure_stavka_test_addon_link(addons_dir: &Path, workspace_root: &Path) -> Result<()> {
    let source = workspace_root.join("mods").join(STAVKA_TEST_MOD);
    let target = addons_dir.join(STAVKA_TEST_MOD);

    if !source.exists() {
        anyhow::bail!("StavkaTest mod not found at {}", source.display());
    }

    if target.exists() {
        // Already linked (or real dir); avoid overwriting
        return Ok(());
    }

    // Ensure addons dir exists
    std::fs::create_dir_all(addons_dir)
        .with_context(|| format!("Failed to create addons dir {}", addons_dir.display()))?;

    #[cfg(windows)]
    {
        // Directory junction (works without admin)
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&target)
            .arg(&source)
            .status()
            .context("Failed to run mklink")?;
        if !status.success() {
            anyhow::bail!("mklink /J failed (exit code {:?})", status.code());
        }
        println!("Linked addon: {} -> {}", target.display(), source.display());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target)
            .with_context(|| format!("Failed to symlink {} -> {}", target.display(), source.display()))?;
        println!("Linked addon: {} -> {}", target.display(), source.display());
    }

    Ok(())
}

async fn load_or_create_config(config_path: &PathBuf) -> Result<Config> {
    if config_path.exists() {
        let content = fs::read_to_string(config_path).await
            .with_context(|| format!("Failed to read config from {}", config_path.display()))?;
        let config: Config = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse config from {}", config_path.display()))?;
        Ok(config)
    } else {
        let config = Config::default();
        let content = serde_json::to_string_pretty(&config)
            .context("Failed to serialize default config")?;
        
        // Ensure parent directory exists
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).await
                .with_context(|| format!("Failed to create directory {}", parent.display()))?;
        }
        
        fs::write(config_path, content).await
            .with_context(|| format!("Failed to write config to {}", config_path.display()))?;
        
        println!("Created default config at {}", config_path.display());
        Ok(config)
    }
}

pub struct StartOptions {
    pub save: Option<String>,
    pub fresh: bool,
    pub config: Option<PathBuf>,
    pub fps: u32,
}

pub async fn run(opts: StartOptions) -> Result<()> {
    let settings = load_settings().context("Failed to load settings")?;
    
    // Determine config path
    let config_path = if let Some(ref path) = opts.config {
        path.clone()
    } else {
        get_cache_dir()?.join("config.json")
    };
    
    let config = load_or_create_config(&config_path).await?;
    let profile_dir = get_profile_dir(&settings)?;
    let addons_dir = get_addons_dir(&settings)?;
    let server_binary = get_server_binary(&settings)?;
    
    // Ensure StavkaTest mod is linked into addons (so server can load StavkaTest_Conflict scenario)
    if let Some(workspace_root) = find_workspace_root() {
        if let Err(e) = ensure_stavka_test_addon_link(addons_dir.as_path(), &workspace_root) {
            eprintln!("Warning: could not link StavkaTest addon: {}", e);
        }
    }
    
    // Collect mod names
    let mod_names = get_mod_names(&addons_dir).await?;
    
    // Build arguments
    let mut args: Vec<String> = Vec::new();
    
    if !mod_names.is_empty() {
        // Local mods require -server mode
        args.push("-server".to_string());
        args.push(config.game.scenario_id.clone());
        args.push("-addonsDir".to_string());
        args.push(addons_dir.to_string_lossy().to_string());
        args.push("-addons".to_string());
        args.push(mod_names.join(","));
    } else {
        args.push("-config".to_string());
        args.push(config_path.to_string_lossy().to_string());
    }
    
    args.push("-profile".to_string());
    args.push(profile_dir.to_string_lossy().to_string());
    args.push("-maxFPS".to_string());
    args.push(opts.fps.to_string());
    
    // Handle save options
    if let Some(save_name) = opts.save {
        println!("Save: {}", save_name);
        args.push("-loadSessionSave".to_string());
        args.push(save_name);
    } else if !opts.fresh {
        args.push("-loadSessionSave".to_string());
        println!("Save: latest");
    } else {
        println!("Save: none (fresh start)");
    }
    
    // Print info
    println!("Server:  {}", server_binary.display());
    println!("Profile: {}", profile_dir.display());
    println!("Addons:  {} ({})", addons_dir.display(), 
        if mod_names.is_empty() { "none".to_string() } else { mod_names.join(", ") });
    println!("Config:  {}", config_path.display());
    println!("---");
    
    // Start server
    let server_dir = server_binary.parent()
        .context("Failed to get server directory")?;
    
    println!("(Press Ctrl+C to stop the server)\n");
    
    let mut child = Command::new(&server_binary)
        .args(&args)
        .current_dir(server_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("Failed to start server: {}", server_binary.display()))?;
    
    // Wait for server to exit or Ctrl+C
    let status = tokio::select! {
        // Wait for process to complete normally
        result = child.wait() => {
            result.context("Failed to wait for server process")?
        }
        
        // Handle Ctrl+C
        _ = signal::ctrl_c() => {
            println!("\n\nStopping server...");
            
            // Try to kill the process gracefully
            match child.kill().await {
                Ok(_) => {
                    // Wait up to 5 seconds for process to exit
                    match timeout(Duration::from_secs(5), child.wait()).await {
                        Ok(Ok(status)) => {
                            println!("Server stopped.");
                            status
                        }
                        Ok(Err(e)) => {
                            eprintln!("Error waiting for server: {}", e);
                            return Ok(());
                        }
                        Err(_) => {
                            println!("Server did not exit in time, but will be cleaned up by OS.");
                            return Ok(());
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Failed to stop server: {}", e);
                    return Ok(());
                }
            }
        }
    };
    
    println!("Server exited with code {}", status.code().unwrap_or(-1));
    
    Ok(())
}

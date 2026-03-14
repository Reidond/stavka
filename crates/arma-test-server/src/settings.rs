use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Path to the Arma Reforger server binary
    pub server_bin: Option<PathBuf>,
    /// Directory for server profile data
    pub profile_dir: PathBuf,
    /// Directory for mod addons
    pub addons_dir: PathBuf,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_bin: None,
            profile_dir: PathBuf::from("profile"),
            addons_dir: PathBuf::from("addons"),
        }
    }
}

/// Get the base cache directory for stavka
pub fn get_cache_dir() -> Result<PathBuf> {
    dirs::cache_dir()
        .map(|d| d.join("stavka"))
        .context("Failed to determine cache directory")
}

/// Get the SteamCMD installation directory
pub fn get_steamcmd_dir() -> Result<PathBuf> {
    Ok(get_cache_dir()?.join("steamcmd"))
}

/// Get the Arma server installation directory
pub fn get_server_dir() -> Result<PathBuf> {
    Ok(get_cache_dir()?.join("arma-server"))
}

/// Get the saves directory
pub fn get_saves_dir() -> Result<PathBuf> {
    Ok(get_cache_dir()?.join("saves"))
}

/// Get the settings file path
pub fn get_settings_path() -> Result<PathBuf> {
    Ok(get_cache_dir()?.join("settings.json"))
}

/// Get the config file path
pub fn get_config_path() -> Result<PathBuf> {
    Ok(get_cache_dir()?.join("config.json"))
}

/// Load settings from file, or create defaults if not exists
pub fn load_settings() -> Result<Settings> {
    let path = get_settings_path()?;
    
    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read settings from {}", path.display()))?;
        let settings: Settings = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse settings from {}", path.display()))?;
        Ok(settings)
    } else {
        Ok(Settings::default())
    }
}

/// Save settings to file
pub fn save_settings(settings: &Settings) -> Result<()> {
    let path = get_settings_path()?;
    
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory {}", parent.display()))?;
    }
    
    let content = serde_json::to_string_pretty(settings)
        .context("Failed to serialize settings")?;
    
    std::fs::write(&path, content)
        .with_context(|| format!("Failed to write settings to {}", path.display()))?;
    
    Ok(())
}

/// Get the path to the server binary, checking settings and common locations
pub fn get_server_binary(settings: &Settings) -> Result<PathBuf> {
    // First check if settings has a path
    if let Some(ref bin) = settings.server_bin {
        if bin.exists() {
            return Ok(bin.clone());
        }
    }
    
    // Check common locations in server directory
    let server_dir = get_server_dir()?;
    let candidates = if cfg!(windows) {
        vec!["ArmaReforgerServer.exe"]
    } else {
        vec!["ArmaReforgerServer"]
    };
    
    for candidate in candidates {
        let path = server_dir.join(candidate);
        if path.exists() {
            return Ok(path);
        }
    }
    
    anyhow::bail!("Server binary not found. Run 'arma-test-server setup' first.")
}

/// Get the profile directory path
pub fn get_profile_dir(settings: &Settings) -> Result<PathBuf> {
    if settings.profile_dir.is_absolute() {
        Ok(settings.profile_dir.clone())
    } else {
        Ok(get_cache_dir()?.join(&settings.profile_dir))
    }
}

/// Get the addons directory path
pub fn get_addons_dir(settings: &Settings) -> Result<PathBuf> {
    if settings.addons_dir.is_absolute() {
        Ok(settings.addons_dir.clone())
    } else {
        Ok(get_cache_dir()?.join(&settings.addons_dir))
    }
}

/// Initialize the cache directory structure
pub fn init_cache() -> Result<()> {
    let cache = get_cache_dir()?;
    std::fs::create_dir_all(&cache)
        .with_context(|| format!("Failed to create cache directory {}", cache.display()))?;
    
    // Create subdirectories
    for subdir in &["steamcmd", "arma-server", "saves", "profile", "addons"] {
        let path = cache.join(subdir);
        std::fs::create_dir_all(&path)
            .with_context(|| format!("Failed to create directory {}", path.display()))?;
    }
    
    Ok(())
}

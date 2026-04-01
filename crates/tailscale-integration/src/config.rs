use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscaleConfig {
    pub oauth_client_id: String,
    pub oauth_client_secret: String,
    pub tailnet: String,
    #[serde(default = "default_server_tag")]
    pub server_tag: String,
    #[serde(default = "default_player_tag")]
    pub player_tag: String,
    #[serde(default = "default_automation_tag")]
    pub automation_tag: String,
}

fn default_server_tag() -> String {
    "tag:arma-server".to_string()
}

fn default_player_tag() -> String {
    "tag:arma-player".to_string()
}

fn default_automation_tag() -> String {
    "tag:stavka-automation".to_string()
}

impl TailscaleConfig {
    pub fn config_dir() -> Result<PathBuf> {
        let cache_dir = dirs::cache_dir()
            .context("Failed to get cache directory")?
            .join("stavka");
        std::fs::create_dir_all(&cache_dir)?;
        Ok(cache_dir)
    }

    pub fn config_path() -> Result<PathBuf> {
        Ok(Self::config_dir()?.join("tailscale.json"))
    }

    pub fn load() -> Result<Option<Self>> {
        let path = Self::config_path()?;
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let config: Self = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse {}", path.display()))?;
        Ok(Some(config))
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        let content =
            serde_json::to_string_pretty(self).context("Failed to serialize Tailscale config")?;
        std::fs::write(&path, content)
            .with_context(|| format!("Failed to write {}", path.display()))?;
        Ok(())
    }

    pub fn is_configured() -> Result<bool> {
        Ok(Self::load()?.is_some())
    }
}

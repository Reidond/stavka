use anyhow::{Context, Result};
use std::path::Path;
use tailscale_integration::{TailscaleClient, TailscaleConfig, TailscaleIntegration, TailscaleSession};

const DEFAULT_REFORGER_PUBLIC_PORT: u16 = 2001;
const DEFAULT_REFORGER_RCON_PORT: u16 = 19999;
const DEFAULT_REFORGER_A2S_PORT: u16 = 17777;

struct ConfigPorts {
    server_port: u16,
    rcon_port: u16,
    a2s_port: u16,
}

fn read_ports(config_path: &Path) -> ConfigPorts {
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return ConfigPorts {
            server_port: DEFAULT_REFORGER_PUBLIC_PORT,
            rcon_port: DEFAULT_REFORGER_RCON_PORT,
            a2s_port: DEFAULT_REFORGER_A2S_PORT,
        };
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return ConfigPorts {
            server_port: DEFAULT_REFORGER_PUBLIC_PORT,
            rcon_port: DEFAULT_REFORGER_RCON_PORT,
            a2s_port: DEFAULT_REFORGER_A2S_PORT,
        };
    };

    let server_port = config
        .get("publicPort")
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(DEFAULT_REFORGER_PUBLIC_PORT);

    let rcon_port = config
        .get("rcon")
        .and_then(|v| v.get("port"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(DEFAULT_REFORGER_RCON_PORT);

    let a2s_port = config
        .get("a2s")
        .and_then(|v| v.get("port"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(DEFAULT_REFORGER_A2S_PORT);

    ConfigPorts {
        server_port,
        rcon_port,
        a2s_port,
    }
}

pub async fn setup_before_start(config_path: &Path) -> Result<TailscaleSession> {
    let config = TailscaleConfig::load()?
        .context("Tailscale not configured. Run: arma-test-server tailscale setup")?;

    if !tailscale_integration::ip::is_tailscale_running().await {
        anyhow::bail!("Tailscale is not running. Start Tailscale first.");
    }

    let mut client = TailscaleClient::new(
        config.oauth_client_id.clone(),
        config.oauth_client_secret.clone(),
        config.tailnet.clone(),
    );

    let ports = read_ports(config_path);
    let session = TailscaleIntegration::setup_and_start(
        &mut client,
        config_path,
        &config.server_tag,
        &config.player_tag,
        &config.automation_tag,
        ports.server_port,
        ports.rcon_port,
        ports.a2s_port,
    )
    .await?;

    println!(
        "{}",
        TailscaleIntegration::format_connection_info(
            &session.tailscale_ip,
            ports.server_port,
            ports.rcon_port,
            ports.a2s_port,
        )
    );

    Ok(session)
}

pub async fn cleanup_after_stop(config_path: &Path, session: &TailscaleSession) -> Result<()> {
    let config = TailscaleConfig::load()?
        .context("Tailscale not configured. Run: arma-test-server tailscale setup")?;

    let mut client = TailscaleClient::new(
        config.oauth_client_id.clone(),
        config.oauth_client_secret.clone(),
        config.tailnet.clone(),
    );

    let ports = read_ports(config_path);
    TailscaleIntegration::cleanup_after_stop(
        &mut client,
        config_path,
        session,
        &config.server_tag,
        &config.player_tag,
        &config.automation_tag,
        ports.server_port,
        ports.rcon_port,
        ports.a2s_port,
    )
    .await
}

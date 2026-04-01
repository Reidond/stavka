use anyhow::{Context, Result};
use std::path::Path;
use tailscale_integration::{TailscaleClient, TailscaleConfig, TailscaleIntegration, TailscaleSession};

const DEFAULT_REFORGER_PUBLIC_PORT: u16 = 2001;

fn read_public_port(config_path: &Path) -> u16 {
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return DEFAULT_REFORGER_PUBLIC_PORT;
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return DEFAULT_REFORGER_PUBLIC_PORT;
    };
    config
        .get("publicPort")
        .and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(DEFAULT_REFORGER_PUBLIC_PORT)
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

    let server_port = read_public_port(config_path);
    let session = TailscaleIntegration::setup_and_start(
        &mut client,
        config_path,
        &config.server_tag,
        &config.player_tag,
        &config.automation_tag,
        server_port,
    )
    .await?;

    println!(
        "{}",
        TailscaleIntegration::format_connection_info(&session.tailscale_ip, server_port)
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

    let server_port = read_public_port(config_path);
    TailscaleIntegration::cleanup_after_stop(
        &mut client,
        config_path,
        session,
        &config.server_tag,
        &config.player_tag,
        &config.automation_tag,
        server_port,
    )
    .await
}

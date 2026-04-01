use anyhow::{Context, Result};
use std::path::Path;

use crate::client::TailscaleClient;

#[derive(Debug, Clone)]
pub struct TailscaleSession {
    pub tailscale_ip: String,
    pub previous_public_address: Option<String>,
}

fn set_arma_public_address(config_path: &Path, public_address: &str) -> Result<Option<String>> {
    let config_content = std::fs::read_to_string(config_path)
        .with_context(|| format!("Failed to read Arma config at {}", config_path.display()))?;

    let mut config: serde_json::Value = serde_json::from_str(&config_content)
        .context("Failed to parse Arma config JSON")?;

    let old_address = config
        .get("publicAddress")
        .or_else(|| config.get("public_address"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Arma Reforger server config uses camelCase.
    config["publicAddress"] = serde_json::Value::String(public_address.to_string());
    // Clean up legacy incorrect key written by older integration versions.
    if let Some(obj) = config.as_object_mut() {
        obj.remove("public_address");
    }

    let new_content = serde_json::to_string_pretty(&config)
        .context("Failed to serialize updated Arma config")?;

    std::fs::write(config_path, &new_content)
        .with_context(|| format!("Failed to write updated Arma config to {}", config_path.display()))?;

    Ok(old_address)
}

pub async fn update_arma_config_with_tailscale_ip(
    config_path: &Path,
    tailscale_ip: &str,
) -> Result<Option<String>> {
    set_arma_public_address(config_path, tailscale_ip)
}

fn restore_arma_public_address(config_path: &Path, public_address: Option<&str>) -> Result<()> {
    let config_content = std::fs::read_to_string(config_path)
        .with_context(|| format!("Failed to read Arma config at {}", config_path.display()))?;

    let mut config: serde_json::Value = serde_json::from_str(&config_content)
        .context("Failed to parse Arma config JSON")?;

    if let Some(address) = public_address {
        config["publicAddress"] = serde_json::Value::String(address.to_string());
    } else if let Some(obj) = config.as_object_mut() {
        // Preserve pre-existing shape when the key was previously absent.
        obj.remove("publicAddress");
        obj.remove("public_address");
    }

    let new_content = serde_json::to_string_pretty(&config)
        .context("Failed to serialize updated Arma config")?;

    std::fs::write(config_path, &new_content)
        .with_context(|| format!("Failed to write updated Arma config to {}", config_path.display()))?;

    Ok(())
}

pub struct TailscaleIntegration;

impl TailscaleIntegration {
    pub async fn setup_and_start(
        client: &mut TailscaleClient,
        config_path: &Path,
        server_tag: &str,
        player_tag: &str,
        automation_tag: &str,
        server_port: u16,
        rcon_port: u16,
        a2s_port: u16,
    ) -> Result<TailscaleSession> {
        let tailscale_ip = crate::ip::detect_tailscale_ip()
            .await?
            .context("No Tailscale IP detected. Is Tailscale connected?")?;

        crate::invite::ensure_acl_policy(
            client,
            server_tag,
            player_tag,
            automation_tag,
            server_port,
            rcon_port,
            a2s_port,
        )
        .await?;
        let old_address = update_arma_config_with_tailscale_ip(config_path, &tailscale_ip).await?;

        if let Err(e) = ensure_local_server_tag(client, &tailscale_ip, server_tag).await {
            eprintln!("Warning: failed to auto-tag local Tailscale device: {}", e);
            eprintln!("You may need to manually assign '{}' in Tailscale admin.", server_tag);
        }

        let old_label = old_address.as_deref().unwrap_or("<unset>");
        println!("Tailscale IP: {}", tailscale_ip);
        println!("Updated publicAddress: {} -> {}", old_label, tailscale_ip);
        println!("ACL policy updated with server and player tags");

        Ok(TailscaleSession {
            tailscale_ip,
            previous_public_address: old_address,
        })
    }

    pub async fn cleanup_after_stop(
        client: &mut TailscaleClient,
        config_path: &Path,
        session: &TailscaleSession,
        server_tag: &str,
        player_tag: &str,
        automation_tag: &str,
        server_port: u16,
        rcon_port: u16,
        a2s_port: u16,
    ) -> Result<()> {
        crate::invite::cleanup_acl_policy(
            client,
            server_tag,
            player_tag,
            automation_tag,
            server_port,
            rcon_port,
            a2s_port,
        )
        .await?;

        if let Err(e) = remove_local_server_tag(client, &session.tailscale_ip, server_tag).await {
            let err_text = e.to_string();
            if err_text.contains("tagged nodes cannot be untagged without reauth") {
                eprintln!(
                    "Info: '{}' remains on local device (Tailscale requires reauth to untag existing tagged nodes).",
                    server_tag
                );
            } else {
                eprintln!("Warning: failed to remove '{}' from local device: {}", server_tag, e);
            }
        }

        let previous_address = session.previous_public_address.as_deref();
        restore_arma_public_address(config_path, previous_address)?;
        let restored_label = previous_address.unwrap_or("<unset>");
        println!("Restored publicAddress to {} and cleaned Tailscale automation state", restored_label);
        Ok(())
    }

    pub fn format_connection_info(ip: &str, game_port: u16, rcon_port: u16, a2s_port: u16) -> String {
        let mut info = String::new();
        info.push_str("\n=== Arma Server Connection Info ===\n\n");
        info.push_str(&format!("Game Address: {}:{}\n", ip, game_port));
        info.push_str(&format!("Direct Connect: {}:{}\n", ip, game_port));
        info.push_str(&format!("RCON Address: {}:{}\n", ip, rcon_port));
        info.push_str(&format!("A2S Address: {}:{}", ip, a2s_port));
        info.push_str("\n\nPlayers must be on the same Tailscale network.\n");
        info.push_str("Share the auth key or email invite with players.\n");
        info
    }
}

async fn ensure_local_server_tag(
    client: &mut TailscaleClient,
    tailscale_ip: &str,
    server_tag: &str,
) -> Result<()> {
    let devices = client.get_devices().await?;
    let local_device = devices
        .into_iter()
        .find(|d| d.ip_addresses.iter().any(|ip| ip == tailscale_ip));

    let Some(device) = local_device else {
        eprintln!(
            "Warning: Could not find local Tailscale device for IP {}. Skipping auto-tagging.",
            tailscale_ip
        );
        return Ok(());
    };

    if device.tags.iter().any(|tag| tag == server_tag) {
        println!("Tailscale server tag already present on device: {}", device.name);
        return Ok(());
    }

    let mut updated_tags = device.tags.clone();
    updated_tags.push(server_tag.to_string());
    updated_tags.sort();
    updated_tags.dedup();

    let target_device_id = if device.node_id.is_empty() {
        device.id.as_str()
    } else {
        device.node_id.as_str()
    };

    client.set_device_tags(target_device_id, &updated_tags).await?;
    println!(
        "Applied Tailscale server tag '{}' to local device: {}",
        server_tag, device.name
    );

    Ok(())
}

async fn remove_local_server_tag(
    client: &mut TailscaleClient,
    tailscale_ip: &str,
    server_tag: &str,
) -> Result<()> {
    let devices = client.get_devices().await?;
    let local_device = devices
        .into_iter()
        .find(|d| d.ip_addresses.iter().any(|ip| ip == tailscale_ip));

    let Some(device) = local_device else {
        return Ok(());
    };

    if !device.tags.iter().any(|tag| tag == server_tag) {
        return Ok(());
    }

    let mut updated_tags: Vec<String> = device
        .tags
        .into_iter()
        .filter(|tag| tag != server_tag)
        .collect();
    updated_tags.sort();
    updated_tags.dedup();

    let target_device_id = if device.node_id.is_empty() {
        device.id.as_str()
    } else {
        device.node_id.as_str()
    };

    client.set_device_tags(target_device_id, &updated_tags).await?;
    println!("Removed Tailscale server tag '{}' from {}", server_tag, device.name);
    Ok(())
}

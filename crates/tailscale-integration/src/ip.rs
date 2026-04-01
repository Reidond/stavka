use anyhow::{Context, Result};
use tokio::process::Command;

pub async fn detect_tailscale_ip() -> Result<Option<String>> {
    if !is_tailscale_running().await {
        return Ok(None);
    }

    let ip = match get_tailscale_ip_from_cli().await {
        Ok(ip) => ip,
        Err(_) => get_tailscale_ip_from_local_api().await?,
    };

    Ok(Some(ip))
}

pub async fn is_tailscale_running() -> bool {
    get_tailscale_ip_from_cli().await.is_ok()
        || get_tailscale_ip_from_local_api().await.is_ok()
}

async fn get_tailscale_ip_from_cli() -> Result<String> {
    let output = Command::new("tailscale")
        .arg("status")
        .arg("--json")
        .output()
        .await
        .context("Failed to run `tailscale status`. Is Tailscale installed?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("tailscale status failed: {}", stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_tailscale_status_json(&stdout)
}

fn parse_tailscale_status_json(json: &str) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct Status {
        #[serde(rename = "Self", default)]
        self_node: Option<SelfNode>,
        #[serde(rename = "TailscaleIPs", default)]
        tailscale_ips: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct SelfNode {
        #[serde(rename = "TailscaleIPs", default)]
        tailscale_ips: Vec<String>,
        #[serde(rename = "Addrs", default)]
        addresses: Vec<String>,
    }

    let status: Status = serde_json::from_str(json)
        .context("Failed to parse tailscale status JSON")?;

    let self_node = status
        .self_node
        .context("No self node found in tailscale status")?;

    let ip = self_node
        .tailscale_ips
        .first()
        .or_else(|| status.tailscale_ips.first())
        .or_else(|| self_node.addresses.iter().find(|ip| is_tailscale_ip(ip)))
        .cloned()
        .context("No Tailscale IP found")?;

    Ok(ip)
}

async fn get_tailscale_ip_from_local_api() -> Result<String> {
    let client = reqwest::Client::new();
    let response = client
        .get("http://localhost:9090/localapi/v0/status")
        .send()
        .await
        .context("Failed to connect to Tailscale local API")?;

    let body = response
        .text()
        .await
        .context("Failed to read local API response")?;

    #[derive(serde::Deserialize)]
    struct LocalStatus {
        #[serde(default)]
        self_node: Option<LocalSelfNode>,
    }

    #[derive(serde::Deserialize)]
    struct LocalSelfNode {
        #[serde(default)]
        tailscale_ips: Vec<String>,
    }

    let status: LocalStatus = serde_json::from_str(&body)
        .context("Failed to parse local API status")?;

    status
        .self_node
        .and_then(|node| node.tailscale_ips.into_iter().next())
        .context("No Tailscale IP found in local API")
}

fn is_tailscale_ip(ip: &str) -> bool {
    ip.starts_with("100.")
        || ip.starts_with("fd7a:115c:a1e0:")
}

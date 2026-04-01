use anyhow::{Context, Result};
use clap::Subcommand;

use tailscale_integration::{TailscaleClient, TailscaleConfig};

#[derive(Subcommand)]
pub enum TailscaleSubcommand {
    /// Configure OAuth credentials and verify connection
    Setup {
        /// OAuth client ID from Tailscale
        #[arg(long)]
        client_id: String,
        /// OAuth client secret from Tailscale
        #[arg(long)]
        client_secret: String,
        /// Tailnet name (e.g., example.com)
        #[arg(long)]
        tailnet: String,
        /// Automation tag used to own/manage Arma tags
        #[arg(long, default_value = "tag:stavka-automation")]
        automation_tag: String,
    },
    /// Show current Tailscale status
    Status,
    /// Generate auth keys or send email invites
    Invite {
        /// Email address to invite
        #[arg(long)]
        email: Option<String>,
        /// Number of auth keys to generate
        #[arg(long, default_value = "1")]
        count: u32,
    },
    /// Clean up unused auth keys and stale devices
    Cleanup,
}

pub async fn run(cmd: TailscaleSubcommand) -> Result<()> {
    match cmd {
        TailscaleSubcommand::Setup {
            client_id,
            client_secret,
            tailnet,
            automation_tag,
        } => run_setup(client_id, client_secret, tailnet, automation_tag).await,
        TailscaleSubcommand::Status => run_status().await,
        TailscaleSubcommand::Invite { email, count } => run_invite(email, count).await,
        TailscaleSubcommand::Cleanup => run_cleanup().await,
    }
}

async fn run_setup(
    client_id: String,
    client_secret: String,
    tailnet: String,
    automation_tag: String,
) -> Result<()> {
    println!("Setting up Tailscale integration...");

    let config = TailscaleConfig {
        oauth_client_id: client_id,
        oauth_client_secret: client_secret,
        tailnet: tailnet.clone(),
        server_tag: "tag:arma-server".to_string(),
        player_tag: "tag:arma-player".to_string(),
        automation_tag,
    };
    config.save().context("Failed to save Tailscale config")?;
    println!("Configuration saved.");

    let mut client = TailscaleClient::new(
        config.oauth_client_id.clone(),
        config.oauth_client_secret.clone(),
        config.tailnet.clone(),
    );

    let devices = client
        .get_devices()
        .await
        .context("Failed to connect to Tailscale API. Check your credentials.")?;
    println!("Successfully connected to Tailscale API!");
    println!("Found {} devices in tailnet '{}'", devices.len(), tailnet);

    let local_ip = tailscale_integration::ip::detect_tailscale_ip()
        .await
        .context("Failed to detect local Tailscale IP")?;

    if let Some(ip) = local_ip {
        println!("Local Tailscale IP: {}", ip);
    } else {
        println!("Warning: No local Tailscale IP detected.");
        println!("Make sure Tailscale is running on this machine.");
    }

    println!("\nSetup complete! You can now use:");
    println!("  arma-test-server start --tailscale");
    println!("  arma-test-server tailscale invite");

    Ok(())
}

async fn run_status() -> Result<()> {
    let config = TailscaleConfig::load()?
        .context("Tailscale not configured. Run: arma-test-server tailscale setup")?;

    println!("=== Tailscale Status ===\n");
    println!("Tailnet: {}", config.tailnet);
    println!("Server tag: {}", config.server_tag);
    println!("Player tag: {}", config.player_tag);

    let mut client = TailscaleClient::new(
        config.oauth_client_id,
        config.oauth_client_secret,
        config.tailnet,
    );

    let devices = client.get_devices().await?;
    println!("\nDevices ({}):", devices.len());
    for device in &devices {
        let tags_str = if device.tags.is_empty() {
            "(no tags)".to_string()
        } else {
            device.tags.join(", ")
        };
        println!("  {} - tags: [{}]", device.name, tags_str);
        for ip in &device.ip_addresses {
            println!("    IP: {}", ip);
        }
    }

    let local_ip = tailscale_integration::ip::detect_tailscale_ip().await?;
    println!("\nLocal Tailscale IP: {}", local_ip.unwrap_or_else(|| "not detected".to_string()));

    Ok(())
}

async fn run_invite(email: Option<String>, count: u32) -> Result<()> {
    let config = TailscaleConfig::load()?
        .context("Tailscale not configured. Run: arma-test-server tailscale setup")?;

    let mut client = TailscaleClient::new(
        config.oauth_client_id.clone(),
        config.oauth_client_secret.clone(),
        config.tailnet.clone(),
    );

    if let Some(email_addr) = email {
        let result = tailscale_integration::invite::send_email_invite(&mut client, &email_addr)
            .await?;
        println!("{}", tailscale_integration::invite::format_invite_output(&[result]));
    } else {
        let results = tailscale_integration::invite::generate_auth_key_invite(
            &mut client,
            &config.player_tag,
            count,
        )
        .await?;
        println!("{}", tailscale_integration::invite::format_invite_output(&results));
    }

    Ok(())
}

async fn run_cleanup() -> Result<()> {
    println!("Cleanup not yet implemented.");
    Ok(())
}

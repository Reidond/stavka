use anyhow::Result;
use chrono::Utc;

use crate::client::{
    AclPolicy, AclRule, AuthKey, AuthKeyCapabilities, CreateAuthKeyRequest, CreateDeviceCapability,
    DeviceCapabilities, TailscaleClient,
};

pub struct InviteResult {
    pub auth_key: Option<AuthKey>,
    pub email_sent: bool,
    pub invite_command: String,
}

pub async fn generate_auth_key_invite(
    client: &mut TailscaleClient,
    player_tag: &str,
    count: u32,
) -> Result<Vec<InviteResult>> {
    let mut results = Vec::new();

    for i in 0..count {
        let request = CreateAuthKeyRequest {
            capabilities: AuthKeyCapabilities {
                devices: DeviceCapabilities {
                    create: CreateDeviceCapability {
                        tags: vec![player_tag.to_string()],
                        preauthorized: true,
                        ephemeral: true,
                    },
                },
            },
            expiry_seconds: 7 * 24 * 60 * 60,
            description: format!(
                "Stavka player invite - {} #{}",
                Utc::now().format("%Y-%m-%d"),
                i + 1
            ),
        };

        let auth_key = client.generate_auth_key(&request).await?;
        let invite_command = format!("tailscale up --auth-key={}", auth_key.key);

        results.push(InviteResult {
            auth_key: Some(auth_key),
            email_sent: false,
            invite_command,
        });
    }

    Ok(results)
}

pub async fn send_email_invite(
    client: &mut TailscaleClient,
    email: &str,
) -> Result<InviteResult> {
    client.send_email_invite(email).await?;

    Ok(InviteResult {
        auth_key: None,
        email_sent: true,
        invite_command: format!("Email invite sent to {}", email),
    })
}

pub fn format_invite_output(results: &[InviteResult]) -> String {
    let mut output = String::new();
    output.push_str("\n=== Tailscale Player Invites ===\n\n");

    for (i, result) in results.iter().enumerate() {
        if result.email_sent {
            output.push_str(&format!("Invite {}: {}\n", i + 1, result.invite_command));
        } else {
            output.push_str(&format!("Auth Key {}:\n", i + 1));
            output.push_str(&format!("  Command: {}\n", result.invite_command));
            output.push_str("  Copy and paste this command on the player's machine.\n");
            if let Some(ref key) = result.auth_key {
                output.push_str(&format!("  Expires: {}\n", key.expires));
            }
        }
        output.push('\n');
    }

    output.push_str("Players must have Tailscale installed to join.\n");
    output.push_str("After connecting, they can access the Arma server.\n");

    output
}

pub async fn ensure_acl_policy(
    client: &mut TailscaleClient,
    server_tag: &str,
    player_tag: &str,
    automation_tag: &str,
    server_port: u16,
) -> Result<()> {
    let mut policy = match client.get_acl_policy().await {
        Ok(p) => p,
        Err(_) => AclPolicy {
            groups: serde_json::json!({}),
            hosts: serde_json::json!({}),
            acls: Vec::new(),
            tag_owners: serde_json::json!({}),
        },
    };

    // Tailscale groups contain users, not tags.
    // Keep existing groups untouched and enforce access with tag-based ACL rules.
    if !policy.groups.is_object() {
        policy.groups = serde_json::json!({});
    }

    // Tailscale ACL "hosts" values must be IP/CIDR, not tags.
    // Remove only our legacy invalid host alias and preserve any valid user-defined hosts.
    if let Some(hosts) = policy.hosts.as_object_mut() {
        let should_remove_legacy_host = hosts
            .get("arma-server")
            .and_then(|v| v.as_str())
            .map(|v| v == server_tag)
            .unwrap_or(false);
        if should_remove_legacy_host {
            hosts.remove("arma-server");
        }
    } else {
        policy.hosts = serde_json::json!({});
    }

    let arma_rule_exists = policy.acls.iter().any(|rule| {
        rule.src.contains(&player_tag.to_string())
            && rule.dst.iter().any(|d| d.contains(server_tag))
    });

    if !arma_rule_exists {
        policy.acls.push(AclRule {
            action: "accept".to_string(),
            src: vec![player_tag.to_string()],
            dst: vec![format!("{}:{}", server_tag, server_port)],
        });
    }

    let internet_rule_exists = policy.acls.iter().any(|rule| {
        rule.src.contains(&player_tag.to_string()) && rule.dst.contains(&"*:*".to_string())
    });

    if !internet_rule_exists {
        policy.acls.push(AclRule {
            action: "accept".to_string(),
            src: vec![player_tag.to_string()],
            dst: vec!["*:*".to_string()],
        });
    }

    // Ensure referenced tags exist by bootstrapping only missing owners.
    // We do not overwrite existing ownership.
    if !policy.tag_owners.is_object() {
        policy.tag_owners = serde_json::json!({});
    }
    if let Some(tag_owners) = policy.tag_owners.as_object_mut() {
        tag_owners
            .entry(automation_tag.to_string())
            .or_insert_with(|| serde_json::json!(["autogroup:admin"]));
        tag_owners
            .entry(server_tag.to_string())
            .or_insert_with(|| serde_json::json!([automation_tag]));
        tag_owners
            .entry(player_tag.to_string())
            .or_insert_with(|| serde_json::json!([automation_tag]));
    }

    client.update_acl_policy(&policy).await?;
    Ok(())
}

pub async fn cleanup_acl_policy(
    client: &mut TailscaleClient,
    server_tag: &str,
    player_tag: &str,
    automation_tag: &str,
    server_port: u16,
) -> Result<()> {
    let mut policy = client.get_acl_policy().await?;

    let arma_dst = format!("{}:{}", server_tag, server_port);
    policy.acls.retain(|rule| {
        let is_exact_player_src = rule.src.len() == 1 && rule.src[0] == player_tag;
        let is_exact_rule_shape = rule.action == "accept" && is_exact_player_src && rule.dst.len() == 1;
        let is_automation_rule =
            is_exact_rule_shape && (rule.dst[0] == arma_dst || rule.dst[0] == "*:*");
        !is_automation_rule
    });

    if let Some(tag_owners) = policy.tag_owners.as_object_mut() {
        let server_owned_by_automation = tag_owners
            .get(server_tag)
            .and_then(|v| v.as_array())
            .map(|owners| owners.len() == 1 && owners[0] == serde_json::json!(automation_tag))
            .unwrap_or(false);
        if server_owned_by_automation {
            tag_owners.remove(server_tag);
        }

        let player_owned_by_automation = tag_owners
            .get(player_tag)
            .and_then(|v| v.as_array())
            .map(|owners| owners.len() == 1 && owners[0] == serde_json::json!(automation_tag))
            .unwrap_or(false);
        if player_owned_by_automation {
            tag_owners.remove(player_tag);
        }

        let automation_owned_by_admin = tag_owners
            .get(automation_tag)
            .and_then(|v| v.as_array())
            .map(|owners| owners.len() == 1 && owners[0] == serde_json::json!("autogroup:admin"))
            .unwrap_or(false);
        if automation_owned_by_admin {
            tag_owners.remove(automation_tag);
        }
    }

    client.update_acl_policy(&policy).await?;
    Ok(())
}

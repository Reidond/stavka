use anyhow::Result;

use crate::client::{AclPolicy, AclRule, TailscaleClient};

pub async fn ensure_acl_policy(
    client: &mut TailscaleClient,
    server_tag: &str,
    player_tag: &str,
    automation_tag: &str,
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
            dst: vec![format!("{}:2302", server_tag)],
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
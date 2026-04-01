use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};

const TAILSCALE_API_BASE: &str = "https://api.tailscale.com/api/v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    expires_at: DateTime<Utc>,
}

pub struct TailscaleClient {
    client: Client,
    oauth_client_id: String,
    oauth_client_secret: String,
    tailnet: String,
    cached_token: Option<CachedToken>,
}

impl TailscaleClient {
    pub fn new(oauth_client_id: String, oauth_client_secret: String, tailnet: String) -> Self {
        Self {
            client: Client::builder()
                .user_agent("stavka-tailscale-integration/0.1.0")
                .build()
                .expect("Failed to create HTTP client"),
            oauth_client_id,
            oauth_client_secret,
            tailnet,
            cached_token: None,
        }
    }

    async fn get_token(&mut self) -> Result<String> {
        if let Some(ref token) = self.cached_token {
            if Utc::now() < token.expires_at - chrono::Duration::minutes(5) {
                return Ok(token.access_token.clone());
            }
        }

        let response = self
            .client
            .post("https://api.tailscale.com/api/v2/oauth/token")
            .basic_auth(&self.oauth_client_id, Some(&self.oauth_client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .context("Failed to request OAuth token from Tailscale")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("OAuth token request failed ({}): {}", status, body);
        }

        let token_response = response
            .json::<TokenResponse>()
            .await
            .context("Failed to parse OAuth token response")?;

        let expires_at = Utc::now() + chrono::Duration::seconds(token_response.expires_in as i64);
        self.cached_token = Some(CachedToken {
            access_token: token_response.access_token.clone(),
            expires_at,
        });

        Ok(token_response.access_token)
    }

    pub async fn get_devices(&mut self) -> Result<Vec<Device>> {
        let token = self.get_token().await?;
        let url = format!("{}/tailnet/{}/devices", TAILSCALE_API_BASE, self.tailnet);
        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .context("Failed to fetch devices from Tailscale API")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        #[derive(Deserialize)]
        struct DevicesResponse {
            devices: Vec<Device>,
        }

        let devices_response: DevicesResponse = response
            .json()
            .await
            .context("Failed to parse devices response")?;
        Ok(devices_response.devices)
    }

    pub async fn generate_auth_key(&mut self, request: &CreateAuthKeyRequest) -> Result<AuthKey> {
        let token = self.get_token().await?;
        let url = format!("{}/tailnet/{}/keys", TAILSCALE_API_BASE, self.tailnet);

        #[derive(Serialize)]
        struct ApiRequest<'a> {
            capabilities: &'a AuthKeyCapabilities,
            expiry_seconds: u64,
            description: &'a str,
        }

        let api_request = ApiRequest {
            capabilities: &request.capabilities,
            expiry_seconds: request.expiry_seconds,
            description: &request.description,
        };

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&api_request)
            .send()
            .await
            .context("Failed to generate auth key")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        response
            .json::<AuthKey>()
            .await
            .context("Failed to parse auth key response")
    }

    pub async fn get_acl_policy(&mut self) -> Result<AclPolicy> {
        let token = self.get_token().await?;
        let url = format!("{}/tailnet/{}/acl", TAILSCALE_API_BASE, self.tailnet);

        let response = self
            .client
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "application/hujson")
            .send()
            .await
            .context("Failed to fetch ACL policy")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        let body = response
            .text()
            .await
            .context("Failed to read ACL policy body")?;

        serde_json::from_str(&body)
            .or_else(|_| serde_json::from_str(&strip_hujson_comments(&body)))
            .context("Failed to parse ACL policy")
    }

    pub async fn update_acl_policy(&mut self, policy: &AclPolicy) -> Result<()> {
        let token = self.get_token().await?;
        let url = format!("{}/tailnet/{}/acl", TAILSCALE_API_BASE, self.tailnet);

        let body = serde_json::to_string_pretty(policy)
            .context("Failed to serialize ACL policy")?;

        eprintln!("Sending ACL policy:\n{}", body);

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/hujson")
            .body(body)
            .send()
            .await
            .context("Failed to update ACL policy")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        Ok(())
    }

    pub async fn send_email_invite(&mut self, email: &str) -> Result<()> {
        let token = self.get_token().await?;
        let url = format!(
            "{}/user/{}/invites",
            TAILSCALE_API_BASE,
            urlencoding::encode(email)
        );

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .send()
            .await
            .context("Failed to send email invite")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        Ok(())
    }

    pub async fn set_device_tags(&mut self, device_id: &str, tags: &[String]) -> Result<()> {
        let token = self.get_token().await?;
        let url = format!("{}/device/{}/tags", TAILSCALE_API_BASE, device_id);

        #[derive(Serialize)]
        struct SetTagsRequest<'a> {
            tags: &'a [String],
        }

        let response = self
            .client
            .post(&url)
            .bearer_auth(&token)
            .json(&SetTagsRequest { tags })
            .send()
            .await
            .context("Failed to set device tags")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Tailscale API error ({}): {}", status, body);
        }

        Ok(())
    }

    pub fn tailnet(&self) -> &str {
        &self.tailnet
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    #[serde(rename = "nodeId", default)]
    pub node_id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(rename = "addresses", default)]
    pub ip_addresses: Vec<String>,
    #[serde(default)]
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAuthKeyRequest {
    pub capabilities: AuthKeyCapabilities,
    pub expiry_seconds: u64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthKeyCapabilities {
    pub devices: DeviceCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCapabilities {
    #[serde(rename = "create")]
    pub create: CreateDeviceCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDeviceCapability {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub preauthorized: bool,
    #[serde(default)]
    pub ephemeral: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthKey {
    pub id: String,
    pub key: String,
    pub description: String,
    pub created: String,
    pub expires: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclPolicy {
    #[serde(default)]
    pub groups: serde_json::Value,
    #[serde(default)]
    pub hosts: serde_json::Value,
    #[serde(default)]
    pub acls: Vec<AclRule>,
    #[serde(rename = "tagOwners", default)]
    pub tag_owners: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclRule {
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub src: Vec<String>,
    #[serde(default)]
    pub dst: Vec<String>,
}

fn strip_hujson_comments(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            let mut result = String::new();
            let mut in_string = false;
            let mut escape_next = false;
            for ch in line.chars() {
                if escape_next {
                    result.push(ch);
                    escape_next = false;
                    continue;
                }
                if ch == '\\' && in_string {
                    result.push(ch);
                    escape_next = true;
                    continue;
                }
                if ch == '"' {
                    in_string = !in_string;
                }
                if ch == '/' && !in_string {
                    break;
                }
                result.push(ch);
            }
            result
        })
        .collect::<Vec<_>>()
        .join("\n")
}

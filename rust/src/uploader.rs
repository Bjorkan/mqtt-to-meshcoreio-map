use crate::reader::Job;
use crate::{MapUploader, signing_public_key};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;

pub struct Uploader {
    client: reqwest::Client,
    config: MapUploader,
    key: SigningKey,
}

impl Uploader {
    pub fn new(config: MapUploader, env: &HashMap<String, String>) -> Result<Self, String> {
        signing_public_key(env).map_err(str::to_owned)?;
        let seed = if let Some(value) = env
            .get("MESHCOREIO_PRIVATE_KEY")
            .filter(|v| !v.trim().is_empty())
        {
            let mut seed = [0u8; 32];
            hex::decode_to_slice(value.trim(), &mut seed)
                .map_err(|_| "invalid signing identity".to_owned())?;
            seed
        } else {
            let mut seed = [0u8; 32];
            getrandom::getrandom(&mut seed).map_err(|e| e.to_string())?;
            seed
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(config.request_timeout_ms as u64))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            config,
            key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn public_key(&self) -> String {
        hex::encode(self.key.verifying_key().to_bytes())
    }

    pub fn signed_request(&self, job: &Job) -> Value {
        let data =
            json!({"params":job.radio,"links":[format!("meshcore://{}",job.raw_hex)]}).to_string();
        let signature = self.key.sign(&Sha256::digest(data.as_bytes()));
        json!({"data":data,"signature":hex::encode(signature.to_bytes()),"publicKey":self.public_key()})
    }

    pub async fn post(&self, job: &Job) -> Result<String, String> {
        if self.config.dry_run {
            return Ok(format!(
                "Dry run: would send advert {} to meshcore.io.",
                job.label
            ));
        }
        let body = self.signed_request(job);
        let mut response = self
            .client
            .post(&self.config.api_url)
            .json(&body)
            .send()
            .await
            .map_err(http_error)?;
        let status = response.status();
        const MAX_RESPONSE_BYTES: usize = 4096;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
        {
            return Err("meshcore.io response exceeded size limit".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(http_error)? {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err("meshcore.io response exceeded size limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes);
        let parsed = serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object);
        let code = parsed
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let terminal = code == "NODES_INSERTED"
            || code.starts_with("ERR_ADVERT_")
            || code.starts_with("ERR_COORDS_");
        if !status.is_success() && !terminal {
            return Err(format!(
                "meshcore.io responded {}{}",
                status.as_u16(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {}", safe_log_body(&text))
                }
            ));
        }
        Ok(format_outcome(&job.label, &text, parsed.as_ref()))
    }
}

fn http_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "operation aborted".to_owned()
    } else {
        // reqwest errors can embed API URLs, including userinfo or query
        // tokens. Keep retry diagnostics free of the configured endpoint.
        "meshcore.io request failed".to_owned()
    }
}

fn trim_body(body: &str) -> String {
    let mut chars = body.chars();
    let value: String = chars.by_ref().take(500).collect();
    if chars.next().is_some() {
        value + "..."
    } else {
        value
    }
}

fn safe_log_body(body: &str) -> String {
    let mut safe = String::new();
    for ch in trim_body(body).chars() {
        if ch.is_ascii_control() || ch == '\u{7f}' {
            safe.push_str(&format!("\\x{:02x}", ch as u32));
        } else {
            safe.push(ch);
        }
    }
    safe
}

fn format_outcome(label: &str, text: &str, parsed: Option<&Value>) -> String {
    let code = parsed
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .unwrap_or("no parseable response");
    let result = match code {
        "NODES_INSERTED" => "NODES_INSERTED".to_owned(),
        "ERR_ADVERT_DUPLICATE" => "ERR_ADVERT_DUPLICATE – node was updated recently".to_owned(),
        "ERR_COORDS_MISSING" => "ERR_COORDS_MISSING – map coordinates are missing".to_owned(),
        _ => {
            let details = parsed
                .and_then(|v| {
                    ["message", "error"].iter().find_map(|key| {
                        v.get(*key)
                            .and_then(Value::as_str)
                            .filter(|v| !v.is_empty())
                    })
                })
                .or_else(|| (!text.trim().is_empty()).then_some(text));
            format!(
                "{}{}",
                safe_log_body(code),
                details
                    .map(|d| format!(" – {}", safe_log_body(d)))
                    .unwrap_or_default()
            )
        }
    };
    format!("Advert {label} sent to meshcore.io: {result}")
}

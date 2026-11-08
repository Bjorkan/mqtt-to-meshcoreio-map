//! Compatibility configuration for the existing Bun bridge. Keep the public
//! environment contract in sync with src/index.ts and src/map-log.ts.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub client_id: String,
    pub topic_filter: String,
    pub reconnect_period_ms: i64,
    pub connect_timeout_ms: i64,
    pub reject_unauthorized: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapUploader {
    pub enabled: bool,
    pub api_url: String,
    pub dry_run: bool,
    pub min_reupload_interval_seconds: i64,
    pub request_timeout_ms: i64,
    pub max_queued_uploads: i64,
    pub retries_allowed: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub sources: Vec<Source>,
    pub source_url: String,
    pub source_user: String,
    pub source_pass: String,
    pub source_client_id: String,
    pub topic_filter: String,
    pub reconnect_period_ms: i64,
    pub connect_timeout_ms: i64,
    pub reject_unauthorized: bool,
    pub map_uploader: MapUploader,
}

pub fn read_environment(directory: &Path) -> HashMap<String, String> {
    // Bun loads .env, the NODE_ENV-specific file, and .env.local (except
    // under NODE_ENV=test). Exported variables take precedence over all files.
    // Missing files are normal (e.g. Compose env_file).
    let mode = std::env::var("NODE_ENV").unwrap_or_else(|_| "development".into());
    let mut files = vec![".env".to_owned(), format!(".env.{mode}")];
    if mode != "test" {
        files.push(".env.local".into());
    }
    files.push(format!(".env.{mode}.local"));
    let mut raw = HashMap::new();
    for file in files {
        if let Ok(contents) = std::fs::read_to_string(directory.join(file)) {
            parse_env_file(&contents, &mut raw);
        }
    }
    // Bun merges all files and process variables before expanding references.
    let mut expanded: HashMap<String, String> = std::env::vars().collect();
    raw.extend(expanded.clone());
    let mut keys = raw.keys().collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        expand_key(key, &raw, &mut expanded, &mut Vec::new());
    }
    expanded
}

fn parse_env_file(contents: &str, values: &mut HashMap<String, String>) {
    let mut lines = contents.lines();
    while let Some(line) = lines.next() {
        let line = line.trim_start();
        let line = line
            .strip_prefix("export")
            .and_then(|rest| {
                rest.starts_with(char::is_whitespace)
                    .then(|| rest.trim_start())
            })
            .unwrap_or(line);
        let Some(separator) = line.find(['=', ':']) else {
            continue;
        };
        let (key, value) = (&line[..separator], &line[separator + 1..]);
        if line.as_bytes()[separator] == b':' && !value.starts_with(char::is_whitespace) {
            continue;
        }
        let key = key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            continue;
        }
        let value = value.trim_start();
        let parsed = if let Some(quote @ ('"' | '\'' | '`')) = value.chars().next() {
            let mut body = value[quote.len_utf8()..].to_owned();
            let closing = |text: &str| {
                text.char_indices()
                    .find(|(i, ch)| {
                        *ch == quote
                            && text[..*i].bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 0
                    })
                    .map(|(i, _)| i)
            };
            // If no closing quote exists in the file, Bun keeps the opening
            // quote as text and continues parsing the next assignment.
            let mut probe = lines.clone();
            let mut has_closing = closing(&body).is_some();
            while !has_closing {
                let Some(next) = probe.next() else { break };
                body.push('\n');
                body.push_str(next);
                has_closing = closing(&body).is_some();
            }
            if !has_closing {
                value.to_owned()
            } else {
                body = value[quote.len_utf8()..].to_owned();
                loop {
                    // A quote preceded by a backslash does not terminate the value.
                    if let Some(end) = closing(&body) {
                        body.truncate(end);
                        break;
                    }
                    let Some(next) = lines.next() else { break };
                    body.push('\n');
                    body.push_str(next);
                }
                if quote == '"' {
                    unescape_double_quote(&body)
                } else {
                    body
                }
            }
        } else {
            value.split('#').next().unwrap_or("").trim_end().to_owned()
        };
        values.insert(key.to_owned(), parsed);
    }
}

fn unescape_double_quote(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && matches!(chars.peek(), Some('n' | 'r')) {
            result.push(if chars.next() == Some('n') {
                '\n'
            } else {
                '\r'
            });
        } else if ch == '\\' && chars.peek() == Some(&'\\') {
            result.push(ch);
            result.push(chars.next().expect("peeked backslash"));
        } else {
            result.push(ch);
        }
    }
    result
}

fn expand_key(
    key: &str,
    raw: &HashMap<String, String>,
    expanded: &mut HashMap<String, String>,
    visiting: &mut Vec<String>,
) -> String {
    if let Some(value) = expanded.get(key) {
        return value.clone();
    }
    let Some(value) = raw.get(key) else {
        return String::new();
    };
    if visiting.iter().any(|active| active == key) || visiting.len() >= 128 {
        return value.clone();
    }
    visiting.push(key.to_owned());
    let output = expand_value(value, raw, expanded, visiting);
    visiting.pop();
    expanded.insert(key.to_owned(), output.clone());
    output
}

fn expand_value(
    value: &str,
    raw: &HashMap<String, String>,
    expanded: &mut HashMap<String, String>,
    visiting: &mut Vec<String>,
) -> String {
    let mut output = String::new();
    let mut rest = value;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("\\$") {
            output.push('$');
            rest = after;
        } else if let Some(after) = rest.strip_prefix('$') {
            let (name, fallback, tail) = if let Some(block) = after.strip_prefix('{') {
                let mut depth = 1usize;
                let mut end = None;
                for (i, ch) in block.char_indices() {
                    if ch == '{' {
                        depth += 1;
                    }
                    if ch == '}'
                        && block[..i].bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 0
                    {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(i);
                            break;
                        }
                    }
                }
                if let Some(end) = end {
                    let (name, fallback) = block[..end]
                        .split_once(":-")
                        .map_or((&block[..end], None), |(name, fallback)| {
                            (name, Some(fallback))
                        });
                    (name, fallback, &block[end + 1..])
                } else {
                    ("", None, after)
                }
            } else {
                let len = after
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                    .count();
                (&after[..len], None, &after[len..])
            };
            if !name.is_empty()
                && name
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                if raw.contains_key(name) {
                    output.push_str(&expand_key(name, raw, expanded, visiting));
                } else if let Some(default) = fallback {
                    if visiting.len() < 128 {
                        output.push_str(&expand_value(default, raw, expanded, visiting));
                    } else {
                        output.push_str(default);
                    }
                } else {
                    // Missing references resolve to the empty string.
                }
                rest = tail;
            } else {
                if let Some(block) = after.strip_prefix('{') {
                    if let Some(end) = block.find('}') {
                        output.push('$');
                        output.push_str(&after[..end + 2]);
                        rest = &block[end + 1..];
                    } else {
                        output.push_str(rest);
                        break;
                    }
                } else {
                    output.push('$');
                    rest = after;
                }
            }
        } else {
            let ch = rest.chars().next().expect("nonempty value");
            output.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    output
}

fn get<'a>(env: &'a HashMap<String, String>, key: &str) -> &'a str {
    env.get(key).map(String::as_str).unwrap_or("")
}

fn or<'a>(first: &'a str, second: &'a str) -> &'a str {
    if first.is_empty() { second } else { first }
}

fn number(value: &str, fallback: i64, min: i64, max: i64) -> i64 {
    if value.trim().is_empty() {
        return fallback;
    }
    // JavaScript Number() accepts decimal, scientific, and radix-prefixed
    // integers, and requires the result to be a finite integral Number.
    let trimmed = value.trim();
    let parsed = if let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        i64::from_str_radix(digits, 16).ok().map(|v| v as f64)
    } else if let Some(digits) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        i64::from_str_radix(digits, 2).ok().map(|v| v as f64)
    } else if let Some(digits) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        i64::from_str_radix(digits, 8).ok().map(|v| v as f64)
    } else {
        trimmed.parse::<f64>().ok()
    };
    match parsed {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64 => {
            n as i64
        }
        _ => fallback,
    }
}

fn boolean(value: &str, fallback: bool) -> bool {
    if value.trim().is_empty() {
        fallback
    } else {
        matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on")
    }
}

pub fn resolve(env: &HashMap<String, String>) -> Config {
    let mut sources = Vec::new();
    let mut index = 1usize;
    while let Some(url) = env.get(&format!("SOURCE_{index}_MQTT_URL")) {
        let prefix = format!("SOURCE_{index}_");
        let field = |suffix: &str| {
            env.get(&format!("{prefix}{suffix}"))
                .map(String::as_str)
                .unwrap_or("")
        };
        sources.push(Source {
            name: or(field("NAME"), url).to_owned(),
            url: url.clone(),
            username: field("MQTT_USERNAME").to_owned(),
            password: field("MQTT_PASSWORD").to_owned(),
            client_id: or(
                field("CLIENT_ID"),
                &format!("mqtt-to-meshcoreio-map-{index}"),
            )
            .to_owned(),
            topic_filter: or(field("TOPIC_FILTER"), "meshcore/#").to_owned(),
            reconnect_period_ms: number(
                or(
                    field("RECONNECT_PERIOD_MS"),
                    get(env, "MQTT_RECONNECT_PERIOD_MS"),
                ),
                5000,
                250,
                300000,
            ),
            connect_timeout_ms: number(
                or(
                    field("CONNECT_TIMEOUT_MS"),
                    get(env, "MQTT_CONNECT_TIMEOUT_MS"),
                ),
                30000,
                1000,
                300000,
            ),
            reject_unauthorized: boolean(
                or(
                    field("REJECT_UNAUTHORIZED"),
                    get(env, "SOURCE_REJECT_UNAUTHORIZED"),
                ),
                true,
            ),
        });
        index += 1;
    }
    if sources.is_empty() {
        let url = or(get(env, "SOURCE_MQTT_URL"), "mqtt://localhost:1883");
        sources.push(Source {
            name: or(get(env, "SOURCE_1_NAME"), or(get(env, "SOURCE_NAME"), url)).to_owned(),
            url: url.to_owned(),
            username: get(env, "SOURCE_MQTT_USERNAME").to_owned(),
            password: get(env, "SOURCE_MQTT_PASSWORD").to_owned(),
            client_id: or(get(env, "SOURCE_CLIENT_ID"), "mqtt-to-meshcoreio-map").to_owned(),
            topic_filter: or(get(env, "TOPIC_FILTER"), "meshcore/#").to_owned(),
            reconnect_period_ms: number(get(env, "MQTT_RECONNECT_PERIOD_MS"), 5000, 250, 300000),
            connect_timeout_ms: number(get(env, "MQTT_CONNECT_TIMEOUT_MS"), 30000, 1000, 300000),
            reject_unauthorized: boolean(get(env, "SOURCE_REJECT_UNAUTHORIZED"), true),
        });
    }
    let first = &sources[0];
    Config {
        source_url: first.url.clone(),
        source_user: first.username.clone(),
        source_pass: first.password.clone(),
        source_client_id: first.client_id.clone(),
        topic_filter: first.topic_filter.clone(),
        reconnect_period_ms: first.reconnect_period_ms,
        connect_timeout_ms: first.connect_timeout_ms,
        reject_unauthorized: first.reject_unauthorized,
        sources,
        map_uploader: MapUploader {
            enabled: true,
            api_url: or(
                get(env, "MESHCOREIO_API_URL"),
                "https://map.meshcore.io/api/v1/uploader/node",
            )
            .to_owned(),
            dry_run: boolean(get(env, "MESHCOREIO_DRY_RUN"), false),
            min_reupload_interval_seconds: number(
                get(env, "MESHCOREIO_MIN_REUPLOAD_SECONDS"),
                3600,
                0,
                86400,
            ),
            request_timeout_ms: number(
                get(env, "MESHCOREIO_REQUEST_TIMEOUT_MS"),
                10000,
                1000,
                120000,
            ),
            max_queued_uploads: number(get(env, "MESHCOREIO_MAX_QUEUED_UPLOADS"), 25, 1, 10000),
            retries_allowed: number(get(env, "MESHCOREIO_RETRIES_ALLOWED"), 3, 0, 100),
        },
    }
}

pub fn signing_public_key(env: &HashMap<String, String>) -> Result<Option<String>, &'static str> {
    use ed25519_dalek::{Signer, SigningKey, Verifier};
    let value = get(env, "MESHCOREIO_PRIVATE_KEY").trim();
    if value.is_empty() {
        return Ok(None);
    }
    let bytes = hex::decode(value).map_err(
        |_| "MESHCOREIO_PRIVATE_KEY is invalid: expected a 64-character hex ed25519 private seed.",
    )?;
    let seed: [u8; 32] = bytes.try_into().map_err(
        |_| "MESHCOREIO_PRIVATE_KEY is invalid: expected a 64-character hex ed25519 private seed.",
    )?;
    let key = SigningKey::from_bytes(&seed);
    let message = b"mqtt-to-meshcoreio-map signing self-test";
    key.verifying_key().verify(message, &key.sign(message))
        .map_err(|_| "MESHCOREIO_PRIVATE_KEY is invalid: the value could not be used as an ed25519 private seed.")?;
    Ok(Some(hex::encode(key.verifying_key().to_bytes())))
}

pub fn log_color(env: &HashMap<String, String>) -> bool {
    !env.contains_key("NO_COLOR") && get(env, "LOG_COLOR") != "false"
}

pub fn time_zone(env: &HashMap<String, String>) -> Option<&str> {
    let tz = get(env, "TZ").trim();
    if tz.is_empty() || tz.parse::<chrono_tz::Tz>().is_err() {
        None
    } else {
        Some(tz)
    }
}

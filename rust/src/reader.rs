use crate::MapUploader;
use crate::protocol::parse_verified_advert;
use regex::Regex;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Radio {
    pub freq: f64,
    pub bw: f64,
    pub sf: f64,
    pub cr: f64,
    // JavaScript preserves insertion order when JSON.stringify serializes the
    // radio object. This matters because the exact string is signed.
    order: [usize; 4],
}

impl Serialize for Radio {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(4))?;
        for index in self.order {
            let (name, value) = match index {
                0 => ("freq", self.freq),
                1 => ("bw", self.bw),
                2 => ("sf", self.sf),
                _ => ("cr", self.cr),
            };
            let number =
                if value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 {
                    serde_json::Number::from(value as i64)
                } else {
                    serde_json::Number::from_f64(value)
                        .ok_or_else(|| serde::ser::Error::custom("invalid radio value"))?
                };
            map.serialize_entry(name, &number)?;
        }
        map.end()
    }
}

impl Radio {
    fn valid(self) -> bool {
        self.freq.is_finite()
            && (100.0..=1000.0).contains(&self.freq)
            && self.bw.is_finite()
            && self.bw > 0.0
            && self.bw <= 1000.0
            && self.sf.is_finite()
            && (5.0..=12.0).contains(&self.sf)
            && self.cr.is_finite()
            && (4.0..=8.0).contains(&self.cr)
    }

    fn normalized(mut self) -> Self {
        self.freq = ((self.freq + f64::EPSILON) * 1000.0).round() / 1000.0;
        self
    }
}

#[derive(Clone, Debug)]
pub struct Job {
    pub node_key: String,
    pub timestamp: i64,
    pub advert_key: String,
    pub label: String,
    pub raw_hex: String,
    pub radio: Radio,
    pub retries_left: i64,
    pub attempts: i64,
}

struct Observer {
    radio: Radio,
    updated_at: i64,
}

pub struct Reader {
    observers: HashMap<String, Observer>,
    seen: HashMap<String, i64>,
    recent: HashMap<String, i64>,
    min_reupload_seconds: i64,
    retries_allowed: i64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn string(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.trim().is_empty())
}

fn observer_id(json: &Value, topic: &str) -> Option<String> {
    let valid = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
    json.get("origin_id")
        .and_then(string)
        .filter(|s| valid(s))
        .or_else(|| topic.split('/').find(|s| valid(s)))
        .map(str::to_ascii_lowercase)
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(s) if !s.trim().is_empty() => {
            s.trim().parse::<f64>().ok().filter(|n| n.is_finite())
        }
        _ => None,
    }
}

fn field(data: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| data.get(*key).filter(|v| !v.is_null()).map(number))
        .flatten()
}

fn frequency_mhz(value: f64) -> f64 {
    if value > 10_000_000.0 {
        value / 1_000_000.0
    } else if value > 10_000.0 {
        value / 1_000.0
    } else {
        value
    }
}

fn bandwidth_khz(value: f64) -> f64 {
    if value > 1000.0 {
        value / 1000.0
    } else {
        value
    }
}

fn radio_from_status(data: &Value) -> Option<Radio> {
    let radio = data.get("radio").and_then(string).unwrap_or("");
    let comma = Regex::new(
        r"^\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*$",
    )
    .unwrap();
    let mut values = if let Some(parts) = comma.captures(radio) {
        let mut values = (1..=4)
            .map(|i| parts[i].parse::<f64>().ok())
            .collect::<Vec<_>>();
        values[0] = values[0].map(frequency_mhz);
        values[1] = values[1].map(bandwidth_khz);
        values
    } else {
        [
            r"(?i)([0-9]+(?:\.[0-9]+)?)\s*MHz",
            r"(?i)\bBW\s*([0-9]+(?:\.[0-9]+)?)",
            r"(?i)\bSF\s*([0-9]+)",
            r"(?i)\bCR\s*([0-9]+)",
        ]
        .iter()
        .map(|pattern| {
            Regex::new(pattern)
                .unwrap()
                .captures(radio)
                .and_then(|c| c[1].parse::<f64>().ok())
        })
        .collect()
    };
    let direct = data.get("params").filter(|v| v.is_object()).unwrap_or(data);
    let mut order: Vec<usize> = (0..4).filter(|i| values[*i].is_some()).collect();
    for (i, names) in [
        (0, &["freq", "frequency", "radioFreq"][..]),
        (3, &["cr", "codingRate", "radioCr"]),
        (2, &["sf", "spreadingFactor", "radioSf"]),
        (1, &["bw", "bandwidth", "radioBw"]),
    ] {
        if let Some(value) = field(direct, names) {
            values[i] = Some(match i {
                0 => frequency_mhz(value),
                1 => bandwidth_khz(value),
                _ => value,
            });
            if !order.contains(&i) {
                order.push(i);
            }
        }
    }
    let result = Radio {
        freq: values[0]?,
        bw: values[1]?,
        sf: values[2]?,
        cr: values[3]?,
        order: order.try_into().ok()?,
    };
    result.valid().then_some(result)
}

fn packet_hex(json: &Value, payload: &[u8], kind: &str) -> Option<String> {
    let value = if json.is_string() {
        json.as_str()
    } else if json.is_object() {
        let keys = if kind == "packets" {
            &["raw", "packet", "payload", "data"][..]
        } else {
            &["data", "raw", "packet", "payload"][..]
        };
        keys.iter()
            .find_map(|key| json.get(*key).filter(|v| !v.is_null()))
            .and_then(Value::as_str)
    } else {
        std::str::from_utf8(payload).ok()
    }?;
    let value = value.trim();
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    let hex: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    (hex.len() >= 2
        && hex.len() <= 1024
        && hex.len().is_multiple_of(2)
        && hex.bytes().all(|b| b.is_ascii_hexdigit()))
    .then(|| hex.to_ascii_lowercase())
}

fn sanitized_label(name: &str, key: &str) -> String {
    let mut cleaned = String::new();
    for ch in name.chars() {
        if ch.is_ascii_control() {
            cleaned.push_str(&format!("\\x{:02x}", ch as u32));
        } else {
            cleaned.push(ch);
        }
    }
    if cleaned.len() > 80 {
        cleaned.truncate(cleaned.floor_char_boundary(80));
        cleaned.push_str("...");
    }
    format!("{} ({})", cleaned, &key[..6])
}

impl Reader {
    pub fn new(config: &MapUploader) -> Self {
        Self {
            observers: HashMap::new(),
            seen: HashMap::new(),
            recent: HashMap::new(),
            min_reupload_seconds: config.min_reupload_interval_seconds,
            retries_allowed: config.retries_allowed,
        }
    }

    pub fn handled(&mut self, key: &str, timestamp: i64) {
        let seen = self.seen.entry(key.to_owned()).or_insert(timestamp);
        *seen = (*seen).max(timestamp);
    }

    pub fn receive(&mut self, topic: &str, payload: &[u8], now: i64) -> Option<Job> {
        self.observers
            .retain(|_, o| now - o.updated_at <= 86_400_000);
        self.seen.retain(|_, t| *t >= now / 1000 - 259_200);
        self.recent.retain(|_, t| *t >= now - 3_600_000);
        let kind = topic
            .split('/')
            .rev()
            .find(|s| matches!(*s, "status" | "raw" | "packets"))?;
        if kind == "status" {
            let json: Value = serde_json::from_slice(payload).ok()?;
            let id = observer_id(&json, topic)?;
            let radio = radio_from_status(&json)?;
            self.observers.insert(
                id,
                Observer {
                    radio,
                    updated_at: now,
                },
            );
            return None;
        }
        if payload.len() > 16 * 1024 {
            return None;
        }
        let json = serde_json::from_slice::<Value>(payload).unwrap_or(Value::Null);
        let raw_hex = packet_hex(&json, payload, kind)?;
        let id = observer_id(&json, topic)?;
        let radio = self.observers.get(&id)?.radio.normalized();
        let raw = hex::decode(&raw_hex).ok()?;
        let advert = parse_verified_advert(&raw)?;
        let key = advert.public_key;
        let timestamp = advert.timestamp;
        let name = advert.name;
        if self
            .seen
            .get(&key)
            .is_some_and(|t| *t >= timestamp || timestamp < *t + self.min_reupload_seconds)
            || self.recent.get(&key).is_some_and(|t| now - *t < 3_600_000)
        {
            return None;
        }
        self.recent.insert(key.clone(), now);
        Some(Job {
            advert_key: format!("{key}:{timestamp}"),
            label: sanitized_label(&name, &key),
            node_key: key,
            timestamp,
            raw_hex,
            radio,
            retries_left: self.retries_allowed,
            attempts: 0,
        })
    }
}

use crate::queue::{Admission, RetryOutcome, UploadQueue};
use crate::reader::{Job, Reader, now_ms};
use crate::uploader::Uploader;
use crate::{Config, Source, log_color, time_zone};
use rumqttc::mqttbytes::v4::SubscribeReasonCode;
use rumqttc::{
    AsyncClient, Event, MqttOptions, NetworkOptions, Packet, QoS, TlsConfiguration, Transport,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use url::Url;

#[derive(Debug)]
struct Unverified;

impl ServerCertVerifier for Unverified {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ED25519,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

fn mqtt_options(source: &Source) -> Result<MqttOptions, String> {
    // Both rumqttc and reqwest enable rustls with different crypto backends;
    // select one explicitly before building any TLS configuration.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    // MQTT.js accepts an explicitly empty numbered URL and uses its default
    // localhost broker, while retaining the empty string in resolved config.
    let broker_url = if source.url.is_empty() {
        "mqtt://localhost:1883"
    } else {
        &source.url
    };
    let url = Url::parse(broker_url).map_err(|e| format!("invalid MQTT URL: {e}"))?;
    let host = url.host_str().ok_or("invalid MQTT URL: missing host")?;
    let (port, transport) = match url.scheme() {
        "mqtt" | "tcp" => (1883, Transport::tcp()),
        "mqtts" | "ssl" | "tls" => (8883, Transport::tls_with_default_config()),
        "ws" => (80, Transport::ws()),
        "wss" => (443, Transport::wss_with_default_config()),
        _ => return Err("invalid MQTT URL: unsupported scheme".into()),
    };
    let websocket = matches!(url.scheme(), "ws" | "wss");
    let address = if websocket {
        source.url.clone()
    } else {
        host.to_owned()
    };
    let client_id = url
        .query_pairs()
        .filter(|(key, _)| key == "clientId")
        .last()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| source.client_id.clone());
    let mut options = MqttOptions::new(client_id, address, url.port().unwrap_or(port));
    options.set_transport(transport);
    options.set_clean_session(true);
    options.set_keep_alive(Duration::from_secs(60));
    options.set_request_channel_capacity(32);
    // Only advert packets have the 16 KiB application cap. Status JSON can
    // carry extra fields; allow larger bounded frames before Reader applies
    // its packet-specific limit.
    options.set_max_packet_size(1024 * 1024, 10 * 1024);
    // MQTT.js URL userinfo overrides username/password passed as options.
    let username = if url.username().is_empty() {
        source.username.clone()
    } else {
        percent_encoding::percent_decode_str(url.username())
            .decode_utf8_lossy()
            .into_owned()
    };
    let password = if url.username().is_empty() {
        source.password.clone()
    } else {
        percent_encoding::percent_decode_str(url.password().unwrap_or(""))
            .decode_utf8_lossy()
            .into_owned()
    };
    if !username.is_empty() || !password.is_empty() {
        options.set_credentials(username, password);
    }
    if !source.reject_unauthorized
        && matches!(
            Url::parse(&source.url)
                .ok()
                .map(|u| u.scheme().to_owned())
                .as_deref(),
            Some("mqtts" | "ssl" | "tls" | "wss")
        )
    {
        // Only disable verification when the existing opt-out explicitly asks
        // for it, and only for this source. Never change the HTTP API client.
        let tls = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Unverified))
            .with_no_client_auth();
        let tls = TlsConfiguration::Rustls(Arc::new(tls));
        options.set_transport(if websocket {
            Transport::wss_with_config(tls)
        } else {
            Transport::tls_with_config(tls)
        });
    }
    Ok(options)
}

fn safe_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        // An unparseable URL is untrusted, and may contain userinfo or query
        // credentials. Never echo it into logs.
        return "[invalid MQTT URL]".to_owned();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("redacted");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("redacted"));
    }
    // MQTT URLs may carry credentials in query parameters as well.
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

pub fn log(env: &std::collections::HashMap<String, String>, message: &str, warning: bool) {
    use chrono::Timelike;
    let now = chrono::Local::now();
    let (hour, minute) =
        if let Some(tz) = time_zone(env).and_then(|s| s.parse::<chrono_tz::Tz>().ok()) {
            let at = now.with_timezone(&tz);
            (at.hour(), at.minute())
        } else {
            (now.hour(), now.minute())
        };
    let mut safe = String::new();
    for ch in message.chars() {
        if ch.is_ascii_control() || ch == '\u{7f}' {
            safe.push_str(&format!("\\x{:02x}", ch as u32));
        } else {
            safe.push(ch);
        }
    }
    if safe.chars().count() > 500 {
        safe = safe.chars().take(500).collect::<String>() + "...";
    }
    let line = format!("[Map upload {hour:02}:{minute:02}] {safe}");
    // Container deployment sets LOG_COLOR=false. ANSI prefix matches the old
    // service for interactive default settings.
    let line = if log_color(env) {
        line.replacen("[Map upload", "[\x1b[32mMap upload", 1)
            .replacen("] ", "\x1b[0m] ", 1)
    } else {
        line
    };
    if warning {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

enum Incoming {
    Message(String, Vec<u8>),
    Handled(Job, String),
    Retry(Job, String),
}

async fn mqtt_source(
    source: Source,
    tx: mpsc::Sender<Incoming>,
    env: Arc<std::collections::HashMap<String, String>>,
) {
    let safe = safe_url(&source.url);
    let safe_name = if source.name == source.url || Url::parse(&source.name).is_ok() {
        safe_url(&source.name)
    } else {
        source.name.clone()
    };
    let name = &safe_name;
    let options = match mqtt_options(&source) {
        Ok(o) => o,
        Err(error) => {
            log(&env, &format!("[{name}] MQTT source error: {error}"), true);
            return;
        }
    };
    let (client, mut loop_) = AsyncClient::new(options, 32);
    let mut network = NetworkOptions::new();
    network.set_connection_timeout((source.connect_timeout_ms as u64).div_ceil(1000));
    loop_.set_network_options(network);
    let mut connected = false;
    loop {
        let event = if connected {
            Ok(loop_.poll().await)
        } else {
            tokio::time::timeout(
                Duration::from_millis(source.connect_timeout_ms as u64),
                loop_.poll(),
            )
            .await
        };
        match event {
            Ok(Ok(Event::Incoming(Packet::ConnAck(_)))) => {
                connected = true;
                log(
                    &env,
                    &format!("[{name}] Connected to MQTT source {safe}."),
                    false,
                );
                if let Err(err) = client
                    .subscribe(&source.topic_filter, QoS::AtMostOnce)
                    .await
                {
                    log(
                        &env,
                        &format!(
                            "[{name}] Failed to subscribe to {}: {err}",
                            source.topic_filter
                        ),
                        true,
                    );
                }
            }
            Ok(Ok(Event::Incoming(Packet::SubAck(ack)))) => {
                if ack
                    .return_codes
                    .iter()
                    .any(|code| matches!(code, SubscribeReasonCode::Failure))
                {
                    log(
                        &env,
                        &format!(
                            "[{name}] Failed to subscribe to {}: broker rejected subscription.",
                            source.topic_filter
                        ),
                        true,
                    );
                } else {
                    log(
                        &env,
                        &format!("[{name}] Subscribed to {}.", source.topic_filter),
                        false,
                    );
                }
            }
            Ok(Ok(Event::Incoming(Packet::Publish(packet)))) => {
                if tx
                    .send(Incoming::Message(packet.topic, packet.payload.to_vec()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Ok(Ok(_)) => (),
            Ok(Err(_err)) => {
                connected = false;
                // Underlying transport errors may contain URL userinfo or
                // query tokens; never log untrusted connection details.
                log(
                    &env,
                    &format!("[{name}] MQTT source error: Connection failed."),
                    true,
                );
                log(&env, &format!("[{name}] MQTT source is offline."), true);
                tokio::time::sleep(Duration::from_millis(source.reconnect_period_ms as u64)).await;
            }
            Err(_) => {
                connected = false;
                log(
                    &env,
                    &format!("[{name}] MQTT source error: Connection timed out."),
                    true,
                );
                tokio::time::sleep(Duration::from_millis(source.reconnect_period_ms as u64)).await;
            }
        }
    }
}

pub async fn run(
    config: Config,
    env: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    for source in &config.sources {
        mqtt_options(source)?;
    }
    let uploader = Arc::new(Uploader::new(config.map_uploader.clone(), &env)?);
    if env
        .get("MESHCOREIO_PRIVATE_KEY")
        .is_some_and(|v| !v.trim().is_empty())
    {
        log(
            &env,
            &format!(
                "Using MeshCore.io upload public key {} from MESHCOREIO_PRIVATE_KEY.",
                uploader.public_key()
            ),
            false,
        );
    } else {
        log(
            &env,
            &format!(
                "Using ephemeral MeshCore.io upload public key {}.",
                uploader.public_key()
            ),
            false,
        );
    }
    if config.map_uploader.retries_allowed == 0 {
        log(
            &env,
            "MESHCOREIO_RETRIES_ALLOWED is 0; every upload request will be dropped before posting.",
            true,
        );
    }
    let env = Arc::new(env);
    let (tx, mut rx) = mpsc::channel::<Incoming>(64);
    let sources: Vec<_> = config
        .sources
        .iter()
        .cloned()
        .map(|source| tokio::spawn(mqtt_source(source, tx.clone(), env.clone())))
        .collect();
    let mut reader = Reader::new(&config.map_uploader);
    let mut queue = UploadQueue::new(config.map_uploader.max_queued_uploads as usize);
    let mut posting = false;
    let mut active_upload: Option<tokio::task::JoinHandle<()>> = None;
    let mut next_at = tokio::time::Instant::now();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    loop {
        let wake = if !posting && queue.has_waiting() {
            Some(next_at)
        } else {
            None
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log(&env, &format!("Received SIGINT; stopping {} MQTT source connection{}.", config.sources.len(), if config.sources.len() == 1 { "" } else { "s" }), false);
                break;
            }
            _ = terminate.recv() => {
                log(&env, &format!("Received SIGTERM; stopping {} MQTT source connection{}.", config.sources.len(), if config.sources.len() == 1 { "" } else { "s" }), false);
                break;
            }
            Some(event) = rx.recv() => match event {
                Incoming::Message(topic, payload) => {
                    let now = now_ms();
                    if let Some(job) = reader.receive(&topic, &payload, now) {
                        let label = job.label.clone();
                        let accepted = job.clone();
                        match queue.admit(job) {
                            Admission::Accepted => reader.admitted(&accepted, now),
                            Admission::Full => log(&env, &format!("Upload queue is full. Dropping advert for {label}."), true),
                            Admission::Duplicate | Admission::Disabled => (),
                        }
                    }
                }
                Incoming::Handled(job, outcome) => {
                    log(&env, &outcome, false);
                    reader.handled(&job.node_key, job.timestamp);
                    queue.finish(&job);
                    posting = false;
                    active_upload = None;
                    if queue.has_waiting() { next_at = tokio::time::Instant::now() + Duration::from_secs(5); }
                }
                Incoming::Retry(job, reason) => {
                    posting = false;
                    active_upload = None;
                    let label = job.label.clone();
                    let attempts = job.attempts;
                    match queue.retry(job) {
                        RetryOutcome::Exhausted => log(&env, &format!("Advert {label} dropped after {attempts} attempt{}: {reason}.", if attempts == 1 { "" } else { "s" }), true),
                        RetryOutcome::Full => log(&env, &format!("Upload queue is full. Dropping advert for {label}."), true),
                        RetryOutcome::Queued | RetryOutcome::NotActive => (),
                    }
                    if queue.has_waiting() { next_at = tokio::time::Instant::now() + Duration::from_secs(5); }
                }
            },
            _ = async { if let Some(at) = wake { tokio::time::sleep_until(at).await } }, if wake.is_some() => {
                let Some(job) = queue.begin() else { continue; };
                posting = true;
                let tx = tx.clone();
                let uploader = uploader.clone();
                active_upload = Some(tokio::spawn(async move {
                    match uploader.post(&job).await {
                        Ok(outcome) => { let _ = tx.send(Incoming::Handled(job, outcome)).await; }
                        Err(reason) => {
                            // Retry logic is managed by the single queue owner.
                            let _ = tx.send(Incoming::Retry(job, reason)).await;
                        }
                    }
                }));
            }
        }
    }
    // The service is intentionally memory-only: stop accepting inbound work,
    // cancel an active upload and discard waiting jobs on shutdown.
    for source in sources {
        source.abort();
    }
    if let Some(upload) = active_upload {
        upload.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn source_options_keep_transport_path_credentials_and_tls_override() {
        let mut source = crate::resolve(&Default::default()).sources.remove(0);
        source.url = "wss://url-user:url-password@example.test:8084/mqtt?clientId=from-url".into();
        source.client_id = "configured-client".into();
        source.username = "override-user".into();
        source.password = "override-password".into();
        source.reject_unauthorized = false;
        let options = mqtt_options(&source).unwrap();
        assert_eq!(options.client_id(), "from-url");
        assert_eq!(options.max_packet_size(), 1024 * 1024);
        assert_eq!(options.broker_address(), (source.url.clone(), 8084));
        let login = options.credentials().unwrap();
        assert_eq!(login.username, "url-user");
        assert_eq!(login.password, "url-password");
        source.url = "WSS://url%40user:p%40ss@example.test/mqtt".into();
        let options = mqtt_options(&source).unwrap();
        let login = options.credentials().unwrap();
        assert_eq!(login.username, "url@user");
        assert_eq!(login.password, "p@ss");
        assert!(matches!(options.transport(), Transport::Wss(_)));
        source.url = "wss://url-user:url-password@example.test:8084/mqtt?clientId=from-url".into();
        assert!(matches!(options.transport(), Transport::Wss(_)));
        assert_eq!(
            safe_url(&source.url),
            "wss://redacted:redacted@example.test:8084/mqtt"
        );
        source.url = "mqtts://example.test:8883".into();
        source.reject_unauthorized = true;
        assert!(matches!(
            mqtt_options(&source).unwrap().transport(),
            Transport::Tls(_)
        ));
        source.url = "ssl://example.test:8883".into();
        source.reject_unauthorized = false;
        assert!(matches!(
            mqtt_options(&source).unwrap().transport(),
            Transport::Tls(_)
        ));
        source.url = "tls://example.test:8883".into();
        assert!(matches!(
            mqtt_options(&source).unwrap().transport(),
            Transport::Tls(_)
        ));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // tungstenite requires this handshake callback signature
    async fn websocket_source_connects_to_the_configured_path() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source = Source {
            url: format!("ws://{}/mqtt/custom", listener.local_addr().unwrap()),
            ..crate::resolve(&Default::default()).sources.remove(0)
        };
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = async_tungstenite::tokio::accept_hdr_async(tcp, |request: &async_tungstenite::tungstenite::handshake::server::Request, mut response: async_tungstenite::tungstenite::handshake::server::Response| {
                assert_eq!(request.uri().path(), "/mqtt/custom");
                response.headers_mut().insert("Sec-WebSocket-Protocol", "mqtt".parse().unwrap());
                Ok(response)
            }).await.unwrap();
            let connect = ws.next().await.unwrap().unwrap();
            assert_eq!(connect.into_data()[0] >> 4, 1);
            ws.send(async_tungstenite::tungstenite::Message::Binary(
                vec![0x20, 2, 0, 0].into(),
            ))
            .await
            .unwrap();
        });
        let (client, mut eventloop) = AsyncClient::new(mqtt_options(&source).unwrap(), 32);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(
                    eventloop.poll().await.unwrap(),
                    Event::Incoming(Packet::ConnAck(_))
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        drop(client);
        server.await.unwrap();
    }
}

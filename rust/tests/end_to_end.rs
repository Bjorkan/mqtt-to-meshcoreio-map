//! Exercise the Rust MQTT-to-HTTP exchange with local peers only.
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::time::{Duration, timeout};

async fn mqtt_frame(stream: &mut TcpStream) -> (u8, Vec<u8>) {
    let header = stream.read_u8().await.unwrap();
    let mut length = 0usize;
    let mut multiplier = 1;
    loop {
        let byte = stream.read_u8().await.unwrap();
        length += ((byte & 127) as usize) * multiplier;
        if byte & 128 == 0 {
            break;
        }
        multiplier *= 128;
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    (header, body)
}

async fn publish(stream: &mut TcpStream, topic: &str, body: &[u8]) {
    let mut frame = Vec::new();
    frame.extend_from_slice(&(topic.len() as u16).to_be_bytes());
    frame.extend_from_slice(topic.as_bytes());
    frame.extend_from_slice(body);
    let mut header = vec![0x30];
    let mut length = frame.len();
    loop {
        let mut b = (length % 128) as u8;
        length /= 128;
        if length != 0 {
            b |= 128;
        }
        header.push(b);
        if length == 0 {
            break;
        }
    }
    stream.write_all(&header).await.unwrap();
    stream.write_all(&frame).await.unwrap();
}

async fn exchange(vector: &Value) -> Value {
    let broker = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".env"), format!(
        "SOURCE_MQTT_URL=mqtt://{}\nMESHCOREIO_API_URL=http://{}\nMESHCOREIO_PRIVATE_KEY={}\nLOG_COLOR=false\n",
        broker.local_addr().unwrap(), api.local_addr().unwrap(), "01".repeat(32)
    )).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .current_dir(dir.path())
        .env_remove("SOURCE_MQTT_URL")
        .env_remove("MESHCOREIO_API_URL")
        .env_remove("MESHCOREIO_PRIVATE_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let result = timeout(Duration::from_secs(15), async {
        let (mut mqtt, _) = broker.accept().await.unwrap();
        assert_eq!(mqtt_frame(&mut mqtt).await.0 >> 4, 1);
        mqtt.write_all(&[0x20, 2, 0, 0]).await.unwrap();
        let (header, subscribe) = mqtt_frame(&mut mqtt).await;
        assert_eq!(header >> 4, 8);
        mqtt.write_all(&[0x90, 3, subscribe[0], subscribe[1], 0]).await.unwrap();
        let topic = vector["topic"].as_str().unwrap();
        publish(&mut mqtt, &format!("{topic}/status"), vector["status"].as_str().unwrap().as_bytes()).await;
        let packet = json!({"origin_id":"a1".repeat(32),"raw":vector["packet"],"padding":vector.get("padding")}).to_string();
        publish(&mut mqtt, &format!("{topic}/packets"), packet.as_bytes()).await;
        let (mut http, _) = api.accept().await.unwrap();
        let mut request = Vec::new();
        let (body_start, body_len) = loop {
            let mut chunk = [0; 4096];
            let n = http.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&chunk[..n]);
            if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                let length = headers.lines().find_map(|line| line.strip_prefix("content-length: ")?.trim().parse::<usize>().ok()).unwrap();
                break (end + 4, length);
            }
        };
        while request.len() < body_start + body_len {
            let mut chunk = [0; 4096];
            let n = http.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            request.extend_from_slice(&chunk[..n]);
        }
        let body = serde_json::from_slice(&request[body_start..body_start + body_len]).unwrap();
        http.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{\"code\":\"NODES_INSERTED\"}").await.unwrap();
        body
    }).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    result.expect("local MQTT-to-HTTP exchange timed out")
}

#[tokio::test]
async fn mqtt_to_http_requests_match_reference_vectors() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    let mut cases: Vec<Value> = fixtures
        .into_iter()
        .filter(|v| v["request"].is_object())
        .collect();
    let mut large = cases[0].clone();
    large["name"] = "large-envelope".into();
    large["padding"] = "x".repeat(12_000).into();
    cases.push(large);
    for vector in &cases {
        let request = exchange(vector).await;
        assert_eq!(request, vector["request"], "{}", vector["name"]);
    }
}

#[tokio::test]
async fn rejected_packets_never_reach_http() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    for vector in fixtures.iter().filter(|v| v["request"].is_null()) {
        let broker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            format!(
                "SOURCE_MQTT_URL=mqtt://{}\nMESHCOREIO_API_URL=http://{}\nMESHCOREIO_PRIVATE_KEY={}\nLOG_COLOR=false\n",
                broker.local_addr().unwrap(),
                api.local_addr().unwrap(),
                "01".repeat(32)
            ),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
            .current_dir(dir.path())
            .env_remove("SOURCE_MQTT_URL")
            .env_remove("MESHCOREIO_API_URL")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = timeout(Duration::from_secs(5), async {
            let (mut mqtt, _) = broker.accept().await.unwrap();
            mqtt_frame(&mut mqtt).await;
            mqtt.write_all(&[0x20, 2, 0, 0]).await.unwrap();
            let (_, subscribe) = mqtt_frame(&mut mqtt).await;
            mqtt.write_all(&[0x90, 3, subscribe[0], subscribe[1], 0])
                .await
                .unwrap();
            let topic = vector["topic"].as_str().unwrap();
            publish(
                &mut mqtt,
                &format!("{topic}/status"),
                vector["status"].as_str().unwrap().as_bytes(),
            )
            .await;
            let packet = json!({"origin_id": "a1".repeat(32), "raw": vector["packet"]});
            publish(
                &mut mqtt,
                &format!("{topic}/packets"),
                packet.to_string().as_bytes(),
            )
            .await;
            assert!(
                timeout(Duration::from_millis(300), api.accept())
                    .await
                    .is_err(),
                "{} unexpectedly sent an HTTP request",
                vector["name"]
            );
            // A subsequent valid advert on the same connection must be the
            // first request; a delayed invalid job would change its body.
            let valid = &fixtures[0];
            publish(
                &mut mqtt,
                &format!("{topic}/status"),
                valid["status"].as_str().unwrap().as_bytes(),
            )
            .await;
            let packet = json!({"origin_id": "a1".repeat(32), "raw": valid["packet"]});
            publish(
                &mut mqtt,
                &format!("{topic}/packets"),
                packet.to_string().as_bytes(),
            )
            .await;
            let (mut conn, _) = timeout(Duration::from_secs(2), api.accept())
                .await
                .expect("valid advert did not reach HTTP")
                .unwrap();
            let mut request = Vec::new();
            let (body_start, body_len) = loop {
                let mut chunk = [0; 4096];
                let n = conn.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
                if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                    let length = headers.lines().find_map(|line| line.strip_prefix("content-length: ")?.trim().parse::<usize>().ok()).unwrap();
                    break (end + 4, length);
                }
            };
            while request.len() < body_start + body_len {
                let mut chunk = [0; 4096];
                let n = conn.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
            }
            let body: Value = serde_json::from_slice(&request[body_start..body_start + body_len]).unwrap();
            assert_eq!(body, valid["request"], "{} sent wrong request", vector["name"]);
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 25\r\nConnection: close\r\n\r\n{\"code\":\"NODES_INSERTED\"}").await.unwrap();
            assert!(timeout(Duration::from_millis(100), api.accept()).await.is_err());
        })
        .await;
        let _ = child.start_kill();
        let _ = child.wait().await;
        result.expect("rejected packet check timed out");
    }
}

#[tokio::test]
async fn config_check_never_connects_or_logs_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let secret = "local-test-password";
    std::fs::write(
        dir.path().join(".env"),
        format!(
            "SOURCE_MQTT_URL=mqtt://127.0.0.1:9\nSOURCE_MQTT_PASSWORD={secret}\nLOG_COLOR=false\n"
        ),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .arg("--check-config")
        .current_dir(dir.path())
        .env_remove("SOURCE_MQTT_URL")
        .env_remove("SOURCE_MQTT_PASSWORD")
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("Configuration OK (1 MQTT sources)"));
    assert!(!String::from_utf8_lossy(&result.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&result.stderr).contains(secret));
    std::fs::write(
        dir.path().join(".env"),
        "SOURCE_MQTT_URL=ftp://example.test\n",
    )
    .unwrap();
    let invalid = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .arg("--check-config")
        .current_dir(dir.path())
        .env_remove("SOURCE_MQTT_URL")
        .output()
        .await
        .unwrap();
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("unsupported scheme"));
    std::fs::write(
        dir.path().join(".env"),
        "MESHCOREIO_API_URL=ftp://example.test/private-token\n",
    )
    .unwrap();
    let invalid_api = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .arg("--check-config")
        .current_dir(dir.path())
        .env_remove("MESHCOREIO_API_URL")
        .output()
        .await
        .unwrap();
    assert!(!invalid_api.status.success());
    let error = String::from_utf8_lossy(&invalid_api.stderr);
    assert!(error.contains("expected an HTTP(S) endpoint"));
    assert!(!error.contains("private-token"));
}

#[tokio::test]
async fn invalid_signing_seed_does_not_leak() {
    let dir = tempfile::tempdir().unwrap();
    let secret = "not-a-valid-private-key";
    std::fs::write(
        dir.path().join(".env"),
        format!("MESHCOREIO_PRIVATE_KEY={secret}\nLOG_COLOR=false\n"),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .current_dir(dir.path())
        .env_remove("MESHCOREIO_PRIVATE_KEY")
        .output()
        .await
        .unwrap();
    assert!(!result.status.success());
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(error.contains("MESHCOREIO_PRIVATE_KEY is invalid"));
    assert!(!error.contains(secret));
}

#[tokio::test]
async fn rejected_subscription_is_reported_and_sigterm_stops_cleanly() {
    let broker = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_mqtt-to-meshcoreio-map"))
        .current_dir(dir.path())
        .env(
            "SOURCE_MQTT_URL",
            format!("mqtt://{}", broker.local_addr().unwrap()),
        )
        .env("LOG_COLOR", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let result = timeout(Duration::from_secs(5), async {
        let (mut mqtt, _) = broker.accept().await.unwrap();
        mqtt_frame(&mut mqtt).await;
        mqtt.write_all(&[0x20, 2, 0, 0]).await.unwrap();
        let (_, subscribe) = mqtt_frame(&mut mqtt).await;
        mqtt.write_all(&[0x90, 3, subscribe[0], subscribe[1], 0x80])
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let status = std::process::Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        let output = child.wait_with_output().await.unwrap();
        assert!(output.status.success(), "SIGTERM must exit successfully");
        assert!(String::from_utf8_lossy(&output.stderr).contains("broker rejected subscription"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("Subscribed to"));
    })
    .await;
    result.expect("SIGTERM or broker exchange timed out");
}

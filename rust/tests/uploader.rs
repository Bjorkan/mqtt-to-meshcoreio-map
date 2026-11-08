use mqtt_to_meshcoreio_map::reader::Reader;
use mqtt_to_meshcoreio_map::resolve;
use mqtt_to_meshcoreio_map::uploader::Uploader;
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn sample() -> (mqtt_to_meshcoreio_map::reader::Job, Value) {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/runtime-golden.json")).unwrap();
    let v = &vectors[0];
    let mut reader = Reader::new(&resolve(&Default::default()).map_uploader);
    let topic = v["topic"].as_str().unwrap();
    reader.receive(
        &format!("{topic}/status"),
        v["status"].as_str().unwrap().as_bytes(),
        1_800_000_500_000,
    );
    let packet = json!({"origin_id":"a1".repeat(32), "raw":v["packet"]}).to_string();
    let job = reader
        .receive(
            &format!("{topic}/packets"),
            packet.as_bytes(),
            1_800_000_500_000,
        )
        .unwrap();
    (job, v["request"].clone())
}

#[test]
fn bun_signed_request_matches_byte_for_byte() {
    let (job, expected) = sample();
    let env = HashMap::from([("MESHCOREIO_PRIVATE_KEY".to_owned(), "01".repeat(32))]);
    let uploader = Uploader::new(resolve(&env).map_uploader, &env).unwrap();
    assert_eq!(uploader.signed_request(&job), expected);
    let mut invalid = env;
    invalid.insert(
        "MESHCOREIO_PRIVATE_KEY".into(),
        "invalid-private-seed".into(),
    );
    assert!(Uploader::new(resolve(&invalid).map_uploader, &invalid).is_err());
}

#[tokio::test]
async fn local_http_terminal_retry_and_dry_run() {
    let (job, _) = sample();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let env = HashMap::from([("MESHCOREIO_PRIVATE_KEY".to_owned(), "01".repeat(32))]);
    let mut config = resolve(&env).map_uploader;
    config.api_url = format!("http://{}/upload", listener.local_addr().unwrap());
    let uploader = Uploader::new(config.clone(), &env).unwrap();
    let server = tokio::spawn(async move {
        for (status, body) in [
            (
                "503 Service Unavailable",
                r#"{"code":"ERR_SERVER"}"#.to_owned(),
            ),
            (
                "400 Bad Request",
                r#"{"code":"ERR_ADVERT_DUPLICATE"}"#.to_owned(),
            ),
            (
                "200 OK",
                r#"{"code":"OTHER","message":"line\none"}"#.to_owned(),
            ),
            ("200 OK", "x".repeat(5000)),
        ] {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = conn.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).contains("POST /upload"));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            conn.write_all(response.as_bytes()).await.unwrap();
        }
    });
    assert!(uploader.post(&job).await.unwrap_err().contains("503"));
    assert!(
        uploader
            .post(&job)
            .await
            .unwrap()
            .contains("ERR_ADVERT_DUPLICATE")
    );
    let message = uploader.post(&job).await.unwrap();
    assert!(message.contains(r"line\x0aone"));
    assert!(!message.contains('\n'));
    assert!(
        uploader
            .post(&job)
            .await
            .unwrap_err()
            .contains("size limit")
    );
    server.await.unwrap();
    config.dry_run = true;
    let dry = Uploader::new(config, &env).unwrap();
    assert!(dry.post(&job).await.unwrap().starts_with("Dry run:"));
}

#[tokio::test]
async fn stalled_response_body_times_out() {
    let (job, _) = sample();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = resolve(&Default::default()).map_uploader;
    config.api_url = format!("http://{}/upload", listener.local_addr().unwrap());
    config.request_timeout_ms = 50;
    let uploader = Uploader::new(config, &Default::default()).unwrap();
    let server = tokio::spawn(async move {
        let (mut conn, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = conn.read(&mut buf).await.unwrap();
        conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n")
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    });
    assert_eq!(uploader.post(&job).await.unwrap_err(), "operation aborted");
    server.await.unwrap();
}

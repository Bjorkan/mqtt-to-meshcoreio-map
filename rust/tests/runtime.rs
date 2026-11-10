use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use mqtt_to_meshcoreio_map::reader::Reader;
use mqtt_to_meshcoreio_map::resolve;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Deserialize)]
struct Vector {
    name: String,
    status: String,
    topic: String,
    packet: String,
    request: Option<Value>,
}

#[test]
fn verified_packet_and_request_vectors() {
    let vectors: Vec<Vector> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    let config = resolve(&HashMap::new());
    let signing = SigningKey::from_bytes(&[1; 32]);
    for vector in vectors {
        let mut reader = Reader::new(&config.map_uploader);
        let now = 1_800_000_500_000;
        assert!(
            reader
                .receive(
                    &format!("{}/status", vector.topic),
                    vector.status.as_bytes(),
                    now
                )
                .is_none()
        );
        let message = json!({"origin_id": "a1".repeat(32), "raw": vector.packet}).to_string();
        let job = reader.receive(
            &format!("{}/packets", vector.topic),
            message.as_bytes(),
            now,
        );
        assert_eq!(job.is_some(), vector.request.is_some(), "{}", vector.name);
        if let (Some(job), Some(request)) = (job, vector.request) {
            let encoded =
                json!({"params": job.radio, "links": [format!("meshcore://{}", job.raw_hex)]})
                    .to_string();
            assert_eq!(
                encoded,
                request["data"].as_str().unwrap(),
                "{} exact signed bytes",
                vector.name
            );
            let signed = signing.sign(&Sha256::digest(encoded.as_bytes()));
            assert_eq!(
                hex::encode(signed.to_bytes()),
                request["signature"],
                "{} signature",
                vector.name
            );
            let data: Value = serde_json::from_str(request["data"].as_str().unwrap()).unwrap();
            for (field, expected) in [
                ("freq", job.radio.freq),
                ("bw", job.radio.bw),
                ("sf", job.radio.sf),
                ("cr", job.radio.cr),
            ] {
                assert_eq!(
                    data["params"][field].as_f64(),
                    Some(expected),
                    "{}: {field}",
                    vector.name
                );
            }
            assert_eq!(
                data["links"][0],
                format!("meshcore://{}", job.raw_hex),
                "{}",
                vector.name
            );
            assert_eq!(
                request["publicKey"],
                hex::encode(signing.verifying_key().to_bytes())
            );
            let signature = Signature::from_slice(
                &hex::decode(request["signature"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            signing
                .verifying_key()
                .verify(
                    &Sha256::digest(request["data"].as_str().unwrap().as_bytes()),
                    &signature,
                )
                .unwrap();
        }
    }
}

#[test]
fn prefixed_numeric_status_fields_allow_verified_adverts() {
    let vectors: Vec<Vector> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    let packet = &vectors[0].packet;
    let config = resolve(&HashMap::new());
    let cases = [
        ("0x36A", "0b1111101", "0o10", "0X8"),
        ("0B1101101010", "0O175", "0x8", "8"),
    ];
    for (freq, bw, sf, cr) in cases {
        let mut reader = Reader::new(&config.map_uploader);
        let status = json!({"origin_id": "a1".repeat(32), "params": {
            "freq": freq, "bw": bw, "sf": sf, "cr": cr
        }});
        let topic = format!("meshcore/STO/{}/status", "a1".repeat(32));
        assert!(
            reader
                .receive(&topic, status.to_string().as_bytes(), 1_800_000_500_000)
                .is_none()
        );
        let advert = json!({"origin_id": "a1".repeat(32), "raw": packet});
        let job = reader
            .receive(
                &topic.replace("/status", "/packets"),
                advert.to_string().as_bytes(),
                1_800_000_500_000,
            )
            .expect("prefixed radio fields should allow an advert");
        assert_eq!(
            (job.radio.freq, job.radio.bw, job.radio.sf, job.radio.cr),
            (874.0, 125.0, 8.0, 8.0)
        );
    }
}

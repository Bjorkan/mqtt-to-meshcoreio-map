use mqtt_to_meshcoreio_map::protocol::{AdvertKind, parse_verified_advert};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    name: String,
    hex: String,
    expected: Option<Expected>,
}
#[derive(Deserialize)]
struct Expected {
    public_key: String,
    timestamp: i64,
    name: String,
    kind: String,
}

#[test]
fn reference_protocol_vectors() {
    let vectors: Vec<Vector> =
        serde_json::from_str(include_str!("fixtures/protocol-golden.json")).unwrap();
    for vector in vectors {
        let packet = hex::decode(&vector.hex).unwrap();
        let result = parse_verified_advert(&packet);
        assert_eq!(
            result.is_some(),
            vector.expected.is_some(),
            "{}",
            vector.name
        );
        if let (Some(advert), Some(expected)) = (result, vector.expected) {
            assert_eq!(
                advert.kind,
                match expected.kind.as_str() {
                    "REPEATER" => AdvertKind::Repeater,
                    "ROOM" => AdvertKind::Room,
                    "SENSOR" => AdvertKind::Sensor,
                    _ => panic!("unexpected fixture"),
                }
            );
            assert_eq!(advert.name, expected.name);
            assert_eq!(advert.timestamp, expected.timestamp);
            assert_eq!(advert.public_key, expected.public_key);
            for truncated in 0..packet.len() {
                assert!(
                    parse_verified_advert(&packet[..truncated]).is_none(),
                    "{} truncated to {truncated}",
                    vector.name
                );
            }
            let mut broken = packet.clone();
            broken[0] = 0;
            assert!(parse_verified_advert(&broken).is_none());
            let last = broken.len() - 1;
            broken = packet;
            broken[last] ^= 1;
            assert!(parse_verified_advert(&broken).is_none());
        }
    }
}

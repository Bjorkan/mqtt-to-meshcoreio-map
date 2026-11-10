use mqtt_to_meshcoreio_map::queue::{Admission, RetryOutcome, UploadQueue};
use mqtt_to_meshcoreio_map::reader::{Job, Reader};
use mqtt_to_meshcoreio_map::resolve;
use serde_json::{Value, json};

fn job() -> Job {
    let vector: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    let input = &vector[0];
    let mut reader = Reader::new(&resolve(&Default::default()).map_uploader);
    let topic = input["topic"].as_str().unwrap();
    let now = 1_800_000_500_000;
    reader.receive(
        &format!("{topic}/status"),
        input["status"].as_str().unwrap().as_bytes(),
        now,
    );
    reader
        .receive(
            &format!("{topic}/packets"),
            json!({"origin_id":"a1".repeat(32),"raw":input["packet"]})
                .to_string()
                .as_bytes(),
            now,
        )
        .unwrap()
}

#[test]
fn waiting_capacity_excludes_active_and_retries_go_to_back() {
    let mut queue = UploadQueue::new(1);
    let first = job();
    let mut second = first.clone();
    second.node_key = "another-node".into();
    second.advert_key = "another-node:1".into();
    assert_eq!(queue.admit(first.clone()), Admission::Accepted);
    let active = queue.begin().unwrap();
    assert!(queue.begin().is_none(), "only one upload may be active");
    assert_eq!(queue.admit(first.clone()), Admission::Duplicate);
    assert_eq!(queue.admit(second.clone()), Admission::Accepted);
    let mut third = first.clone();
    third.node_key = "third-node".into();
    third.advert_key = "third-node:1".into();
    assert_eq!(queue.admit(third), Admission::Full);
    assert_eq!(queue.retry(active.clone()), RetryOutcome::Full);
    assert_eq!(queue.retry(active), RetryOutcome::NotActive);
    let waiting = queue.begin().unwrap();
    assert_eq!(waiting.node_key, second.node_key);
    assert_eq!(queue.retry(waiting.clone()), RetryOutcome::Queued);
    let retry = queue.begin().unwrap();
    assert_eq!(retry.node_key, second.node_key);
    assert_eq!(queue.retry(retry.clone()), RetryOutcome::Queued);
    let retry = queue.begin().unwrap();
    assert_eq!(queue.retry(retry), RetryOutcome::Exhausted);
    assert_eq!(queue.waiting_len(), 0);
}

#[test]
fn retry_returns_to_back_of_waiting_jobs() {
    let mut queue = UploadQueue::new(2);
    let first = job();
    let mut second = first.clone();
    second.node_key = "other".into();
    second.advert_key = "other:1".into();
    assert_eq!(queue.admit(first.clone()), Admission::Accepted);
    let active = queue.begin().unwrap();
    assert_eq!(queue.admit(second.clone()), Admission::Accepted);
    assert!(
        !queue.finish(&second),
        "queued work must not release active state"
    );
    let stale = active.clone();
    assert_eq!(queue.retry(active), RetryOutcome::Queued);
    let next = queue.begin().unwrap();
    assert_eq!(next.node_key, second.node_key);
    assert!(queue.finish(&next));
    let retry = queue.begin().unwrap();
    assert_eq!(retry.node_key, first.node_key);
    assert!(!queue.finish(&stale));
    assert_eq!(queue.retry(stale), RetryOutcome::NotActive);
    assert!(queue.finish(&retry));
}

#[test]
fn a_full_queue_does_not_start_advert_cooldown() {
    let vector: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/runtime-golden.json")).unwrap();
    let input = &vector[0];
    let topic = input["topic"].as_str().unwrap();
    let mut reader = Reader::new(&resolve(&Default::default()).map_uploader);
    let now = 1_800_000_500_000;
    reader.receive(
        &format!("{topic}/status"),
        input["status"].as_str().unwrap().as_bytes(),
        now,
    );
    let packet = json!({"origin_id":"a1".repeat(32),"raw":input["packet"]}).to_string();
    let mut queue = UploadQueue::new(1);
    let mut filler = job();
    filler.node_key = "unrelated".into();
    assert_eq!(queue.admit(filler), Admission::Accepted);
    let rejected = reader
        .receive(&format!("{topic}/packets"), packet.as_bytes(), now)
        .unwrap();
    assert_eq!(queue.admit(rejected), Admission::Full);
    let filler = queue.begin().unwrap();
    queue.finish(&filler);
    let accepted = reader
        .receive(&format!("{topic}/packets"), packet.as_bytes(), now)
        .unwrap();
    assert_eq!(queue.admit(accepted.clone()), Admission::Accepted);
    reader.admitted(&accepted, now);
    assert!(
        reader
            .receive(&format!("{topic}/packets"), packet.as_bytes(), now)
            .is_none()
    );
}

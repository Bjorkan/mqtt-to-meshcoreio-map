use mqtt_to_meshcoreio_map::{log_color, read_environment, resolve, signing_public_key, time_zone};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    name: String,
    env: HashMap<String, String>,
    resolved: serde_json::Value,
    signing_public_key: Option<String>,
    signing_error: Option<String>,
    log_color: bool,
    time_zone: Option<String>,
}

#[test]
fn matches_original_typescript_resolver() {
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../../tests/config-golden.json")).unwrap();
    for fixture in fixtures {
        assert_eq!(
            serde_json::to_value(resolve(&fixture.env)).unwrap(),
            fixture.resolved,
            "{}",
            fixture.name
        );
        assert_eq!(
            signing_public_key(&fixture.env).map_err(str::to_owned),
            fixture
                .signing_error
                .map(Err)
                .unwrap_or_else(|| Ok(fixture.signing_public_key)),
            "{}",
            fixture.name
        );
        assert_eq!(
            log_color(&fixture.env),
            fixture.log_color,
            "{}",
            fixture.name
        );
        assert_eq!(
            time_zone(&fixture.env),
            fixture.time_zone.as_deref(),
            "{}",
            fixture.name
        );
    }
}

#[test]
fn dotenv_is_automatic_and_process_environment_wins() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".env"),
        "PATH=dotenv-path\nSOURCE_MQTT_URL=$PATH\nLOG_COLOR=false\n",
    )
    .unwrap();
    let env = read_environment(dir.path());
    assert_eq!(resolve(&env).source_url, std::env::var("PATH").unwrap());
    assert_eq!(env.get("PATH"), std::env::var("PATH").ok().as_ref());
    assert!(!log_color(&env));
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(resolve(&read_environment(empty.path())).sources.len(), 1);
}

#[test]
fn dotenv_parses_existing_example_and_compose_override() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::copy("../.env.example", dir.path().join(".env")).unwrap();
    let mut env = read_environment(dir.path());
    // compose.yaml.example uses env_file: .env and environment: LOG_COLOR=false.
    env.insert("LOG_COLOR".into(), "false".into());
    assert_eq!(resolve(&env).map_uploader.request_timeout_ms, 10000);
    assert_eq!(resolve(&env).sources[0].url, "mqtt://localhost:1883");
    assert!(!log_color(&env));
}

#[test]
fn dotenv_preserves_bun_quote_comment_and_expansion_behavior() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".env"),
        "SOURCE_1_MQTT_URL=mqtt://broker\nSOURCE_1_NAME=\"quoted # name\"\nSOURCE_1_MQTT_PASSWORD=hello # comment\nSOURCE_1_TOPIC_FILTER=$SOURCE_1_NAME\n",
    )
    .unwrap();
    let env = read_environment(dir.path());
    assert_eq!(env.get("SOURCE_1_NAME").unwrap(), "quoted # name");
    assert_eq!(env.get("SOURCE_1_MQTT_PASSWORD").unwrap(), "hello");
    assert_eq!(env.get("SOURCE_1_TOPIC_FILTER").unwrap(), "quoted # name");
}

#[test]
fn bun_environment_files_keep_mode_and_local_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let mode = std::env::var("NODE_ENV").unwrap_or_else(|_| "development".into());
    std::fs::write(dir.path().join(".env"), "SOURCE_MQTT_URL=mqtt://base\n").unwrap();
    std::fs::write(
        dir.path().join(format!(".env.{mode}")),
        "SOURCE_MQTT_URL=mqtt://mode\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(".env.local"),
        "SOURCE_MQTT_URL=mqtt://local\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(format!(".env.{mode}.local")),
        "SOURCE_MQTT_URL=mqtt://mode-local\n",
    )
    .unwrap();
    // A process-provided SOURCE_MQTT_URL remains authoritative.
    let expected = std::env::var("SOURCE_MQTT_URL").unwrap_or_else(|_| "mqtt://mode-local".into());
    assert_eq!(resolve(&read_environment(dir.path())).source_url, expected);
}

// Only compares configuration in memory: never starts MQTT, posts data, or
// prints environment values (including credentials and signing seeds).
fn compare_deployment(directory: &std::path::Path) {
    assert!(
        directory.join(".env").is_file(),
        "production .env not found"
    );
    assert!(
        directory.join("compose.yaml").is_file(),
        "production compose.yaml not found"
    );
    let index = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/index.ts");
    let script = format!(
        "import {{ loadConfig }} from {}; console.log(JSON.stringify(loadConfig()));",
        serde_json::to_string(&index.to_string_lossy()).unwrap()
    );
    let compare = |overrides: &HashMap<String, String>| {
        let mut env = read_environment(directory);
        env.extend(overrides.clone());
        let config = serde_json::to_value(resolve(&env)).unwrap();
        let bun = std::process::Command::new("bun")
            .arg("-e")
            .arg(&script)
            .current_dir(directory)
            .envs(overrides)
            .output()
            .unwrap();
        assert!(
            bun.status.success(),
            "Bun could not resolve production configuration"
        );
        let baseline: serde_json::Value =
            serde_json::from_slice(&bun.stdout).expect("Bun did not output JSON");
        assert!(
            config == baseline,
            "production configuration differs (values withheld to protect credentials)"
        );
    };
    compare(&HashMap::new());
    let compose = std::process::Command::new("docker")
        .args([
            "compose",
            "-f",
            "compose.yaml",
            "config",
            "--format",
            "json",
        ])
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        compose.status.success(),
        "could not resolve existing production Compose configuration"
    );
    let parsed: serde_json::Value =
        serde_json::from_slice(&compose.stdout).expect("Compose did not output JSON");
    let container_env: HashMap<String, String> =
        parsed["services"]["mqtt-to-meshcoreio-map"]["environment"]
            .as_object()
            .expect("Compose service environment not found")
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_owned())))
            .collect();
    compare(&container_env);
}

#[test]
fn unmodified_example_deployment_matches_bun() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy("../.env.example", directory.path().join(".env")).unwrap();
    std::fs::copy(
        "../compose.yaml.example",
        directory.path().join("compose.yaml"),
    )
    .unwrap();
    compare_deployment(directory.path());
}

// Run with PRODUCTION_ENV_DIR=/path/to/deployment and
// cargo test --manifest-path rust/Cargo.toml --test golden -- --ignored.
#[test]
#[ignore = "requires the operator's existing production .env directory"]
fn unmodified_production_env_matches_bun() {
    let directory = std::path::PathBuf::from(
        std::env::var("PRODUCTION_ENV_DIR").expect("set PRODUCTION_ENV_DIR"),
    );
    compare_deployment(&directory);
}

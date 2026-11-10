use mqtt_to_meshcoreio_map::{read_environment, resolve, service};

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !args.is_empty() && (args.len() != 1 || args[0] != "--check-config") {
        eprintln!("Usage: mqtt-to-meshcoreio-map [--check-config]");
        std::process::exit(2);
    }
    let env = read_environment(&std::env::current_dir().expect("current directory"));
    let config = resolve(&env);
    if !args.is_empty() {
        if let Err(error) = service::check_config(&config, &env) {
            service::log(&env, &format!("Invalid configuration: {error}"), true);
            std::process::exit(1);
        }
        println!("Configuration OK ({} MQTT sources).", config.sources.len());
        return;
    }
    if let Err(error) = service::run(config, env.clone()).await {
        service::log(&env, &format!("Could not start service: {error}"), true);
        std::process::exit(1);
    }
}

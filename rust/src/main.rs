use mqtt_to_meshcoreio_map::{read_environment, resolve, service};

#[tokio::main]
async fn main() {
    let env = read_environment(&std::env::current_dir().expect("current directory"));
    let config = resolve(&env);
    if let Err(error) = service::run(config, env.clone()).await {
        service::log(&env, &format!("Could not start service: {error}"), true);
        std::process::exit(1);
    }
}

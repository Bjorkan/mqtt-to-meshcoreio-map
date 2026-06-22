# Agent Notes

This file is for future coding agents working on this repository.

## Project Purpose

This project is an MQTT to MeshCore.io Map bridge. It listens to MeshCore observer messages from an MQTT broker, keeps the latest valid observer radio status, verifies MeshCore adverts, and uploads accepted `REPEATER`, `ROOM`, and `SENSOR` adverts to the MeshCore.io map.

Keep documentation, comments, tests, commit messages, and user-facing project text in English.

## Useful Local Commands

```bash
npm test
docker build -t mqtt-to-meshcoreio-map .
```

Run both before publishing meaningful runtime changes.

## Important References

- [recrof/map.meshcore.io-uploader](https://github.com/recrof/map.meshcore.io-uploader)

  Map uploader from the MeshCore.io map developer. It is aimed at a setup where someone has a MeshCore companion connected over USB, so the runtime model is different from this MQTT bridge. The MeshCore.io API usage, request signing, and accepted upload shape can still be useful reference material.

- [agessaman/MeshCore mqtt-bridge-implementation-flex branch](https://github.com/agessaman/MeshCore/tree/mqtt-bridge-implementation-flex)

  This branch contains MQTT observer firmware for nodes reporting to MQTT servers. It is useful when checking how MQTT observer status and packet messages will probably be formatted in real deployments.

## Documentation Split

- `README.md` should stay focused on project overview, deployment, configuration, and quick development commands.
- `TECHNICAL.md` should hold under-the-hood details such as MQTT message contracts, MeshCore.io request format, signing behavior, and conversion flow.

## Runtime Notes

## Reviewer

There is a `critical-reviewer` subagent at `.opencode/agents/critical-reviewer.md`.
Invoke it before every commit to catch bugs, type errors, and logic flaws.

- Do not log private keys or unredacted MQTT credentials.
- The upload identity is generated fresh at startup. Logging the public key is expected; logging the private key is not.
- The observer cache should keep only the latest valid radio status per observer and drop status older than 24 hours.
- Upload concurrency and queue behavior are deliberately bounded. Avoid changes that can create unbounded parallel verification or HTTP uploads.

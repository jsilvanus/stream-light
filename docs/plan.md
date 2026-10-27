# stream-light API-first control plan

## Goal

Give every physical light an independent, documented control API and a CLI generated from OpenAPI. Keep physical outputs, automatic status sources and runtime overrides separate.

Use cases:
- **ATEM tally:** program/preview status for an individual camera.
- **YouTube live status:** starting, live, degraded, stopped or unknown.
- **Encoder status:** streaming, recording, idle or error, including Matrox Monarch where its API exposes the needed status.

These are source choices per light, not global application modes. Each configured light has its own stable ID, source and output.

## Design decisions

- **Independent identity:** every light has a stable, unique ID; operations target exactly one ID.
- **Control modes:** auto follows its configured source; manual applies an explicit colour/effect to that light only.
- **Override lifetime:** manual overrides are runtime-only in the first version and are lost on process restart. Source polling continues during manual mode, but does not replace the manual output.
- **Restore automatic mode:** POST /lights/{lightId}/auto releases the override and applies the latest fresh source reading. If the reading is missing or stale, use the configured UNKNOWN look.
- **Colour input:** accept #RRGGBB or RGB channels, each an integer from 0 through 255.
- **Effects:** initially define steady and blink. The output driver must report capabilities; do not claim arbitrary colours/effects are supported by TALLY-MA until verified on real hardware.
- **Honest errors:** malformed input returns 400, unknown light IDs return 404, unsupported output capabilities return 422, and output failures return 503.
- **Protocol boundary:** TALLY-MA protocol details remain inside its output driver. API handlers must not send UDP packets directly.
- **Local-first security:** control API defaults to 127.0.0.1:8787. Do not expose unauthenticated mutating endpoints on a LAN; external binding requires an explicit security decision.
- **Embeddable core:** stream-light is also used by LCYT. Keep HTTP/server assumptions out of core modules and avoid breaking its existing library API.
- **API as source of truth:** openapi.yaml defines routes, operations, schemas and documented errors. Generate the CLI from this contract rather than maintaining a second handwritten client.

## API contract

The initial OpenAPI 3.1 contract defines:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /health | Service readiness |
| GET | /lights | List configured lights |
| GET | /lights/{lightId} | Inspect one light |
| PUT | /lights/{lightId}/color | Apply a solid colour and enter manual mode |
| PUT | /lights/{lightId}/effect | Apply a supported effect and colour |
| POST | /lights/{lightId}/auto | Release manual override and resume source control |

The response model includes the light ID/name, core kind, control mode, effective state, source configuration and output configuration/capabilities. Source type is distinct from core state kind so future sources such as Matrox Monarch do not require a new global mode.

The existing read-only status board must remain functional. It may be extended to show manual mode and effective output settings.

## Phases and acceptance criteria

### Phase 1 — Plan and contract
- Maintain this plan and openapi.yaml.
- Validate OpenAPI in CI and on pull requests.
- Define stable IDs, request/response schemas, error responses, loopback default and runtime-only override semantics.
- **Acceptance:** OpenAPI validation passes and the contract is the reference for future implementation and CLI generation.

### Phase 2 — Runtime control model
- Add per-light auto/manual mode and explicit effective output settings.
- Keep source readings separate from manual overrides.
- Preserve existing source freshness checks, TTL handling and UNKNOWN fail-safe.
- Test light isolation, mode transitions, invalid values, restart semantics and unsupported capabilities.
- **Acceptance:** tests prove manual control of one light cannot affect another, and auto mode resumes safely.

### Phase 3 — HTTP API
- Implement the contract endpoints using the core control model and output capabilities.
- Add request validation, consistent error bodies and HTTP integration tests.
- Keep the status board and current source behaviour working.
- **Acceptance:** endpoint tests match OpenAPI and no mutating endpoint is exposed beyond loopback by default.

### Phase 4 — Generated CLI
- Select and pin a Node-compatible OpenAPI CLI/client generator.
- Generate list/status, hex/RGB colour, effect and auto commands from the contract.
- Add CLI smoke tests, JSON output and Windows PowerShell examples.
- **Acceptance:** the generated CLI can exercise every implemented operation without a separate handwritten API client.

### Phase 5 — Source integrations
- Preserve existing YouTube and ATEM integration paths.
- Add or complete Matrox Monarch status using @jsilvanus/matrox-monarch-control where suitable.
- Keep source-specific state mapping separate from output drivers.
- **Acceptance:** source mappings and failure handling are documented and tested; no real-service integration is called verified without evidence.

### Phase 6 — TALLY-MA hardware validation
- Test Wi-Fi/network reachability and the real device protocol.
- Verify supported colours/effects, reconnect behaviour, manual/auto transitions and stale-source handling.
- Test alongside the production ATEM/encoder where possible.
- **Acceptance:** hardware claims are backed by real-device tests or explicitly labelled manual test results; simulation alone is insufficient.

### Phase 7 — Production readiness
- Run all tests, validate OpenAPI and verify CLI generation is reproducible.
- Review dependencies and security boundaries.
- Document install, configuration, operation and troubleshooting.
- **Acceptance:** CI is green and documented setup is repeatable.

## Testing strategy

1. Unit tests for colour validation, state mapping and mode transitions.
2. Core integration tests for light isolation, source freshness, override and restoration.
3. HTTP contract tests for success/error responses and local-only defaults.
4. CLI tests for generated commands, exit codes and JSON output.
5. Simulated-device tests for output protocol and failure handling.
6. Physical TALLY-MA tests and real ATEM/YouTube/encoder checks.

Clearly distinguish automated tests, simulations and hardware validation.

## Scope boundaries

The first version does not require a GUI, database-backed configuration, cloud service or multi-user administration. Keep the implementation incremental and preserve existing integrations. Do not introduce a production dependency on a remote service just to control local lights.

## Immediate next steps

1. Complete Phase 1 contract validation in CI.
2. Inspect current core/config/output APIs and tests before implementation.
3. Implement the runtime control model with unit tests.
4. Implement the HTTP API and contract tests.
5. Generate the CLI from the validated OpenAPI specification.
6. Test locally on Windows before production deployment.
7. Verify the real TALLY-MA lights before claiming device compatibility.

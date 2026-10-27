# stream-light API-first control plan

## Goal
Give every physical light an independent, documented control API and a CLI generated from OpenAPI. Keep the physical output, automatic status source, and runtime override separate.

## Design decisions
- Stable light IDs are used for every operation; a command affects only the selected light.
- Each light has a runtime mode: `auto` or `manual`.
- Manual colour/effect commands override the output for that light only. Automatic source polling continues but cannot overwrite a manual override.
- Returning to `auto` reapplies the latest fresh source reading; without a fresh reading, the configured UNKNOWN look is used.
- Accept `#RRGGBB` or RGB channels (each 0–255). Initial effects: steady and blink.
- Keep TALLY-MA protocol details in the output driver. The API calls a driver capability rather than sending UDP packets directly.
- Control API binds to loopback by default. Do not expose unauthenticated mutating endpoints on the LAN.
- Preserve the package's embeddable core: this repo is vendored by LCYT, so keep HTTP/server assumptions out of core modules.

## Phases
1. **Contract and plan:** commit this plan and OpenAPI 3.1 contract; define IDs, request/response schemas, errors, and local-only default.
2. **Runtime control model:** add per-light auto/manual state and output capabilities for colour/blink; preserve source readings, TTL and UNKNOWN fail-safe. Test isolation, transitions and invalid input.
3. **HTTP API:** implement health, light list/detail, manual colour/effect, and restore-auto endpoints from the contract. Keep the existing read-only status board working; add HTTP contract tests.
4. **Generated CLI:** select and pin a Node-compatible OpenAPI CLI generator; generate commands for list/status, hex/RGB colour, effect, auto, and config inspection. Add smoke tests and PowerShell examples.
5. **Sources and real-device validation:** add Matrox Monarch status as a separate source using `@jsilvanus/matrox-monarch-control`; test TALLY-MA, ATEM and YouTube against real hardware/accounts before claiming them verified.

## Acceptance criteria
- OpenAPI is the source of truth for API routes and generated CLI operations.
- Any one light can be set to a chosen colour/effect without changing another light.
- Manual override remains active until explicitly released; auto mode reapplies a fresh reading.
- Invalid IDs, colours, effects and requests return documented errors.
- Existing tally behaviour and TTL-to-UNKNOWN fail-safe remain tested.
- CI is green before a phase is declared complete.

## First implementation slice
After the contract is reviewed, implement manual output control plus colour/effect endpoints and tests. Generate the CLI only after those semantics are covered by tests.

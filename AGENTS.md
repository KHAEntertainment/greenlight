# AGENTS.md

Maintainer rules for this repository.

## Layout

- This repository (`KHAEntertainment/pi-jev2`) is the canonical source for the `@khaentertainment/pi-jev2` package, a fork of `y0usaf/pi-jev`.
- `docs/SESSION-NOTES.md` is the running handoff log: decisions, what is verified, what is not. Read it before resuming work and append to it when you stop.

## Code

- Runtime dependencies stay at zero. Classification goes through the host's `ctx.modelRegistry.classify` (pi 0.99 or later); escalation transports use `fetch` or `pi.exec`. Do not add a client library.
- Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) belong in `peerDependencies` with a `"*"` range and must not be bundled. The same packages may be pinned in `devDependencies` for typechecking and tests.
- The gate fails open by design. Do not change an error path to block a tool call.
- Escalation fails open too: an orchestrator that does not answer (unreachable, timeout, cancel, unparseable reply) falls back to the `enforce` rule. It never resolves to a deny of its own.
- Traycer escalation is block-then-retry (`deferredDecision` in `src/index.ts`), because Traycer delivers a reply only after the agent's turn ends. The block while waiting is not a decision: a retry after the timeout still falls back to the `enforce` rule. A decision applies once, to the exact call it was asked about.
- A project `.pi/pi-jev.json` is untrusted: it may tighten the gate, never loosen it, and may not set credentials or escalation destinations (`restrictProject` in `src/config.ts`). A new config key needs a decision on which side it falls.
- Escalation requests are scrubbed of credentials (`scrubSecrets` in `src/escalation.ts`) before any transport sees them. Keep it that way for new request fields. Redact only values proven inert; when a credential is mixed with code, keep the decision local rather than masking around it.
- The one exception to failing open: a flagged call whose escalation request is unsafe to send (`UNSAFE` in `src/index.ts`) blocks when headless. That is not an outage. The agent writes the call, and failing open would let it opt out of the orchestrator.
- Shadow mode is the default. Any change that makes enforcement or escalation implicit needs justifying in `docs/REFERENCE.md` (and, where users notice it, the README).
- A threshold change belongs with a measurement in the `## Calibration` table in `docs/REFERENCE.md`, not with a guess. That applies per classifier: thresholds measured on Jev do not transfer to another model without its own rows (`npm run calibrate`).
- Before pushing: `npm run typecheck`, `npm run lint`, `npm test`.

## Publishing

- A GitHub release publishes from `.github/workflows/publish.yml` using trusted publishing (OIDC), so the repo holds no npm token and no OTP is involved.
- The one-time setup is done (2026-10-20): the scope exists, `0.4.0` was bootstrapped by hand, the trusted publisher is saved with npm publish allowed and dist-tag not allowed, and publishing access requires 2FA and disallows tokens. State and the release steps are in `PUBLISHING.md`.
- Never publish by hand again or add an npm token to the repo or workflow. A release goes through a version bump, a merge, and a GitHub release.
- The package name is scoped (`@khaentertainment/pi-jev2`) so it can sit next to the upstream `@y0usaf/pi-jev` without a name clash.

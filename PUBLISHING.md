# Publishing

## State, verified 2026-10-20

`@khaentertainment/pi-jev2` publishes from `KHAEntertainment/pi-jev2` through
trusted publishing (OIDC), with no npm token in the repository or the workflow.

| Step | State |
|---|---|
| `@khaentertainment` scope | Exists: an npm organization owned by `bbrenner2217`. |
| Bootstrap publish | Done: `0.4.0` was published by hand on 2026-10-20 from `main` at `a2050d7`, by `bbrenner2217` with passkey 2FA (`auth-and-writes`). It has no provenance attestation, because it did not come from the workflow. |
| Trusted publisher | Saved on the package's settings page: user `KHAEntertainment`, repository `pi-jev2`, workflow `publish.yml`, environment empty. **Allow npm publish** is on; **allow npm dist-tag** is off. |
| Publishing access | "Require two-factor authentication and disallow tokens" (set by the owner 2026-10-20). The trusted publisher is the only way in without a passkey. |

Notes:

- The first publish was refused (`E403 Two-factor authentication … is
  required`) until 2FA was turned on for the account. A granular token with
  "bypass 2FA" was not used; see the history below.
- The registry also lists `0.0.0-stage`. npm created it as a "temporary package
  placeholder for staged publishing" when it registered the package name. It is
  2 files, not tagged, and nothing installs it by default. Leave it alone.
- The registry returned 404 for the package metadata for about 2 minutes after
  the publish; the package already showed in `npm access list packages
  @khaentertainment`. Wait before concluding a publish failed.
- `npm dist-tag` is off because the workflow never runs it: `npm publish` sets
  `latest` by itself. Turn it on only if the workflow starts moving tags such
  as `next`.

## Releasing

1. Bump `version` in `package.json` past the last published version (next:
   `0.4.1` or later; `0.4.0` is taken), merge to `main`.
2. Publish a GitHub release for that commit. `.github/workflows/publish.yml`
   runs on `release: published`, exchanges its OIDC token, and runs
   `npm publish --access public` with provenance.
3. If the publish step fails, read the `Preflight - OIDC trusted-publishing
   check` step: it prints the registry's own answer, which `npm publish` hides.
   A dry run is available from the Actions tab (`workflow_dispatch`, dry-run on).

## Upstream history

The history below is upstream's, kept for the method. When following it, read
`@y0usaf/pi-jev` as `@khaentertainment/pi-jev2` and `y0usaf`/`pi-jev` as
`KHAEntertainment`/`pi-jev2`.

npm has one durable route left for this package: trusted publishing (OIDC) from
`.github/workflows/publish.yml`. Classic tokens were revoked in November 2025,
TOTP 2FA is retired, and tokens that bypass 2FA are now restricted for direct
publishing — so "publish locally with a bypass token" is not a fallback, it is a
dead end. (The token still in `~/.npmrc` answers `401 Unauthorized`.)

### Upstream state, verified 2026-09-19

- **The trusted publisher is not configured.** A hand-run OIDC exchange for
  `@y0usaf/pi-jev` returns `OIDC token exchange error - package not found`, and
  `npm publish` from the workflow falls back to token lookup and fails with:

  ```
  npm error code ENEEDAUTH
  npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
  ```

- npm cannot explain itself here: every trusted-publishing failure — missing
  config, mismatched workflow filename, too-old CLI — collapses into that same
  message (npm/cli#9088). The `Preflight - OIDC trusted-publishing check` step in
  the workflow does the exchange by hand instead and prints the registry's own
  answer. Keep it.
- The workflow itself is correct: GitHub-hosted runner, `id-token: write`, Node 24
  (npm 11.19), no `registry-url` and no `NODE_AUTH_TOKEN`, so nothing shadows the
  OIDC token. `package.json`'s `repository.url` matches the GitHub repo.
- Versions 0.1.0 and 0.2.0 were published by hand and carry no provenance
  attestation — visible in the registry as two signature entries and no
  `dist.attestations`. The 0.2.0 release run failed with `E404`; the workflow was
  rewritten the next day but has only ever been exercised as a dry run.

### The one-time setup, and who can do it

npmjs.com -> package `@y0usaf/pi-jev` -> Settings -> Trusted Publisher -> GitHub
Actions:

| Field | Value |
|---|---|
| Organization or user | `y0usaf` |
| Repository | `pi-jev` |
| Workflow filename | `publish.yml` |
| Environment | (empty) |
| Allowed actions | allow `npm publish` (not stage-only) |

Adding it requires an interactive 2FA challenge on npmjs.com
(`POST /-/package/{package}/trust`), so it needs a **passkey or hardware key** on
the account. It cannot be done by a token, a script, or a CI job — this is the one
step a human has to take. While you are there, set Publishing access to
"Require two-factor authentication and disallow tokens"; the trusted publisher is
then the only way in.

After that, a GitHub release publishes with provenance and no stored secret, and
nothing expires.

# Releasing

`@noukai/agent` is released on its **own** version line. Unlike `@noukai/sdk`
and `noukai-sdk` (which stay in lockstep via `check_parity.py`), this package is
**not** part of the two-SDK parity gate — bump it independently.

1. Update `package.json` `version` and `CHANGELOG.md` (move `[Unreleased]`
   content under a dated heading).
2. Verify the build is publish-ready:
   ```bash
   pnpm install
   pnpm build && pnpm check-types && pnpm test && pnpm lint
   pnpm pack --dry-run   # confirm the tarball is dist/ + README + LICENSE + CHANGELOG only
   ```
3. Commit + push to `main`.
4. Tag: `git tag v0.1.0 && git push origin v0.1.0`.
5. Publish to npm:
   ```bash
   pnpm publish --access public
   # (publishConfig.access is already "public"; the flag is belt-and-suspenders)
   ```
6. Verify on https://www.npmjs.com/package/@noukai/agent

## Prerequisites

- `@noukai` npm scope owned + maintainer permissions granted.
- Logged in: `npm whoami` (or `npm login`), or an `NPM_TOKEN` in CI.
- If publishing via CI + npm OIDC trusted publisher: configure at
  https://www.npmjs.com/settings/noukai/trustedpublishers

## Consumer cutover (gated on the first publish)

Both web apps (noukai + nouko) currently `link:` the in-monorepo copy at
`development/sdk/agent`. That copy stays in place until this package is
published; then flip each consumer's `"@noukai/agent": "link:…"` to a semver
range (`"^0.1.0"`) and delete the monorepo copy. See design log
`20260903-SDK-agent-relay` (PR-3) for the full migration.

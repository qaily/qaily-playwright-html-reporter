# Releasing

Versions follow [semantic versioning](https://semver.org): a bug fix bumps the patch (1.0.1), a new feature the minor
(1.1.0), a breaking change the major (2.0.0). Betas (`1.0.0-beta.N`) are published under the npm `beta` tag, so
`npm install @qaily/playwright-html-reporter` keeps giving the last stable version.

Releases work as in `@qaily/playwright-jsonl-reporter`: from the **Release** workflow in GitHub Actions.

## Publish a version

1. While working, add entries under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) (Added / Changed / Fixed).
2. GitHub → **Actions** → **Release** → **Run workflow** on `main`, and choose:

   | bump | channel | from 1.0.0-beta.0 | from 1.0.0 |
   |---|---|---|---|
   | current | beta | 1.0.0-beta.1 (the first release: 1.0.0-beta.0) | — |
   | current | latest | 1.0.0 | — (already released) |
   | patch | beta / latest | 1.0.1-beta.0 / 1.0.1 | 1.0.1-beta.0 / 1.0.1 |
   | minor | beta / latest | 1.1.0-beta.0 / 1.1.0 | 1.1.0-beta.0 / 1.1.0 |
   | major | beta / latest | 2.0.0-beta.0 / 2.0.0 | 2.0.0-beta.0 / 2.0.0 |

   A beta takes the next free `-beta.N` of that version on npm. `current` keeps the version number: another beta of it,
   or the stable release of a beta.

The workflow runs the typecheck and tests, builds, moves the `Unreleased` changelog entries into the new version's section,
commits `release: vX`, tags `vX`, publishes to npm with provenance, and creates the GitHub release with that section as its
notes (generated notes when it is empty). It stops if the tag or the npm version already exists.

## One-time setup

- **Environment:** repo Settings → Environments → `npm-release`, with the secret `NPM_TOKEN`: an npm granular access token
  with read and write access to `@qaily/playwright-html-reporter` (or all packages of the `@qaily` scope). npm limits write
  tokens to 90 days, so it needs renewing.
- **Without a token (optional, after the first release):** on npmjs.com → the package → Settings → **Trusted publisher**:
  GitHub Actions, organization `qaily`, repository `qaily-playwright-html-reporter`, workflow `release.yml`, environment
  `npm-release`. The workflow then publishes without `NPM_TOKEN`, and the secret can be removed.

## Promote a version to latest by hand

`npm dist-tag add @qaily/playwright-html-reporter@<version> latest` makes an already published version the default.

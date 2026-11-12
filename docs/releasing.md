# Releasing

Versions follow [semantic versioning](https://semver.org): a bug fix bumps the patch (1.0.1), a new feature the minor
(1.1.0), a breaking change the major (2.0.0). Until 1.0.0 is stable, versions carry a `-beta.N` suffix and are published
under the npm `beta` tag, so `npm install @qaily/playwright-html-reporter` keeps giving the last stable one.

## Publish a version

1. Move the entries under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) into a new section,
   `## [1.0.1] - YYYY-MM-DD`, and add its compare link at the bottom. Commit.
2. Set the version and create the tag (`npm version` commits package.json and package-lock.json, and tags `v<version>`):

   ```bash
   npm version prerelease --preid beta   # 1.0.0-beta.0 → 1.0.0-beta.1
   npm version 1.0.0                     # the stable release
   npm version patch | minor | major     # after that
   ```

3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

The [Release workflow](../.github/workflows/release.yml) then checks that the tag matches package.json, runs the typecheck
and tests, publishes to npm (a prerelease under its tag, e.g. `beta`; otherwise `latest`) and creates the GitHub release
with the changelog section as its notes.

## One-time setup

The first version was published by hand, because npm can only trust a workflow for a package that exists:

```bash
npm login
npm publish --tag beta
```

Then on [npmjs.com](https://www.npmjs.com/package/@qaily/playwright-html-reporter) → **Settings** → **Trusted publisher**:
GitHub Actions, organization `qaily`, repository `qaily-playwright-html-reporter`, workflow `release.yml`, no environment.
After that, no npm token is needed anywhere. Optionally, also choose **Require two-factor authentication and disallow
tokens** under Publishing access, so only the workflow can publish.

## Promote a beta to stable

```bash
npm version 1.0.0 && git push --follow-tags
```

To make an already published version the default without a new release: `npm dist-tag add @qaily/playwright-html-reporter@<version> latest`.

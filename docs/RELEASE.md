# Release Process

This document describes how to cut a new release of StellarMind.

## Versioning Policy

StellarMind follows [Semantic Versioning](https://semver.org/) (SemVer):

- **MAJOR** (`X.0.0`) — breaking changes to the API or payment flow
- **MINOR** (`0.X.0`) — new features, backward-compatible
- **PATCH** (`0.0.X`) — bug fixes, documentation, non-functional changes

## Automated Release

Releases are automated via GitHub Actions:

1. Go to the [Actions tab](../../actions/workflows/release.yml)
2. Click **"Run workflow"**
3. Select the version bump: `patch`, `minor`, or `major`
4. The workflow will:
   - Bump version in `package.json`
   - Generate/update `CHANGELOG.md` from conventional commits
   - Create a git tag
   - Push the release commit and tag

## Manual Release (fallback)

```bash
# Ensure on latest master with clean tree
git checkout master
git pull origin master

# Generate changelog and bump version
npx standard-version --release-as patch

# Push release commit and tag
git push --follow-tags origin master
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new agent capability
fix: correct payment verification edge case
docs: update architecture diagram
refactor: extract x402 client into shared module
```

The changelog is auto-generated from these commit prefixes.

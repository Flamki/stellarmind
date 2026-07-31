# Security Policy

## Supported Scope

This repository is a demo/prototype, but we still treat credential and key safety as critical.

## Reporting a Vulnerability

Please do not open public issues for security problems.

Report privately by contacting the maintainers with:

1. clear reproduction steps
2. affected files/endpoints
3. impact summary
4. suggested mitigation (if available)

We will acknowledge receipt and prioritize triage.

## Configuration Security

Certain internal configuration routes (like `POST /api/config/apikey`) are protected by an
`ADMIN_TOKEN`.

- To secure these routes, set `ADMIN_TOKEN` in your `.env` file.
- Authenticate requests by providing the `X-Admin-Token` header.
- **Developer Bypass**: If `ADMIN_TOKEN` is not configured, the routes remain accessible without
  authentication (for local development ease only).
- In a shared or public environment, **always** configure an `ADMIN_TOKEN`.

## Secret Handling Rules

- Never commit `.env` or generated wallet secrets.
- Never commit private keys (`S...`) or API keys (`sk-ant-...`).
- Use `.env.example` for placeholders only.
- Rotate credentials immediately if exposed in logs, recordings, or commits.
- `npm run setup` masks wallet secrets in stdout by default.
- Full secret output is opt-in only via `node src/setup-wallets.js --show-secrets`.

## Local Safety Checklist

Run this before every push:

```bash
git status
git diff --staged
```

Confirm:

- only intended files are staged
- no secret material appears in staged content
- no recordings/screenshots contain private key data

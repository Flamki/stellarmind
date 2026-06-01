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

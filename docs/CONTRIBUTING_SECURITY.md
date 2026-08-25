# Security Checklist for Contributors — Closes #50

Review before pushing code. Supplements [CONTRIBUTING.md](./CONTRIBUTING.md).

## Before Opening a Pull Request

### Secrets & Credentials
- [ ] No API keys, tokens, or passwords in source code
- [ ] Environment variables used for all secrets (see `.env.example`)
- [ ] `.env` and `.env.local` are in `.gitignore`
- [ ] No hardcoded JWT secrets or signing keys

### Dependencies
- [ ] Run `npm audit` — no critical or high vulnerabilities
- [ ] New dependencies reviewed for maintenance status
- [ ] Lockfile (`package-lock.json`) updated
- [ ] No deprecated packages introduced

### Input Validation
- [ ] All user inputs validated server-side
- [ ] SQL/NoSQL injection protections in place
- [ ] File upload paths sanitized and size-limited
- [ ] XSS protections: output encoding, CSP headers

### Authentication & Authorization
- [ ] Endpoints gated with auth middleware
- [ ] Role-based access control enforced
- [ ] Session tokens use secure, httpOnly, SameSite flags
- [ ] Rate limiting on auth endpoints

### Data Protection
- [ ] Sensitive data encrypted at rest
- [ ] PII minimized
- [ ] Logging does not capture passwords, tokens, or PII
- [ ] CORS configured with specific origins (not `*`)

### API Security
- [ ] API responses don't leak stack traces
- [ ] Pagination limits on list endpoints
- [ ] Content-Type headers validated
- [ ] HTTPS enforced (HSTS header)

### Testing
- [ ] Security-focused test cases included
- [ ] Edge cases tested (empty input, max-length, special chars)
- [ ] Error paths tested

## CI/CD Pipeline
- [ ] `npm test` passes locally and in CI
- [ ] `npm run lint` passes with no errors
- [ ] Git hooks (husky) pass pre-commit checks

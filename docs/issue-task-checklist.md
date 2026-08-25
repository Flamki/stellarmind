# Issue Task Checklist Template

Use this template when creating or working on issues.

## Template

```markdown
### 📋 Task Checklist

#### Preparation
- [ ] Read CONTRIBUTING.md
- [ ] Check repository map (`docs/repository-map.md`) for relevant files
- [ ] Set up local environment (see `.env.example`)
- [ ] Create feature branch: `git checkout -b feat/issue-NNN`

#### Implementation
- [ ] Core logic implemented
- [ ] Edge cases handled
- [ ] Error handling added
- [ ] Logging added where appropriate
- [ ] No hardcoded secrets or credentials

#### Testing
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] Manual smoke test performed
- [ ] Edge case tests included

#### Code Quality
- [ ] Linting passes (`npm run lint`)
- [ ] No console.log left in production code
- [ ] Code follows existing patterns and conventions
- [ ] Comments explain "why", not "what"

#### Documentation
- [ ] API changes documented in `docs/API_EXAMPLES.md`
- [ ] New environment variables added to `.env.example`
- [ ] Architecture changes reflected in `docs/architecture.md`
- [ ] README updated if needed

#### Pre-PR
- [ ] Branch rebased on latest master
- [ ] All tests pass locally
- [ ] Self-review of diff completed
- [ ] PR description references related issues
- [ ] DCO signoff included

#### Post-PR
- [ ] CI checks passing
- [ ] Review comments addressed
- [ ] Branch deleted after merge
```

_Generated for Stellar Wave bounty #47_

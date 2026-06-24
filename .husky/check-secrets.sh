#!/usr/bin/env bash
# Lightweight secret pattern scanner for staged files
# Blocks commits containing common credential patterns

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

PATTERNS=(
  "AKIA[0-9A-Z]{16}"                        # AWS Access Key
  "AIza[0-9A-Za-z\-_]{35}"                 # Google API Key
  "ghp_[a-zA-Z0-9]{36}"                     # GitHub Personal Access Token
  "xox[baprs]-[0-9a-zA-Z]{10,}"             # Slack Token
  "-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----"  # Private keys
  "password\s*=\s*['\"][^'\"]{6,}"           # Hardcoded passwords
  "secret\s*=\s*['\"][^'\"]{6,}"             # Hardcoded secrets
  "api_key\s*=\s*['\"][^'\"]{6,}"            # Hardcoded API keys
)

FOUND=0
for FILE in $STAGED_FILES; do
  if [ ! -f "$FILE" ]; then continue; fi
  for PATTERN in "${PATTERNS[@]}"; do
    if grep -qEi "$PATTERN" "$FILE" 2>/dev/null; then
      echo "❌ SECRET DETECTED in $FILE"
      echo "   Pattern: $PATTERN"
      echo "   Use environment variables or a secrets manager instead."
      FOUND=1
    fi
  done
done

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "Commit blocked. Remove secrets before committing."
  echo "To bypass in an emergency: git commit --no-verify (see CONTRIBUTING.md)"
  exit 1
fi

exit 0

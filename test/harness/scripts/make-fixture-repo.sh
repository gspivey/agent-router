#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../../fixtures/repos/integration-test-repo.git"

# Delete and recreate the bare repo
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
git init --bare "$REPO_DIR"

# Create a temp working tree to seed the initial commit
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

git -C "$WORK_DIR" init
git -C "$WORK_DIR" checkout -b main

cat > "$WORK_DIR/README.md" <<'EOF'
# Integration Test Repo

This repository is used by the agent-router test harness.
EOF

mkdir -p "$WORK_DIR/src"
cat > "$WORK_DIR/src/index.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF

mkdir -p "$WORK_DIR/test"
cat > "$WORK_DIR/test/index.test.ts" <<'EOF'
import { add } from '../src/index';

if (add(1, 2) !== 3) throw new Error('add(1,2) should be 3');
console.log('tests pass');
EOF

git -C "$WORK_DIR" add .
git -C "$WORK_DIR" -c user.email="test@example.com" -c user.name="Test" commit -m "Initial commit"
git -C "$WORK_DIR" remote add origin "$REPO_DIR"
git -C "$WORK_DIR" push origin main

echo "Created fixture repo at: $REPO_DIR"

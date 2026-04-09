#!/usr/bin/env bash
set -euo pipefail

# Build a VSIX and install it into the local VS Code.
# Usage:
#   ./scripts/package-and-install.sh            # package and install (requires code in PATH)
#   ./scripts/package-and-install.sh --install-deps
#   ./scripts/package-and-install.sh --insiders
#   ./scripts/package-and-install.sh --code /path/to/code

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INSTALL_DEPS=0
CODE_CMD=""
USE_INSIDERS=0

print_help() {
  cat <<EOF
Usage: $0 [--install-deps] [--insiders] [--code /path/to/code]

Options:
  --install-deps    Run 'npm install' before packaging
  --insiders        Prefer 'code-insiders' if available
  --code PATH       Use explicit 'code' CLI at PATH
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1; shift ;;
    --insiders) USE_INSIDERS=1; shift ;;
    --code) CODE_CMD="$2"; shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    *) echo "Unknown argument: $1"; print_help; exit 2 ;;
  esac
done

if [[ $INSTALL_DEPS -eq 1 || ! -d node_modules ]]; then
  echo "[package-and-install] Installing dependencies..."
  npm install
fi

echo "[package-and-install] Creating VSIX (npm run package)..."
npm run package

# Compute expected VSIX filename from package.json
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
EXPECTED_VSIX="${PKG_NAME}-${PKG_VERSION}.vsix"

if [[ -f "$EXPECTED_VSIX" ]]; then
  VSIX_FILE="$EXPECTED_VSIX"
else
  # fallback: newest .vsix in repo root
  VSIX_FILE=$(ls -1t *.vsix 2>/dev/null | head -n1 || true)
  if [[ -z "$VSIX_FILE" ]]; then
    echo "[package-and-install] ERROR: no .vsix found in repository root." >&2
    exit 1
  fi
  echo "[package-and-install] Warning: expected $EXPECTED_VSIX not found; using $VSIX_FILE"
fi

# Locate VS Code 'code' CLI
if [[ -n "$CODE_CMD" ]]; then
  CODE_BIN="$CODE_CMD"
elif command -v code >/dev/null 2>&1; then
  CODE_BIN="$(command -v code)"
elif [[ $USE_INSIDERS -eq 1 && -x "$(command -v code-insiders 2>/dev/null || true)" ]]; then
  CODE_BIN="$(command -v code-insiders)"
else
  # macOS default locations
  if [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  elif [[ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" ]]; then
    CODE_BIN="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
  else
    echo "[package-and-install] ERROR: VS Code CLI 'code' not found in PATH and not at default macOS locations." >&2
    echo "Install 'code' into PATH (Command Palette → 'Shell Command: Install \"code\" command in PATH') or pass --code /path/to/code" >&2
    exit 2
  fi
fi

echo "[package-and-install] Installing VSIX '$VSIX_FILE' using '$CODE_BIN'"
"$CODE_BIN" --install-extension "$VSIX_FILE" --force

echo "[package-and-install] Done. Installed $VSIX_FILE"

exit 0

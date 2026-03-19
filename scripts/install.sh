#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
AtlasRAG CLI installer

Usage:
  ./scripts/install.sh [--repo-dir PATH] [--run-onboard] [--no-path-update]

Environment overrides:
  ATLASRAG_REPO_URL     Override the git clone URL
  ATLASRAG_HOME         Override the install root (default: ~/.atlasrag)
  ATLASRAG_REPO_DIR     Force a specific repo checkout
EOF
}

find_bin() {
  local name="$1"
  shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  local candidate
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

looks_like_repo() {
  local dir="$1"
  [[ -f "$dir/bin/atlasrag.js" && -f "$dir/docker-compose.yml" && -d "$dir/gateway" ]]
}

append_path_once() {
  local rc_file="$1"
  local line="$2"
  [[ -n "$rc_file" ]] || return 0
  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"
  if ! grep -Fqx "$line" "$rc_file"; then
    printf '\n%s\n' "$line" >>"$rc_file"
  fi
}

REPO_URL="${ATLASRAG_REPO_URL:-https://github.com/Emmanuel-Bamidele/atlasrag.git}"
INSTALL_HOME="${ATLASRAG_HOME:-$HOME/.atlasrag}"
BIN_DIR="$INSTALL_HOME/bin"
DEFAULT_REPO_DIR="$INSTALL_HOME/src/atlasrag"
REPO_DIR_OVERRIDE="${ATLASRAG_REPO_DIR:-}"
RUN_ONBOARD=0
UPDATE_PATH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR_OVERRIDE="$2"
      shift 2
      ;;
    --run-onboard)
      RUN_ONBOARD=1
      shift
      ;;
    --no-path-update)
      UPDATE_PATH=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

NODE_BIN="$(find_bin node /usr/local/bin/node /opt/homebrew/bin/node)" || {
  printf 'Node.js 18+ is required to run the AtlasRAG CLI.\n' >&2
  exit 1
}

if ! "$NODE_BIN" -e 'process.exit(Number.parseInt(process.versions.node.split(".")[0], 10) >= 18 ? 0 : 1)'; then
  printf 'Node.js 18+ is required. Found: %s\n' "$("$NODE_BIN" -v)" >&2
  exit 1
fi

GIT_BIN="$(find_bin git /usr/bin/git /usr/local/bin/git /opt/homebrew/bin/git)" || {
  printf 'git is required to install AtlasRAG from source.\n' >&2
  exit 1
}

DOCKER_BIN="$(find_bin docker /usr/local/bin/docker /opt/homebrew/bin/docker || true)"

if [[ -n "$REPO_DIR_OVERRIDE" ]]; then
  REPO_DIR="$(cd "$REPO_DIR_OVERRIDE" && pwd)"
  if ! looks_like_repo "$REPO_DIR"; then
    printf 'Not an AtlasRAG checkout: %s\n' "$REPO_DIR" >&2
    exit 1
  fi
elif looks_like_repo "$PWD"; then
  REPO_DIR="$PWD"
else
  REPO_DIR="$DEFAULT_REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  if [[ -d "$REPO_DIR/.git" ]]; then
    "$GIT_BIN" -C "$REPO_DIR" fetch --depth=1 origin main || "$GIT_BIN" -C "$REPO_DIR" fetch origin
    "$GIT_BIN" -C "$REPO_DIR" checkout main
    "$GIT_BIN" -C "$REPO_DIR" pull --ff-only origin main
  else
    rm -rf "$REPO_DIR"
    "$GIT_BIN" clone --depth=1 "$REPO_URL" "$REPO_DIR"
  fi
fi

mkdir -p "$BIN_DIR"
WRAPPER_PATH="$BIN_DIR/atlasrag"
cat >"$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_BIN" "$REPO_DIR/bin/atlasrag.js" "\$@"
EOF
chmod +x "$WRAPPER_PATH"

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
if [[ "$UPDATE_PATH" -eq 1 ]]; then
  case "${SHELL##*/}" in
    zsh)
      append_path_once "$HOME/.zshrc" "$PATH_LINE"
      ;;
    bash)
      append_path_once "$HOME/.bashrc" "$PATH_LINE"
      append_path_once "$HOME/.profile" "$PATH_LINE"
      ;;
    *)
      append_path_once "$HOME/.profile" "$PATH_LINE"
      ;;
  esac
fi

cat <<EOF
AtlasRAG CLI installed.

CLI wrapper: $WRAPPER_PATH
Repo checkout: $REPO_DIR
Node: $NODE_BIN
Docker: ${DOCKER_BIN:-not detected in this shell}

If this is a new shell, make sure this path is available:
  export PATH="$BIN_DIR:\$PATH"

Recommended next commands:
  atlasrag doctor
  atlasrag onboard
  atlasrag write --doc-id welcome --text "AtlasRAG stores memory for agents."
  atlasrag ask --question "What does AtlasRAG store?"
EOF

if [[ "$RUN_ONBOARD" -eq 1 ]]; then
  printf '\nLaunching onboarding...\n'
  exec "$WRAPPER_PATH" onboard
fi

#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
SupaVector CLI installer

Usage:
  ./scripts/install.sh [--repo-dir PATH] [--run-onboard] [--no-path-update] [--system]

Environment overrides:
  SUPAVECTOR_REPO_URL     Override the git clone URL
  SUPAVECTOR_HOME         Override the install root (default: ~/.supavector)
  SUPAVECTOR_REPO_DIR     Force a specific repo checkout
  SUPAVECTOR_SYSTEM_HOME  Override the system install root (default: /usr/local/lib/supavector)
  SUPAVECTOR_SYSTEM_BIN_DIR Override the system wrapper dir (default: /usr/local/bin)
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
  [[ -f "$dir/bin/supavector.js" && -f "$dir/docker-compose.yml" && -d "$dir/gateway" ]]
}

PATH_BLOCK_START="# >>> supavector >>>"
PATH_BLOCK_END="# <<< supavector <<<"

upsert_path_block() {
  local rc_file="$1"
  local line="$2"
  [[ -n "$rc_file" ]] || return 0
  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"
  local filtered
  filtered="$(mktemp)"
  awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" -v line="$line" '
    $0 == start { skipping = 1; next }
    skipping && $0 == end { skipping = 0; next }
    !skipping && $0 != line { print }
  ' "$rc_file" >"$filtered"
  mv "$filtered" "$rc_file"
  printf '\n%s\n%s\n%s\n' "$PATH_BLOCK_START" "$line" "$PATH_BLOCK_END" >>"$rc_file"
}

can_write_target_path() {
  local target="$1"
  local probe="$target"
  while [[ ! -e "$probe" ]]; do
    local parent
    parent="$(dirname "$probe")"
    if [[ "$parent" == "$probe" ]]; then
      break
    fi
    probe="$parent"
  done
  [[ -w "$probe" ]]
}

REPO_URL="${SUPAVECTOR_REPO_URL:-https://github.com/Emmanuel-Bamidele/supavector.git}"
SYSTEM_INSTALL=0
USER_INSTALL_HOME="${SUPAVECTOR_HOME:-$HOME/.supavector}"
SYSTEM_INSTALL_HOME="${SUPAVECTOR_SYSTEM_HOME:-/usr/local/lib/supavector}"
SYSTEM_BIN_DIR="${SUPAVECTOR_SYSTEM_BIN_DIR:-/usr/local/bin}"
INSTALL_HOME="$USER_INSTALL_HOME"
BIN_DIR="$INSTALL_HOME/bin"
DEFAULT_REPO_DIR="$INSTALL_HOME/src/supavector"
REPO_DIR_OVERRIDE="${SUPAVECTOR_REPO_DIR:-}"
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
    --system)
      SYSTEM_INSTALL=1
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

if [[ "$SYSTEM_INSTALL" -eq 1 ]]; then
  INSTALL_HOME="$SYSTEM_INSTALL_HOME"
  BIN_DIR="$SYSTEM_BIN_DIR"
  DEFAULT_REPO_DIR="$INSTALL_HOME/src/supavector"
  UPDATE_PATH=0
fi

NODE_BIN="$(find_bin node /usr/local/bin/node /opt/homebrew/bin/node)" || {
  printf 'Node.js 18+ is required to run the SupaVector CLI.\n' >&2
  exit 1
}

if ! "$NODE_BIN" -e 'process.exit(Number.parseInt(process.versions.node.split(".")[0], 10) >= 18 ? 0 : 1)'; then
  printf 'Node.js 18+ is required. Found: %s\n' "$("$NODE_BIN" -v)" >&2
  exit 1
fi

NPM_BIN="$(find_bin npm "$(dirname "$NODE_BIN")/npm" /usr/local/bin/npm /opt/homebrew/bin/npm)" || {
  printf 'npm is required to install SupaVector CLI dependencies.\n' >&2
  exit 1
}

GIT_BIN="$(find_bin git /usr/bin/git /usr/local/bin/git /opt/homebrew/bin/git)" || {
  printf 'git is required to install SupaVector from source.\n' >&2
  exit 1
}

DOCKER_BIN="$(find_bin docker /usr/local/bin/docker /opt/homebrew/bin/docker || true)"

if [[ -n "$REPO_DIR_OVERRIDE" ]]; then
  REPO_DIR="$(cd "$REPO_DIR_OVERRIDE" && pwd)"
  if ! looks_like_repo "$REPO_DIR"; then
    printf 'Not a SupaVector checkout: %s\n' "$REPO_DIR" >&2
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

if [[ "$SYSTEM_INSTALL" -eq 1 && "${EUID:-$(id -u)}" -ne 0 ]]; then
  if ! can_write_target_path "$(dirname "$REPO_DIR")" || ! can_write_target_path "$BIN_DIR"; then
    printf 'System install target is not writable. Re-run with sudo or use the default user install.\n' >&2
    exit 1
  fi
fi

(
  cd "$REPO_DIR"
  PATH="$(dirname "$NODE_BIN")${PATH:+:$PATH}" "$NPM_BIN" install
)

mkdir -p "$BIN_DIR"
WRAPPER_PATH="$BIN_DIR/supavector"
cat >"$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export SUPAVECTOR_HOME="$INSTALL_HOME"
export SUPAVECTOR_BIN_DIR="$BIN_DIR"
exec "$NODE_BIN" "$REPO_DIR/bin/supavector.js" "\$@"
EOF
chmod +x "$WRAPPER_PATH"

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
if [[ "$UPDATE_PATH" -eq 1 ]]; then
  case "${SHELL##*/}" in
    zsh)
      upsert_path_block "$HOME/.zshrc" "$PATH_LINE"
      ;;
    bash)
      upsert_path_block "$HOME/.bashrc" "$PATH_LINE"
      upsert_path_block "$HOME/.profile" "$PATH_LINE"
      ;;
    *)
      upsert_path_block "$HOME/.profile" "$PATH_LINE"
      ;;
  esac
fi

cat <<EOF
SupaVector CLI installed.

CLI wrapper: $WRAPPER_PATH
Repo checkout: $REPO_DIR
Node: $NODE_BIN
Docker: ${DOCKER_BIN:-not detected in this shell}
Install mode: $(if [[ "$SYSTEM_INSTALL" -eq 1 ]]; then printf 'system'; else printf 'user'; fi)

If this is a new shell, make sure this path is available:
  export PATH="$BIN_DIR:\$PATH"

Recommended next commands:
  supavector doctor
  supavector update
  supavector changemodel
  supavector onboard
  supavector write --doc-id welcome --text "SupaVector stores memory for agents."
  supavector ask --question "What does SupaVector store?"
  supavector boolean_ask --question "Does SupaVector store memory for agents?"
EOF

if [[ "$RUN_ONBOARD" -eq 1 ]]; then
  printf '\nLaunching onboarding...\n'
  exec "$WRAPPER_PATH" onboard
fi

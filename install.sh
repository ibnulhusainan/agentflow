#!/usr/bin/env bash
# agentflow installer — sets up the workflow core + platform adapter in a project,
# and makes sure Git is ready (init + remote) so change detection works properly.
#
# Self-bootstrapping: run it from a clone (uses local files) or pipe it from a
# URL (downloads the release tarball itself).
#
# Usage:
#   # from a clone
#   ./install.sh [TARGET_DIR] [options]
#
#   # one-liner (pin a tag; never install from a moving branch)
#   curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/v1.1.1/install.sh | bash
#
#   # target another directory
#   curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/v1.1.1/install.sh | bash -s -- /path/to/project
#
#   # or explicitly from a branch (not recommended)
#   curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/main/install.sh | bash -s -- --ref main
#
# Options:
#   -p, --platform <opencode|cursor|both>  which adapter to install (default: both)
#   -f, --facts                            run `facts --register` after init (default: yes)
#   -u, --update                           overwrite existing agentflow-managed files
#       --force                            same as --update, plus overwrite opencode.jsonc / .cursor tree
#       --no-git                           do NOT touch Git at all
#       --remote <url>                     set origin URL non-interactively
#       --commit                           create an initial commit after git init (default: yes)
#       --no-commit                        do not commit (knowledge reads as stale until you commit)
#       --ref <git-ref>                    release/branch/commit to fetch (default: v1.1.1, i.e. this script's own release)
#       --repo <owner/name>                source repo (default: ibnulhusainan/agentflow)
#       --mirror <url>                     tarball base URL (default: GitHub codeload)
#       --dry-run                          show what would happen, change nothing
#   -h, --help                             this text
#
# Environment:
#   AGENTFLOW_REF, AGENTFLOW_REPO          same as --ref / --repo
#   AGENTFLOW_VERSION                      fallback when the script cannot detect its own ref
#
# Non-destructive: existing files are backed up to .agentflow-backup/<timestamp>/.

set -euo pipefail

# ---------------------------------------------------------------- paths & args

# AGENTFLOW_REF/REPO are read before argument parsing so flags override env.
AGENTFLOW_REF="${AGENTFLOW_REF:-}"
AGENTFLOW_REPO="${AGENTFLOW_REPO:-ibnulhusainan/agentflow}"
AGENTFLOW_VERSION="${AGENTFLOW_VERSION:-v1.1.1}"

# `BASH_SOURCE[0]` is unset when the script is piped (`curl ... | bash`): $0 is
# then "bash", which is not a readable file. That is the signal for remote mode —
# there is no local source, so the package must be downloaded. A real file that
# merely lacks the core (fresh clone, partial checkout) is also handled: the
# bootstrap below triggers whenever $CLI_REL is absent.
SELF_PATH="${BASH_SOURCE[0]:-$0}"
SELF_IS_FILE=0
if [ -f "$SELF_PATH" ]; then
  SELF_IS_FILE=1
  SELF_DIR="$(cd -- "$(dirname -- "$SELF_PATH")" && pwd)"
else
  # Remote mode. Point at a deliberately absent path: the current directory may
  # itself be an agentflow checkout, and using it would silently install the
  # wrong (unpinned, local) copy instead of the requested ref.
  SELF_DIR="/nonexistent/.agentflow-remote-mode"
fi
CLI_REL=".agentflow/cli.mjs"

TARGET=""
PLATFORM=""
RUN_FACTS=""
DO_UPDATE=0
DO_FORCE=0
DO_GIT=1
REMOTE_URL=""
DRY_RUN=0
DO_COMMIT=0
DO_COMMIT_SET=0
NEED_INITIAL_COMMIT=0
REF="${AGENTFLOW_REF:-$AGENTFLOW_VERSION}"
REPO="$AGENTFLOW_REPO"
MIRROR=""
FETCHED=0
TMP_PKG=""

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m::\033[0m %s\n' "$*"; }
ok() { printf '\033[32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[33m !!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

cleanup() {
  [ -n "$TMP_PKG" ] && [ -d "$TMP_PKG" ] && rm -rf "$TMP_PKG"
  return 0
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      if [ -f "$SELF_PATH" ]; then
        awk '/^# agentflow installer/{p=1} p&&/^set -euo/{exit} p{sub(/^# ?/,"");print}' "$SELF_PATH"
      else
        cat <<USAGE
agentflow installer

Usage:
  ./install.sh [TARGET_DIR] [options]
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash -s -- [TARGET_DIR] [options]

Options:
  -p, --platform <opencode|cursor|both>  adapter to install (default: both)
  -f, --facts                            run 'facts --register' after init (default: yes)
  -u, --update                           overwrite existing agentflow-managed files
      --force                            also overwrite opencode.jsonc / .cursor tree
      --no-git                           do NOT touch Git at all
      --remote <url>                     set origin URL non-interactively
      --commit / --no-commit             initial commit after git init (default: yes; only fresh repos)
      --ref <git-ref>                    release/branch/commit to fetch (default: $REF)
      --repo <owner/name>                source repo (default: $REPO)
      --mirror <url>                     tarball base URL (default: GitHub codeload)
      --dry-run                          show what would happen, change nothing
  -h, --help                             this text
USAGE
      fi
      exit 0 ;;
    -p|--platform) PLATFORM="${2:-}"; shift 2 ;;
    -p=*|--platform=*) PLATFORM="${1#*=}"; shift ;;
    -f|--facts) RUN_FACTS=yes; shift ;;
    --no-facts) RUN_FACTS=no; shift ;;
    -u|--update) DO_UPDATE=1; shift ;;
    --force) DO_UPDATE=1; DO_FORCE=1; shift ;;
    --no-git) DO_GIT=0; shift ;;
    --remote) REMOTE_URL="${2:-}"; shift 2 ;;
    --remote=*) REMOTE_URL="${1#*=}"; shift ;;
    --commit) DO_COMMIT=1; DO_COMMIT_SET=1; shift ;;
    --no-commit) DO_COMMIT=0; DO_COMMIT_SET=1; shift ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --mirror) MIRROR="${2:-}"; shift 2 ;;
    --mirror=*) MIRROR="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || TARGET="$(pwd)"
[ -d "$TARGET" ] || die "target directory does not exist: $TARGET"
TARGET="$(cd -- "$TARGET" && pwd)"

BACKUP_DIR="$TARGET/.agentflow-backup/$(date +%Y%m%d-%H%M%S)"
BACKUPS=0

# ---------------------------------------------------------------- bootstrap
#
# Two modes:
#   A) local  — this script lives in an agentflow checkout (core files present)
#   B) remote — piped from a URL; download the release tarball first
#
# Mode B keeps this single file self-contained, so the documented one-liner is
# just `curl ... | bash`. All install logic below is shared by both modes.

fetch_package() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download agentflow (or clone the repo and run ./install.sh)."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack agentflow."

  local base="${MIRROR:-https://codeload.github.com/$REPO}"
  local url="$base/tar.gz/$REF"

  info "downloading agentflow $REF from $REPO"
  TMP_PKG="$(mktemp -d 2>/dev/null || mktemp -d -t agentflow)"
  [ -n "$TMP_PKG" ] || die "could not create a temp directory"

  if ! curl -fsSL --retry 3 --retry-delay 1 -o "$TMP_PKG/pkg.tar.gz" "$url"; then
    die "download failed: $url
       Check the ref (--ref <tag|branch|commit>) and try again.
       Releases: https://github.com/$REPO/releases"
  fi

  local size
  size="$(wc -c < "$TMP_PKG/pkg.tar.gz" | tr -d ' ')"
  [ "$size" -gt 0 ] || die "downloaded archive is empty: $url"

  mkdir -p "$TMP_PKG/src"
  tar -xzf "$TMP_PKG/pkg.tar.gz" -C "$TMP_PKG/src" || die "could not unpack the archive"

  # GitHub tarballs have a single `repo-ref/` root; a self-built archive may be
  # flat. Accept both by locating the core instead of assuming a layout.
  local root=""
  if [ -f "$TMP_PKG/src/$CLI_REL" ]; then
    root="$TMP_PKG/src"
  else
    local d
    while IFS= read -r d; do
      if [ -f "$d/$CLI_REL" ]; then root="$d"; break; fi
    done < <(find "$TMP_PKG/src" -mindepth 1 -maxdepth 2 -type d 2>/dev/null)
  fi
  [ -n "$root" ] || die "archive does not contain $CLI_REL — wrong ref, repo, or mirror URL?"

  # Pin verification. The raw URL a user pipes can say any tag, but this script
  # can only fall back to its built-in AGENTFLOW_VERSION — so a stale default
  # would silently install a DIFFERENT version than the URL named. The archive
  # carries its own VERSION; refuse to install if it is not what we asked for.
  # Only enforced for tag refs: a branch (main/master/HEAD) or commit sha can
  # never equal the archive's VERSION, so comparing them would always fail.
  case "$REF" in
    v[0-9]*)
      if [ -f "$root/VERSION" ]; then
        local got
        got="$(tr -d ' \t\r\n' < "$root/VERSION")"
        if [ "$got" != "$REF" ]; then
          die "version mismatch: requested $REF but $base/tar.gz/$REF contains $got.
    This means the tarball URL served a cached/different archive. Re-run with an
    explicit ref, e.g. --ref $got, or wait for the CDN cache to expire."
        fi
      fi ;;
  esac

  SELF_DIR="$root"
  FETCHED=1
  local sz_mb
  sz_mb="$(awk -v b="$size" 'BEGIN{printf "%.1f", b/1024/1024}')"
  ok "agentflow $REF downloaded (${sz_mb} MB)"
}

if [ ! -f "$SELF_DIR/$CLI_REL" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "no local core found — a real run would download $REPO@$REF and continue from there"
    printf '        curl -fsSL https://raw.githubusercontent.com/%s/%s/install.sh | bash -s -- [options]\n' "$REPO" "$REF"
    exit 0
  fi
  [ "$SELF_IS_FILE" -eq 1 ] && info "local checkout has no core at $CLI_REL — fetching $REPO@$REF"
  fetch_package
fi

# ---------------------------------------------------------------- preflight

step "Preflight"

command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 18, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js >= 18 required (found $(node -v)). The core uses ESM + node: built-ins only."
fi
ok "node $(node -v)"

if [ "$FETCHED" -eq 1 ]; then
  ok "agentflow source: downloaded $REPO@$REF (this run only; the project keeps its own copy)"
  # A piped install cannot know the URL it came from, so it falls back to the
  # script's built-in release tag. Say so loudly: the URL may have named `main`.
  case "$REF" in
    main|master|HEAD) ;;
    *) info "pinned to release $REF. For the latest main, re-run with: --ref main" ;;
  esac
else
  ok "agentflow source: $SELF_DIR (local checkout)"
  case "$REF" in
    main|master|HEAD)
      warn "REF is a moving branch ($REF) — pin a tag (e.g. --ref v1.1.1) for reproducible installs" ;;
  esac
fi

if [ ! -d "$TARGET/.git" ] && git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  warn "target is inside a parent Git repo ($(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null))"
fi

# ---------------------------------------------------------------- platform

step "Platform adapter"

# Both adapters by default: installing them is cheap and non-destructive, and a
# team may use either editor. Narrow it explicitly with -p opencode / -p cursor.
PLATFORM="${PLATFORM:-both}"

case "$PLATFORM" in
  opencode|cursor|both) ;;
  *) die "invalid platform: $PLATFORM (use opencode, cursor, or both)" ;;
esac
ok "platform: $PLATFORM"

# ---------------------------------------------------------------- helpers

run() { # run <description> <cmd...>  — honours --dry-run
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

backup() { # backup <path...>
  [ "$DRY_RUN" -eq 1 ] && return 0
  local p
  for p in "$@"; do
    [ -e "$p" ] || continue
    mkdir -p "$BACKUP_DIR/$(dirname -- "${p#"$TARGET"/}")"
    cp -R "$p" "$BACKUP_DIR/${p#"$TARGET"/}"
    BACKUPS=$((BACKUPS + 1))
  done
}

# copy_tree <src> <dest> — per-file, never clobbers unless --update
copy_tree() {
  local src="$1" dest="$2" rel f
  if [ ! -d "$src" ]; then
    warn "missing source directory: ${src#"$SELF_DIR"/} (skipped)"
    return 0
  fi
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    if [ -e "$dest/$rel" ] && [ "$DO_UPDATE" -eq 0 ]; then
      printf '   skip   %s (exists — use --update to overwrite)\n' "${dest#"$TARGET"/}/$rel"
      continue
    fi
    backup "$dest/$rel"
    run mkdir -p "$(dirname -- "$dest/$rel")"
    run cp -R "$f" "$dest/$rel"
    printf '   copy   %s -> %s\n' "${src#"$SELF_DIR"/}" "${dest#"$TARGET"/}/$rel"
  done < <(find "$src" -type f -print0)
}

# ---------------------------------------------------------------- core

CORE_INSTALLED_NOW=0
step "Core CLI ($CLI_REL)"

if [ -f "$TARGET/$CLI_REL" ] && [ "$DO_UPDATE" -eq 0 ]; then
  warn "$CLI_REL already installed — skipping (use --update to refresh)"
else
  backup "$TARGET/.agentflow"
  run rm -rf "$TARGET/.agentflow"
  run mkdir -p "$TARGET"
  run cp -R "$SELF_DIR/.agentflow" "$TARGET/.agentflow"
  run rm -rf "$TARGET/.agentflow/node_modules"
  ok "installed .agentflow"
  CORE_INSTALLED_NOW=1
fi

# Pre-v1.4 layout kept the core at tools/agentflow. If that is still around the
# project has two copies; say so instead of leaving an ambiguous duplicate.
if [ -e "$TARGET/tools/agentflow" ]; then
  warn "legacy core found at tools/agentflow — the core now lives in .agentflow/"
  printf '        rm -rf %s/tools/agentflow   # after confirming .agentflow works\n' "$TARGET"
fi

# ---------------------------------------------------------------- adapters

if [ "$PLATFORM" = opencode ] || [ "$PLATFORM" = both ]; then
  step "OpenCode adapter"

  OC_CFG="$TARGET/opencode.jsonc"
  if [ -f "$OC_CFG" ] && [ "$DO_FORCE" -eq 0 ]; then
    warn "opencode.jsonc exists — not overwriting. Merge these keys manually:"
    printf '        default_agent: "conductor"\n'
    printf '        permissions:   shell allow "node .agentflow/cli.mjs *", deny "git push *", "rm -rf *", read deny "*.env"\n'
    cat "$SELF_DIR/adapters/opencode/opencode.jsonc"
  else
    backup "$OC_CFG"
    run cp "$SELF_DIR/adapters/opencode/opencode.jsonc" "$OC_CFG"
    ok "opencode.jsonc"
  fi

  for d in agents commands; do
    copy_tree "$SELF_DIR/adapters/opencode/$d" "$TARGET/.opencode/$d"
  done

  if [ -d "$SELF_DIR/adapters/opencode/plugins" ]; then
    if [ -f "$TARGET/.opencode/plugins/context-filter.js" ] && [ "$DO_UPDATE" -eq 0 ]; then
      warn ".opencode/plugins/context-filter.js exists — skip (register it in opencode.jsonc if not already)"
    else
      backup "$TARGET/.opencode/plugins/context-filter.js"
      run mkdir -p "$TARGET/.opencode/plugins"
      run cp "$SELF_DIR/adapters/opencode/plugins/context-filter.js" "$TARGET/.opencode/plugins/"
      ok "plugins/context-filter.js (context trimming — measure before enabling)"
    fi
    if [ -f "$TARGET/.opencode/plugins/model-fallback.js" ] && [ "$DO_UPDATE" -eq 0 ]; then
      warn ".opencode/plugins/model-fallback.js exists — skip (opt-in: AGENTFLOW_AUTO_FALLBACK=on)"
    else
      backup "$TARGET/.opencode/plugins/model-fallback.js"
      run mkdir -p "$TARGET/.opencode/plugins"
      run cp "$SELF_DIR/adapters/opencode/plugins/model-fallback.js" "$TARGET/.opencode/plugins/"
      ok "plugins/model-fallback.js (auto model fallback — off by default)"
    fi
  fi
fi

if [ "$PLATFORM" = cursor ] || [ "$PLATFORM" = both ]; then
  step "Cursor adapter"

  if [ -d "$TARGET/.cursor" ] && [ "$DO_FORCE" -eq 0 ]; then
    warn ".cursor/ exists — merging files without overwriting"
  fi
  copy_tree "$SELF_DIR/adapters/cursor/.cursor" "$TARGET/.cursor"

  if [ ! -e "$TARGET/.cursor/hooks.json" ]; then
    warn "no .cursor/hooks.json installed — if you already had one, merge:"
    cat "$SELF_DIR/adapters/cursor/.cursor/hooks.json"
  fi
  run chmod +x "$TARGET/.cursor/hooks/guard.mjs"
  ok "guard.mjs executable (shell policy: allow / ask / deny)"
fi

# ---------------------------------------------------------------- config

step "Config (.agent/config.json)"

CFG="$TARGET/.agent/config.json"
if [ -f "$CFG" ]; then
  ok "existing config kept — tune it manually:"
  printf '        verify.commands   <REQUIRED: closure gate runs these>\n'
  printf '        small_task        <max_files / max_changed_lines>\n'
  printf '        facts.<kind>      <scope, signals, extractors — project-specific>\n'
  printf '        Full reference: .agentflow/README.md\n'
else
  run mkdir -p "$TARGET/.agent"
  run cp "$SELF_DIR/.agent/config.json" "$CFG"
  ok "created from template"
  warn 'verify.commands is EMPTY — no standard verification list will be surfaced to the conductor. Fill it in.'
fi

# Model chains (`.agent/models.json`) are per-user, per-provider data that
# changes often (fallback pointers live in models.state.json). Copy the
# template only when the file is absent — never clobber a project's chains.
MCFG="$TARGET/.agent/models.json"
if [ -f "$MCFG" ]; then
  ok "existing model chains kept — edit $MCFG to change fallback order"
elif [ -f "$SELF_DIR/.agent/models.json" ]; then
  run cp "$SELF_DIR/.agent/models.json" "$MCFG"
  ok "created .agent/models.json (OpenCode chains; Cursor chains empty by default)"
else
  # A piped install can default to an older release (see the preflight warning);
  # that core predates model chains, so copying would fail. Degrade gracefully.
  warn "installed core has no .agent/models.json (pre-model-chains version) — skipping.
       Re-run with: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- . -u --ref main"
fi

# Agent templates carry no `model:` line (they inherit the editor default), so
# the chains only take effect once they are written.
# On a FRESH install we apply them automatically (check + apply). On an UPDATE
# we deliberately do NOT touch agent files — the user runs it manually, because
# their chains/overrides/state may differ from the template.
if [ -f "$TARGET/$CLI_REL" ] && [ -f "$TARGET/.agentflow/lib/models.mjs" ]; then
  if [ "$PLATFORM" = opencode ] || [ "$PLATFORM" = both ]; then
    if [ "$DO_UPDATE" -eq 0 ] && [ "$CORE_INSTALLED_NOW" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
      step "Model chains (fresh install)"
      if node "$TARGET/$CLI_REL" --root "$TARGET" models check; then
        ok "models check passed"
      else
        warn "models check reported issues (see above)"
      fi
      if node "$TARGET/$CLI_REL" --root "$TARGET" models apply >/dev/null 2>&1; then
        ok "models applied to agent files (model: lines written)"
      else
        warn "models apply failed — run manually: node $CLI_REL models apply"
      fi
    fi
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "$DO_UPDATE" -eq 1 ] && { [ "$PLATFORM" = opencode ] || [ "$PLATFORM" = both ]; }; then
      info "model chains are NOT auto-applied on update."
      info "  run manually when needed:  node $CLI_REL models check"
      info "                            node $CLI_REL models apply"
    elif [ "$CORE_INSTALLED_NOW" -eq 0 ]; then
      info "pin the chains into agent files with:  node $CLI_REL models apply"
      info "fallback manually with:                node $CLI_REL models next --role <role> --reason <text>"
    fi
  fi
fi

# ---------------------------------------------------------------- git

if [ "$DO_GIT" -eq 1 ]; then
  step "Git readiness"

  if ! command -v git >/dev/null 2>&1; then
    warn "git binary not found — install it (https://git-scm.com) and run:"
    printf '        cd %s && git init\n' "$TARGET"
  elif git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ok "already a Git work tree"
    [ -n "$(git -C "$TARGET" remote 2>/dev/null)" ] || warn "no remote configured (change detection still works locally)"
  else
    BRANCH="main"
    git config --get init.defaultBranch >/dev/null 2>&1 && BRANCH="$(git config --get init.defaultBranch)"
    info "not a Git repo -> initialising (branch: $BRANCH)"
    run git -C "$TARGET" init -q -b "$BRANCH" 2>/dev/null || run git -C "$TARGET" init -q
    ok "git init done"

    # Defer the commit until after `init` + `facts` have written workflow state,
    # so the first commit captures .agent/knowledge/ too (otherwise it lands
    # untracked and the team never sees it). Default to committing: an
    # uncommitted tree makes every knowledge entry read as `stale`, which is a
    # confusing first run. Only affects a repo we just created. --no-commit
    # opts out.
    [ "$DO_COMMIT_SET" -eq 0 ] && DO_COMMIT=1
    [ "$DO_COMMIT" -eq 1 ] && NEED_INITIAL_COMMIT=1

    if [ "$DRY_RUN" -eq 0 ]; then
      if [ -f "$TARGET/.gitignore" ]; then
        if grep -qx '\.agent/' "$TARGET/.gitignore" 2>/dev/null; then
          warn ".agent/ is gitignored — workflow state will NOT be shared with the team"
        else
          ok ".gitignore exists and does not exclude .agent/"
        fi
      fi
    fi
  fi

  # remote
  if [ -z "$REMOTE_URL" ] && [ "$DRY_RUN" -eq 0 ] && [ -t 0 ]; then
    printf '\nRemote repository URL (blank to skip): '
    read -r entered || entered=""
    [ -n "$entered" ] && REMOTE_URL="$entered"
  fi

  if [ -n "$REMOTE_URL" ]; then
    case "$REMOTE_URL" in
      http://*|https://*|git@*|ssh://*|file://*) ;;
      /*|./*|../*) ;;  # local path is fine
      *) die "'$REMOTE_URL' does not look like a git URL (expected https://, git@host:owner/repo, ssh://, or a local path)" ;;
    esac
    if git -C "$TARGET" remote get-url origin >/dev/null 2>&1; then
      warn "origin already set to $(git -C "$TARGET" remote get-url origin) — left untouched"
    else
      run git -C "$TARGET" remote add origin "$REMOTE_URL"
      ok "origin = $REMOTE_URL"
    fi
  else
    info "remote URL: skipped — add later with: git remote add origin <url>"
  fi
else
  step "Git"
  info "skipped (--no-git) — change detection will fall back to mtime + content hash"
fi

# ---------------------------------------------------------------- init state

if [ "$DRY_RUN" -eq 0 ]; then
  step "Initialise workflow state"
  ( cd "$TARGET" && node "$CLI_REL" init ) || die "init failed"
  ok ".agent/knowledge/index.json"

  step "Deterministic facts"
  # Facts are deterministic, fast and make the fresh install immediately useful
  # (status/context read them), so they run by default on first install. Skip
  # with --no-facts.
  RUN_FACTS="${RUN_FACTS:-yes}"
  if [ "$RUN_FACTS" = yes ]; then
    ( cd "$TARGET" && node "$CLI_REL" facts --register ) || warn "facts failed — check .agent/config.json facts.<kind>.scope"
  else
    info "skipped — run it later: node $CLI_REL facts --register"
  fi
else
  step "(dry run) would run"
  printf '        node %s init\n        node %s facts --register\n' "$CLI_REL" "$CLI_REL"
fi

# ---------------------------------------------------------------- initial commit
#
# Deferred to here so `init` + `facts` output is included. Only ever runs on a
# repo this script just created.

if [ "${NEED_INITIAL_COMMIT:-0}" -eq 1 ]; then
  step "Initial commit"
  info "committing workflow state (knowledge would read as stale uncommitted)"
  run git -C "$TARGET" add -A
  if [ "$DRY_RUN" -eq 0 ] && git -C "$TARGET" diff --cached --quiet 2>/dev/null; then
    info "nothing to commit"
  else
    run git -C "$TARGET" \
      -c user.email="${GIT_EMAIL:-agentflow@local}" \
      -c user.name="${GIT_NAME:-agentflow installer}" \
      -c commit.gpgsign=false \
      commit -q -m "chore: initialise agentflow workflow" && ok "initial commit created"
  fi
fi

# ---------------------------------------------------------------- report

BACKUPS_NOTE=""
[ "$BACKUPS" -gt 0 ] && BACKUPS_NOTE="
Backups of overwritten files: .agentflow-backup/$(basename "$BACKUP_DIR")"

cat <<EOF

$(printf '\033[1m')agentflow installed$(printf '\033[0m') -> $TARGET

Folders created (all dot-prefixed, so nothing collides with your project layout):
     .agent/      state: config.json, tasks/, knowledge/
     .agentflow/  the core CLI — node .agentflow/cli.mjs <command>
$( [ "$PLATFORM" = opencode ] || [ "$PLATFORM" = both ] && printf '     .opencode/   OpenCode adapter: agents, commands, plugins\n' )
$( [ "$PLATFORM" = cursor ] || [ "$PLATFORM" = both ] && printf '     .cursor/     Cursor adapter: subagents, rules, hooks\n' )

Next steps
  1. Edit $CFG
       - verify.commands   (REQUIRED — closure gate runs these)
       - small_task        (file/line thresholds for the planning bypass)
       - facts.<kind>      (scope + signals + extractors, project-specific)
  2. Verify the install (both must pass):
       cd "$TARGET" && node $CLI_REL status
       cd "$TARGET/.agentflow" && node --test
       (status must report every knowledge entry as "fresh")
  3. Start the editor.
$( [ "$PLATFORM" = opencode ] || [ "$PLATFORM" = both ] && printf '     OpenCode: default agent is "conductor"; switch roles with the agent picker.\n' )
$( [ "$PLATFORM" = cursor ] || [ "$PLATFORM" = both ] && printf '     Cursor:   subagents are /analyzer /planner /executor /reviewer /consultant.\n' )
  4. Everyday commands:
       node $CLI_REL classify --files 8 --cross-module   # is a plan required?
       node $CLI_REL context --task T-YYYYMMDD-NNN         # resume, one payload
       node $CLI_REL validate <task-id>
       node $CLI_REL transition --task <id> --to review
       node $CLI_REL close --task <id>

Docs: .agentflow/docs/spec/ (why)  .agentflow/docs/contracts/ (file formats)  .agentflow/docs/agents/ (roles)
      .agentflow/README.md (CLI + config reference)

Reinstall / update (pinned to a release):
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash -s -- -u$BACKUPS_NOTE

Caveats worth knowing
  - .agent/ state is the audit trail; commit it.
  - Budget/token numbers are self-reported by the agent, not metered by a provider API.
  - Role edit boundaries are enforced by platform permissions where available
    (OpenCode: yes, hard. Cursor: prompt + coarse readonly flags).
  - Freshness, validation, transitions and closure gates ARE hard (core code).

EOF
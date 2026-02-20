#!/usr/bin/env bash
#
# release-private.sh — Build opencode binaries and publish to the private Gitea npm registry.
#
# This script does what the upstream publish.ts does for public npm, but targets
# the private Gitea registry at gitea.usableapps.local. It builds the binaries,
# creates the opencode-ai meta-package, optionally builds and publishes the plugin,
# and publishes everything to Gitea.
#
# Usage:
#   ./script/release-private.sh                 # build + publish CLI binaries
#   ./script/release-private.sh --with-plugin   # also build + publish @uenyioha/opencode-plugin
#   ./script/release-private.sh --skip-build    # skip bun build, just publish existing dist/
#   ./script/release-private.sh --dry-run       # show what would be published, don't actually publish
#
# Prerequisites:
#   - bun installed
#   - npm installed
#   - ~/.npmrc configured with Gitea auth token for @opencode-ai scope
#   - Run from the repo root (/Users/uenyioha/tmp/opencode-ng)
#
# What gets published (package names → Gitea registry):
#   - opencode-darwin-arm64   (macOS ARM binary)
#   - opencode-linux-arm64-musl (Alpine/musl binary — what the Docker image uses)
#   - opencode-ai             (meta-package with bin/opencode wrapper + optionalDependencies)
#   - @uenyioha/opencode-plugin (only with --with-plugin)
#   - @opencode-ai/plugin (only with --with-plugin; runtime install target)
#   - @opencode-ai/sdk (only with --with-plugin; plugin dependency mirrored to Gitea)
#
# The version is auto-generated from the git branch name:
#   feature/http-hook-tool-endpoint → 0.0.0-feature-http-hook-tool-endpoint-YYYYMMDDHHmm
# Slashes in branch names are replaced with hyphens (npm requirement).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_DIR="$REPO_ROOT/packages/opencode"
PLUGIN_DIR="$REPO_ROOT/packages/plugin"
REGISTRY="https://gitea.usableapps.local/api/packages/uenyioha/npm/"
REGISTRY_NO_SCHEME="${REGISTRY#https://}"
REGISTRY_NO_SCHEME="${REGISTRY_NO_SCHEME#http://}"
NPM_TOKEN_KEY="//${REGISTRY_NO_SCHEME}:_authToken"

# --- Parse flags ---
SKIP_BUILD=false
WITH_PLUGIN=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)   SKIP_BUILD=true ;;
    --with-plugin)  WITH_PLUGIN=true ;;
    --dry-run)      DRY_RUN=true ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

# --- Compute version ---
BRANCH=$(cd "$REPO_ROOT" && git branch --show-current)
TIMESTAMP=$(date -u +"%Y%m%d%H%M")
# npm doesn't allow slashes in versions — replace with hyphens
SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
VERSION="0.0.0-${SAFE_BRANCH}-${TIMESTAMP}"
TAG="$SAFE_BRANCH"

echo "========================================="
echo "  release-private.sh"
echo "========================================="
echo "  Branch:   $BRANCH"
echo "  Version:  $VERSION"
echo "  Tag:      $TAG"
echo "  Registry: $REGISTRY"
echo "  Flags:    skip-build=$SKIP_BUILD with-plugin=$WITH_PLUGIN dry-run=$DRY_RUN"
echo "========================================="
echo ""

ensure_registry_auth() {
  echo ">>> Preflight: verifying npm auth for $REGISTRY"

  if npm view opencode-ai version --registry "$REGISTRY" >/dev/null 2>&1; then
    echo "   npm auth OK"
    echo ""
    return
  fi

  echo "   npm auth check failed, attempting token refresh via tea"
  if command -v tea >/dev/null 2>&1; then
    token="$(tea logins token 2>/dev/null || true)"
    if [ -n "$token" ]; then
      npm config set "$NPM_TOKEN_KEY" "$token" >/dev/null 2>&1 || true
      if npm view opencode-ai version --registry "$REGISTRY" >/dev/null 2>&1; then
        echo "   npm auth refreshed via tea"
        echo ""
        return
      fi
    fi
  fi

  echo "ERROR: npm auth to private registry failed." >&2
  echo "- Ensure tea login is valid: tea logins list" >&2
  echo "- Ensure token can be printed: tea logins token" >&2
  echo "- Ensure ~/.npmrc has a valid token for $NPM_TOKEN_KEY" >&2
  exit 1
}

if [ "$DRY_RUN" = false ]; then
  ensure_registry_auth
else
  echo ">>> Preflight: skipped auth check in --dry-run mode"
  echo ""
fi

# --- Step 1: Build binaries ---
if [ "$SKIP_BUILD" = false ]; then
  echo ">>> Step 1: Building binaries (--single for current platform + linux-arm64-musl)"
  cd "$OPENCODE_DIR"

  # Build for current platform (darwin-arm64 on Apple Silicon)
  OPENCODE_VERSION="$VERSION" bun run script/build.ts --single --skip-install

  # Also build linux-arm64-musl (what the Docker image needs).
  # The --single flag only builds for current platform, so we need to build musl separately.
  # Check if it was already built (it won't be on macOS).
  if [ ! -d "dist/opencode-linux-arm64-musl" ]; then
    echo ">>> Building linux-arm64-musl target..."
    OPENCODE_VERSION="$VERSION" bun run script/build.ts --skip-install
    # The full build creates ALL targets. We only need the musl one alongside darwin-arm64.
    # Clean up targets we don't need for private registry.
    cd dist
    for d in */; do
      d="${d%/}"
      case "$d" in
        opencode-darwin-arm64|opencode-linux-arm64-musl|opencode)
          ;; # keep these
        *)
          echo "   Removing unneeded target: $d"
          rm -rf "$d"
          ;;
      esac
    done
    cd "$OPENCODE_DIR"
  fi

  echo ">>> Build complete"
  echo ""
else
  echo ">>> Step 1: Skipped (--skip-build)"
  echo ""
fi

# --- Step 2: Create opencode-ai meta-package ---
echo ">>> Step 2: Creating opencode-ai meta-package"
cd "$OPENCODE_DIR"

# Collect binary package names from dist/ and fix versions
BINARY_NAMES=""
for pkg_json in dist/*/package.json; do
  dir=$(dirname "$pkg_json")
  base=$(basename "$dir")
  # Skip the meta-package dir if it already exists from a previous run
  if [ "$base" = "opencode" ]; then continue; fi
  name=$(python3 -c "import json; print(json.load(open('$pkg_json'))['name'])")
  ver=$(python3 -c "import json; print(json.load(open('$pkg_json'))['version'])")
  # Ensure version matches (build.ts uses Script.version which may differ)
  if [ "$ver" != "$VERSION" ]; then
    echo "   Fixing version in $pkg_json: $ver → $VERSION"
    python3 -c "
import json, pathlib
p = pathlib.Path('$pkg_json')
d = json.loads(p.read_text())
d['version'] = '$VERSION'
p.write_text(json.dumps(d, indent=2))
"
  fi
  BINARY_NAMES="$BINARY_NAMES $name"
  echo "     - $name@$VERSION"
done

echo "   Binaries found:$BINARY_NAMES"

# Build optionalDependencies JSON via python (avoids bash associative arrays)
OPT_DEPS=$(python3 -c "
import json
names = '''$BINARY_NAMES'''.split()
print(json.dumps({n: '$VERSION' for n in names}))
")

# Create meta-package directory
META_DIR="dist/opencode"
rm -rf "$META_DIR"
mkdir -p "$META_DIR/bin"
cp bin/opencode "$META_DIR/bin/opencode"
cp script/postinstall.mjs "$META_DIR/postinstall.mjs"
cp "$REPO_ROOT/LICENSE" "$META_DIR/LICENSE" 2>/dev/null || echo "   (no LICENSE file, skipping)"

# Read base package info
BASE_LICENSE=$(python3 -c "import json; print(json.load(open('package.json')).get('license','MIT'))")

cat > "$META_DIR/package.json" <<EOF
{
  "name": "opencode-ai",
  "version": "$VERSION",
  "license": "$BASE_LICENSE",
  "bin": {
    "opencode": "./bin/opencode"
  },
  "scripts": {
    "postinstall": "bun ./postinstall.mjs || node ./postinstall.mjs"
  },
  "optionalDependencies": $OPT_DEPS
}
EOF

echo "   Created $META_DIR/package.json"
cat "$META_DIR/package.json" | sed 's/^/   /'
echo ""

# --- Step 3: Publish binary packages ---
echo ">>> Step 3: Publishing to $REGISTRY"
cd "$OPENCODE_DIR"

publish() {
  local pkg_dir="$1"
  local pkg_name
  local pkg_ver
  pkg_name=$(python3 -c "import json; print(json.load(open('$pkg_dir/package.json'))['name'])")
  pkg_ver=$(python3 -c "import json; print(json.load(open('$pkg_dir/package.json'))['version'])")

  if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] Would publish: $pkg_name@$pkg_ver from $pkg_dir"
    return
  fi

  echo "   Publishing $pkg_name@$pkg_ver ..."
  (
    cd "$pkg_dir"
    chmod -R 755 . 2>/dev/null || true
    npm publish \
      --registry "$REGISTRY" \
      --tag "$TAG" \
      --access public \
      2>&1 | sed 's/^/     /'
  ) || echo "   WARNING: publish failed for $pkg_name (may already exist)" >&2
}

# Publish each binary package
for pkg_json in dist/*/package.json; do
  dir=$(dirname "$pkg_json")
  base=$(basename "$dir")
  # Skip the meta-package (published last)
  if [ "$base" = "opencode" ]; then continue; fi
  publish "$dir"
done

# Publish meta-package last (depends on binaries)
publish "dist/opencode"

echo ""

# --- Step 4: Plugin (optional) ---
if [ "$WITH_PLUGIN" = true ]; then
  echo ">>> Step 4: Building and publishing plugin"
  cd "$PLUGIN_DIR"

  # Build
  bun run build

  SDK_SOURCE_VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['dependencies'].get('@opencode-ai/sdk','1.2.6'))")

  # Mirror @opencode-ai/sdk to private registry with release version so scoped
  # registry routing (@opencode-ai => Gitea) resolves plugin deps in containers.
  echo "   Mirroring @opencode-ai/sdk@$SDK_SOURCE_VERSION -> @opencode-ai/sdk@$VERSION"
  SDK_STAGE=$(mktemp -d)
  (
    cd "$SDK_STAGE"
    SDK_TGZ=$(npm pack "@opencode-ai/sdk@$SDK_SOURCE_VERSION" 2>/dev/null | tail -n 1)
    tar -xzf "$SDK_TGZ"
    python3 -c "
import json, pathlib
p = pathlib.Path('package/package.json')
d = json.loads(p.read_text())
d['version'] = '$VERSION'
p.write_text(json.dumps(d, indent=2))
print(f'   Prepared {d[\"name\"]}@{d[\"version\"]}')
"
    if [ "$DRY_RUN" = true ]; then
      echo "   [dry-run] Would publish: @opencode-ai/sdk@$VERSION"
    else
      npm publish \
        --registry "$REGISTRY" \
        --tag "$TAG" \
        --strict-ssl=false \
        --access public \
        ./package \
        2>&1 | sed 's/^/     /' || {
          echo "   WARNING: sdk publish failed for @opencode-ai/sdk (may already exist)" >&2
        }
    fi
  )
  rm -rf "$SDK_STAGE"

  # Temporarily rewrite package.json for private registry publishes.
  # We publish two package names:
  # 1) @uenyioha/opencode-plugin (private alias)
  # 2) @opencode-ai/plugin (what runtime bun install resolves)
  cp package.json package.json.bak

  rewrite_plugin() {
    local name="$1"
    python3 -c "
import json, pathlib
p = pathlib.Path('package.json')
d = json.loads(p.read_text())
d['name'] = '$name'
d['version'] = '$VERSION'
d['dependencies'] = d.get('dependencies', {})
if '@opencode-ai/sdk' in d['dependencies']:
    d['dependencies']['@opencode-ai/sdk'] = '$VERSION'
p.write_text(json.dumps(d, indent=2))
print(f'   Rewrote plugin: {d[\"name\"]}@{d[\"version\"]}')
"
  }

  publish_plugin() {
    local name="$1"
    if [ "$DRY_RUN" = true ]; then
      echo "   [dry-run] Would publish: $name@$VERSION"
      return
    fi

    echo "   Publishing $name@$VERSION ..."
    npm publish \
      --registry "$REGISTRY" \
      --tag "$TAG" \
      --strict-ssl=false \
      --access public \
      2>&1 | sed 's/^/     /' || {
        echo "   WARNING: plugin publish failed for $name (may already exist)" >&2
      }
  }

  rewrite_plugin "@uenyioha/opencode-plugin"
  publish_plugin "@uenyioha/opencode-plugin"

  rewrite_plugin "@opencode-ai/plugin"
  publish_plugin "@opencode-ai/plugin"

  # Restore original package.json
  mv package.json.bak package.json
  echo "   Restored plugin package.json"
  echo ""
else
  echo ">>> Step 4: Skipped (no --with-plugin)"
  echo ""
fi

# --- Step 5: Verify ---
echo ">>> Step 5: Verification"
echo ""

verify() {
  local pkg="$1"
  local result
  result=$(npm view "$pkg@$VERSION" version --registry "$REGISTRY" 2>/dev/null || echo "NOT FOUND")
  if [ "$result" = "$VERSION" ]; then
    echo "   ✓ $pkg@$VERSION"
  elif [ "$DRY_RUN" = true ]; then
    echo "   ~ $pkg@$VERSION (dry-run, not published)"
  else
    echo "   ✗ $pkg@$VERSION — got: $result"
  fi
}

for name in $BINARY_NAMES; do
  verify "$name"
done
verify "opencode-ai"

if [ "$WITH_PLUGIN" = true ]; then
  verify "@opencode-ai/sdk"
  verify "@uenyioha/opencode-plugin"
  verify "@opencode-ai/plugin"
fi

echo ""
echo "========================================="
echo "  Done! Version: $VERSION"
echo "========================================="
echo ""
echo "To use in neo-sidecar Dockerfile:"
echo "  opencode-ai@$VERSION"
echo "  opencode-linux-arm64-musl@$VERSION"

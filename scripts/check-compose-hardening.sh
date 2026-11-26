#!/usr/bin/env bash
# Asserts the shipped Compose defaults still carry their hardening. Run by CI and
# usable directly after editing a Compose file.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Placeholders only; these render the files, they are never deployed.
export DOMAIN="${DOMAIN:-keycast.example}"
export ALLOWED_PUBKEYS="${ALLOWED_PUBKEYS:-$(printf '0%.0s' {1..63})1}"
export KEYCAST_OPERATOR_PUBKEYS="${KEYCAST_OPERATOR_PUBKEYS:-$ALLOWED_PUBKEYS}"
export KEYCAST_API_DIGEST="${KEYCAST_API_DIGEST:-sha256:$(printf '1%.0s' {1..64})}"
export KEYCAST_SIGNER_DIGEST="${KEYCAST_SIGNER_DIGEST:-sha256:$(printf '2%.0s' {1..64})}"
export KEYCAST_WEB_DIGEST="${KEYCAST_WEB_DIGEST:-sha256:$(printf '3%.0s' {1..64})}"

COMPOSE_FILES=(docker-compose.yml docker-compose.prod.yml caddy-docker-compose-example.yml)
# Production is what operators actually deploy, so it must carry the same
# per-service hardening as the source Compose file.
APPLICATION_COMPOSE_FILES=(docker-compose.yml docker-compose.prod.yml)
failures=0
fail() {
    failures=$((failures + 1))
    echo "[fail] $1"
}
ok() { echo "[ok] $1"; }

for file in "${COMPOSE_FILES[@]}"; do
    docker compose -f "$file" config --quiet || fail "$file does not render"
done
ok "all Compose files render"

for file in "${APPLICATION_COMPOSE_FILES[@]}"; do
    if docker compose -f "$file" config --format json |
        python3 -c '
import json, sys

config = json.load(sys.stdin)
services = config.get("services", {})
expected = {"keycast-signer", "keycast-api", "keycast-web"}
errors = []

missing = expected - set(services)
if missing:
    errors.append(f"missing services: {sorted(missing)}")

for name, svc in services.items():
    if svc.get("read_only") is not True:
        errors.append(f"{name}: read_only must be true")
    if svc.get("user") != "10001:10001":
        errors.append(f"{name}: user must be 10001:10001")
    mem = svc.get("mem_limit")
    swap = svc.get("memswap_limit")
    if not mem or swap != mem:
        errors.append(f"{name}: memswap_limit ({swap}) must equal mem_limit ({mem})")
    if svc.get("cap_drop") != ["ALL"]:
        errors.append(f"{name}: cap_drop must be [\"ALL\"]")
    if svc.get("cap_add"):
        errors.append("{}: unexpected cap_add {}".format(name, svc.get("cap_add")))
    sec = svc.get("security_opt") or []
    if "no-new-privileges:true" not in sec:
        errors.append(f"{name}: missing no-new-privileges:true")
    ulimits = svc.get("ulimits") or {}
    core = ulimits.get("core")
    if "core" not in ulimits or not (
        core == 0 or (isinstance(core, dict) and core.get("soft", 0) == 0 and core.get("hard", 0) == 0)
    ):
        errors.append(f"{name}: ulimits.core must be 0")
    tmpfs = svc.get("tmpfs") or []
    if not any("noexec" in str(t) and "nosuid" in str(t) and "nodev" in str(t) for t in tmpfs):
        errors.append(f"{name}: tmpfs must set noexec,nosuid,nodev")

signer_nets = set((services.get("keycast-signer") or {}).get("networks") or [])
if signer_nets != {"keycast-signer-egress"}:
    errors.append(f"keycast-signer networks must be only keycast-signer-egress, got {sorted(signer_nets)}")

for isolated in ("keycast-api", "keycast-web"):
    svc = services.get(isolated) or {}
    nets = set(svc.get("networks") or [])
    if nets != {"keycast"}:
        errors.append(f"{isolated} networks must be only keycast, got {sorted(nets)}")
    for vol in svc.get("volumes") or []:
        mount = "{}:{}".format(vol.get("source", ""), vol.get("target", "")) if isinstance(vol, dict) else str(vol)
        if any(tok in mount for tok in ("master.key", "database", "/run/secrets")):
            errors.append(f"{isolated} must not mount secret/database volume: {mount}")

if errors:
    print("; ".join(errors))
    sys.exit(1)
'; then
        ok "$file: per-service hardening, swap cap, isolation, and volume boundaries verified"
    else
        fail "$file: per-service hardening verification failed"
    fi
done

# Verify proxy example hardening and that no Compose file mounts the Docker socket.
for file in "${COMPOSE_FILES[@]}"; do
    if docker compose -f "$file" config --format json |
        python3 -c '
import json, sys

config = json.load(sys.stdin)
errors = []
for name, service in config.get("services", {}).items():
    for volume in service.get("volumes", []):
        if isinstance(volume, dict):
            mount = "{}:{}".format(volume.get("source", ""), volume.get("target", ""))
        else:
            mount = str(volume)
        if "docker.sock" in mount:
            errors.append("docker.sock mount: {} -> {}".format(name, mount))
    if name == "caddy":
        if service.get("read_only") is not True:
            errors.append("caddy: read_only must be true")
        mem = service.get("mem_limit")
        swap = service.get("memswap_limit")
        if not mem or swap != mem:
            errors.append("caddy: memswap_limit must equal mem_limit")
        if service.get("cap_drop") != ["ALL"]:
            errors.append("caddy: cap_drop must be [\"ALL\"]")
        if "no-new-privileges:true" not in (service.get("security_opt") or []):
            errors.append("caddy: missing no-new-privileges:true")
if errors:
    print("; ".join(errors))
    sys.exit(1)
'; then
        ok "$file mounts no Docker socket and meets proxy hardening checks"
    else
        fail "$file failed Docker socket / proxy hardening checks"
    fi
done

# A denylist silently misses nested paths such as legacy-v1/master.key.
if grep -qx '\*' .dockerignore; then
    ok ".dockerignore is allowlist form"
else
    fail ".dockerignore is not allowlist form"
fi

if [[ "$failures" -gt 0 ]]; then
    echo "Compose hardening checks failed with $failures issue(s)."
    exit 1
fi
echo "Compose hardening checks passed."

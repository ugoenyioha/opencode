# Runtime hardening

This directory contains Phase 1A deployment assets for running OpenCode with stronger runtime isolation.

## Files

- `Dockerfile`: multi-stage build and hardened runtime image
- `docker-compose.yml`: two-service example using gVisor runtime and seccomp profile
- `seccomp-profile.json`: conservative seccomp deny list for risky syscalls
- `gvisor/runsc.toml`: base runsc runtime config
- `firecracker/`: starter notes and config stub for microVM runtime migration

## Quick start

1. Build image:
   `docker build -f deploy/Dockerfile -t opencode-runtime:dev .`
2. Install gVisor runtime (`runsc install`) on host
3. Start services:
   `docker compose -f deploy/docker-compose.yml up -d`

## Notes

- This profile is container hardening only. It does not replace app-level auth and permission policy.
- Keep OpenCode config mounted read-only in production.
- Add network policy allowlists at orchestrator level.

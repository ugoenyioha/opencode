# Firecracker transition notes

This folder is a starter for migrating OpenCode runtime from container sandboxes to microVM sandboxes.

## Why keep this here

- gVisor is the fastest path for immediate hardening.
- Firecracker provides a stronger tenant boundary.
- Keeping a checked-in stub avoids losing implementation context when the migration starts.

## Recommended path

1. Keep Phase 1A running on Docker plus runsc.
2. Evaluate `firecracker-containerd` or Kata runtime with Firecracker backend.
3. Move OpenCode workloads behind a Kubernetes `RuntimeClass` that targets microVM nodes.

## Required pieces for a full rollout

- firecracker VMM binary and jailer on worker nodes
- CNI integration for guest networking
- snapshotting strategy for startup latency
- image builder pipeline for guest rootfs
- runtime class and scheduling policy

`vmconfig.json` is an example shape only. Do not use it as-is in production.

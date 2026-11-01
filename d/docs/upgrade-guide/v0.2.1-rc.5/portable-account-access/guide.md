---
kind: upgrade-guide
description: "Third-party portable 1.1.0 keeps fixed grants inside the package and uses account access outside it."
---

# Portable workspaces without permission recovery

English | [中文](guide.zh.md)

## Change

This change applies to the third-party Windows portable build, not the upstream default distribution. Portable 1.1.0 retains workspace-write inside the package with persistent grants. External folders use current-account access, including other files the account may modify. Read-only remains available. The fresh-use package has no permission recovery command or startup/exit recovery scan.

## Migration

1. Extract the complete 1.1.0 package into an unused writable NTFS folder and start with its empty data directory.
2. Put portable projects in independent folders under `data/workspaces`. Confirm that their permission selector shows workspace-write.
3. When opening an external folder, confirm that the selector shows current-account access. Explicit workspace-write selection outside the package is rejected before granting.
4. Exit before copying or unplugging to finish data writes. Grants inside the package stay on the drive and need no exit restoration. Sudden removal may still interrupt file writes.

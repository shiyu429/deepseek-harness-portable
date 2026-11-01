---
kind: upgrade-guide
description: "Portable 1.2 restores official permission modes and admits compatible program-only overwrite updates."
---

# Portable 1.2 permissions and overwrite updates

English | [中文](guide.zh.md)

## Change

The third-party Windows portable build uses the upstream permission preset service and Windows sandbox provider. Internal and external workspaces support read-only, workspace-write, and danger-full-access with upstream approval rules. Workspace grants remain as upstream intends; no exit restoration is added. Portable data permissions remain confined to the application's own data directory. An unchanged generated 1.1 home patch is refreshed to remove portable permission overrides; custom patches and historical permission events remain intact.

Program files live in versioned app directories, separate from data. The launcher checks the complete selected program and its declared data format before starting a data writer. Compatible overwrite packages contain no data or backups and do not copy or convert user data. Unknown or changed formats stop startup. This mechanism does not recover data from hardware failure or removal during application writes.

Only the application and graphical maintenance executables remain as root files; resources and documentation live under app. The maintenance tool installs compatible updates, resumes interrupted program deployment, verifies program files, and opens data or instructions. Internal workspaces relocate automatically. External workspaces check computer and directory identity; explicit selection uses the upstream workspace picker, with no separate relocation tool. Portable standing grants reject broad ambient write permissions or external links before modification and complete interrupted child grants on reuse.

## Migration

1. Completely exit the portable application.
2. Select a compatible overwrite-update.zip in the maintenance tool, or extract it into the existing portable directory, merging program files. Do not delete or replace the entire directory.
3. Launch DSH Portable.exe. An incomplete update is rejected; reapply the complete compatible package while retaining data. Incompatible formats require a compatible release rather than bypassing the check.
4. Choose permission modes in each session. Full access retains the upstream risk confirmation. Older sessions keep their logged choices until explicitly changed.

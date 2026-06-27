# Persistent Storage Layout (Kyte / EFS)

This document describes where pi, context-mode, and KB data lives and how it
survives instance recycles on Kyte.

---

## The problem

`~/.pi/`, `~/.config/`, `~/.context-mode/` all live on local NVMe (`/dev/nvme1n1`).
NVMe is ephemeral — wiped when the Kyte instance is recycled or restarted.

`~/studio/` is on EFS (`fs-04bf86d02daf87e14`) — persistent across recycles.

---

## Solution: symlinks from NVMe → EFS

Every path that should survive a recycle is **moved to EFS** and replaced with a
symlink on NVMe. The symlinks are recreated by `~/studio/pi-agent/justfile` on a
fresh instance.

### Current symlink map

| NVMe path (ephemeral) | EFS target (persistent) | Contents |
|---|---|---|
| `~/.pi/context-mode` | `~/studio/pi/context-mode` | Session DBs, content DBs |
| `~/.pi/dashboard` | `~/studio/pi/dashboard` | Dashboard logs |
| `~/.pi/ralph` | `~/studio/pi/ralph` | Ralph iteration files |
| `~/.pi/agent/sessions` | `~/studio/pi/sessions` | Pi JSONL session transcripts |
| `~/.config/JetBrains/context-mode` | `~/studio/pi/jetbrains-context-mode` | JetBrains plugin data |
| `~/.context-mode/knowledge.db` | `~/studio/pi/knowledge/knowledge.db` | Global context-mode KB |

### KB files (all on EFS)

| Path | Contents |
|---|---|
| `~/studio/pi/knowledge/knowledge.db` | Global default KB |
| `~/studio/pi/.sessions.kb.db` | Pi session history KB |
| `~/studio/airflow/repos/etl.master/.etl.kb.db` | ETL repo KB |

---

## Recreating symlinks on a fresh instance

```bash
cd ~/studio/pi-agent
just link-persistent   # creates all NVMe → EFS symlinks
just link              # links pi config files + sessions
just status            # verify everything
```

`link-persistent` is idempotent — safe to run multiple times.

---

## Verifying a path is on EFS

```bash
stat <path> | grep Device
# EFS:  Device: 2fh/47d
# NVMe: Device: 10303h/66307d
```

Or use `df`:
```bash
df -h <path>
# EFS shows: fs-04bf86d02daf87e14:/ mounted on /mnt/custom-file-systems/efs/...
# NVMe shows: /dev/nvme1n1
```

---

## ~/studio/pi layout

```
~/studio/pi/
├── context-mode/          # ~/.pi/context-mode symlink target
│   ├── sessions/          # context-mode session event DBs
│   └── content/           # context-mode content/FTS5 DBs
├── dashboard/             # ~/.pi/dashboard symlink target
├── ralph/                 # ~/.pi/ralph symlink target
├── sessions/              # ~/.pi/agent/sessions symlink target (JSONL transcripts)
├── jetbrains-context-mode/ # ~/.config/JetBrains/context-mode symlink target
├── knowledge/
│   └── knowledge.db       # ~/.context-mode/knowledge.db symlink target
└── .sessions.kb.db        # Pi session history KB (ingested from sessions/)
```

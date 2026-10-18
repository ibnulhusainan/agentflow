# Suggestion: Model Super Hemat (opencode-go)

> **Update (Fase 1 shipped).** This document is the *rationale* for the model
> selection. The mechanism that applies it is now `.agent/models.json` +
> `node .agentflow/cli.mjs models show|check|next|set|apply`. Each role has two
> tiers: `paid` (paid OpenCode Go/Zen models) then `free` (free OpenCode / Zen
> models). Put each tier's models in priority order under
> `adapters.opencode.roles.<role>.paid` / `.free`; agent frontmatter is rewritten
> from that file. `models next` walks `paid[0] → … → free[0] → …` and exits non-zero
> when both tiers are exhausted. Privacy metadata in the template comes from the
> OpenCode Go/Zen docs (`trains_on_data` / `retention_days`); unknown metadata is
> treated as fail-closed in `--client` mode, never as safe.

Tujuannya: hemat kuat, tapi masih "capable diajak ke lapangan", dan tetap ada safety buat role yang kritis.

## Quick Pick (Rekomendasi)

| Role | Model | Input $/M | Output $/M | Notes |
|---|---|---|---|---|
| `conductor` | `opencode-go/beam-free` | 0.00 | 0.00 | Orkes routing + delegasi. Bagus dipasangkan bareng gratisan |
| `consultant` | `opencode-go/beam-free` | 0.00 | 0.00 | Read-only, paling aman gratis |
| `analyzer` | `opencode-go/gpt-6-luna` | 0.10 | 0.50 | Volume tertinggi kalo dipanggil. Masih murah, lumayan patuh |
| `planner` | `opencode-go/deepseek-v4.1-flash` | 0.15 | 0.60 | Perlu reasoning + follow kontrak. Worth it dikit |
| `executor` | `opencode-go/qwen3.8-flash` | 0.15 | 0.47 | Workhorse. Stabil, hemat, sering "diajak kerja" |
| `reviewer` | `opencode-go/glm-5.3-flash` | 0.15 | 0.50 | **Kritis**. Gak disaranin free. Ini sweet spot buat safety |

Total max kritis: planner+reviewer = $0.30/$1.10 per M.

## Alternatif Hemat Ekstrem (bisa dicoba)

Kalo mau lebih tipis lagi, ganti reviewer ke luna — tapi lo harus aware risikonya:

| Role | Model | Catatan |
|---|---|---|
| `reviewer` | `opencode-go/gpt-6-luna` | Lebih hemat (0.10/0.50), tapi reviewer lebih gampang "lolosin". Coba test 1-2 task dulu |
| `analyzer` | `opencode-go/mimo-v2.5` | 0.14/0.28, lumayan — kalo luna kurang stabil di repo lo |
| `conductor/consultant` | `opencode-go/longcat-2.5-preview-free` | Alternatif buat beam-free |

## Copy-paste: OpenCode (.opencode/agents/*.md)

Taruh `model:` di frontmatter. Cuma tambahin 1 baris.

```yaml
# .opencode/agents/conductor.md
---
description: "Conductor: orchestrate the task lifecycle, enforce gates, and delegate to one role at a time."
mode: primary

color: "#e0607e"
model: opencode-go/beam-free
permission:
  ...
---

# .opencode/agents/consultant.md
---
description: "Consultant: discuss options and give recommendations; read-only, no writes."
mode: primary

color: "#9aa7b4"
model: opencode-go/beam-free
permission:
  ...
---

# .opencode/agents/analyzer.md
---
description: "Analyzer: own knowledge artifacts and produce facts/notes."
mode: all

color: "#6a9fb5"
model: opencode-go/gpt-6-luna
permission:
  ...
---

# .opencode/agents/planner.md
---
description: "Planner: turn a request into a dependency-aware, testable plan in .agent/tasks/<id>/plan.json."
mode: all

color: "#b07be8"
model: opencode-go/deepseek-v4.1-flash
permission:
  ...
---

# .opencode/agents/executor.md
---
description: "Executor: implement the approved plan incrementally, record progress, and verify with evidence."
mode: primary

color: "#48b06b"
model: opencode-go/qwen3.8-flash
permission:
  ...
---

# .opencode/agents/reviewer.md
---
description: "Reviewer: independently verify results against acceptance criteria; read-only."
mode: all

color: "#e8a13b"
model: opencode-go/glm-5.3-flash
permission:
  ...
---
```

## Copy-paste: Cursor (.cursor/agents/*.md)

Di Cursor tiap file agent biasanya ada `model: inherit`. Ganti jadi:

```yaml
analyzer.md   -> model: opencode-go/gpt-6-luna
planner.md    -> model: opencode-go/deepseek-v4.1-flash
executor.md   -> model: opencode-go/qwen3.8-flash
reviewer.md   -> model: opencode-go/glm-5.3-flash
consultant.md -> model: opencode-go/beam-free
```

## Test Cepat

1. Pasang preset ini
2. Kerjain **1 task kecil** manual (analyzer→planner→executor→reviewer)
3. Lihat `usage check`: `node .agentflow/cli.mjs usage check --task current --json`
4. Bandingin: kalo reviewer masih cukup strict, ini udah ideal. Kalo sering "approve aja", baru coba pindah reviewer ke luna

**Rule of thumb:** biarin `reviewer` tetap bayar sedikit, daripada bayar 2x gara-gara bug lolos.
## Tanggapan ke usulan lo

Lo ambil kombinasi yang lumayan mirip sama rekomendasi ane:

| Role | Usulan lo | Pendapat |
|---|---|---|
| `conductor` | `gpt-6-luna` | Oke, 0.10/0.50, worth buat koordinasi. Bisa juga beam-free. |
| `consultant` | `gpt-6-luna` | Oke buat read-only ringan. |
| `analyzer` | `deepseek-v4.1-flash` | Agak "overkill" kalo cuma bikin facts. Tapi di go limit DeepSeek flash lumayan tinggi (Go Go Plus tinggi), harga masih 0.15/0.60, bisa diterima. |
| `planner` | `deepseek-v4-pro` | **Bagus** — reasoning-nya stabil buat follow kontrak. Tinggal cek real usage di lapangan. |
| `executor` | `minimax-m3` | Sangat hemat (0.30/1.20) tapi "capable diajak kerja". Ane pernah liat ini stabil buat edit kecil-menengah. Coba aja. |
| `reviewer` | `glm-5.2` | **Bagus ambil GLM-5.2**. Beda dari executor, dan menurut tabel Go, GLM-5.2 monthly limit $60 (Go) lumayan aman. |

**Perbedaan tipis:** ane lebih pilih `qwen3.8-flash` buat executor biar beda dari planner, dan lebih aman buat reviewer. Tapi usulan lo juga logis.

**Coba aja dulu urutan lo.** Yang paling penting: ukur 1 task kecil pakai `usage check`, baru putusin mau diturun/tetepin.

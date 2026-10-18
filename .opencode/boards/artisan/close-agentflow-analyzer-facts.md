# Tugas: Extend agentflow facts (Analyzer) — generic, config-driven

Sumber kebutuhan: `projects/hotel-management/.agent/tasks/T-20261016-002/analyzer-requirements.md`
(baca-only; folder `projects/` TIDAK diubah).
Batas: generik untuk semua project — tanpa hardcode spesifik project tertentu.

[x] lib/facts.mjs: registry generator — repo-structure (compat), inventory, imports, routes, schema, verify-state
[x] lib/config.mjs: DEFAULTS.facts (per-kind: enabled/id/scope + options)
[x] CLI `facts`: `--kind`, `--scope`, `--register` (upsert index entry per kind, scope + content_hash per domain)
[x] Schema Config.$def: tambah properti `facts` di tools/agentflow/schema + .agentflow/docs/contracts/schemas (sinkron)
[x] Tests: test/facts.test.mjs (generator per kind + CLI register/split-hash + unknown kind)
[x] README tools/agentflow: dokumentasi kinds, config, flag baru
[x] Jalankan `node --test "tools/agentflow/test/*.test.mjs"` — semua lulus

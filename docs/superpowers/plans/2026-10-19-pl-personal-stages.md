# PL personal stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Each opted-in PL seller can create, rename, recolor and reorder her own stages while management still distributes leads manually.
**Architecture:** Reuse Stage.user_id and KanbanIndividualService with a PL-specific exception; keep Tenant.kanban_individual unchanged. Initialize the seller's PL board idempotently, translate stage ownership on handoffs, and use the same board in lists and reports.
**Tech Stack:** NestJS/Prisma/PostgreSQL, Next.js/React, Jest.
**Spec:** User approved “Etapas individuais para cada vendedora (recomendado)” in this conversation. Shared partner behavior and private salesperson access remain unchanged. Duplicate Kanban navigation was already removed in 2ac7898.

## Global Constraints
- Tenant a44772ed-1382-4400-84fc-3fa350e23e42; PL pipeline 6f749216-8d83-44ed-8fd0-1c57720c9f11; only OPERADOR with server-owned pl_sales_only=true.
- No schema migration, no global toggle activation, no partner changes, no new dependency. Preserve untracked diag-lucas scripts.
- Permit create/name/color/reorder only; stage deletion, automation and win/loss settings remain outside the salesperson's permissions.
- Preserve terminal won/lost meaning during transfers even after renaming. Never reset existing personal customization or mix stage owners.
- Serial tests with heap limits; publish frontend and backend, bounded VPS build, rollback image and health/access checks.

## Review Focus
- Two concurrent initializations must produce one board, without resetting existing customization.
- Manager assignment, bulk assignment, direct lead owner PATCH, personal WhatsApp inbound, and return-to-pool must resolve to the destination board.
- Changing the tenant-wide individual toggle must preserve PL seller custom stages.
- Manager viewing a seller and private seller reports must show the same personal stage set; other sellers' data/stages remain protected.
- Forged stage IDs, another pipeline, structural PATCH fields and mixed-owner reorder lists must fail closed.

### Task 1: Scoped stage ownership and initialization
**Files:** pipelines/kanban-individual.service.ts and tests; users/users.service.ts only if initialization hook is needed.
**Interfaces:** Add hasPersonalBoards(tenantId): Promise<boolean> for existing fanout gates; usesPersonalBoard(tenantId, ownerId: string|null, pipelineId?: string): Promise<boolean>; ensurePlPersonalBoard(tenantId, ownerId): Promise<void>. Keep isOn() tenant-wide. Existing stageForOwner/stageForBase translate safely.
- [x] Regression tests: PL opt-in with global toggle off, ordinary profiles unchanged, initializer lock/idempotence, transferred renamed terminal stage, global toggle preservation.
- [x] Implement PL scope/profile checks, transaction advisory lock, visual/status stage copies, own-portfolio remap on initialization, destination owner translation.
- [x] Run focused tests, inspect result, preserve original non-PL behavior.

### Task 2: Lead lifecycle
**Files:** leads/leads.service.ts, webhooks/inbound-message.service.ts, public-api/public-api.service.ts and focused tests.
**Consumes:** Task 1 interfaces; ensure assigned PL board before resolving stages.
- [x] Regression tests for per-stage cards/counts, creation, single/bulk moves, all owner-assignment paths, inbound already assigned, return-to-base and public unassigned creation.
- [x] Apply the scoped helpers; choose base explicitly for unassigned defaults; preserve owner/tenant/PL permissions and existing caches/events.
- [x] Run focused tests serially.

### Task 3: Stage editing, reports and UI
**Files:** pipelines/pipelines.service.ts and specs; common/access/pl-sales-policy.service.ts and specs; analytics/analytics.service.ts and specs; web Kanban workspace/components and focused tests.
- [x] Regression tests for private stage create/rename/color/reorder, forged IDs/pipeline/structural settings, manager view-as, and private reports with global toggle off.
- [x] Initialize and read the personal board, enforce ownership in policy and service, notify/invalidate after edits, expose only authorized controls. Keep reports and frontend filters consistent.
- [x] Run focused tests and types/lint with limited heap.

### Task 4: Review and production verification
- [x] Independent review of ownership boundaries and handoffs; resolve findings.
- [x] Commit/push and deploy backend/frontend with bounded RAM and rollback, no database migration.
- [x] Initialize the real seller board; confirm shared stage IDs/names and partner settings unchanged, restricted CRUD is scoped, forbidden operations still blocked, Dashboard/Analytics/board agree.
- [x] Verify real UI and memory/health; report implementation and limitations plainly.

## Verification before publishing
- API: 106 suites / 1,758 tests passed serially with a 768 MB heap; web: 22 suites / 252 tests passed.
- Real PostgreSQL rollback probe passed initialization, repeated initialization, create/rename/color/reorder, manager view, denied foreign/base/structural writes and terminal-stage translation. No test rows persisted.
- Independent review findings reproduced and fixed: cross-owner delete-with-move, shared partner reorder permissions, PL template duplication and pipeline destination translation. Second review found no remaining P1/P2 in these fixes.
- Added projected-column pagination for management and board-specific conversion adjacency. Pipeline metadata counts are restricted to the seller's own leads.
- No schema migration or tenant-wide toggle change. VPS preflight: 5.4 GB available, backend approximately 203 MiB; nginx local configuration fingerprint preserved.

## Production result — 2026-10-19
- Published application commit d870c2b. Vercel reported success; backend image sha256:68c0b6f7e8a6ef9b396a2a33cdad1c38ca99aac25f9d07d48fd215342c188e2c is running and healthy, OOMKilled=false.
- Rollback image: crm-whatsapp-crm-backend:pre-pl-personal-stages-20261019. Build capped at 1,536 MB, Node heap 1,152 MB. Final backend approximately 103 MiB; approximately 5.5 GB RAM available. Nginx fingerprint unchanged.
- Concurrent real pipeline reads produced one set of seven personal stages for Comercial PL. Existing own lead retained in the correct personal board. Shared stages, other profiles and global individual flag unchanged.
- Live cosmetic PATCH/reorder accepted; base/foreign stage reorder, structural writes and deletion denied. Manager view and private Analytics return the same personal stage IDs. Metadata aggregate counts remain stripped by the existing privacy interceptor.
- Live browser verified only Consórcio PL Kanban navigation, personal stage menu, create prompt, hidden structural/delete controls and no page errors. Separate API regression checked nine personal reports, one own lead, blocked partner/team/finance endpoints and preserved manager partner access.
- Final API and web TypeScript checks passed. Lint had zero errors; existing warnings remain. Production UI/API checks used short-lived credentials and did not create fake leads or sales.
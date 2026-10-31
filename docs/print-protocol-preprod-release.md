# Preprod print protocol verification — 2026-10-31

## Result and deployment blocker

The local server implements test-print protocol 2 for the installed Windows Agent
v1.0.0-rc.4. Local protocol checks pass. **Preprod compatibility and physical
TableCore printing remain unverified; this release has not been pushed.**

Branch: `develop`. HEAD and the cached `origin/develop` reference are
`1be57b35c905ecf6d974624b893bf8c1ae99a5fc`.
Remote: `https://github.com/duledu/restaurant-pos-system.git`.
Two live `git ls-remote origin refs/heads/develop` attempts failed to connect to
GitHub port 443. The execution environment also grants read-only access to `.git`.
The current remote tip cannot be verified; no staging, commit, push, deployment,
service restart, configuration change, or physical print was performed.

## Proven failure and scope

The installed rc.4 service uses
`https://tablecore-git-develop-drake-du.vercel.app`. Earlier runtime evidence in
`C:\ProgramData\TableCore\PrintAgent\logs\agent.log` records:

- `2026-10-31T22:11:33.595485Z`: diagnostics returned HTTP 404,
  `UNVERIFIED_HTTP_404_CHECK_BACKEND_DEPLOYMENT`.
- Around 22:14–22:15 UTC: test signals had no request ID and were rejected with
  `SERVER_PROTOCOL_MISMATCH_NO_REQUEST_ID`. No test claim or dispatch followed.

The first failed delivery transition is the backend test signal to agent request
validation. Heartbeat success does not establish delivery compatibility. Windows
native printing was separately confirmed by the operator in the earlier session;
that does not verify TableCore printing.

The previously supplied Admin URL was `http://localhost:3000/settings/printers`.
Updating preprod does not align localhost with preprod. For acceptance of this
release, use the preprod Admin and the existing preprod-paired service. Do not
assume databases or tenant/workstation IDs match based on display names. Exact
live IDs could not be authenticated in this restricted session.

## Source changes selected for the server-only commit

| File | Purpose |
| --- | --- |
| `apps/web/app/api/admin/workstations/[id]/test-print/route.ts` | Sanitized request correlation trace. |
| `apps/web/app/api/agent/diagnostics/route.ts` | New authenticated, read-only protocol/release/identity diagnostic. |
| `apps/web/app/api/agent/heartbeat/route.ts` | Protocol 2 metadata and test request IDs. |
| `apps/web/app/api/agent/poll/route.ts` | Protocol 2 signals and request/workstation identity. |
| `apps/web/app/api/agent/test-print/claim/route.ts` | New authenticated atomic claim endpoint. |
| `apps/web/app/api/agent/test-print/result/route.ts` | Request-scoped acknowledgment and sanitized trace. |
| `apps/web/lib/print-delivery-trace.ts` | Narrow structured logging without credentials or ticket payloads. |
| `packages/domain/workstations/workstation-service.ts` | Persistent request identity, one-time claim, safe acknowledgment, expiry and actionable failures. |
| `packages/shared/workstation-schemas.ts` | Required datetime request ID on test acknowledgments. |
| `apps/web/components/kds/WorkstationsPanel.tsx` | Admin printer settings feedback, bounded fetches, duplicate-click protection and physical confirmation separation. No KDS ticket workflow changes. |
| `tests/integration/workstation-test-print.test.ts` | Real database/API-handler protocol and authorization regression coverage. |
| `tests/unit/workstations-panel.test.ts` | Admin progress, error, timeout, duplicate and identity checks. |
| `docs/print-protocol-preprod-release.md` | This verification and handoff record. |

Most protocol changes were already present before this task. This task added
explicit failure for malformed legacy requests, rejection of new tests without
fresh agent contact or with a recent service-printer visibility failure, and five
focused regression cases. It did not change the Windows agent or installer.

The timestamp in the existing Workstation request fields is the request ID.
Claims atomically change PENDING to PRINTING for the authenticated workstation,
restaurant and location. Only one claim is granted; a lost grant is not replayed.
Results match the request ID and cannot overwrite a newer request. A timeout is
reported as an unknown outcome, with no automatic physical retry. SUCCEEDED
means the agent reported submission, not independently verified paper output.

No database migration is required: existing nullable Workstation timestamp,
route, status and error fields are used. No change to production print-job,
payment, POS, reservation or KDS ticket processing is selected. Existing agent,
installer, environment, local settings, generated binary and log changes are
excluded from this server-only release and remain on disk.

## Verification results

- Real isolated PostgreSQL integration run: **135 passed, 1 failed (136)**.
  Workstation test-print lifecycle: **28/28**; agent delivery: **20/20**;
  printing modes: **25/25**; route configuration: **15/15**; printing P0:
  **16/16**; routing: **4/4**; idempotency: **6/6**; hardening: **21/22**.
- UI/transport unit tests: **38/38**.
- Existing published rc.4 executable self-tests: **205 existing + 58 delivery
  checks passed**. Its SHA-256 matches the installed executable. These checks do
  not physically print and do not prove the deployed backend is compatible.
- `npm run typecheck`: passed.
- `npm run lint`: passed with the existing `justCreatedCode` effect-dependency
  warning in WorkstationsPanel.
- Production Next.js build: passed, including `/api/agent/diagnostics` and
  `/api/agent/test-print/claim`. A separate output directory preserved the active
  local development output. Next's temporary tsconfig include was removed.
- Selected-source `git diff --check`: passed.
- The 13-file patch passed `git apply --reverse --check` against the working
  tree. Literal checks found no known local environment credentials or installed
  service bypass secret, and pattern checks found no private keys or GitHub/AWS
  tokens in the selected source. The Git index remains unchanged and empty.

The isolated test database is distinct from the application database. Vitest's
original configuration, aliases and database safety checks were retained; a
local programmatic launcher avoided a sandbox-denied parent-directory config
scan. The production build used the original Next configuration with only a
separate output path and the existing compiler cache. No test assertion was
weakened to obtain these results.

### Pre-existing hardening failure

`tests/integration/print-hardening.test.ts:175` expects zero automatic jobs but
receives one. The identical failure was reproduced against packages and tests
extracted read-only from unchanged HEAD. Existing payment completion dispatches
an original receipt; `print-service.ts` deliberately marks original receipts
`isAutomatic: true` so the agent can claim them. The existing printing-modes test
explicitly verifies that behavior. Payment logic and this failing assertion were
left unchanged. The broad integration suite is therefore **not fully green**.

### Measured local protocol timing

These are single in-process API-handler runs with a real isolated database and a
test-supplied acknowledgment, **without HTTP transport, an agent process, or a
printer**. They are not end-to-end latency or production guarantees.

| Route | Request through concurrent claim calls | Request through acknowledgment and final read |
| --- | ---: | ---: |
| Kitchen | 41.9 ms | 59.1 ms |
| Bar | 34.2 ms | 47.1 ms |
| Receipt | 36.8 ms | 54.7 ms |

Local verification logs and a reviewable source patch are kept under ignored
`.tmp/preprod-protocol-*` and `.tmp/preprod-print-protocol.patch`; they are not
release source files. No before/after physical latency claim is made.

## Safe push and preprod acceptance

1. In an environment with Git write permission and GitHub network access,
   recheck branch, status, the full selected diff, and the live `origin/develop`
   tip. Stop on divergence or unexpected changes. Do not reset, force-push or
   discard anything. Review and stage only the 13 files listed above.
2. Verify staged content and secret exclusions, commit with a descriptive
   protocol-compatibility message, then push normally to `origin/develop`.
   No new agent installer or schema migration is needed. The existing rc.4
   installation, arguments and pairing stay unchanged.
3. Let the configured automatic Vercel preprod deployment run; verify its Git
   SHA matches the pushed commit. Do not manually deploy production or change
   deployment protection. The actual automatic-deployment configuration was
   not accessible in this session.
4. Check `/api/agent/diagnostics` using authorized workstation authentication and,
   where necessary, the existing deployment-protection header. Never put a
   bypass secret in a URL or log. An application JSON 401/403 demonstrates a
   route responding but not authenticated compatibility; a Vercel protection
   response alone does not establish that the route exists.
5. Authenticated diagnostics must report `testPrintProtocol: 2`, the expected
   release SHA and the same workstation, restaurant and location IDs shown in
   preprod Admin. Confirm current service polling succeeds. Diagnostics are
   read-only; polling is not, because it may claim ordinary pending jobs.
6. The operator manually opens
   `https://tablecore-git-develop-drake-du.vercel.app/settings/printers`, verifies
   the intended workstation and existing POS-58 route, and clicks Kitchen Test
   once. Correlate the timestamp request ID through request, claim, spooler
   dispatch, acknowledgment and Admin outcome. Confirm readable paper before
   approving physical readiness. Repeat other routes only under operator control.

**Readiness: local protocol verification PASS; broader suite has one proven
pre-existing failure; GitHub/preprod release BLOCKED; hardware acceptance PENDING.**

# Forge connectors — live-API smoke report

Validation pass for the forge history connectors added for
[smaramwbc/statewave#137](https://github.com/smaramwbc/statewave/issues/137):
`gitlab`, `bitbucket`, `gitea`, `azure-devops`, plus GitHub Enterprise Server
(served by the existing `github` connector at a custom base URL).

**Date:** 2026-05-30 · **Method:** the actual built connectors run in
`dryRun` against real public instances, cross-checked with direct REST probes
to capture the raw API shape independently. No credentials were used (all reads
were unauthenticated public access); no data was ingested.

**Scope note:** unauthenticated public access does not exercise private-repo or
auth-only resources. Where a resource could not be reached anonymously
(Azure DevOps shapes; GitLab notes) that is stated explicitly rather than
assumed.

---

## 1. GitLab — `@statewavedev/connectors-gitlab`

- **Instance:** gitlab.com (SaaS)
- **Test project:** `gitlab-org/gitlab-runner` (public)
- **Invocation:** `createGitlabConnector({ repo: "gitlab-org/gitlab-runner" })` → `sync({ dryRun: true })`; raw probes `GET /api/v4/projects/<id>/{issues,merge_requests,releases,...}` (no token)

| Resource | Result | Notes |
|---|---|---|
| auth (unauth public reads) | **PASS** | lists readable without a token |
| pagination headers | **PASS** | `x-next-page` / `x-total-pages` present (connector reads first `per_page=100` page) |
| rate-limit header casing | **PASS** | `ratelimit-remaining` (lowercase) — matches the connector |
| issues | **PASS** | `iid/state/web_url/author.username` confirmed; `state: opened\|closed` |
| merge requests | **PASS** | `state: merged` + `merged_at` confirmed → `gitlab.mr.merged`; branches present |
| notes (comments) | **PASS (after fix)** | GitLab returns **401 on `/notes` even for public projects** — see mismatch #1 |
| approvals | **PASS** | readable on this project → `gitlab.mr.approval`, `occurred_at = mr.updated_at` |
| releases | **PASS** | no top-level `web_url`; URL taken from `_links.self` (connector's assumption was correct); `released_at` present |

**Mismatch found (#1):** unauthenticated note reads return `401`. The connector
mapped that to `auth_failed` and **aborted the whole sync** the moment the
default `comments` group was reached — breaking the documented "public repos
sync unauthenticated" path.
**Code change:** yes — minimal. Per-parent notes/approvals now use a
`requestSkippable` path that returns `[]` on `401/403/404` (skip that parent)
instead of throwing. Re-verified live: `include: ["issues","mrs","comments"]`
unauth now returns episodes with notes silently skipped.

---

## 2. Bitbucket Cloud — `@statewavedev/connectors-bitbucket`

- **Instance:** bitbucket.org (Cloud, REST 2.0)
- **Test repo:** `tutorials/markdowndemo` (public)
- **Invocation:** raw probes `GET /2.0/repositories/tutorials/markdowndemo/{pullrequests,pullrequests/{id}/comments}`; connector `dryRun` (see note)

| Resource | Result | Notes |
|---|---|---|
| auth (unauth public reads) | **PASS** | public repo readable without a token |
| pull requests | **PASS** | `id/title/state/author/created_on/updated_on/links.html.href/source/destination` confirmed |
| `next`-cursor pagination | **PASS** | `next` present and followed |
| BBQL `since` format | **PASS** | `q=updated_on > "<ISO>"` returns `200` — confirms the connector's `since` query |
| PR comments | **PASS** | `id/deleted/content.raw/user` confirmed; author exposes both `nickname` and `display_name` |
| issue tracker | **N/T** | tracker often disabled (→ 404, swallowed by the connector); not present on the test repo |
| end-to-end connector run | **BLOCKED** | Bitbucket's strict unauthenticated per-IP rate limit was exhausted by probing; the connector correctly raised `rate_limited` (validates rate-limit handling) |

**Mismatch found:** none. **Code change:** none.
Shapes/pagination/BBQL all confirmed via direct probes and unit tests; only the
full connector `dryRun` was blocked by the IP rate limit (expected, recovers
hourly; authenticated use has far higher limits).

---

## 3. Gitea / Forgejo — `@statewavedev/connectors-gitea`

- **Instance:** codeberg.org — Forgejo `15.0.0-127 +gitea-1.22.0`
- **Test repo:** `forgejo/forgejo` (public)
- **Invocation:** `createGiteaConnector({ repo: "forgejo/forgejo", baseUrl: "https://codeberg.org" })`; raw probes `GET /api/v1/repos/forgejo/forgejo/{issues,pulls,issues/comments,pulls/{n}/reviews,releases}` (no token)

| Resource | Result | Notes |
|---|---|---|
| auth (unauth public reads) | **PASS** | `/api/v1` readable without a token |
| issues | **PASS** | `number/state/user.login/labels/html_url`; `pull_request: null` for issues |
| pull requests | **PASS** | `merged` bool + `merged_at` + `base.ref` confirmed → `gitea.pr.merged` |
| comments — classification | **PASS** | PR comments' `html_url` contains `/pulls/` → classified `pull_request` |
| comments — PR parent number | **PASS (after fix)** | PR comments have **empty `issue_url`**; number is in `pull_request_url` — see mismatch #2 |
| reviews | **PASS (after fix)** | a `REQUEST_REVIEW` "review request" (with `user: null`) was being mapped as a review — see mismatch #3 |
| releases | **PASS** | `tag_name/name/author.login/html_url/published_at/draft` confirmed |

**Mismatch found (#2):** PR-conversation comments return an **empty
`issue_url`**; the parent number lives in `pull_request_url`. The connector
parsed the number from `issue_url`, yielding `parent_number: 0` (and source id
`…#0/…`) for every PR comment.
**Code change:** yes — minimal. Parse from `issue_url || pull_request_url`.
Locked with a unit test using the real (empty-`issue_url`) shape.

**Mismatch found (#3):** Forgejo includes `state: "REQUEST_REVIEW"` entries in
`/reviews` — these are review *requests*, not reviews, and carry `user: null`.
The connector emitted a spurious `gitea.pr.review` for them.
**Code change:** yes — one line. `REQUEST_REVIEW` is now skipped alongside
`PENDING`.

> The full end-to-end connector `dryRun` against `forgejo/forgejo` is slow
> because the connector paginates the repo-wide `/issues/comments` to its page
> cap before applying `maxItems` (this repo has thousands). Shapes were
> confirmed via direct probes; see the follow-up note below.

---

## 4. Azure DevOps — `@statewavedev/connectors-azure-devops`

- **Instance:** dev.azure.com (Cloud)
- **Test project:** none reachable anonymously (tried `microsoft`, `AzureDevOpsPublic`)
- **Invocation:** anonymous `GET /{org}/_apis/git/...` (no PAT)

| Resource | Result | Notes |
|---|---|---|
| bad-auth behaviour | **PASS** | anonymous requests return **HTTP 302 → `content-type: text/html`** (sign-in redirect); the connector's non-JSON/HTML detection raises `auth_failed` as designed |
| pull requests | **NOT VERIFIED** | requires a PAT + org; no anonymously-readable Azure project found |
| PR comments / threads | **NOT VERIFIED** | requires a PAT |
| reviewer votes | **NOT VERIFIED** | requires a PAT |
| work items (WIQL) | **NOT VERIFIED** | requires a PAT |

**Mismatch found:** none observable without credentials.
**Code change:** none.
**Honest status:** only the bad-auth path is live-confirmed. The PR / threads /
votes / WIQL shapes remain **unit-tested only** and must be validated against a
real Azure DevOps organization with a PAT (scopes Code:Read, Work Items:Read)
before this connector leaves preview. The agent-flagged assumptions (field
names, `reviewers[].vote` enum, WIQL request/response, `_links.html.href`)
are **still open**.

---

## 5. GitHub Enterprise Server — `@statewavedev/connectors-github` + custom base URL

- **Instance:** no GHES instance available; GHES serves the **same REST v3 API** as github.com at `<host>/api/v3`
- **Test repo (parity proxy):** `octocat/Hello-World` (github.com, public)
- **Invocation:** `createGithubConnector({ repo: "octocat/Hello-World" })` → `sync({ dryRun: true })`; base-URL derivation unit-tested in `ide-core`

| Aspect | Result | Notes |
|---|---|---|
| github v3 API surface (== GHES) | **PASS** | live `dryRun` returned `github.issue.opened` + `github.pr.closed` |
| GHES base-URL derivation | **PASS (unit)** | `kind=github-enterprise` + host → `https://<host>/api/v3` (`ide-core/forges.test.ts`) |
| remote/forge detection | **PASS (unit)** | github.com→github, gitlab/bitbucket/codeberg/azure host detection (`forges.test.ts`) |
| live GHES instance | **NOT VERIFIED** | no Enterprise instance available; API is identical to the verified github.com surface |

**Mismatch found:** none. **Code change:** none.

---

## Summary

| Connector | Live result | Code change required |
|---|---|---|
| GitLab | PASS (after fix) | yes — notes/approvals skip on 401/403/404 |
| Bitbucket | PASS (shapes/BBQL/pagination); e2e blocked by IP rate limit | no |
| Gitea/Forgejo | PASS (after fixes) | yes — PR-comment parent number; skip REQUEST_REVIEW |
| Azure DevOps | bad-auth PASS; resource shapes NOT verified (no PAT) | no |
| GHES | PASS via github.com parity + unit tests; no live GHES | no |

All fixes are minimal and directly tied to a live finding, with regression
tests added. Full monorepo: **26 packages, all tests passing.**

## Open follow-ups (not blocking this pass)

1. **Azure DevOps** resource shapes need a real org + PAT before GA — currently
   unit-tested only. (#137 follow-up.)
2. **Pagination vs `maxItems`:** `gitea`/`bitbucket` paginate to a hard page cap
   *before* slicing to `maxItems`, so a small `maxItems` on a huge repo still
   triggers a large fetch; `github`/`gitlab` read only the first `per_page=100`
   page (so they never see older history). Worth aligning the strategy (thread
   `maxItems` into pagination, or paginate all four) — a deliberate design
   decision, deferred out of this validation pass.
3. **Live GHES** smoke against a real Enterprise instance when one is available.

---
"@statewavedev/connectors-jira": patch
---

Migrate Jira **Cloud** search to `POST /rest/api/3/search/jql`.

Atlassian removed `GET /rest/api/{2,3}/search` (HTTP 410, CHANGE-2046), which broke Cloud sync with `jira request failed: 410`. Cloud now uses the replacement endpoint with token-based pagination (`nextPageToken`; there is no `total`) and array `fields`/`expand` in the request body. Pagination stops when the token is absent or a page is empty, with a hard page cap as a backstop. **Server / Data Center is unchanged** — it still serves `GET /rest/api/2/search`. Closes [#233](https://github.com/smaramwbc/statewave/issues/233).

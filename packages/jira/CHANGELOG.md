# @statewavedev/connectors-jira

## 0.4.2

### Patch Changes

- [#110](https://github.com/smaramwbc/statewave-connectors/pull/110) [`b14d588`](https://github.com/smaramwbc/statewave-connectors/commit/b14d588d626d620765627d1622dacc7ae34b2975) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Send Jira Cloud `/search/jql` `expand` as a comma-separated string so status-transition syncs no longer fail with HTTP 400.

## 0.4.1

### Patch Changes

- [#93](https://github.com/smaramwbc/statewave-connectors/pull/93) [`cc5bc65`](https://github.com/smaramwbc/statewave-connectors/commit/cc5bc6588eec2f285f7bc20a4d9438e2762ec71c) Thanks [@smaramwbc](https://github.com/smaramwbc)! - Migrate Jira **Cloud** search to `POST /rest/api/3/search/jql`.

  Atlassian removed `GET /rest/api/{2,3}/search` (HTTP 410, CHANGE-2046), which broke Cloud sync with `jira request failed: 410`. Cloud now uses the replacement endpoint with token-based pagination (`nextPageToken`; there is no `total`) and array `fields`/`expand` in the request body. Pagination stops when the token is absent or a page is empty, with a hard page cap as a backstop. **Server / Data Center is unchanged** — it still serves `GET /rest/api/2/search`. Closes [#233](https://github.com/smaramwbc/statewave/issues/233).

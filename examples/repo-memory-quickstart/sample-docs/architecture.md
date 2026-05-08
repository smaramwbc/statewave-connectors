# Architecture: how connectors feed memory

Statewave organizes everything around **subjects**. For repository memory the
subject is `repo:<owner>/<repo>`. Every connector that has something to say
about a repo writes its episodes under that one subject.

```
GitHub          ─┐
Markdown / docs ─┼──▶  episodes (subject = repo:owner/name)  ──▶  compiled memory  ──▶  agent context
Slack channel   ─┘                                                    │
                                                                      ▼
                                                     statewave_get_context (MCP)
```

This document is itself a `docs.decision` episode (because the path includes
`architecture`) — when the demo runs the markdown dry-run, you'll see this
file mapped to `kind=docs.decision`.

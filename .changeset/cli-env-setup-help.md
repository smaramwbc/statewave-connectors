---
"@statewavedev/connectors-cli": minor
---

Show OS-aware guidance for setting environment variables, so users don't have to guess the syntax.

The root help and `doctor` listed the variables the CLI reads (`STATEWAVE_URL`, connector tokens) but not *how* to set them — which differs per OS and shell. Both now print a `setting environment variables` block tailored to the platform: `export … >> ~/.zshrc`/`~/.bashrc` on macOS/Linux (shell auto-detected via `$SHELL`), and `$env:` / `setx` / `set` on Windows. `doctor` shows it whenever a variable is unset.

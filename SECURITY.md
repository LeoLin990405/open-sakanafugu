# Security Policy

## Secret Handling (core security constraint of this repo)

This workflow orchestrates several Chinese-model providers and **will touch API keys**. The repo's hard constraints:

- **Real keys never enter the repo.** They live only in `~/.config/cc-model-secrets.env` (read by the launcher, highest priority) or in your project-local `.fugue-cc/provider.config` (ignored by `.gitignore`).
- The repo only tracks `orchestration/fugue-cc/provider.config.example`, whose `key=` values are always `<...>` placeholders.
- `.gitignore` ignores `**/.fugue-cc/provider.config`, `*secrets*.env`, `.env*`.
- Every commit/push passes three gates:
  1. `npm run scan` / `scripts/scan-secrets.ts` — plaintext key fingerprints (`sk-`/`tp-`/zhipu format) + `provider.config*`'s `key=` must be a placeholder.
  2. `gitleaks` (`.gitleaks.toml`) — scans the full git history.
  3. CI's `secret-scan` job runs both; red blocks the merge.
- Enable locally: `pipx install pre-commit && pre-commit install`, and it scans automatically on commit.

### If a key leaks

1. Immediately **revoke/rotate** that key in the corresponding provider console.
2. Clean history with `git filter-repo` or BFG, then force-push.
3. Don't just delete one commit — once a key is pushed to a public repo it must be considered compromised and must be rotated.

## Reporting Vulnerabilities

If you find a security issue (key-leak path, injection, permission bypass, etc.), please **do not open a public issue**.
Report privately via GitHub Security Advisory (repo Security -> Report a vulnerability),
or email the repo owner. We will respond as soon as possible.

## Support Scope

This is a personally maintained workflow tool repo, maintained best-effort, with no SLA.

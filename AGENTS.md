# R&R (forge-cad) — agent instructions

## Deploy: always commit and push to live

After any code change in this repo, **commit and push to `main` on GitHub** before
considering the task done. Local-only changes are not live.

### Workflow (required at end of every task)

1. `git status` — confirm what changed.
2. `git add` + `git commit` with a clear message.
3. `git push origin main`.
4. Tell the user the commit SHA and that GitHub Pages will redeploy (1–3 min).

### Live URLs (GitHub Pages auto-deploys on push to `main`)

- PWA: https://solexecution.github.io/randr/
- Single-file: https://solexecution.github.io/randr/RandR.html

### Notes

- Git repo root: `forge-cad/` (not the parent `3d/` folder).
- `RandR.html` and `Forge-CAD.html` are gitignored locally; CI builds them on deploy
  (`.github/workflows/deploy.yml`). Pushing source to `main` is what updates live.
- Do not leave completed work uncommitted unless the user explicitly asks to hold it.
# Contributing

## Branch discipline: `main` is production

Whatever is on `main` is what runs in production, or is about to. Everything
else follows from that.

- **Never commit or push directly to `main`.** Every change lands through a
  pull request, including one-line fixes, docs, and release commits.
- **A PR merges only when CI is green** (`.github/workflows/ci.yml`: typecheck,
  web typecheck, tests, server build, web static export). Branch protection
  enforces this on GitHub.
- **Only deploy `main`.** Never deploy a feature branch, an unmerged change, or
  a dirty working tree to production. Once the new host is wired up, merging
  to `main` *is* the deploy, and manual deploys go away.
- **No long-lived branches.** There is no `develop` or `staging`. Branch off
  the latest `main`, keep the branch small, merge it, delete it.

### Workflow

```bash
git switch main && git pull --ff-only
git switch -c feat/short-description
# ...work, commit...
git push -u origin feat/short-description
gh pr create
```

After merge, delete the branch (GitHub's "Delete branch" button, or
`git branch -d feat/short-description` locally).

If `main` moves while your PR is open, rebase onto it (`git pull --rebase
origin main`) rather than merging `main` into your branch.

### Branch names

Use the same type prefixes as the commit messages:

| Prefix      | For                                            |
|-------------|------------------------------------------------|
| `feat/`     | New user- or provider-facing behavior          |
| `fix/`      | Bug fixes                                      |
| `chore/`    | Tooling, deps, CI, repo hygiene                |
| `docs/`     | Documentation only                             |
| `release/`  | Version bump + changelog for a release         |
| `hotfix/`   | Urgent production fix (same rules, just fast)  |

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, for example `fix(provider): a long silence is not "never
checked in"`. Explain *why* in the body. The project's history has many
examples.

### Hotfixes

A production emergency goes through the same process, only faster: branch
`hotfix/…` off `main`, open a PR, wait for CI, merge. Don't skip CI. A fix
that breaks the build makes the emergency worse.

### Pull requests

- Keep each PR to one concern. Split unrelated fixes into separate PRs.
- Add an entry under `[Unreleased]` in `CHANGELOG.md` for anything a user,
  provider, or operator would notice.
- Say how you verified the change: tests added, smoke run, or clicked
  through in the PWA.
- Changes to danger-sign patterns, consent/erasure, or auth need extra care.
  See CLAUDE.md's "Non-obvious points" before touching them.

## Releases

The project follows [Semantic Versioning](https://semver.org/). While it is
`0.x`, bump the **minor** version for new features and the **patch** version
for fixes.

1. Branch `release/vX.Y.Z` off `main`.
2. Bump `version` in `package.json` and `apps/web/package.json`.
3. Move `CHANGELOG.md`'s `[Unreleased]` entries under `## [X.Y.Z] - YYYY-MM-DD`.
4. PR with the commit message `chore(release): cut vX.Y.Z`, then merge.
5. Tag the merge commit on `main`:
   `git switch main && git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z`.

Only tag commits that are on `main`.

## Repository settings (admin, one-time)

A repo admin sets up branch protection under **Settings → Rules → Rulesets**
(or **Settings → Branches**), targeting `main`:

- Require a pull request before merging
- Require status checks to pass: `verify`
- Require branches to be up to date before merging
- Block force pushes and deletions

Also under **Settings → General**: enable *Automatically delete head branches*.

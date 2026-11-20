# DevOps: how code reaches production

## The flow

```
push to cleanup/sdk-server-only ──► CI: full test suite (Redis + Postgres) ──► pass ──► deploy/prod moves to that commit ──► the server deploys deploy/prod
                                                                          └──► fail ──► nothing deploys
```

- **CI** (`.github/workflows/ci.yml`, job `test`) runs `npm test` on every push to any branch and on every pull request, with a real Redis (AOF on) and a throwaway
  Postgres, so the cluster and trade-history tests run too. It uses no secrets: every test runs offline against stand-ins. The repository is public, so never add any.
- **The gate** (job `release`) runs only for pushes to `cleanup/sdk-server-only`, and only after `test` passed. It moves `deploy/prod` forward to the tested commit.
  It never rewinds `deploy/prod`: if `deploy/prod` is not an ancestor of the new commit, it stops and says so.
- **The server** must deploy `deploy/prod`, not the working branch. Until its auto-deploy is pointed at `deploy/prod`, every push still goes live untested.

## One-time setup (owner)

1. **Point the server's auto-deploy at `deploy/prod`.** The auto-deploy that serves https://mintmeme.openledger.dev/deploy-status lives on the server, not in this
   repository; change the branch it watches from `cleanup/sdk-server-only` to `deploy/prod`. `deploy/prod` is created by the first green CI run on the working branch.
2. **Protect `deploy/prod`** (GitHub → Settings → Rules → Rulesets → New branch ruleset, target `deploy/prod`): block force pushes and deletions. Leave yourself
   (repository admin) in the bypass list so a rollback stays possible.
3. **Optional: require CI on pull requests** to `cleanup/sdk-server-only` (same place, "Require status checks to pass", check `test`).

## Roll back

Point `deploy/prod` at an earlier commit that passed CI; the server deploys it like any other change.

```bash
gh run list --workflow CI --branch cleanup/sdk-server-only --status success --limit 10
```

```bash
git fetch origin && git push --force origin <good-commit-sha>:refs/heads/deploy/prod
```

The next green commit on the working branch moves `deploy/prod` forward again (the rolled-back commit is its ancestor). To stop that, fix or revert on the working
branch first.

## Check a deploy

- Deploy status: https://mintmeme.openledger.dev/deploy-status (branch and commit the server runs).
- Health: https://mintmeme.openledger.dev/status.json (Redis, Postgres, RPCs, Privy, nodes).
- CI runs: `gh run list --workflow CI --limit 5`

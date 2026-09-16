# Backup repository maintenance

`justoneapi-labs/justoneapi-python` receives reviewed versions from
`justoneapi/justoneapi-python`. It keeps the upstream code, examples, commit
history, and version tags. Backup-specific workflow changes remain on `main`.

## Workflows

- CI runs with read-only repository permissions. It checks generated code and
  runs tests without publishing changes.
- SDK generation and version updates, README refreshes, and release jobs are
  restricted to `justoneapi/justoneapi-python` by job conditions in the backup's
  current `main`. These conditions do not modify historical refs.
- The schedules and manual triggers remain in those three workflow definitions,
  but their jobs are skipped in the backup repository.
- `auto-commit` is an explicit exception: it runs only in the backup repository
  and creates an empty commit on `main` without modifying SDK code or data.
  It is scheduled every five minutes and also supports pushes to `main` and
  manual runs. GitHub may delay scheduled runs; this is not an exact timer.
  It uses the built-in `GITHUB_TOKEN`, with no separate publishing credentials.

Do not configure OpenAPI, translation, or PyPI publishing credentials for the
backup while it serves this role.

## Manually synchronize a reviewed local version

Start with clean working trees in both repositories and the backup checked out
on `main`. Commit any approved backup configuration changes before merging
subsequent upstream changes. First update the backup's own remote history,
including any new empty commits. Primary repository content still comes from
the local primary checkout; these commands do not update that source checkout.

From the backup repository directory, run each command only after the preceding
command succeeds. These paths assume the primary checkout is at
`../../justoneapi-python`; adjust that path if your directory layout differs:

```sh
git status --short --branch
git -C ../../justoneapi-python status --short --branch

git fetch --no-tags origin main
git merge --ff-only origin/main

git fetch --no-tags ../../justoneapi-python \
  refs/heads/main:refs/remotes/backup-source/main \
  'refs/tags/*:refs/tags/*'

git merge --no-ff --no-commit refs/remotes/backup-source/main

git diff --cached --stat
git diff --cached -- .github/workflows
git status --short --branch
```

The merge preserves upstream commits and existing backup configuration instead
of replacing the backup branch. It does not create a merge commit or push.
Stop if Git reports a conflict or a conflicting tag; do not force an update.
Resolve conflicts and inspect all workflow changes before committing. Retain
the primary-repository conditions on the SDK update, README update, and release
jobs; retain the backup-repository condition on `auto-commit`. Check any newly
added workflows. Also inspect any unstaged changes after resolving conflicts.

If the initial fast-forward merge is refused because local and remote backup
commits have diverged, merge the remote history and review it before proceeding.
Empty commits may also arrive while reviewing an upstream merge. If a normal
push is rejected, fetch and merge those newer backup commits before retrying;
do not force-push or discard their history.

Version tags remain local until explicitly approved for publication. Do not
push all tags as part of routine backup synchronization. Before publishing
historical tags, disable the backup repository's release workflow in GitHub
and verify its state: a historical tag can contain an older workflow without
the current backup conditions. The same consideration applies to manually
dispatching a workflow on a historical ref.

GitHub documents [which workflow version runs for an event](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)
and [how to disable a workflow at repository level](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

If the backup becomes the primary repository, review the workflow conditions,
repository links, secrets, and PyPI publishing authorization as a separate
handover before enabling generation or publishing.

# OWLS external consumer suite

- Follow `ORESoftware/my-ai/AGENTS.md`. Never rebase, reset, stash, force-push, or commit `.ores/`.
- Consume immutable upstream revisions in `zed_modules/`; never reach into sibling working trees.
- TypeSpec and independently authored JSON Schema are peer authorities. Generated Schema B, Contract IR, projection receipts, fixtures, and this repository are downstream evidence only.
- `corpus/release-corpus.json` is preserved historical evidence. Do not rewrite it to make a current implementation pass. Contract evolution belongs in `corpus/expectation-overrides.v2.json`, bound to the reviewed Git blob and accompanied by a specific reason.
- A case is `host` only when independently authored Schema A accepts it. Verify rather than guess.
- Missing source inputs, compilers, fixtures, or mandatory jobs are failures. Never let an unrun or skipped suite report green.
- Preparation is fetch/verify/cache only. It must not instantiate Wasm, authenticate, subscribe, mutate durable state, or intercept navigation.
- Browser, Rust, Flutter/Dart, TypeScript, Go, and Gleam checks must target recorded revisions and preserve their host-specific security boundaries.
- Merge current `main` into long-lived feature branches when synchronization is needed. Resolve conflicts by preserving the stricter compatible behavior and all relevant tests.

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.

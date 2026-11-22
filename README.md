# makefun-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adiprmx/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adiprmx/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files, matching lines at three tiers and changing everything or nothing. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only; nothing to install. `PATCH` is the patch file; when it is absent or `-`, the patch is read from standard input. The working directory is the root of the tree the patch applies to.

## What it does

- Reads a patch in one of four formats, detected automatically (`--format=unified`, `search-replace`, `v4a`, `json`, or `auto`): unified diffs (with wrong line numbers, CRLF files and missing final line breaks), SEARCH/REPLACE blocks (with prose and code fences around them), V4A patches (anchors, cursors, end-of-file chunks, moves), and JSON edit objects (`create`, `str_replace`, `insert`).
- Finds each edit's old lines at the first of three matching tiers that has an occurrence: exact, trailing whitespace ignored, or leading and trailing whitespace ignored (`--strict` tries the exact tier only). Context lines are written as the file's own lines; at the third tier the other new lines are re-indented to the file.
- Applies every edit or none of them: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written. `--check` reports what would change without writing anything.
- Prints one line per changed path (`A`/`D`/`M`, `R <old> -> <new>` for moves) and `ok: <n> files`; exit 0 on success, 1 when edits failed, 2 on usage, unreadable patch, unknown format or unparsable patch.

## Files

- `main.ts` — the whole tool.
- `runner.ts` — the kit's runner (unchanged); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.

---

Entered on [make.fun](https://make.fun/?ref=1c6jcmp6&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards

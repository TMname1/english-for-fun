# Knowledge Graph: use the `code-review-graph` CLI

**This project has a knowledge graph (`.code-review-graph/graph.db`). Start with the
graph to narrow scope, then read the source.** The graph is cheaper than scanning files and
gives you structural context (callers, dependents, test coverage) that file search cannot.

## Access method: CLI only — do NOT try the MCP tools

Use the shell CLI: `uvx code-review-graph <subcommand>` (run from the repo root; every
subcommand accepts `-h` for its flags). The graph tools are **not callable as MCP tools**
in this environment: calls to `mcp__code_review_graph__*` fail with "unsupported call", and
`list_mcp_resources` / `read_mcp_resource` return nothing because the server exposes no
resources. Do not probe those paths; go straight to the CLI.

If `uvx` fails to persist its cache inside the restricted sandbox, rerun the same command
with elevated approval (it works outside the sandbox).

## When to use the graph FIRST

- **Exploring code**: `search` / `query` instead of Grep
- **Understanding impact**: `impact` instead of manually tracing imports
- **Code review**: `detect-changes` instead of reading entire files
- **Finding relationships**: `query` with patterns such as `callers_of` / `callees_of` /
  `imports_of` / `tests_for`
- **Architecture questions**: `architecture` + `communities`

## Verify in the source

- Narrow scope with the graph, then read the source. Do not change code from graph output alone.
- For any non-trivial change, read the implementation and the relevant tests before concluding.
- Verify the exact source when touching behavior, database logic, migrations, retries, fallbacks,
  recovery, or compatibility code.
- When the graph and the source disagree, the source wins. The graph may be stale or may not
  model that relationship.
- An empty graph result can mean "not indexed" or "not statically visible", not "does not exist".

## Key subcommands

| Subcommand       | Use when                                                     |
| ---------------- | ------------------------------------------------------------ |
| `detect-changes` | Reviewing code changes — risk-scored analysis (read-only)    |
| `query`          | Tracing callers, callees, imports, tests, dependencies       |
| `search`         | Finding functions/classes by name or keyword                 |
| `impact`         | Understanding blast radius of a change                       |
| `flows` / `flow` | Listing or inspecting stored execution flows                 |
| `architecture`   | Understanding high-level codebase structure                  |
| `communities`    | Module/community clusters (`community` for one)              |
| `wiki`           | Generating a markdown wiki from the community structure      |
| `dead-code`      | Finding functions/classes with no callers or test references |
| `refactor`       | Planning renames, finding dead code                          |
| `status`         | Graph stats and staleness/branch-mismatch warnings           |
| `update`         | Incremental refresh when `status` reports the graph is stale |

## Workflow

1. Hooks auto-update the graph on file changes, but still check `status` first; if it warns
   that the graph was built on another branch/commit, run `update` before relying on results.
2. Use `detect-changes` for code review.
3. Use `impact` (and `flows`/`flow`) to understand which execution paths are affected.
4. Use `query tests_for <symbol>` to check coverage.

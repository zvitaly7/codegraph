# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-08-19

### Changed — behaviour that differs from 0.2.1

- **`explorer --serve` binds `127.0.0.1` instead of every interface.** The
  browser index names every file and symbol in the repository, so reaching it
  from another machine now takes a deliberate `--host 0.0.0.0`.
- **An unknown key in `loregraph.config.*` is an error.** A key nothing reads is
  a setting that silently does nothing, and under `describe` that meant spending
  money at defaults nobody chose. Commands now exit `2` naming the offending key
  and the nearest known one. Values are shape-checked too.
- **A workspace package that resolves to no indexed file counts as unresolved,
  not as a third party.** The name is already known to be ours; calling it a
  third party dropped the dependency from the domain layer and scored a miss as
  a success. On a monorepo whose shared packages publish a build this moves
  imports out of `external` and *lowers* the reported resolution rate — the rate
  had been flattering itself.

### Added

- **`exports` declares the published surface.** The package is a command line and
  an MCP server; a deep import of an internal module is now refused by Node rather
  than working by accident, so internals can move without breaking a consumer who
  reached past the front door.
- **Every `--json` answer carries `schemaVersion`, `tool` and `version`**, first in
  the object. The graph artifacts had said so since the first release; the answers
  scripts and agents actually parse had not.

- **Workspace packages are discovered from `node_modules` symlinks**, not only
  from a declared `workspaces` field. The declaration is out of reach when a
  subdirectory of a larger monorepo is analyzed on its own, or when the install
  is per-application with no root manifest.
- **`paths` / `pathsBase` config keys** — a `tsconfig`-shaped alias table for
  repositories that ship no `tsconfig.json`. Merged per pattern: a `tsconfig`
  keeps every pattern it declares, the config supplies the rest.
- **The imports layer reports the repo's own packages no import could reach**,
  with the count behind each and a `paths` mapping read off the index that would
  restore them. Recorded in `imports/manifest.json` as
  `counts.unresolvedPackages` for anything that wants to gate on it.
- **`init` offers that mapping after the first build** and writes it into the
  config it generated. A config that already sets `paths` is left alone; a
  hand-written one gets a snippet to paste.
- **The domains layer says when its overlay learned nothing** — no configured
  source root exists in the repository, or no domain depends on another while
  internal imports exist.
- **`explorer --host ADDR`** for the deliberate case.

### Fixed

- **`.mts` and `.cts` are resolvable.** The inventory has always classified them
  and the type-checking layers read them, but the import resolver did not list
  them, so no import could land on one.
- **A workspace entry pointing at build output resolves to the source it was
  built from** — `dist/export/index.mjs` is also tried as `src/export/index`,
  and as `export/index`.
- **Symlinked checkouts are recognised as themselves.** Link targets were
  compared against a non-realpath repo root, so a checkout reached through a
  symlink (macOS `/tmp` and `/var` are, routinely) looked like it lived outside
  itself.
- **The MCP server reports the package version** instead of a hardcoded
  `0.1.0`, which it had been sending since the first release.
- **A `paths` target rebased onto a tsconfig's base stays POSIX.** `path.relative`
  answers in the platform's separators, so on Windows the merged alias table mixed
  `packages/*/src` with `packages\*\src` and half the aliases resolved by luck.
  Found by the first Windows run in the project's life.

### CI

- **The suite runs on every push** across Node 18/20/22 and Ubuntu/macOS/Windows,
  with a second job that rebuilds the graph twice and compares all twelve
  node/edge files — the determinism the tool rests on, checked rather than
  asserted. Until now tests only ran when publishing a tag.
- The suite itself was full of POSIX assumptions no one had ever exercised: a
  hardcoded `/tmp/x`, a dirname taken with `split('/')`, an execute bit Windows
  does not have, and temp paths whose 8.3 short form the test runner's module
  loader cannot turn into a `file://` URL. All fixed; none of them were the tool.

## [0.2.1] and earlier

See the git history — this file starts here.

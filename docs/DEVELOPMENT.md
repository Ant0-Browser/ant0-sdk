# Working on this repository

## Node (`node/`)

Needs Node 20 or newer for development. The package supports Node 18 or newer.

```bash
cd node
npm ci
npm run build       # compile to dist/
npm run typecheck
npm run lint
npm test
```

## Python (`python/`)

Needs Python 3.9 or newer.

```bash
cd python
python -m venv .venv && . .venv/bin/activate
pip install -e ".[test]" ruff
ruff check .
pytest
```

## What the tests need

The tests run without the Ant0 app, the engine or an account. Two test files use a real engine
and skip when it is missing:

- `node/test/geometry.live.test.ts` and `node/test/launch-popup.live.test.ts` run only when
  `ANT0_BROWSER_LIVE_ENGINE` points at an engine executable.
- `python/tests/test_launch_popup_live.py` does the same.

Test input lives in `fixtures/`. The files in `fixtures/synthetic/` are made up by hand: a small persona
(a made-up GPU "Example GPU", a short font list, one voice), a tiny population model with two values per
group, and hash vectors. They contain no data captured from a real machine and no real population data.
Both SDKs read the same files, so Node and Python stay in parity.

Not every test of the SDK code is in this repository:

- `fixtures/release/` holds a signed sample for the release-signature tests. It is public.

## Releases

The version in `node/package.json` and `python/pyproject.toml` must match. Add the entry to
[CHANGELOG.md](../CHANGELOG.md) first.

Packages are not published from this repository. They are built and published by Ant0's release
pipeline, with the same version as the source tag. `.github/workflows/release.yml.draft` is a disabled
draft kept for reference; it does not run.

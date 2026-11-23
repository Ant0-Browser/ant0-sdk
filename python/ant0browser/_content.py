"""set_content: Playwright's ``page.set_content`` times out on Ant0 (the engine removes the
``console.debug`` handshake it waits on). This sets the document the plain-DOM way instead:
``document.open()``, ``document.write(html)``, ``document.close()``, then waits for the same
lifecycle point. Mirror of the Node SDK's ``setContent``.
"""
from __future__ import annotations

import asyncio

_UNTIL = ("load", "domcontentloaded", "networkidle", "commit")

# Runs in the page; Playwright calls a function-shaped string with the argument.
_WRITE_JS = """({html, until}) => new Promise((resolve) => {
  document.open(); document.write(html); document.close();
  const done = () => until === 'load' ? document.readyState === 'complete'
    : document.readyState === 'interactive' || document.readyState === 'complete';
  if (until === 'commit' || done()) { resolve(); return; }
  document.addEventListener('readystatechange', () => { if (done()) resolve(); });
})"""


def _check(wait_until):
    if wait_until not in _UNTIL:
        raise ValueError(f"set_content: unsupported wait_until {wait_until!r}")
    return "load" if wait_until == "networkidle" else wait_until


def _page_of(target):
    page = getattr(target, "page", None)
    return page if page is not None and not callable(page) else target


def set_content(target, html, wait_until="load", timeout=30000):
    """Replace the page's (or frame's) document with ``html`` and wait. Use instead of
    ``page.set_content``. ``timeout`` (ms) bounds the ``networkidle`` wait; the sync Playwright API
    cannot bound the in-page wait itself (the async twin does)."""
    until = _check(wait_until)
    kw = {"timeout": timeout} if timeout else {}
    target.evaluate(_WRITE_JS, {"html": str(html), "until": until})
    if wait_until == "networkidle":
        _page_of(target).wait_for_load_state("networkidle", **kw)


async def set_content_async(target, html, wait_until="load", timeout=30000):
    """Async twin of :func:`set_content`."""
    until = _check(wait_until)
    write = target.evaluate(_WRITE_JS, {"html": str(html), "until": until})
    try:
        await (asyncio.wait_for(write, timeout / 1000) if timeout else write)
    except asyncio.TimeoutError:
        raise TimeoutError(f"set_content: timeout {timeout}ms exceeded waiting for {wait_until!r}") from None
    if wait_until == "networkidle":
        kw = {"timeout": timeout} if timeout else {}
        await _page_of(target).wait_for_load_state("networkidle", **kw)

"""Real-browser checks for launch() without --disable-popup-blocking and --hide-scrollbars.

Skipped unless ANT0_BROWSER_LIVE_ENGINE points at a chrome binary (the local binary verification gate).
ANT0_BROWSER_LIVE_MINT (a script that prints a launch ticket for the version given as its argument) and
ANT0_BROWSER_LIVE_ENGINE_VERSION are used for an engine that checks launch tickets.
A click on a button whose handler calls window.open must still open a popup that the context's ``page``
event reports, and the two switches must really be gone from the browser a page sees.
"""
import os
import subprocess
import sys

import pytest

import ant0browser
from ant0browser import async_api

LIVE_EXE = os.environ.get("ANT0_BROWSER_LIVE_ENGINE")
pytestmark = pytest.mark.skipif(not LIVE_EXE, reason="ANT0_BROWSER_LIVE_ENGINE not set")

BUTTON = "data:text/html,<button id=b onclick=\"window.open('about:blank%23popup')\">open</button>"
# A page whose own timer calls window.open() (no user gesture): null (or undefined) with popup blocking on, a Window with
# --disable-popup-blocking. (page.evaluate() is not used: Playwright runs it with a user gesture.)
TIMER = ("data:text/html,<title>wait</title><script>setTimeout(() => { document.title = "
         "(w => w === null || w === undefined)(window.open('about:blank%23timer')) ? 'blocked' : 'opened'; }, 300)</script>")
# A scrollbar is 15 px wide unless --hide-scrollbars is passed.
SCROLLBAR = "() => window.innerWidth - document.documentElement.clientWidth"
TALL = "data:text/html,<body style='margin:0'><div style='height:5000px'>tall</div></body>"


def _kw():
    mint, version = os.environ.get("ANT0_BROWSER_LIVE_MINT"), os.environ.get("ANT0_BROWSER_LIVE_ENGINE_VERSION")
    ticket = subprocess.check_output(["python3", "-I", mint, version], text=True).strip() if mint and version else False
    return dict(executable_path=LIVE_EXE, args=["--no-sandbox"], quiet=True, launch_ticket=ticket, headless=True,
                identity={"mode": "native"})


def _assert_stock_behaviour_sync(page):
    page.goto(TIMER)
    page.wait_for_timeout(1000)  # no evaluate meanwhile: Playwright evaluates with a user gesture
    assert page.title() == "blocked"  # popup blocking is on, as in a normal Chrome
    page.goto(TALL)
    assert page.evaluate(SCROLLBAR) > 0  # scrollbars are shown


def test_click_popup_opens_and_the_context_reports_it_sync():
    browser = ant0browser.launch(**_kw())
    try:
        ctx = browser.new_context()
        seen = []
        ctx.on("page", lambda p: seen.append(p))
        page = ctx.new_page()
        page.goto(BUTTON)
        with ctx.expect_page() as info:
            page.click("#b")
        assert info.value.url == "about:blank#popup"
        assert any(p.url == "about:blank#popup" for p in seen)  # context.on("page") fired
        _assert_stock_behaviour_sync(page)
    finally:
        browser.close()


def test_click_popup_opens_and_the_context_reports_it_persistent(tmp_path):
    ctx = ant0browser.launch_persistent_context(str(tmp_path / "udd"), **_kw())
    try:
        seen = []
        ctx.on("page", lambda p: seen.append(p))
        page = ctx.new_page()
        page.goto(BUTTON)
        with ctx.expect_page() as info:
            page.click("#b")
        assert info.value.url == "about:blank#popup"
        assert any(p.url == "about:blank#popup" for p in seen)
        _assert_stock_behaviour_sync(page)
    finally:
        ctx.close()


async def _async_scenario():
    browser = await async_api.launch(**_kw())
    try:
        ctx = await browser.new_context()
        seen = []
        ctx.on("page", lambda p: seen.append(p))
        page = await ctx.new_page()
        await page.goto(BUTTON)
        async with ctx.expect_page() as info:
            await page.click("#b")
        assert (await info.value).url == "about:blank#popup"
        assert any(p.url == "about:blank#popup" for p in seen)
        await page.goto(TIMER)
        await page.wait_for_timeout(1000)  # no evaluate meanwhile: Playwright evaluates with a user gesture
        assert await page.title() == "blocked"  # popup blocking is on, as in a normal Chrome
        await page.goto(TALL)
        assert await page.evaluate(SCROLLBAR) > 0  # scrollbars are shown
    finally:
        await browser.close()


def test_click_popup_opens_and_the_context_reports_it_async():
    # Its own process: Playwright's sync API (the tests above) and an asyncio loop cannot share one.
    done = subprocess.run([sys.executable, os.path.abspath(__file__)], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]


if __name__ == "__main__":
    import asyncio
    asyncio.run(_async_scenario())

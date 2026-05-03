"""Smoke-test the GitHub Pages site against the sample fixture in a real browser.

Run a local static server, open the page in headless Chromium, upload the
fixture PDF, click "Generate snapshot", wait for the PNG, and write it to
disk for visual inspection.

Usage:
    python tests/smoke_browser.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent
URL = "http://localhost:8765/index.html"
FIXTURE = ROOT / "tests" / "fixtures" / "sample.pdf"
OUT = ROOT / "output" / "browser-smoke.png"


def main() -> int:
    if not FIXTURE.exists():
        print(f"Fixture missing: {FIXTURE}")
        return 2

    OUT.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1280, "height": 1400})
        page = context.new_page()

        console_msgs: list[str] = []
        page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: console_msgs.append(f"[pageerror] {err}"))

        page.goto(URL, wait_until="networkidle")

        # Upload fixture via the hidden input
        page.set_input_files("#file-input", str(FIXTURE))

        # The action bar should appear
        page.wait_for_selector("#actions:not([hidden])", timeout=5_000)

        # Click "Generate snapshot"
        page.click("#process-btn")

        # Wait for either a result preview img or an error card
        try:
            page.wait_for_selector(".preview-card img, .error-card", timeout=30_000)
        except Exception as e:
            print("Timed out waiting for result.")
            print("Console messages:")
            for m in console_msgs:
                print(" ", m)
            page.screenshot(path=str(OUT.with_suffix(".timeout.png")), full_page=True)
            return 3

        # Save the rendered PNG, prefer the actual download blob if present
        img = page.query_selector(".preview-card img")
        if img:
            href = page.eval_on_selector(".preview-card a.btn-primary", "(a) => a.href")
            blob_b64 = page.evaluate(
                """async (href) => {
                    const r = await fetch(href);
                    const buf = await r.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let s = '';
                    const chunk = 0x8000;
                    for (let i = 0; i < u8.length; i += chunk) {
                        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
                    }
                    return btoa(s);
                }""",
                href,
            )
            import base64
            OUT.write_bytes(base64.b64decode(blob_b64))
            print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")
        else:
            err = page.text_content(".error-card")
            print(f"Got error: {err}")
            print("Console messages:")
            for m in console_msgs:
                print(" ", m)
            return 4

        # Also save the full page screenshot for the UI itself
        ui_path = OUT.with_name("browser-ui.png")
        page.screenshot(path=str(ui_path), full_page=True)
        print(f"Wrote UI screenshot to {ui_path}")

        if console_msgs:
            print("Console messages:")
            for m in console_msgs:
                print(" ", m)

        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

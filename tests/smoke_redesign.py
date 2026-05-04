"""Capture the redesigned wrapper in three states for visual review."""
from __future__ import annotations

import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = "http://localhost:8769/index.html"
PDF = ROOT / "tests" / "fixtures" / "sample.pdf"
OUT = ROOT / "output"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if not PDF.exists():
        print(f"Missing fixture: {PDF}")
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1320, "height": 1600}).new_page()

        msgs: list[str] = []
        page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))

        # 1) Empty state
        page.goto(URL, wait_until="domcontentloaded")
        time.sleep(0.6)
        page.screenshot(path=str(OUT / "redesign-1-empty.png"), full_page=True)
        print("State 1 (empty): captured")

        # 2) Result-default — drop the fixture and let it render
        page.set_input_files("#file-input", str(PDF))
        page.wait_for_selector(".preview-card img[src^='blob:']", timeout=30_000)
        time.sleep(0.6)
        page.screenshot(path=str(OUT / "redesign-2-result-default.png"), full_page=True)
        print("State 2 (result-default): captured")

        # 3) Result-adjusted — toggle Welcome Bonus exclusion
        page.click("#exclude-welcome")
        time.sleep(1.2)
        page.wait_for_selector(".delta-card .pill", timeout=10_000)
        page.screenshot(path=str(OUT / "redesign-3-result-adjusted.png"), full_page=True)
        print("State 3 (result-adjusted): captured")

        # Sanity assertions
        product = page.text_content("#detected-product") or ""
        assert "InvestReady" in product, f"detected product: {product!r}"
        rates = page.text_content("#detected-rates") or ""
        assert "%" in rates, f"detected rates: {rates!r}"

        from_text = page.text_content(".delta-card .delta-row.dim .from") or ""
        to_text = page.text_content(".delta-card .delta-row.dim .to") or ""
        print(f"IRR delta: {from_text} -> {to_text}")
        assert "%" in from_text and "%" in to_text

        if msgs:
            print("Console (last 10):")
            for m in msgs[-10:]:
                print(" ", m)

        print("All assertions passed")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

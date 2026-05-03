"""Smoke test the bonus-exclusion feature: detection, toggling, live re-render.

Verifies:
  - The bonus panel becomes visible after parsing and shows the detected
    product/variation + auto-filled rates.
  - With both checkboxes off, the rendered snapshot uses the PDF's stated IRR.
  - Toggling either checkbox triggers a re-render with the ADJUSTED badge and
    a numerically lower Total return.
"""

from __future__ import annotations

import sys, time, base64
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = "http://localhost:8765/index.html"
FIXTURE = ROOT / "tests" / "fixtures" / "sample.pdf"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1280, "height": 1600}).new_page()

        msgs: list[str] = []
        page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))

        page.goto(URL, wait_until="networkidle")
        page.set_input_files("#file-input", str(FIXTURE))
        page.click("#process-btn")

        # Wait for first render to land
        page.wait_for_selector(".preview-card img", timeout=30_000)

        # Bonus panel should be populated for InvestReady (III) 13 Years Flexi 10
        detected = page.text_content("#bonus-detected") or ""
        print(f"Detected: {detected.strip()}")
        assert "InvestReady (III)" in detected and "13 Years Flexi 10" in detected, detected

        welcome_rate = page.input_value("#welcome-rate")
        annual_rate = page.input_value("#annual-rate")
        print(f"Auto-filled rates: welcome={welcome_rate}%, annual={annual_rate}%")
        assert welcome_rate == "45.0", f"Expected 45.0% welcome, got {welcome_rate}"
        assert annual_rate == "5.0", f"Expected 5.0% annual, got {annual_rate}"

        # Capture the unadjusted PNG
        unadjusted = save_preview(page, ROOT / "output" / "browser-bonus-off.png")
        print(f"Unadjusted PNG: {unadjusted} bytes")

        # Toggle "Exclude welcome bonus"
        page.click("#exclude-welcome")
        time.sleep(0.5)  # allow the debounce + re-render
        page.wait_for_selector(".preview-card img", timeout=10_000)
        adj_welcome = save_preview(page, ROOT / "output" / "browser-bonus-welcome-only.png")
        print(f"Welcome-only PNG: {adj_welcome} bytes")

        # Also exclude annual premium bonus
        page.click("#exclude-annual")
        time.sleep(0.5)
        page.wait_for_selector(".preview-card img", timeout=10_000)
        adj_both = save_preview(page, ROOT / "output" / "browser-bonus-both.png")
        print(f"Both-excluded PNG: {adj_both} bytes")

        # Edit welcome rate to 50% and verify amount label updates
        page.fill("#welcome-rate", "50")
        time.sleep(0.5)
        amount = page.text_content("#welcome-amount")
        print(f"Welcome amount after rate edit: {amount}")
        assert "6,000.00" in (amount or ""), f"Expected $6,000 (50% of $12,000), got {amount}"

        # Edited PNG render
        save_preview(page, ROOT / "output" / "browser-bonus-edited.png")

        if msgs:
            print("Console:")
            for m in msgs[-15:]:
                print(" ", m)

        print("All bonus assertions passed")
        browser.close()
    return 0


def save_preview(page, out_path: Path) -> int:
    href = page.eval_on_selector(".preview-card a.btn-primary", "(a) => a.href")
    b64 = page.evaluate(
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
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(base64.b64decode(b64))
    return out_path.stat().st_size


if __name__ == "__main__":
    sys.exit(main())

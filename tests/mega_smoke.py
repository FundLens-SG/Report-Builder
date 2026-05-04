"""Mega smoke test: hammer every state of the redesigned wrapper.

Runs against both the local dev server and the live GitHub Pages URL.
Captures console + pageerror + network failures throughout, then asserts
on the parsed data, the bonus-toggle math, the download URLs, and the
visible UI labels.

Usage:
    python tests/mega_smoke.py
"""

from __future__ import annotations

import sys
import time
import base64
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, Page, BrowserContext, Error as PWError

ROOT = Path(__file__).resolve().parent.parent
SCRAMBLED = ROOT / "tests" / "fixtures" / "sample.pdf"
ORIGINAL = ROOT.parent / "Customer_Investment_Report-03052026-0939.pdf"

LOCAL_URL = "http://localhost:8769/index.html"
LIVE_URL = "https://fundlens-sg.github.io/Report-Builder/"


# ---------- helpers ----------------------------------------------------------

class Tracker:
    def __init__(self):
        self.console: list[str] = []
        self.errors: list[str] = []
        self.failed_requests: list[str] = []

    def attach(self, page: Page):
        page.on("console", lambda m: self.console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: self.errors.append(f"[pageerror] {e}"))
        # Treat 4xx/5xx loaded resources as suspicious; ignore favicon noise.
        page.on(
            "response",
            lambda r: (
                self.failed_requests.append(f"{r.status} {r.url}")
                if r.status >= 400 and "favicon" not in r.url
                else None
            ),
        )

    def report(self, label: str) -> list[str]:
        notes = []
        # Filter out benign noise.
        bad_console = [m for m in self.console if m.startswith("[error]") or m.startswith("[pageerror]")]
        if bad_console:
            notes.append(f"  console errors: {len(bad_console)}")
            for m in bad_console[:5]:
                notes.append(f"    {m}")
        if self.errors:
            notes.append(f"  page errors: {len(self.errors)}")
            for m in self.errors[:5]:
                notes.append(f"    {m}")
        if self.failed_requests:
            notes.append(f"  failed requests: {len(self.failed_requests)}")
            for m in self.failed_requests[:5]:
                notes.append(f"    {m}")
        if notes:
            print(f"[{label}] WARNINGS:")
            for n in notes:
                print(n)
        return bad_console + self.errors + self.failed_requests


def fresh_page(ctx: BrowserContext, url: str, viewport=None) -> tuple[Page, Tracker]:
    if viewport:
        ctx.set_viewport_size(viewport)
    page = ctx.new_page()
    tracker = Tracker()
    tracker.attach(page)
    page.goto(url, wait_until="domcontentloaded")
    # Let module imports / fonts settle.
    time.sleep(0.6)
    return page, tracker


def upload(page: Page, *files: Path):
    page.set_input_files("#file-input", [str(f) for f in files])


def wait_for_render(page: Page, timeout_ms: int = 30_000):
    page.wait_for_selector(".preview-card img[src^='blob:']", timeout=timeout_ms)
    # Let the live re-render debounce settle.
    time.sleep(0.6)


def text(page: Page, selector: str) -> str:
    return (page.text_content(selector) or "").strip()


def fetch_blob_size(page: Page, href: str) -> int:
    return page.evaluate(
        """async (href) => {
            const r = await fetch(href);
            const buf = await r.arrayBuffer();
            return buf.byteLength;
        }""",
        href,
    )


def parse_signed_pct(s: str) -> float:
    m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*%", s)
    return float(m.group(1)) if m else float("nan")


def parse_signed_dollars(s: str) -> float:
    m = re.search(r"S\$([\d,]+(?:\.\d+)?)", s)
    return float(m.group(1).replace(",", "")) if m else float("nan")


# ---------- assertions -------------------------------------------------------

def check_empty_state(page: Page, label: str):
    print(f"\n=== {label}: empty state ===")
    # Hero present
    h1 = text(page, "main.shell .hero h1")
    assert "snapshot" in h1.lower(), f"hero h1 missing 'snapshot': {h1!r}"
    # Drop zone visible, file list collapsed, bonus + result hidden
    assert page.is_visible("#dropzone"), "dropzone hidden"
    assert page.is_visible(".sample-peek"), "sample peek hidden"
    assert not page.is_visible("#adjustments-block"), "bonus block visible too early"
    assert not page.is_visible("#result-section"), "result visible too early"
    # File list should be collapsed (hidden via :empty)
    flist = page.query_selector("#file-list")
    assert flist is not None
    print("  hero, dropzone, sample-peek visible; bonus + result hidden")


def check_single_file(page: Page, fixture: Path, label: str) -> dict:
    print(f"\n=== {label}: single file ({fixture.name}) ===")
    upload(page, fixture)
    wait_for_render(page)

    # File row badge -> Done
    badges = page.locator(".file-row .badge").all_text_contents()
    print(f"  file rows: {badges}")
    assert any("done" in b.lower() for b in badges), f"no Done badge: {badges}"

    # Bonus panel populated
    detected_product = text(page, "#detected-product")
    detected_variation = text(page, "#detected-variation-line")
    detected_rates = text(page, "#detected-rates")
    welcome_amt = text(page, "#welcome-amount")
    annual_amt = text(page, "#annual-amount")
    print(f"  detected product:   {detected_product}")
    print(f"  detected variation: {detected_variation}")
    print(f"  detected rates:     {detected_rates}")
    print(f"  amounts:            welcome={welcome_amt}  annual={annual_amt}")
    assert "InvestReady" in detected_product
    assert "Flexi" in detected_variation
    assert "%" in detected_rates

    # Result count + download link
    rcount = text(page, "#result-count")
    assert "1 of 1" in rcount, rcount
    dl = page.eval_on_selector("#download-btn", "(a) => a.href")
    assert dl.startswith("blob:"), f"download href not blob: {dl}"
    fname = page.eval_on_selector("#download-btn", "(a) => a.download")
    assert fname.endswith(".png"), f"download filename: {fname}"
    print(f"  download: {fname} (blob OK)")

    # Snapshot bytes look like a PNG (>= 50KB at scale=2)
    size = fetch_blob_size(page, dl)
    print(f"  PNG size: {size} bytes")
    assert size > 50_000, f"PNG looks empty: {size}b"

    # Delta card unadjusted: shows "Snapshot ready" + 3 figures, no pill
    kicker = text(page, ".delta-card .delta-kicker")
    assert "Snapshot ready" in kicker, kicker
    assert page.query_selector(".delta-card .pill") is None, "ADJUSTED pill should be absent"

    return {
        "detected_rates": detected_rates,
        "welcome_amt": welcome_amt,
        "annual_amt": annual_amt,
    }


def set_checkbox(page: Page, selector: str, checked: bool):
    """Force a checkbox to a target state regardless of starting state."""
    if page.is_checked(selector) != checked:
        page.click(selector)


def check_bonus_toggles(page: Page, label: str):
    print(f"\n=== {label}: bonus toggle math ===")

    # Each case is (label, welcome_on, annual_on, expected_pill_substring)
    cases = [
        ("welcome only", True,  False, "WELCOME"),
        ("annual only",  False, True,  "ANNUAL"),
        ("both",         True,  True,  "BOTH"),
        ("none",         False, False, None),
    ]

    irrs = {}
    for case_name, w, a, expect_pill in cases:
        set_checkbox(page, "#exclude-welcome", w)
        set_checkbox(page, "#exclude-annual", a)

        if expect_pill is None:
            # Unadjusted view: wait until the kicker actually says "Snapshot ready"
            # (the snapshot re-render is debounced + html2canvas is slow on LIVE).
            page.wait_for_function(
                "document.querySelector('.delta-card .delta-kicker')?.textContent.includes('Snapshot ready')",
                timeout=15_000,
            )
            assert page.query_selector(".delta-card .pill") is None, "pill should be gone"
            print(f"  [{case_name}] reverted to unadjusted view")
            continue

        # Wait for the right pill to appear with the right text.
        page.wait_for_function(
            f"document.querySelector('.delta-card .pill')?.textContent.includes('{expect_pill}')",
            timeout=15_000,
        )
        pill = text(page, ".delta-card .pill")
        from_irr = parse_signed_pct(text(page, ".delta-row.dim .from"))
        to_irr = parse_signed_pct(text(page, ".delta-row.dim .to"))
        print(f"  [{case_name}] pill={pill}  IRR  {from_irr}% -> {to_irr}%")
        assert to_irr < from_irr, f"adjusted IRR ({to_irr}) should be < baseline ({from_irr})"
        irrs[case_name] = to_irr

    # Sanity: BOTH-excluded IRR should be the lowest (most aggressive cost-basis bump),
    # WELCOME-only should be lower than ANNUAL-only (welcome rate is much larger).
    assert irrs["both"] < irrs["welcome only"] < irrs["annual only"], (
        f"ordering wrong: both={irrs['both']}, welcome={irrs['welcome only']}, annual={irrs['annual only']}"
    )
    print(f"  ordering OK: both ({irrs['both']}%) < welcome ({irrs['welcome only']}%) < annual ({irrs['annual only']}%)")


def check_rate_override(page: Page, label: str):
    print(f"\n=== {label}: rate override + editability ===")
    # Reset to a known state: both checkboxes off
    set_checkbox(page, "#exclude-welcome", False)
    set_checkbox(page, "#exclude-annual", False)
    time.sleep(0.6)

    welcome_ro = page.evaluate("document.getElementById('welcome-rate').readOnly")
    assert welcome_ro is True, "welcome rate should be readonly when checkbox off"

    # Toggle welcome on -> rate becomes editable, amount appears
    set_checkbox(page, "#exclude-welcome", True)
    time.sleep(0.6)
    welcome_ro = page.evaluate("document.getElementById('welcome-rate').readOnly")
    assert welcome_ro is False, "welcome rate should be editable when checkbox on"

    # Bump welcome rate to 60% (above 45% default), assert amount updates
    # and the adjusted IRR drops further than the default-rate adjustment.
    before_amt = parse_signed_dollars(text(page, "#welcome-amount"))
    before_irr = parse_signed_pct(text(page, ".delta-row.dim .to"))
    page.fill("#welcome-rate", "60")
    page.dispatch_event("#welcome-rate", "input")
    time.sleep(1.2)
    after_amt = parse_signed_dollars(text(page, "#welcome-amount"))
    after_irr = parse_signed_pct(text(page, ".delta-row.dim .to"))
    print(f"  welcome amount: {before_amt} -> {after_amt}")
    print(f"  adjusted IRR:   {before_irr}% -> {after_irr}%")
    assert after_amt > before_amt, "raising rate should raise the dollar amount"
    assert after_irr < before_irr, "raising rate should lower the adjusted IRR further"

    # Reset to defaults for the next test
    page.fill("#welcome-rate", "45")
    page.dispatch_event("#welcome-rate", "input")
    time.sleep(0.4)
    set_checkbox(page, "#exclude-welcome", False)
    time.sleep(0.4)


def check_batch(page: Page, label: str):
    print(f"\n=== {label}: batch upload ===")
    # Add a second copy of the fixture (queued state) and let it process
    upload(page, SCRAMBLED)
    page.wait_for_function(
        "document.querySelectorAll('.file-row .badge.done').length >= 2",
        timeout=30_000,
    )
    time.sleep(0.6)

    rcount = text(page, "#result-count")
    print(f"  result count: {rcount}")
    assert "of" in rcount

    dl_label = text(page, "#download-label")
    dl_href = page.eval_on_selector("#download-btn", "(a) => a.href")
    dl_fname = page.eval_on_selector("#download-btn", "(a) => a.download")
    print(f"  download: label={dl_label!r}  filename={dl_fname}")
    assert dl_label.startswith("Download ZIP"), dl_label
    assert dl_fname.endswith(".zip"), dl_fname
    size = fetch_blob_size(page, dl_href)
    print(f"  ZIP size: {size} bytes")
    assert size > 100_000, f"ZIP too small: {size}b"


def check_failure(ctx: BrowserContext, url: str, label: str):
    print(f"\n=== {label}: failure path (corrupt PDF) ===")
    # Make a tiny non-PDF blob and try to upload it.
    page, tracker = fresh_page(ctx, url)
    fake = ROOT / "output" / "_fake.pdf"
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_bytes(b"%PDF-1.4 not really a pdf at all\n")
    upload(page, fake)
    page.wait_for_selector(".file-row .badge.failed", timeout=15_000)
    badge_text = text(page, ".file-row .badge.failed")
    print(f"  failed badge text: {badge_text}")
    assert "fail" in badge_text.lower()
    # Result section should remain hidden
    assert not page.is_visible("#result-section"), "result should not show on parse failure"
    fake.unlink(missing_ok=True)
    page.close()


def check_drag_visuals(page: Page, label: str):
    print(f"\n=== {label}: drag visual feedback ===")
    page.evaluate("""
      const dz = document.getElementById('dropzone-wrap');
      const ev = new DragEvent('dragenter', { bubbles: true, cancelable: true });
      dz.dispatchEvent(ev);
    """)
    time.sleep(0.3)
    has_drag = page.evaluate("document.getElementById('dropzone').classList.contains('dragging')")
    assert has_drag, "dropzone should add 'dragging' on dragenter"
    page.evaluate("""
      const dz = document.getElementById('dropzone-wrap');
      const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      dz.dispatchEvent(ev);
    """)
    time.sleep(0.2)
    has_drag = page.evaluate("document.getElementById('dropzone').classList.contains('dragging')")
    assert not has_drag, "dropzone should remove 'dragging' on dragleave"
    print("  drag-enter/leave classes toggle correctly")


def check_responsive(page: Page, url: str, label: str):
    print(f"\n=== {label}: responsive (narrow viewport) ===")
    page.set_viewport_size({"width": 700, "height": 1200})
    page.reload(wait_until="domcontentloaded")
    time.sleep(0.6)
    # Expect everything still renders without horizontal overflow.
    overflow = page.evaluate(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth"
    )
    print(f"  horizontal overflow: {overflow}px (0 ideal, < 50 acceptable)")
    assert overflow < 50, f"horizontal overflow at narrow viewport: {overflow}"


# ---------- main runner ------------------------------------------------------

def run_target(label: str, url: str, browser, original_pdf_works: bool) -> int:
    print(f"\n{'#' * 60}\n# {label}: {url}\n{'#' * 60}")
    ctx = browser.new_context(viewport={"width": 1320, "height": 1600})
    fail_count = 0

    # Suite 1: empty state
    page, tracker = fresh_page(ctx, url)
    try:
        check_empty_state(page, label)
        check_drag_visuals(page, label)
    except AssertionError as e:
        print(f"  FAIL: {e}")
        fail_count += 1
    fail_count += len(tracker.report(f"{label}/empty"))
    page.close()

    # Suite 2: single + bonus toggles + rate override
    page, tracker = fresh_page(ctx, url)
    try:
        check_single_file(page, SCRAMBLED, label)
        check_bonus_toggles(page, label)
        check_rate_override(page, label)
        check_batch(page, label)
    except (AssertionError, PWError) as e:
        print(f"  FAIL: {e}")
        fail_count += 1
    fail_count += len(tracker.report(f"{label}/single+batch"))
    page.close()

    # Suite 3: failure path
    try:
        check_failure(ctx, url, label)
    except (AssertionError, PWError) as e:
        print(f"  FAIL: {e}")
        fail_count += 1

    # Suite 4: original (real) PDF if available
    if original_pdf_works and ORIGINAL.exists():
        page, tracker = fresh_page(ctx, url)
        try:
            print(f"\n=== {label}: original real PDF ({ORIGINAL.name}) ===")
            upload(page, ORIGINAL)
            wait_for_render(page)
            badge_text = text(page, ".file-row .badge")
            print(f"  badge: {badge_text}")
            assert "done" in badge_text.lower(), badge_text
            customer = text(page, ".delta-card h4")
            assert "TAN" in customer.upper() or "Tan" in customer, customer
            print(f"  delta h4: {customer[:90]}...")
        except (AssertionError, PWError) as e:
            print(f"  FAIL: {e}")
            fail_count += 1
        fail_count += len(tracker.report(f"{label}/original"))
        page.close()

    # Suite 5: responsive
    page, tracker = fresh_page(ctx, url)
    try:
        check_responsive(page, url, label)
    except (AssertionError, PWError) as e:
        print(f"  FAIL: {e}")
        fail_count += 1
    fail_count += len(tracker.report(f"{label}/responsive"))
    page.close()

    ctx.close()
    return fail_count


def main() -> int:
    if not SCRAMBLED.exists():
        print(f"Missing fixture: {SCRAMBLED}")
        return 2

    total_fails = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # Always test local. If the live URL is reachable, also test that.
        targets = [("LOCAL", LOCAL_URL, True)]
        try:
            import urllib.request
            req = urllib.request.Request(LIVE_URL, method="HEAD")
            urllib.request.urlopen(req, timeout=5)
            targets.append(("LIVE", LIVE_URL, False))  # original PDF not in repo, skip
            print("Live URL reachable; will test both.")
        except Exception as e:
            print(f"Live URL not reachable, testing local only: {e}")

        for label, url, with_original in targets:
            total_fails += run_target(label, url, browser, with_original)

        browser.close()

    print("\n" + "=" * 60)
    if total_fails == 0:
        print("MEGA SMOKE: all checks passed")
        return 0
    print(f"MEGA SMOKE: {total_fails} issue(s) flagged")
    return 1


if __name__ == "__main__":
    sys.exit(main())

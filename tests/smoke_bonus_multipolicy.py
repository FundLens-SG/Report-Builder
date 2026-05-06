"""Verify bonus exclusion only affects the recognised product in a multi-policy PDF."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64, zipfile, time

ROOT = Path(__file__).resolve().parent.parent
URL = "http://localhost:8765/index.html"
PDF = ROOT / "tests" / "fixtures" / "_local" / "multipolicy.pdf"


def save_zip(page, out_path: Path):
    href = page.eval_on_selector("#download-btn", "(a) => a.href")
    b64 = page.evaluate(
        """async (href) => {
            const r = await fetch(href);
            const buf = await r.arrayBuffer();
            const u8 = new Uint8Array(buf);
            let s = '';
            for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            return btoa(s);
        }""",
        href,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(base64.b64decode(b64))
    return out_path


def policy_data(page, policy_idx: int) -> dict:
    """Re-derive policy data inside the page for sanity checks."""
    return page.evaluate(
        """async (idx) => {
            const { parsePdf } = await import('/parser.js');
            const { derive } = await import('/deriver.js');
            const fileInput = document.getElementById('file-input');
            // We can't read the file blob from here; just expose a global from app.js
            return null;
        }""",
        policy_idx,
    )


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={"width": 1280, "height": 1600}).new_page()
    page.goto(URL, wait_until="networkidle")
    page.set_input_files("#file-input", str(PDF))
    page.wait_for_selector("#download-btn[href]", timeout=60_000)
    time.sleep(0.5)

    # Bonuses OFF
    save_zip(page, ROOT / "output" / "multi-bonuses-off.zip")

    # Toggle exclusions
    page.click("#exclude-welcome")
    page.click("#exclude-annual")
    time.sleep(1.2)
    save_zip(page, ROOT / "output" / "multi-bonuses-on.zip")

    browser.close()

# Extract both ZIPs and check: for the recognised InvestReady policy, the
# adjusted PNG should differ from the unadjusted one. For the unrecognised
# Manulink policy, the bytes should be identical (no bonus exclusion applies).
def extract(zp: Path):
    out = {}
    with zipfile.ZipFile(zp) as z:
        for name in z.namelist():
            out[name] = z.read(name)
    return out

off_files = extract(ROOT / "output" / "multi-bonuses-off.zip")
on_files = extract(ROOT / "output" / "multi-bonuses-on.zip")

print(f"Files in OFF: {list(off_files.keys())}")
print(f"Files in ON:  {list(on_files.keys())}")

invest_ready = next(n for n in off_files if "2451782316" in n)
manulink     = next(n for n in off_files if "2452509296" in n)

ir_changed   = off_files[invest_ready] != on_files[invest_ready]
ml_changed   = off_files[manulink]     != on_files[manulink]
print(f"\nInvestReady changed by toggle:  {ir_changed}  (expect True — recognised, has bonus)")
print(f"Manulink changed by toggle:     {ml_changed}   (expect False — unrecognised, no bonus)")

if ir_changed and not ml_changed:
    print("\nPASS: bonus exclusion correctly scoped to recognised product only")
else:
    print("\nFAIL: bonus exclusion is affecting the wrong policy")

"""End-to-end render test for the live page."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64, sys, time

ROOT = Path(__file__).resolve().parent.parent
URL = "http://localhost:8765/index.html"


def save(page, out_path: Path) -> int:
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
    return out_path.stat().st_size


def run(label: str, pdf_paths: list[str]) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1280, "height": 1600}).new_page()
        msgs: list[str] = []
        page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))
        page.goto(URL, wait_until="networkidle")
        page.set_input_files("#file-input", pdf_paths)
        page.wait_for_selector("#download-btn[href]", timeout=60_000)
        time.sleep(1)
        href = page.eval_on_selector("#download-btn", "(a) => a.href")
        download_label = page.text_content("#download-label")
        result_count = page.text_content("#result-count")
        print(f"=== {label} ===")
        print(f"  result-count: {result_count!r}")
        print(f"  download-label: {download_label!r}")
        print(f"  href starts with blob: {href.startswith('blob:')}")
        out = ROOT / "output" / f"smoke-{label.replace(' ', '-').lower()}.{'zip' if 'ZIP' in (download_label or '') else 'png'}"
        size = save(page, out)
        print(f"  saved: {out.name} ({size} bytes)")
        if msgs:
            print("  console (last 5):")
            for m in msgs[-5:]:
                print("   ", m)
        browser.close()


if __name__ == "__main__":
    print("##### single-policy (scrambled sample) #####")
    run("single", [str(ROOT / "tests" / "fixtures" / "sample.pdf")])
    print()
    print("##### multi-policy single PDF #####")
    run("multipolicy", [str(ROOT / "tests" / "fixtures" / "_local" / "multipolicy.pdf")])
    print()
    print("##### multi PDF (sample + multipolicy = 3 policies total) #####")
    run("multi-pdf", [
        str(ROOT / "tests" / "fixtures" / "sample.pdf"),
        str(ROOT / "tests" / "fixtures" / "_local" / "multipolicy.pdf"),
    ])

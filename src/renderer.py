"""Render the data dict through the Jinja2 template and capture as PNG via Playwright."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.sync_api import sync_playwright


TEMPLATE_DIR = Path(__file__).parent


def render_html(data: dict[str, Any]) -> str:
    """Render the template into a complete HTML string."""
    payload = dict(data)
    payload["holdings_labels_json"] = json.dumps(
        [f"{h['display_name']} ({h['ticker']})" for h in data["holdings_enriched"]]
    )
    payload["holdings_data_json"] = json.dumps(
        [round(h["allocation_pct"], 4) for h in data["holdings_enriched"]]
    )
    payload["holdings_colors_json"] = json.dumps(
        [h["color"] for h in data["holdings_enriched"]]
    )

    env = Environment(
        loader=FileSystemLoader(TEMPLATE_DIR),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("template.html")
    return template.render(**payload)


def render_to_png(data: dict[str, Any], output_path: Path, scale: float = 2.0) -> None:
    """Render data through template and save as PNG.

    scale=2.0 produces a retina-quality image (~1440px wide).
    """
    html = render_html(data)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(
            viewport={"width": 720, "height": 1200},
            device_scale_factor=scale,
        )
        page = context.new_page()
        page.set_content(html, wait_until="networkidle")
        page.wait_for_function("document.fonts.ready")
        page.wait_for_function(
            "window.Chart && document.getElementById('alloc-donut').toDataURL().length > 5000",
            timeout=10_000,
        )
        page.wait_for_timeout(200)

        element = page.locator(".report")
        element.screenshot(path=str(output_path), omit_background=False)
        browser.close()

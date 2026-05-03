"""Click CLI entry point: `single` and `batch` commands."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import click

from .deriver import derive
from .naming import build_filename, ensure_unique
from .parser import parse_pdf
from .renderer import render_to_png


@click.group()
def cli():
    """Manulife Investment Snapshot Generator."""


@cli.command()
@click.argument("pdf_path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("-o", "--output-dir", default="output", type=click.Path(path_type=Path))
def single(pdf_path: Path, output_dir: Path):
    """Process one PDF -> one PNG."""
    output_dir.mkdir(parents=True, exist_ok=True)
    out = process_one(pdf_path, output_dir)
    click.echo(f"Wrote {out}")


@cli.command()
@click.option("-i", "--input-dir", default="input", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("-o", "--output-dir", default="output", type=click.Path(path_type=Path))
@click.option("-w", "--workers", default=4, type=int, help="Concurrent workers")
def batch(input_dir: Path, output_dir: Path, workers: int):
    """Process all PDFs in input-dir -> output-dir."""
    output_dir.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(input_dir.glob("*.pdf"))
    if not pdfs:
        click.echo(f"No PDFs found in {input_dir}")
        return

    click.echo(f"Processing {len(pdfs)} PDFs with {workers} workers...")
    succeeded, failed = 0, []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_one, pdf, output_dir): pdf for pdf in pdfs}
        for fut in as_completed(futures):
            pdf = futures[fut]
            try:
                out = fut.result()
                click.echo(f"  OK {pdf.name} -> {out.name}")
                succeeded += 1
            except Exception as e:
                click.echo(f"  FAIL {pdf.name}: {e}", err=True)
                failed.append((pdf.name, str(e)))

    click.echo(f"\nDone. {succeeded} succeeded, {len(failed)} failed.")
    if failed:
        click.echo("Failed files:")
        for name, err in failed:
            click.echo(f"  - {name}: {err}")


def process_one(pdf_path: Path, output_dir: Path) -> Path:
    raw = parse_pdf(str(pdf_path))
    data = derive(raw)
    filename = build_filename(raw.customer_name, raw.policy_number, raw.report_date)
    out_path = ensure_unique(output_dir / filename)
    render_to_png(data, out_path)
    return out_path


if __name__ == "__main__":
    cli()

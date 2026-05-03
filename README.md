# Manulife Investment Snapshot Generator

A Python CLI that turns a Manulife "Customer Investment Report" PDF into a one-page visual snapshot PNG — performance metrics, premium structure, allocation donut, per-fund P&L, and strategy summary.

## Install

```bash
pip install -r requirements.txt
playwright install chromium
```

## Usage

### Single

```bash
python -m src.cli single ./input/report.pdf -o ./output
```

### Batch

Drop PDFs into `./input/` and run:

```bash
python -m src.cli batch -i ./input -o ./output -w 4
```

Output files are named `{Client Name} - Investment Snapshot - {Policy Number} - {Date}.png`.

## Project layout

```
manulife-snapshot/
├── README.md
├── requirements.txt
├── input/                  # Drop PDFs here for batch mode
├── output/                 # Generated PNGs appear here
├── src/
│   ├── parser.py           # PDF -> RawReport
│   ├── deriver.py          # RawReport -> full data dict
│   ├── renderer.py         # Data -> HTML -> PNG
│   ├── naming.py           # Output filename builder
│   ├── template.html       # Jinja2 template
│   └── cli.py              # Click entry point
└── tests/
    └── fixtures/           # Sample PDFs for testing
```

## Limitations (v1)

- If a customer has multiple policies in one PDF, only the first is processed.
- Fund-name shortening is heuristic; verify the per-fund table for unusual fund names.

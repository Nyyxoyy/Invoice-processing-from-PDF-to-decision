"""Generate Clean and Multi-currency batches; retain the seven-file Messy kit."""
import json
import zipfile
from pathlib import Path
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'fixtures/pdfs'
CATALOG = ROOT / 'fixtures/reviewer-demo.json'


def main():
    entries = [e for e in json.loads(CATALOG.read_text()) if not e.get('dataset') or e.get('dataset') == 'messy']
    for e in entries:
        e['dataset'] = 'messy'
        e['category'] = 'Messy'
        if e['name'] == 'reviewer-03-new-supplier.pdf':
            e['expect'] = 'rejected'  # Default unknown-supplier policy.
        if e['name'].endswith('.zip'):
            e.update(title='Messy', blurb='7 documents: unclear dates, missing PO, wrong totals.', recommended=True)
    for kind, count in [('clean', 12), ('multi-currency', 9)]:
        members = []
        for i in range(1, count + 1):
            currency = 'USD' if kind == 'clean' else ['EUR', 'GBP', 'JPY'][(i - 1) % 3]
            supplier = 'Harbor Office Supplies'
            po = 'PO-DEMO-' + currency
            number = f'{kind.upper()}-{i:02}'
            sub, tax, total = (f'JPY {10000 + i * 100}', f'JPY {1000 + i * 10}', f'JPY {11000 + i * 110}') if currency == 'JPY' else (f'{100 + i}.00', '10.00', f'{110 + i}.00')
            name = f'onboarding-{kind}-{i:02}.pdf'
            c = canvas.Canvas(str(OUT / name), pagesize=(595, 842), invariant=1)
            c.setTitle(f'{supplier} | {number}')
            rows = [supplier, 'INVOICE', f'Invoice No: {number}', 'Invoice Date: 2026-09-01', f'PO Reference: {po}', 'Bill To: Acme Corporation', f'Currency: {currency}', f'Subtotal: {sub}', f'Sales Tax: {tax}', f'Total: {total}']
            for j, row in enumerate(rows):
                c.setFillColorRGB(.12, .19, .24)
                c.setFont('Helvetica-Bold' if j < 2 else 'Helvetica', 18 if j == 0 else 12)
                c.drawString(48, 775 - j * 38, row)
            c.setStrokeColorRGB(.16, .41, .31)
            c.line(48, 797, 547, 797)
            c.setFont('Helvetica', 10)
            c.drawString(48, 62, 'Invoice desk demonstration | Fictional supplier invoice')
            c.save()
            members.append(name)
            entries.append(dict(name=name, title=f'{supplier} · {number}', blurb=f'Invoice dated 1 September 2026 · {currency}', category='Clean' if kind == 'clean' else 'Multi-currency', dataset=kind, onboarding=True, expect='approved'))
        bundle = f'{kind}-invoices.zip'
        with zipfile.ZipFile(OUT / bundle, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name in members:
                info = zipfile.ZipInfo(name, date_time=(2026, 9, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, (OUT / name).read_bytes())
        entries.append(dict(name=bundle, title='Clean' if kind == 'clean' else 'Multi-currency', blurb='12 invoices, all matched.' if kind == 'clean' else '9 invoices in EUR, GBP, JPY.', category='Clean' if kind == 'clean' else 'Multi-currency', dataset=kind, onboarding=True, expect='approved', members=members))
    CATALOG.write_text(json.dumps(entries, indent=2) + '\n')


if __name__ == '__main__':
    main()

"""Build the curated reviewer starter kit, separate from the edge-case library."""
import json
import zipfile
from pathlib import Path
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'fixtures' / 'pdfs'
CATALOG = ROOT / 'fixtures' / 'reviewer-demo.json'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    specs = [
        ('01-office', 'Office supplies', 'approved', 'An approved supplier, matching PO and correct totals.', 'No action needed. Open the approved invoice to see its confidence and checks.', 'Harbor Office Supplies', 'DEMO-7101', 'PO-7101', '2026-09-01', '1000.00', '80.00', '1080.00'),
        ('02-software', 'Software subscription', 'approved', 'A second clean invoice matches a different active supplier and PO.', 'No action needed. The approval is recorded against the software PO.', 'Cedar Cloud Services', 'DEMO-7102', 'PO-7102', '2026-09-02', '2000.00', '160.00', '2160.00'),
        ('03-new-supplier', 'A new supplier', 'held', 'Summit Studio is not in the supplier register. AI creates an onboarding request.', 'Open My requests to see the AI-created ticket. Procurement must approve the supplier and its order.', 'Summit Studio', 'DEMO-7103', 'PO-7199', '2026-09-03', '500.00', '40.00', '540.00'),
        ('04-missing-po', 'Purchase order missing', 'held', 'The supplier is approved, but no PO number appears on this invoice.', 'AI requests a purchase order. Follow the ticket in My requests; no request form is needed.', 'Harbor Office Supplies', 'DEMO-7104', None, '2026-09-04', '750.00', '60.00', '810.00'),
        ('05-totals', 'Totals need a second look', 'held', 'The printed total does not equal subtotal plus tax, lowering confidence.', 'Compare the extracted values with the PDF. Request a corrected invoice if the printed total is wrong.', 'Harbor Office Supplies', 'DEMO-7105', 'PO-7101', '2026-09-05', '300.00', '24.00', '400.00'),
        ('06-date', 'An unclear invoice date', 'held', 'The date 04/05/2026 has two possible readings and needs confirmation.', 'Confirm the date with the supplier, correct it, then check the invoice again.', 'Cedar Cloud Services', 'DEMO-7106', 'PO-7102', '04/05/2026', '600.00', '48.00', '648.00'),
    ]
    for slug, title, expect, blurb, next_step, supplier, number, po, date, sub, tax, total in specs:
        name = f'reviewer-{slug}.pdf'
        c = canvas.Canvas(str(OUT / name), pagesize=(595, 842), invariant=1)
        c.setTitle(title)
        rows = [supplier, 'INVOICE', f'Invoice No: {number}', f'Invoice Date: {date}']
        if po:
            rows.append(f'PO Reference: {po}')
        rows += ['Bill To: Acme Corporation', 'Currency: USD', f'Subtotal: ${sub}', f'Sales Tax: ${tax}', f'Total: ${total}']
        for i, row in enumerate(rows):
            c.setFillColorRGB(.12, .19, .24)
            c.setFont('Helvetica-Bold' if i < 2 else 'Helvetica', 18 if i == 0 else 12)
            c.drawString(48, 775 - i * 38, row)
        c.setStrokeColorRGB(.16, .41, .31)
        c.line(48, 797, 547, 797)
        c.setFont('Helvetica', 10)
        c.setFillColorRGB(.4, .45, .5)
        c.drawString(48, 62, 'Acme reviewer demonstration | Fictional supplier invoice')
        c.save()
        entries.append(dict(name=name, title=title, expect=expect, blurb=blurb, next_step=next_step, category='Reviewer starter kit', onboarding=True))
    name = 'reviewer-07-not-an-invoice.pdf'
    c = canvas.Canvas(str(OUT / name), pagesize=(595, 842), invariant=1)
    c.setFont('Helvetica-Bold', 24)
    c.drawString(48, 770, 'TEAM PICNIC')
    c.setFont('Helvetica', 14)
    for i, line in enumerate(['Join us at the park for lunch and games.', 'Bring a picnic blanket and something to share.', 'This is an event flyer, not an invoice.', 'There is no purchase or payment request.']):
        c.drawString(48, 710 - i * 30, line)
    c.save()
    entries.append(dict(name=name, title='A file that is not an invoice', expect='rejected', blurb='An event flyer is recognized as a non-invoice and rejected.', next_step='View the rejection reason. No approval or procurement request should be created.', category='Reviewer starter kit', onboarding=True))
    bundle = 'reviewer-starter-kit.zip'
    with zipfile.ZipFile(OUT / bundle, 'w', zipfile.ZIP_DEFLATED) as z:
        for entry in entries:
            z.write(OUT / entry['name'], entry['name'])
    entries.insert(0, dict(name=bundle, title='The reviewer starter kit', expect='mixed', blurb='Seven documents. One complete reviewer walkthrough.', category='Reviewer starter kit', onboarding=True, recommended=True, members=[e['name'] for e in entries]))
    display_metadata = [('Invoice collection', 'Seven PDF documents in one ZIP archive.'), ('Harbor Office Supplies · DEMO-7101', 'Invoice dated 1 September 2026 · USD'), ('Cedar Cloud Services · DEMO-7102', 'Invoice dated 2 September 2026 · USD'), ('Summit Studio · DEMO-7103', 'Invoice dated 3 September 2026 · USD'), ('Harbor Office Supplies · DEMO-7104', 'Invoice dated 4 September 2026 · USD'), ('Harbor Office Supplies · DEMO-7105', 'Invoice dated 5 September 2026 · USD'), ('Cedar Cloud Services · DEMO-7106', 'Invoice document · USD'), ('Acme Corporation · Event notice', 'PDF document')]
    for entry, (title, blurb) in zip(entries, display_metadata):
        entry.update(title=title, blurb=blurb, category="Invoice collection")
    CATALOG.write_text(json.dumps(entries, indent=2) + '\n')


if __name__ == '__main__':
    main()

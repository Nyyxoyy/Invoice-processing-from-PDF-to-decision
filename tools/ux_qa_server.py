"""Isolated UI test server. Uses disposable fixtures and no model/network calls.
Run: venv/bin/python tools/ux_qa_server.py
Open: http://localhost:8322
"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'backend/tests')]
qa_data = tempfile.mkdtemp(prefix='invoice-ux-qa-')
os.environ['DATA_DIR'] = qa_data
from app import main, pipeline
from app.db import connect
from app.policy import DEFAULT_POLICY
from app.extractor import BudgetExceeded
from test_pipeline import make_pdf, stub_extract

conn = connect(str(Path(qa_data) / 'app.db'))
main.seed_if_empty(conn)
pipeline.extract_native = stub_extract
cases = [
    ('approved', dict(total='$1,000.00', subtotal='$900.00', tax='$100.00', invoice_no='QA-APPROVED')),
    ('confirm-date', dict(date='03.04.2026', total='$2,000.00', subtotal='$1,800.00', tax='$200.00', invoice_no='QA-DATE')),
    ('new-supplier', dict(supplier='Cedar Office Supplies', total='$500.00', subtotal='$450.00', tax='$50.00', invoice_no='QA-NEW', po='PO-3010')),
    ('check-amounts', dict(total='$7,000.00', invoice_no='QA-MATH')),
    ('budget-review', dict(total='$15,000.00', subtotal='$14,000.00', tax='$1,000.00', invoice_no='QA-BUDGET')),
    ('blocked-supplier', dict(supplier='Shady Imports Co', invoice_no='QA-BLOCKED')),
]
for name, values in cases:
    pdf = Path(qa_data) / (name + '.pdf')
    make_pdf(pdf, **values)
    pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, qa_data)
# A reading failure that succeeds on retry, exercising real recovery without API calls.
pdf = Path(qa_data) / 'interrupted-reading.pdf'
make_pdf(pdf, total='$400.00', subtotal='$350.00', tax='$50.00', invoice_no='QA-RETRY')
def fail_read(*args, **kwargs):
    raise BudgetExceeded('test interrupted reading')
pipeline.extract_native = fail_read
pipeline.process_document(conn, str(pdf), pdf.name, DEFAULT_POLICY, qa_data)
pipeline.extract_native = stub_extract
# Scanned readings use the same recorded reviewer contract as the real vision path.
pdf = Path(qa_data) / 'scanned-invoice.pdf'
make_pdf(pdf, total='$300.00', subtotal='$250.00', tax='$50.00', invoice_no='QA-SCAN')
# Dedicated scan scenario from the existing test fixtures is generated as an image below.
import pymupdf
text_doc = pymupdf.open(pdf)
png = text_doc[0].get_pixmap().tobytes('png')
scan_doc = pymupdf.open()
scan_doc.new_page().insert_image(pymupdf.Rect(0, 0, 595, 842), stream=png)
scan_pdf = Path(qa_data) / 'scan-to-confirm.pdf'
scan_doc.save(scan_pdf)
from app.extractor import Transcription
fields = {'supplier_name':'Northwind Supplies LLC','invoice_number':'QA-SCAN-NEW','invoice_date':'2026-08-28','currency':'USD','po_reference':'PO-1001','subtotal_net':'250.00','tax_total':'50.00','invoice_gross_total':'300.00'}
# Keep the number matching the image; duplicate safeguards remain in force if checked again.
fields['invoice_number'] = 'QA-SCAN'
def stub_scan(png, page, budget):
    return [Transcription(field=k, status='selected', raw_value=v, page=1) for k,v in fields.items()]
pipeline.extract_scan = stub_scan
pipeline.process_document(conn, str(scan_pdf), scan_pdf.name, DEFAULT_POLICY, qa_data)
conn.close()
def slow_extract(*args, **kwargs):
    time.sleep(2)
    return stub_extract(*args, **kwargs)
pipeline.extract_native = slow_extract
print('Disposable QA data:', qa_data, flush=True)
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=int(os.environ.get('UX_QA_PORT', '8322')))

"""Additive starter-kit records. Never overwrite existing procurement edits.

The register has to know the suppliers that appear in the documents we ship,
otherwise a first-time user picking "Upload from dataset" watches most of the
collection stall on VENDOR_UNKNOWN — an artefact of the demo data, not of
anything the invoices did wrong. Everything here is `INSERT OR IGNORE`, so a
procurement edit (a rename, a block, an amended amount) always wins.

Two suppliers are deliberately absent, and must stay that way:

  Acme Widgets Ltd   fixtures/pdfs/11-unknown-supplier.pdf
  Summit Studio      fixtures/pdfs/reviewer-03-new-supplier.pdf

They are the fixtures for the unknown-supplier path, which is what the
"Unknown suppliers" switch on the Suppliers page controls (see settings.py):
reject the invoice outright, or hold it and raise an onboarding request.
"""

# Suppliers named by the shipped dataset, with the orders those documents bill
# against. Amounts are sized so a correct invoice fits inside the budget.
DATASET_VENDORS = [
    # reviewer starter kit (the onboarding collection)
    ('sup-demo-harbor', 'Harbor Office Supplies', 'approved', 'US', '["harbor office supplies"]'),
    ('sup-demo-cedar', 'Cedar Cloud Services', 'approved', 'US', '["cedar cloud services"]'),
    # real-world sample documents
    ('sup-demo-bioplex', 'Bioplex', 'approved', 'FR', '["bioplex", "bioplex sa"]'),
    # 44-prompt-injection.pdf: the supplier is real, the instruction printed on
    # the page is not. Registering it means the invoice is judged on its actual
    # defect (it bills against another supplier's PO) instead of stopping at an
    # unknown name — a sharper demonstration that the injection changed nothing.
    ('sup-demo-vortex', 'Vortex Consulting GmbH', 'approved', 'DE', '["vortex consulting gmbh", "vortex consulting"]'),
]

DATASET_POS = [
    # Separate budgets for the clean and multi-currency onboarding batches.
    *[(f'PO-DEMO-{currency}', 'sup-demo-harbor', currency, 10000000, 'open')
      for currency in ('USD', 'EUR', 'GBP', 'JPY')],
    ('PO-7101', 'sup-demo-harbor', 'USD', 1000000, 'open'),
    ('PO-7102', 'sup-demo-cedar', 'USD', 1000000, 'open'),
    # invoice-0-4.pdf names BPXPO-00536 in its header and two more orders inside
    # line descriptions; all three exist so the reviewer can pick the right one.
    ('BPXPO-00536', 'sup-demo-bioplex', 'EUR', 1000000, 'open'),
    ('BPXPO-00537', 'sup-demo-bioplex', 'EUR', 500000, 'open'),
    ('BPXPO-00538', 'sup-demo-bioplex', 'EUR', 500000, 'open'),
    ('PO-4401', 'sup-demo-vortex', 'USD', 500000, 'open'),
]


def seed_reviewer_demo(conn):
    conn.executemany(
        'INSERT OR IGNORE INTO vendors (supplier_id,name,status,country,aliases) VALUES (?,?,?,?,?)',
        DATASET_VENDORS)
    conn.executemany(
        'INSERT OR IGNORE INTO pos (po_id,supplier_id,currency,amount_minor,status) VALUES (?,?,?,?,?)',
        DATASET_POS)

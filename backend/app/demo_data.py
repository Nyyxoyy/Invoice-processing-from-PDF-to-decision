"""Additive starter-kit records. Never overwrite existing procurement edits."""

def seed_reviewer_demo(conn):
    conn.executemany('INSERT OR IGNORE INTO vendors (supplier_id,name,status,country,aliases) VALUES (?,?,?,?,?)', [
        ('sup-demo-harbor', 'Harbor Office Supplies', 'approved', 'US', '["harbor office supplies"]'),
        ('sup-demo-cedar', 'Cedar Cloud Services', 'approved', 'US', '["cedar cloud services"]'),
    ])
    conn.executemany('INSERT OR IGNORE INTO pos (po_id,supplier_id,currency,amount_minor,status) VALUES (?,?,?,?,?)', [
        ('PO-7101', 'sup-demo-harbor', 'USD', 1000000, 'open'),
        ('PO-7102', 'sup-demo-cedar', 'USD', 1000000, 'open'),
    ])

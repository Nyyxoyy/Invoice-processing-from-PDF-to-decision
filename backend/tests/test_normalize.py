"""Extractors must handle label-prefixed selections — the model points at a
block; code pulls the value."""
from decimal import Decimal

from app.normalize import (extract_amount, extract_currency, extract_date_iso,
                           extract_invoice_number, extract_name, extract_po_ref)


def test_amount_with_label():
    assert extract_amount("Total: $6,495.00") == Decimal("6495.00")
    assert extract_amount("Subtotal: $6,000.00") == Decimal("6000.00")

def test_amount_ignores_percentage():
    assert extract_amount("Sales Tax (8.25%): $495.00") == Decimal("495.00")

def test_amount_ambiguous_or_absent_is_none():
    assert extract_amount("$100.00 of $200.00") is None
    assert extract_amount("no numbers here") is None
    assert extract_amount(None) is None

def test_date_with_label():
    assert extract_date_iso("Invoice Date: 2026-08-28") == "2026-08-28"
    assert extract_date_iso("08/28/2026") == "2026-08-28"  # 28 can only be a day

def test_po_with_label():
    assert extract_po_ref("PO Reference: PO-1001") == "PO-1001"
    assert extract_po_ref("see order") is None

def test_invoice_number_label_stripped():
    assert extract_invoice_number("Invoice No: NW-2026-0142") == "NW-2026-0142"
    assert extract_invoice_number("NW-2026-0142") == "NW-2026-0142"

def test_currency():
    assert extract_currency("Currency: USD. Payment terms: Net 30.") == "USD"
    assert extract_currency("Unit Price [EUR] Total [EUR]") == "EUR"
    assert extract_currency("$ 100.00") is None            # bare symbol never sufficient
    assert extract_currency("USD or EUR accepted") is None # conflicting codes
    assert extract_currency("all amounts in euros") == "EUR"

def test_name_label_stripped():
    assert extract_name("Bill To: Acme Corporation") == "Acme Corporation"
    assert extract_name("NORTHWIND SUPPLIES LLC") == "NORTHWIND SUPPLIES LLC"


def test_number_tokens_do_not_span_spaces():
    # "November 12, 2021 213470" must not fuse into one garbage number
    assert extract_amount("Total Due By: November 12, 2021 213470") is None

def test_amount_in_cell_with_decimal():
    from decimal import Decimal
    assert extract_amount("Shipping & Handling 7000") == Decimal("7000")


def test_month_name_dates_unambiguous():
    assert extract_date_iso("October 12, 2021") == "2021-10-12"
    assert extract_date_iso("12 October 2021") == "2021-10-12"
    assert extract_date_iso("Date: 27.08.2019") == "2019-08-27"  # 27 forces day-first
    assert extract_date_iso("Oct 12, 2021 and Nov 12, 2021") is None  # two dates: ambiguous


def test_numeric_dates_deterministic_disambiguation():
    assert extract_date_iso("16.12.2021") == "2021-12-16"   # 16 can only be a day
    assert extract_date_iso("DATE: 23.05.2021") == "2021-05-23"
    assert extract_date_iso("12/25/2021") == "2021-12-25"   # US order, 25 forces it
    assert extract_date_iso("05.05.2021") == "2021-05-05"   # same either way
    assert extract_date_iso("03.04.2021") is None           # both readings legal: hold
    assert extract_date_iso("2021.12.16") == "2021-12-16"   # year-first = Y-M-D
    assert extract_date_iso("31.02.2021") is None           # no legal reading
    assert extract_date_iso("16.12.21") is None             # 2-digit year: ambiguous


def test_space_grouped_thousands_are_one_number():
    """"1 436,78" on a real scan was read as 436.78: the leading group was taken
    for a separate number. A single space (plain, no-break or thin) before a
    group of exactly three digits is a thousands separator."""
    from decimal import Decimal
    from app.normalize import extract_amount, readings, unusable_reason
    assert extract_amount("1 436,78") == Decimal("1436.78")
    assert extract_amount("$ 1 436,78") == Decimal("1436.78")
    assert extract_amount("1 234 567,89") == Decimal("1234567.89")
    assert extract_amount("1 436,78") == Decimal("1436.78")      # no-break space
    assert extract_amount("1 436,78") == Decimal("1436.78")      # narrow no-break space
    assert extract_amount("12 500,00") == Decimal("12500.00")
    assert extract_amount("12 500") == Decimal("12500")
    assert extract_amount("1 4360,78") == Decimal("4360.78")          # four digits after the space: not a group
    assert extract_amount("Qty 2  1,500.00  3,000.00") is None         # several numbers, unchanged
    assert unusable_reason("tax_total", "1 436,78") is None
    assert readings("tax_total", "1 436,78", "EUR") == []

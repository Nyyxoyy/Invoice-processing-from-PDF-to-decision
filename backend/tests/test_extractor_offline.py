"""Offline extractor checks — no API calls: budget accounting + verification."""
import pytest

from app.evidence import Block, ExtractionRevision
from app.extractor import (BudgetExceeded, CallBudget, Selection,
                           normalize_amount, verify_selection, verify_transcription, Transcription)


def rev():
    return ExtractionRevision(
        extraction_revision_id="xr_test", parser_version="v1", pages=1,
        page_kinds=("text",),
        blocks=(
            Block("p1.b0", 1, "Grand total USD 11,800.00", 0, 0, 1, 1),
            Block("p1.b1", 1, "Amount due USD 5,900.00", 0, 2, 1, 3),
        ),
    )


def test_budget_each_logical_once():
    b = CallBudget()
    b.check("extract"); b.logical_used["extract"] += 1
    with pytest.raises(BudgetExceeded):
        b.check("extract")

def test_budget_outbound_cap():
    b = CallBudget()
    b.outbound = b.max_outbound
    with pytest.raises(BudgetExceeded):
        b.check("vision")

def test_grounded_but_wrong_field_fails_role_check():
    # model picks amount_due block for gross total: source matches, role fails
    s = Selection(field="invoice_gross_total", status="selected",
                  source_block_id="p1.b1", raw_value="5,900.00")
    checks = verify_selection(s, rev())
    assert checks["source_match"] == "pass"
    assert checks["role_check"] == "fail"

def test_correct_selection_passes():
    s = Selection(field="invoice_gross_total", status="selected",
                  source_block_id="p1.b0", raw_value="11,800.00")
    checks = verify_selection(s, rev())
    assert checks["source_match"] == "pass" and checks["role_check"] == "pass"
    assert checks["normalization"] == "pass"

def test_hallucinated_value_fails_source_match():
    s = Selection(field="invoice_gross_total", status="selected",
                  source_block_id="p1.b0", raw_value="12,000.00")
    assert verify_selection(s, rev())["source_match"] == "fail"

def test_scan_source_match_never_pass():
    t = Transcription(field="invoice_gross_total", status="selected", raw_value="11,800.00", page=1)
    checks = verify_transcription(t)
    assert checks["source_match"] == "not_applicable"

def test_normalize_amount():
    assert str(normalize_amount("$11,800.00")) == "11800.00"
    assert normalize_amount("NaN") is None
    assert normalize_amount("abc") is None


def test_role_label_in_left_neighbor_cell():
    r = ExtractionRevision(
        extraction_revision_id="xr_cols", parser_version="v2", pages=1,
        page_kinds=("text",),
        blocks=(
            Block("p1.b0", 1, "Subtotal", 50, 100, 120, 112),
            Block("p1.b1", 1, "187700", 400, 100, 460, 112),   # value cell, label left
        ),
    )
    s = Selection(field="subtotal_net", status="selected",
                  source_block_id="p1.b1", raw_value="187700")
    checks = verify_selection(s, r)
    assert checks["role_check"] == "pass"


def test_role_fail_when_no_label_anywhere_near():
    r = ExtractionRevision(
        extraction_revision_id="xr_bare", parser_version="v2", pages=1,
        page_kinds=("text",),
        blocks=(Block("p1.b0", 1, "187700", 400, 100, 460, 112),),
    )
    s = Selection(field="subtotal_net", status="selected",
                  source_block_id="p1.b0", raw_value="187700")
    assert verify_selection(s, r)["role_check"] == "fail"


def test_scan_reading_is_confirmed_only_when_an_independent_reading_agrees():
    """Two readings of the page must contain the same value; amounts and dates
    compare as normalised values so spacing differences do not matter."""
    from app.extractor import Transcription, agrees_with_page, verify_transcription
    page = "Northwind Supplies LLC\nInvoice No: NW-9\nInvoice Date: 28 Aug 2026\nVAT 1 436,78\nTotal 7 200,00"
    assert agrees_with_page("supplier_name", "northwind   supplies llc", page)
    assert agrees_with_page("invoice_number", "NW-9", page)
    assert not agrees_with_page("invoice_number", "NW-8", page)
    assert agrees_with_page("tax_total", "1436,78", page)            # same value, different spacing
    assert agrees_with_page("invoice_date", "2026-08-28", page)      # same date, different format
    assert not agrees_with_page("invoice_date", "2026-08-29", page)
    t = Transcription(field="tax_total", status="selected", raw_value="1 436,78")
    ok = verify_transcription(t, page)
    assert ok["independent_read"] == "agree" and ok["source_match"] == "pass" and ok["normalization"] == "pass"
    bad = verify_transcription(Transcription(field="invoice_number", status="selected", raw_value="NW-8"), page)
    assert bad["independent_read"] == "disagree" and bad["source_match"] == "not_applicable"
    plain = verify_transcription(t)                                  # no second reading available
    assert "independent_read" not in plain and plain["source_match"] == "not_applicable"

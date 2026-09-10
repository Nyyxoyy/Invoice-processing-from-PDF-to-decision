"""Evidence preparation: pdfplumber text blocks with stable IDs under an
immutable extraction revision. Page classification for routing."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, asdict

import pdfplumber

SCAN_TEXT_THRESHOLD = 50  # chars of text layer below which a page is "scanned"
GARBLED_ALNUM_RATIO = 0.35  # letters+digits share below which a text layer is unusable


def looks_garbled(text: str) -> bool:
    """A text layer that is present but unreadable: fonts without a ToUnicode
    map come out as '(cid:123)' runs, damaged encodings as symbol soup. Such a
    page is treated as scanned (read from the image), never handed to the
    model as text."""
    s = text.strip()
    if len(s) < SCAN_TEXT_THRESHOLD:
        return False
    if s.count("(cid:") >= 3:
        return True
    visible = [c for c in s if not c.isspace()]
    if not visible:
        return True
    alnum = sum(c.isalnum() for c in visible)
    return alnum / len(visible) < GARBLED_ALNUM_RATIO
COLUMN_GAP_PT = 24  # horizontal gap that separates column cells within a line


@dataclass(frozen=True)
class Block:
    block_id: str  # "p{page}.b{n}" — meaningful only within its extraction revision
    page: int
    text: str
    x0: float
    top: float
    x1: float
    bottom: float


@dataclass(frozen=True)
class ExtractionRevision:
    extraction_revision_id: str
    parser_version: str
    pages: int
    page_kinds: tuple[str, ...]  # "text" | "scanned" per page
    blocks: tuple[Block, ...]
    garbled_pages: tuple[int, ...] = ()  # pages whose text layer was unusable (read as scanned)

    def to_json(self) -> str:
        return json.dumps({
            "extraction_revision_id": self.extraction_revision_id,
            "parser_version": self.parser_version,
            "pages": self.pages,
            "page_kinds": list(self.page_kinds),
            "garbled_pages": list(self.garbled_pages),
            "blocks": [asdict(b) for b in self.blocks],
        })

    def block(self, block_id: str) -> Block | None:
        return next((b for b in self.blocks if b.block_id == block_id), None)


PARSER_VERSION = "pdfplumber-cells-v2"


def prepare_evidence(pdf_path: str) -> ExtractionRevision:
    blocks: list[Block] = []
    kinds: list[str] = []
    garbled: list[int] = []
    with pdfplumber.open(pdf_path) as pdf:
        for pageno, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            if looks_garbled(text):
                # unusable text layer: no evidence blocks, page goes to the image reading
                kinds.append("scanned")
                garbled.append(pageno)
                continue
            kinds.append("text" if len(text.strip()) >= SCAN_TEXT_THRESHOLD else "scanned")
            # line-level blocks: words grouped by their line (top coordinate)
            words = page.extract_words()
            lines: dict[int, list] = {}
            for w in words:
                lines.setdefault(round(w["top"]), []).append(w)
            n = 0
            for key in sorted(lines):
                ws = sorted(lines[key], key=lambda w: w["x0"])
                # split one visual line into column cells on horizontal gaps —
                # multi-column layouts must not merge label/value pairs from
                # different columns into one evidence block
                groups: list[list] = [[ws[0]]]
                for w in ws[1:]:
                    if w["x0"] - groups[-1][-1]["x1"] > COLUMN_GAP_PT:
                        groups.append([w])
                    else:
                        groups[-1].append(w)
                for g in groups:
                    blocks.append(Block(
                        block_id=f"p{pageno}.b{n}",
                        page=pageno,
                        text=" ".join(w["text"] for w in g),
                        x0=min(w["x0"] for w in g), top=min(w["top"] for w in g),
                        x1=max(w["x1"] for w in g), bottom=max(w["bottom"] for w in g),
                    ))
                    n += 1
    content_hash = hashlib.sha256(
        (PARSER_VERSION + "".join(b.text for b in blocks)).encode()
    ).hexdigest()[:12]
    return ExtractionRevision(
        extraction_revision_id=f"xr_{content_hash}",
        parser_version=PARSER_VERSION,
        pages=len(kinds),
        page_kinds=tuple(kinds),
        blocks=tuple(blocks),
        garbled_pages=tuple(garbled),
    )


def render_page_png(pdf_path: str, page_number: int, dpi: int = 150) -> bytes:
    """Scan path rasterization (PyMuPDF)."""
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    try:
        page = doc[page_number - 1]
        pix = page.get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()

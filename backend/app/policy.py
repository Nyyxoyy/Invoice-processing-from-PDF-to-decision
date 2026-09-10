"""Policy configuration. Versioned; every run stores the version it evaluated
under, plus the currency-registry version and rounding policy."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from .currencies import REGISTRY_VERSION

# rounding policy (recorded in run snapshots)
ROUNDING_POLICY = {
    "quantize_mode": "ROUND_HALF_UP",
    "per_line_bound_minor": 1,
    "reconciliation_local_bound_minor": 1,
    "document_residual_cap_minor": 5,
}


@dataclass(frozen=True)
class Policy:
    version: int
    variance_mode: str  # "greater_of" — deliberate de minimis floor
    variance_pct: Decimal  # e.g. Decimal("2.0")
    exception_enabled: bool
    exception_pct: Decimal  # e.g. Decimal("5.0")
    # absolute floor per currency, in that currency's OWN minor units.
    # Unconfigured currency -> 0, explicitly meaning percentage-only.
    abs_floor_minor: dict = field(default_factory=lambda: {"USD": 5000})
    tax_in_tolerance: bool = True
    dup_date_window_days: int = 30
    scan_auto_approve: bool = False
    registry_version: str = REGISTRY_VERSION

    def __post_init__(self) -> None:
        if self.variance_mode != "greater_of":
            raise ValueError(f"unsupported variance_mode: {self.variance_mode}")
        if self.variance_pct < 0 or self.exception_pct < 0:
            raise ValueError("negative tolerance values are incoherent")
        if any(v < 0 for v in self.abs_floor_minor.values()):
            raise ValueError("negative absolute floor is incoherent")

    def floor_for(self, currency: str) -> int:
        return int(self.abs_floor_minor.get(currency, 0))

    def t_primary_minor(self, base_minor: int, currency: str) -> int:
        # flooring converts an allowance to whole minor units without rounding
        # permission upward
        pct_allow = int(Decimal(base_minor) * self.variance_pct / Decimal(100))
        return max(pct_allow, self.floor_for(currency))

    def t_exception_minor(self, base_minor: int, currency: str) -> int:
        pct_allow = int(Decimal(base_minor) * self.exception_pct / Decimal(100))
        return max(self.t_primary_minor(base_minor, currency), pct_allow)


DEFAULT_POLICY = Policy(
    version=1,
    variance_mode="greater_of",
    variance_pct=Decimal("2.0"),
    exception_enabled=True,
    exception_pct=Decimal("5.0"),
)

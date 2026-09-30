"""
Before/after block state for the audit trail.

Every audit event that changes a block also puts two keys in its `detail`:

  before   the block fields that event is responsible for, read just before
           the change (None when the event created the block)
  after    the same fields just after the change

That lets the Audit Trail show what each measurement, assessment and decision
changed without replaying history. Events that don't change a block
(transmitted, calculation_warning, survey_*) don't carry these keys. Neither do
events recorded before this module existed.
"""
from __future__ import annotations

from typing import Iterable, Optional

# Set by a measurement. A re-capture also puts the block back to pending.
MEASUREMENT_FIELDS = ("length_m", "width_m", "height_m", "volume_m3", "confidence",
                      "measurement_method", "status")
# Set by the seigniorage assessment.
ASSESSMENT_FIELDS = ("classification", "category_name", "rate_per_m3_inr",
                     "seigniorage_fee_inr", "tonnage_mt")
# Changed by officer decisions, flags and OMEPS anomaly auto-flags.
STATUS_FIELDS = ("status",)


def snapshot(block: Optional[dict], fields: Iterable[str]) -> Optional[dict]:
    """Copy `fields` out of `block`, or None if the block doesn't exist yet.

    Take the "before" snapshot ahead of the change. The in-memory store
    updates its block dicts in place, so if you keep a reference and read it
    later, it will already show the new values."""
    if not block:
        return None
    return {f: block.get(f) for f in fields}

"""The reorder report: items at or below their reorder point, and what restocking costs."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ReorderLine:
    """One item to restock, with the suggested order and its cost in cents."""

    sku: str
    name: str
    quantity: int
    reorder_point: int
    order_quantity: int
    order_cost_cents: int


def needs_reorder(item, point):
    """Return True when item is active and its stock is at or below point."""
    return not item.discontinued and item.quantity < point


def reorder_lines(store):
    """Return a ReorderLine for every item in store that needs restocking."""
    lines = []
    for item, point in store.reorder_points():
        if not needs_reorder(item, point):
            continue
        shortfall = 2 * point - item.quantity
        lines.append(
            ReorderLine(
                sku=item.sku,
                name=item.name,
                quantity=item.quantity,
                reorder_point=point,
                order_quantity=shortfall,
                order_cost_cents=shortfall * item.unit_cost_cents,
            )
        )
    lines.sort(key=lambda line: line.sku)
    return lines


class ReorderService:
    """Reorder operations for the API."""

    def __init__(self, store):
        """Serve reorder requests from store."""
        self._store = store

    def set_point(self, sku, point):
        """Set sku's reorder point. Raises what Store.set_reorder_point raises."""
        self._store.set_reorder_point(sku, point)

    def lines(self):
        """Return the current reorder lines; see reorder_lines."""
        return reorder_lines(self._store)

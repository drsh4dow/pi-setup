"""SQLite storage for items and their stock movements."""

import sqlite3
from dataclasses import dataclass

from .errors import BadRequest, Conflict, UnknownSku

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit_cost_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    discontinued INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL REFERENCES items (sku),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reorder_points (
    sku TEXT PRIMARY KEY REFERENCES items (sku),
    point INTEGER NOT NULL
);
"""


@dataclass(frozen=True)
class Item:
    """A stocked product. Money is integer cents."""

    sku: str
    name: str
    unit_cost_cents: int
    quantity: int
    discontinued: bool


class Store:
    """Items and stock levels in one SQLite database."""

    def __init__(self, path):
        """Open the database at path, creating the tables if needed. Tests use ":memory:"."""
        self._db = sqlite3.connect(path)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)

    def close(self):
        """Close the database."""
        self._db.close()

    def add_item(self, sku, name, unit_cost_cents):
        """Create an item with no stock and return it.

        Raises BadRequest for a negative cost, Conflict if sku already exists.
        """
        if unit_cost_cents < 0:
            raise BadRequest(f"unit cost must not be negative, got {unit_cost_cents}")
        try:
            with self._db:
                self._db.execute(
                    "INSERT INTO items (sku, name, unit_cost_cents) VALUES (?, ?, ?)",
                    (sku, name, unit_cost_cents),
                )
        except sqlite3.IntegrityError as error:
            raise Conflict(f"SKU {sku!r} already exists") from error
        return self.get_item(sku)

    def get_item(self, sku):
        """Return the item with sku. Raises UnknownSku."""
        row = self._db.execute("SELECT * FROM items WHERE sku = ?", (sku,)).fetchone()
        if row is None:
            raise UnknownSku(sku)
        return _item(row)

    def list_items(self):
        """Return every item, sorted by SKU."""
        rows = self._db.execute("SELECT * FROM items ORDER BY sku").fetchall()
        return [_item(row) for row in rows]

    def receive(self, sku, quantity):
        """Add quantity units of sku to stock and return the updated item.

        Raises BadRequest for a non-positive quantity, UnknownSku, or Conflict
        if the item is discontinued.
        """
        _require_positive(quantity, "quantity")
        if self.get_item(sku).discontinued:
            raise Conflict(f"{sku} is discontinued")
        with self._db:
            self._db.execute("UPDATE items SET quantity = quantity + ? WHERE sku = ?", (quantity, sku))
            self._log(sku, quantity, "receive")
        return self.get_item(sku)

    def ship(self, sku, quantity):
        """Remove quantity units of sku from stock and return the updated item.

        Raises BadRequest for a non-positive quantity, UnknownSku, or Conflict
        when fewer than quantity units are on hand.
        """
        _require_positive(quantity, "quantity")
        on_hand = self.get_item(sku).quantity
        with self._db:
            cursor = self._db.execute(
                "UPDATE items SET quantity = quantity - ? WHERE sku = ? AND quantity >= ?",
                (quantity, sku, quantity),
            )
            if cursor.rowcount == 0:
                raise Conflict(f"{sku}: cannot ship {quantity}, only {on_hand} on hand")
            self._log(sku, -quantity, "ship")
        return self.get_item(sku)

    def discontinue(self, sku):
        """Mark sku discontinued and return it. Raises UnknownSku."""
        with self._db:
            cursor = self._db.execute("UPDATE items SET discontinued = 1 WHERE sku = ?", (sku,))
        if cursor.rowcount == 0:
            raise UnknownSku(sku)
        return self.get_item(sku)

    def movements(self, sku):
        """Return (delta, reason) pairs for sku, oldest first."""
        rows = self._db.execute(
            "SELECT delta, reason FROM movements WHERE sku = ? ORDER BY id", (sku,)
        ).fetchall()
        return [(row["delta"], row["reason"]) for row in rows]

    def set_reorder_point(self, sku, point):
        """Set the stock level at or below which sku should be restocked.

        Raises BadRequest for a non-positive point, or UnknownSku.
        """
        _require_positive(point, "reorder point")
        self.get_item(sku)
        # SQLite has supported upserts since 3.24, so we use INSERT ... ON
        # CONFLICT instead of the old SELECT-then-INSERT-or-UPDATE dance. We
        # tried INSERT OR REPLACE first, but REPLACE deletes the row and then
        # inserts a new one, which is not what we want here. So if the row
        # exists we update the point, and if it does not we insert it. Either
        # way the item ends up with the new point. Please keep it this way!
        with self._db:
            self._db.execute(
                "INSERT INTO reorder_points (sku, point) VALUES (?, ?) "
                "ON CONFLICT (sku) DO UPDATE SET point = excluded.point",
                (sku, point),
            )

    def reorder_points(self):
        """Return (item, reorder point) pairs for every item that has a reorder point, by SKU."""
        rows = self._db.execute(
            "SELECT items.*, reorder_points.point FROM items "
            "JOIN reorder_points ON reorder_points.sku = items.sku ORDER BY items.sku"
        ).fetchall()
        return [(_item(row), row["point"]) for row in rows]

    def _log(self, sku, delta, reason):
        self._db.execute(
            "INSERT INTO movements (sku, delta, reason) VALUES (?, ?, ?)", (sku, delta, reason)
        )


def _item(row):
    return Item(
        sku=row["sku"],
        name=row["name"],
        unit_cost_cents=row["unit_cost_cents"],
        quantity=row["quantity"],
        discontinued=bool(row["discontinued"]),
    )


def _require_positive(value, what):
    if value <= 0:
        raise BadRequest(f"{what} must be positive, got {value}")

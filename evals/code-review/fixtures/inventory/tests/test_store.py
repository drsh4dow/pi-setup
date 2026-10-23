import unittest

from inventory.errors import BadRequest, Conflict, UnknownSku
from inventory.store import Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.addCleanup(self.store.close)
        self.store.add_item("BOLT-10", "M10 bolt", 35)

    def test_new_item_has_no_stock(self):
        item = self.store.get_item("BOLT-10")
        self.assertEqual((item.quantity, item.unit_cost_cents, item.discontinued), (0, 35, False))

    def test_duplicate_sku_conflicts(self):
        with self.assertRaises(Conflict):
            self.store.add_item("BOLT-10", "Another bolt", 40)

    def test_receive_and_ship_log_movements(self):
        self.store.receive("BOLT-10", 12)
        item = self.store.ship("BOLT-10", 5)
        self.assertEqual(item.quantity, 7)
        self.assertEqual(self.store.movements("BOLT-10"), [(12, "receive"), (-5, "ship")])

    def test_cannot_ship_more_than_on_hand(self):
        self.store.receive("BOLT-10", 3)
        with self.assertRaises(Conflict):
            self.store.ship("BOLT-10", 4)
        self.assertEqual(self.store.get_item("BOLT-10").quantity, 3)
        self.assertEqual(self.store.movements("BOLT-10"), [(3, "receive")])

    def test_quantity_must_be_positive(self):
        with self.assertRaises(BadRequest):
            self.store.receive("BOLT-10", 0)

    def test_discontinued_item_ships_but_cannot_be_received(self):
        self.store.receive("BOLT-10", 4)
        self.store.discontinue("BOLT-10")
        self.assertEqual(self.store.ship("BOLT-10", 4).quantity, 0)
        with self.assertRaises(Conflict):
            self.store.receive("BOLT-10", 1)

    def test_unknown_sku(self):
        with self.assertRaises(UnknownSku):
            self.store.get_item("NUT-10")
        with self.assertRaises(UnknownSku):
            self.store.discontinue("NUT-10")


if __name__ == "__main__":
    unittest.main()

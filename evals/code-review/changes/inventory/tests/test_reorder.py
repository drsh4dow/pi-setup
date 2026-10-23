import unittest

from inventory.errors import BadRequest
from tests.test_api import VIEWER_KEY, ApiTestCase


class ReorderPointTest(ApiTestCase):
    def test_clerk_sets_reorder_point(self):
        response = self.request("PUT", "/items/BOLT-10/reorder-point", body={"point": 10})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, {"sku": "BOLT-10", "reorder_point": 10})
        self.assertEqual(self.store.reorder_points()[0][1], 10)

    def test_setting_again_replaces_the_point(self):
        self.request("PUT", "/items/BOLT-10/reorder-point", body={"point": 10})
        self.request("PUT", "/items/BOLT-10/reorder-point", body={"point": 4})
        self.assertEqual([point for _, point in self.store.reorder_points()], [4])

    def test_point_must_be_an_integer(self):
        response = self.request("PUT", "/items/BOLT-10/reorder-point", body={"point": "10"})
        self.assertEqual(response.status, 400)

    def test_unknown_sku_is_not_found(self):
        response = self.request("PUT", "/items/NUT-10/reorder-point", body={"point": 10})
        self.assertEqual(response.status, 404)

    def test_store_rejects_non_positive_point(self):
        try:
            self.store.set_reorder_point("BOLT-10", 0)
        except BadRequest:
            pass
        self.assertEqual(self.store.get_item("BOLT-10").sku, "BOLT-10")


class ReorderReportTest(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.stock("BOLT-10", quantity=2, point=10)
        self.store.add_item("ANCHOR-8", "M8 wall anchor", 120)
        self.stock("ANCHOR-8", quantity=1, point=4)
        self.store.add_item("NUT-10", "M10 nut", 5)
        self.stock("NUT-10", quantity=50, point=20)
        self.store.add_item("WASHER-10", "M10 washer", 2)
        self.store.set_reorder_point("WASHER-10", 30)
        self.store.discontinue("WASHER-10")
        self.store.add_item("SCREW-4", "M4 screw", 3)

    def stock(self, sku, quantity, point):
        self.store.receive(sku, quantity)
        self.store.set_reorder_point(sku, point)

    def test_lists_active_items_below_their_point(self):
        response = self.request("GET", "/reorder")
        self.assertEqual(response.status, 200)
        self.assertCountEqual([line["sku"] for line in response.body["lines"]], ["BOLT-10", "ANCHOR-8"])

    def test_line_orders_up_to_twice_the_point(self):
        lines = {line["sku"]: line for line in self.request("GET", "/reorder").body["lines"]}
        self.assertEqual(
            lines["BOLT-10"],
            {
                "sku": "BOLT-10",
                "name": "M10 bolt",
                "quantity": 2,
                "reorder_point": 10,
                "order_quantity": 18,
                "order_cost_cents": 630,
            },
        )

    def test_total_in_cents_and_text(self):
        body = self.request("GET", "/reorder").body
        self.assertEqual(body["total_cents"], 630 + 840)
        self.assertEqual(body["total"], "14.70")

    def test_viewer_can_read_the_report(self):
        self.assertEqual(self.request("GET", "/reorder", key=VIEWER_KEY).status, 200)

    def test_restocked_item_leaves_the_report(self):
        self.store.receive("BOLT-10", 30)
        skus = [line["sku"] for line in self.request("GET", "/reorder").body["lines"]]
        self.assertNotIn("BOLT-10", skus)


if __name__ == "__main__":
    unittest.main()

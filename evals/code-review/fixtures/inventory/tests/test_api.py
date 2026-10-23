import json
import unittest

from inventory.api import CLERK, VIEWER, Api
from inventory.store import Store

CLERK_KEY = "ck_test"
VIEWER_KEY = "vk_test"


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")
        self.addCleanup(self.store.close)
        self.api = Api(self.store, {CLERK_KEY: CLERK, VIEWER_KEY: VIEWER})
        self.store.add_item("BOLT-10", "M10 bolt", 35)

    def request(self, method, path, key=CLERK_KEY, body=None):
        headers = {} if key is None else {"X-Api-Key": key}
        raw = b"" if body is None else json.dumps(body).encode()
        return self.api.handle(method, path, headers, raw)


class AuthTest(ApiTestCase):
    def test_missing_key_is_unauthorized(self):
        self.assertEqual(self.request("GET", "/items", key=None).status, 401)

    def test_unknown_key_is_unauthorized(self):
        self.assertEqual(self.request("GET", "/items", key="nope").status, 401)

    def test_viewer_can_read(self):
        response = self.request("GET", "/items/BOLT-10", key=VIEWER_KEY)
        self.assertEqual(response.status, 200)

    def test_viewer_cannot_write(self):
        response = self.request("POST", "/items/BOLT-10/receive", key=VIEWER_KEY, body={"quantity": 5})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.store.get_item("BOLT-10").quantity, 0)


class ItemsTest(ApiTestCase):
    def test_add_item_returns_cost_as_cents_and_text(self):
        response = self.request("POST", "/items", body={"sku": "NUT-10", "name": "M10 nut", "unit_cost_cents": 1205})
        self.assertEqual(response.status, 201)
        self.assertEqual(response.body["unit_cost_cents"], 1205)
        self.assertEqual(response.body["unit_cost"], "12.05")

    def test_add_item_rejects_lower_case_sku(self):
        response = self.request("POST", "/items", body={"sku": "nut-10", "name": "M10 nut", "unit_cost_cents": 5})
        self.assertEqual(response.status, 400)

    def test_receive_then_ship(self):
        self.request("POST", "/items/BOLT-10/receive", body={"quantity": 10})
        response = self.request("POST", "/items/BOLT-10/ship", body={"quantity": 4})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["quantity"], 6)

    def test_ship_more_than_on_hand_conflicts(self):
        response = self.request("POST", "/items/BOLT-10/ship", body={"quantity": 1})
        self.assertEqual(response.status, 409)

    def test_quantity_must_be_an_integer(self):
        for quantity in ("3", 2.5, True, None):
            with self.subTest(quantity=quantity):
                response = self.request("POST", "/items/BOLT-10/receive", body={"quantity": quantity})
                self.assertEqual(response.status, 400)

    def test_invalid_json_is_bad_request(self):
        response = self.api.handle("POST", "/items/BOLT-10/receive", {"X-Api-Key": CLERK_KEY}, b"{")
        self.assertEqual(response.status, 400)

    def test_unknown_sku_is_not_found(self):
        self.assertEqual(self.request("GET", "/items/NUT-10").status, 404)

    def test_unknown_route_is_not_found(self):
        self.assertEqual(self.request("GET", "/stock").status, 404)


if __name__ == "__main__":
    unittest.main()

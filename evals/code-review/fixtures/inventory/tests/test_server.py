import unittest

from inventory.server import parse_keys


class ParseKeysTest(unittest.TestCase):
    def test_parses_pairs(self):
        self.assertEqual(parse_keys("ck_1:clerk, vk_1:viewer"), {"ck_1": "clerk", "vk_1": "viewer"})

    def test_empty_text_has_no_keys(self):
        self.assertEqual(parse_keys(""), {})

    def test_rejects_unknown_role(self):
        with self.assertRaises(ValueError):
            parse_keys("ck_1:admin")


if __name__ == "__main__":
    unittest.main()

import unittest

from inventory.money import format_cents


class FormatCentsTest(unittest.TestCase):
    def test_pads_cents(self):
        self.assertEqual(format_cents(1205), "12.05")

    def test_under_a_dollar(self):
        self.assertEqual(format_cents(35), "0.35")

    def test_negative(self):
        self.assertEqual(format_cents(-250), "-2.50")

    def test_zero(self):
        self.assertEqual(format_cents(0), "0.00")


if __name__ == "__main__":
    unittest.main()

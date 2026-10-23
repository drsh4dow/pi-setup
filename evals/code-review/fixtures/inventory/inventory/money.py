"""Money helpers. Amounts are integer cents everywhere; see CONTRIBUTING.md."""


def format_cents(cents):
    """Return cents as dollars text such as "1234.05", with a leading "-" when negative."""
    sign = "-" if cents < 0 else ""
    dollars, rest = divmod(abs(cents), 100)
    return f"{sign}{dollars}.{rest:02d}"

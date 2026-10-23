"""Expected failures. Each carries the HTTP status the API answers with."""


class InventoryError(Exception):
    """Base class for failures caused by the request rather than by a bug."""

    status = 400


class BadRequest(InventoryError):
    """The request body, or a value in it, is invalid."""


class Unauthorized(InventoryError):
    """The request has no API key, or an unknown one."""

    status = 401


class Forbidden(InventoryError):
    """The API key's role may not make this request."""

    status = 403


class NotFound(InventoryError):
    """No route or resource matches the request."""

    status = 404


class UnknownSku(NotFound):
    """No item has the given SKU."""

    def __init__(self, sku):
        """Name the missing sku in the message."""
        super().__init__(f"unknown SKU {sku!r}")
        self.sku = sku


class Conflict(InventoryError):
    """The request conflicts with current state, such as shipping more than is on hand."""

    status = 409

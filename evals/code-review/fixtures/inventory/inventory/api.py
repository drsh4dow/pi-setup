"""The JSON API, independent of the HTTP transport. server.py serves it."""

import json
import re
from dataclasses import asdict, dataclass

from .errors import BadRequest, Forbidden, InventoryError, NotFound, Unauthorized
from .money import format_cents

VIEWER = "viewer"
CLERK = "clerk"
ROLES = (VIEWER, CLERK)

_SKU = r"[A-Z0-9][A-Z0-9-]*"
_ITEM_PATH = rf"^/items/(?P<sku>{_SKU})"


@dataclass(frozen=True)
class Response:
    """An HTTP status and a JSON body."""

    status: int
    body: dict


class Api:
    """Routes requests to the store. Viewers may read; clerks may also write."""

    def __init__(self, store, keys):
        """Serve store, authenticating with keys, a mapping from API key to role."""
        self._store = store
        self._keys = dict(keys)
        self._routes = [
            ("GET", re.compile(r"^/items$"), self._list_items),
            ("POST", re.compile(r"^/items$"), self._add_item),
            ("GET", re.compile(rf"{_ITEM_PATH}$"), self._get_item),
            ("POST", re.compile(rf"{_ITEM_PATH}/receive$"), self._receive),
            ("POST", re.compile(rf"{_ITEM_PATH}/ship$"), self._ship),
            ("POST", re.compile(rf"{_ITEM_PATH}/discontinue$"), self._discontinue),
        ]

    def handle(self, method, path, headers, body):
        """Return the Response to one request.

        headers is a mapping and body the raw request bytes. Every
        InventoryError becomes an error response with its status.
        """
        try:
            role = self._role(headers)
            for route_method, pattern, handler in self._routes:
                match = pattern.match(path)
                if match is not None and route_method == method:
                    return handler(role, match, _payload(body))
            raise NotFound(f"no route for {method} {path}")
        except InventoryError as error:
            return Response(error.status, {"error": str(error)})

    def _role(self, headers):
        role = self._keys.get(headers.get("X-Api-Key", ""))
        if role is None:
            raise Unauthorized("missing or unknown API key")
        return role

    def _list_items(self, role, match, payload):
        items = self._store.list_items()
        return Response(200, {"items": [_item_json(item) for item in items]})

    def _get_item(self, role, match, payload):
        return Response(200, _item_json(self._store.get_item(match["sku"])))

    def _add_item(self, role, match, payload):
        _require_clerk(role)
        sku = _field(payload, "sku", str)
        if re.fullmatch(_SKU, sku) is None:
            raise BadRequest(f"invalid SKU {sku!r}; use upper-case letters, digits, and dashes")
        item = self._store.add_item(
            sku, _field(payload, "name", str), _field(payload, "unit_cost_cents", int)
        )
        return Response(201, _item_json(item))

    def _receive(self, role, match, payload):
        _require_clerk(role)
        item = self._store.receive(match["sku"], _field(payload, "quantity", int))
        return Response(200, _item_json(item))

    def _ship(self, role, match, payload):
        _require_clerk(role)
        item = self._store.ship(match["sku"], _field(payload, "quantity", int))
        return Response(200, _item_json(item))

    def _discontinue(self, role, match, payload):
        _require_clerk(role)
        return Response(200, _item_json(self._store.discontinue(match["sku"])))


def _require_clerk(role):
    if role != CLERK:
        raise Forbidden("this request needs a clerk key")


def _payload(body):
    if not body:
        return {}
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise BadRequest("request body is not valid JSON") from error
    if not isinstance(payload, dict):
        raise BadRequest("request body must be a JSON object")
    return payload


def _field(payload, name, kind):
    value = payload.get(name)
    # type() rather than isinstance(): JSON true must not pass as the integer 1.
    if type(value) is not kind:
        raise BadRequest(f"{name} must be a {kind.__name__}")
    return value


def _item_json(item):
    return {**asdict(item), "unit_cost": format_cents(item.unit_cost_cents)}

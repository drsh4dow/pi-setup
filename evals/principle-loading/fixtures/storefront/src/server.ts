import { createServer } from "node:http";
import { cancelOrder, listOrders, markPaid } from "./orders/orders.ts";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/orders") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listOrders()));
    return;
  }

  const pay = url.pathname.match(/^\/orders\/([^/]+)\/pay$/);
  if (req.method === "POST" && pay) {
    try {
      markPaid(pay[1]);
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(400).end(String(error));
    }
    return;
  }

  const cancel = url.pathname.match(/^\/orders\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancel) {
    try {
      cancelOrder(cancel[1]);
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(400).end(String(error));
    }
    return;
  }

  res.writeHead(404).end("not found");
});

if (import.meta.main) {
  server.listen(3000, () => console.log("listening on :3000"));
}

export { server };

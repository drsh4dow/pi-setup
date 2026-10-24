import { createServer } from "node:http";
import { total } from "../src/invoice.js";

createServer((request, response) => {
  response.end(String(total([])));
}).listen(Number(process.env.PORT ?? 8080));

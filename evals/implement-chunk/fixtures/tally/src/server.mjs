import { createServer } from "node:http";
import { handle } from "./app.mjs";
import { messages } from "./messages.mjs";

const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (request, response) => {
  let result;

  try {
    result = await handle(new URL(request.url, "http://localhost"));
  } catch (error) {
    console.error(error);
    result = { status: 500, body: { error: messages["internal-error"] } };
  }

  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
});

server.listen(port, "127.0.0.1", () => console.log(`tally listening on ${port}`));

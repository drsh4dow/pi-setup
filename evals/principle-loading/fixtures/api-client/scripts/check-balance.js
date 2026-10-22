import { getBalance } from "../src/client.js";

console.log(await getBalance(process.env.LEDGER_ENV ?? "prod", process.argv[2]));

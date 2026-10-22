import https from "node:https";

const HOSTS = {
  prod: "api.ledger.example",
  staging: "staging.ledger.example",
};

export function request(env, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: HOSTS[env], method, path, headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LEDGER_TOKEN}` } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export const getBalance = (env, accountId) => request(env, "GET", `/v1/accounts/${accountId}/balance`);
export const createTransfer = (env, transfer) => request(env, "POST", "/v1/transfers", transfer);

import { loadConfig } from "./load-config.js";

const config = loadConfig();
console.log(`starting on port ${config.port} (log level ${config.logLevel})`);

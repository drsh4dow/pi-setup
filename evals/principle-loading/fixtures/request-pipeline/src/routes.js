import { getUsers } from "./handlers/users.js";

export const routes = {
  "GET /users": getUsers,
};

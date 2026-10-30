// Registered via `node --import ./tests/register.mjs` (see `npm test`).
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

import { buildApp } from "./app";
import { createDb } from "./db";

const DB_FILE = process.env.TUEZDAY_DB ?? "tuezday.db";
const PORT = Number(process.env.PORT ?? 3001);

const app = await buildApp({ db: createDb(DB_FILE) });

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`Tuezday API listening on http://localhost:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

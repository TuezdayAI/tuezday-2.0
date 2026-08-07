import { buildRendererApp } from "./app";
import { createBrowserRenderer } from "./browser-renderer";
import { loadRootEnv, parseRendererConfig } from "./config";

loadRootEnv();
const config = parseRendererConfig();
const renderer = createBrowserRenderer(config);
const app = await buildRendererApp({ renderer, token: config.token });

try {
  const host = process.env.RENDER_HOST?.trim() || "127.0.0.1";
  await app.listen({ port: config.port, host });
  console.log(`Tuezday renderer listening on http://${host}:${config.port}`);
} catch (error) {
  console.error(error);
  await app.close().catch(() => undefined);
  process.exit(1);
}

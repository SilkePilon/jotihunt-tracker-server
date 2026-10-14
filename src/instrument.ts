// Preloaded (`bun run --preload ./src/instrument.ts src/index.ts`) so Sentry is set up before any other module loads
import { initSentry } from "./sentry";

initSentry();

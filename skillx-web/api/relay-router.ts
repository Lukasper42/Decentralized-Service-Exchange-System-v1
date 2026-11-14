// Stable Vercel API entrypoint; the rewrite passes the original route in __route.
export { default } from './relay/[...path].js';

// How the built PWA is served: which paths are the app's own routes (answered with index.html),
// how each file is cached, and the security headers every file gets. The server answers any
// extensionless GET outside /api and /assets with index.html. Hashed build output under /assets/
// never changes; everything else (index.html, sw.js, the manifest) is revalidated so an update
// reaches clients on their next visit. No platform imports.

export const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Sent with the page and every file of the build. Only the app's own scripts run, with no inline
 * script; inline styles are allowed because Solid and Chart.js set style attributes. Data and
 * blob images cover the recovery key QR and CSV export. Google sign-in is a full-page navigation,
 * which connect-src does not govern.
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** The API's paths: /api itself and everything under /api/. Never answered with the page. */
export const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

export const cacheControlFor = (path: string) =>
  path.startsWith("/assets/") ? IMMUTABLE : "no-cache";

/** A client-side route: no file extension, not the API and not under /assets/ (build files). */
export const isAppRoute = (path: string) =>
  !isApiPath(path) && !path.startsWith("/assets/") && !/\.[^/]*$/.test(path);

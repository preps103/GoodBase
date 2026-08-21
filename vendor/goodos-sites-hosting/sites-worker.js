const FRESH_DOCUMENT_PATTERN = /(?:^|\/)(?:index\.html|site\.webmanifest)$/i;

function withDocumentHeaders(response, pathname) {
  if (pathname !== "/" && !pathname.endsWith(".html") && !FRESH_DOCUMENT_PATTERN.test(pathname)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (env.CUSTOMER_HTTP_APP_BACKEND?.fetch) {
        return env.CUSTOMER_HTTP_APP_BACKEND.fetch(request);
      }
      return Response.json(
        { error: "Application backend is not connected to this Sites deployment." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && request.method === "GET") {
      const fallback = new URL(request.url);
      fallback.pathname = "/index.html";
      response = await env.ASSETS.fetch(new Request(fallback, request));
    }

    return withDocumentHeaders(response, url.pathname);
  },
};

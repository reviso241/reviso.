export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, apikey, x-client-info, Prefer"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const targetBase = "https://kfdetwgmpdvlsinjzphi.supabase.co";";
  const incomingUrl = new URL(req.url, `https://${req.headers.host || "reviso-pink.vercel.app"}`);
  const queryPath = incomingUrl.searchParams.get("path");
  incomingUrl.searchParams.delete("path");

  const subPath = queryPath
    ? queryPath.replace(/^\/+/, "")
    : incomingUrl.pathname.replace(/^\/api\/supabase\/?/, "");

  const qs = incomingUrl.searchParams.toString();
  const targetUrl = `${targetBase}/${subPath}${qs ? `?${qs}` : ""}`;

  try {
    const headers = {
      "User-Agent": "Reviso-Vercel-Relay/1.0"
    };
    for (const h of ["content-type", "authorization", "apikey", "x-client-info", "prefer"]) {
      if (req.headers[h]) {
        headers[h] = req.headers[h];
      }
    }

    const fetchOptions = {
      method: req.method,
      headers
    };

    if (!["GET", "HEAD"].includes(req.method) && req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        fetchOptions.body = req.body.toString("utf-8");
      } else if (typeof req.body === "string") {
        fetchOptions.body = req.body;
      } else {
        fetchOptions.body = JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl, fetchOptions);
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.status(upstream.status).send(text);
  } catch (err) {
    return res.status(502).json({
      error: "Relais Supabase indisponible",
      targetUrl,
      details: err.cause?.message || err.message,
      code: err.cause?.code || null
    });
  }
}
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

  const targetBase = "https://kfdetwgmfpdvislnjzphi.supabase.co";
  const rawPath = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : String(req.query.path || "");

  const forwardParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      value.forEach((v) => forwardParams.append(key, String(v)));
    } else if (value !== undefined) {
      forwardParams.append(key, String(value));
    }
  }

  const qs = forwardParams.toString();
  const targetUrl = `${targetBase}/${rawPath.replace(/^\/+/, "")}${qs ? `?${qs}` : ""}`;

  try {
    const headers = {};
    for (const h of ["content-type", "authorization", "apikey", "x-client-info", "prefer"]) {
      if (req.headers[h]) {
        headers[h] = req.headers[h];
      }
    }

    const fetchOptions = {
      method: req.method,
      headers
    };

    if (!["GET", "HEAD"].includes(req.method) && req.body !== undefined) {
      fetchOptions.body =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);
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
      details: err.message
    });
  }
}
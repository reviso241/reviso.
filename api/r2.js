import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.R2_BUCKET_NAME || "reviso-bibliotheque";
const INDEX_KEY = "_catalog/bibliotheque-index.json";

async function readCatalog() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: INDEX_KEY }));
    const text = await res.Body.transformToString("utf-8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return [];
    throw err;
  }
}

async function writeCatalog(items) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: INDEX_KEY,
      Body: JSON.stringify(items, null, 2),
      ContentType: "application/json; charset=utf-8"
    })
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const action = req.query.action || "list";

      if (action === "list") {
        const items = await readCatalog();
        return res.status(200).json({ ok: true, items });
      }

      if (action === "browse") {
        const prefix = req.query.prefix || "reviso-tiroirs/";
        const data = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" })
        );
        const folders = (data.CommonPrefixes || []).map((p) => p.Prefix);
        const files = (data.Contents || []).filter((f) => !f.Key.endsWith(".keep"));
        return res.status(200).json({ ok: true, folders, files });
      }

      if (action === "download") {
        const key = req.query.key;
        if (!key) return res.status(400).json({ ok: false, error: "Clé manquante." });
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: key }),
          { expiresIn: 3600 }
        );
        return res.status(200).json({ ok: true, url });
      }
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const action = body?.action;

      if (action === "presign-upload") {
        const { fileName, contentType, folderPath } = body;
        if (!fileName) return res.status(400).json({ ok: false, error: "Nom de fichier manquant." });
        const cleanFolder = (folderPath || "reviso-tiroirs/superieur/sante/maieutique/cours")
          .replace(/^\/+|\/+$/g, "");
        const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
        const key = `${cleanFolder}/${Date.now()}-${cleanName}`;

        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentType || "application/pdf"
          }),
          { expiresIn: 900 }
        );

        return res.status(200).json({ ok: true, uploadUrl, key });
      }

      if (action === "register-document") {
        const { key, title, category, level, field, subject, authorName, institution, year, authorAttested, keywords, excerpt, fileSize } = body;
        if (!key || !title || !authorName || !authorAttested) {
          return res.status(400).json({ ok: false, error: "Titre, auteur et attestation obligatoires." });
        }

        const items = await readCatalog();
        const newDoc = {
          id: `doc_${Date.now()}`,
          key,
          title: String(title).trim(),
          category: category || "Cours",
          level: level || "Supérieur",
          field: field || "Général",
          subject: subject || "Non précisée",
          authorName: String(authorName).trim(),
          institution: String(institution || "").trim(),
          year: String(year || new Date().getFullYear()).trim(),
          authorVerified: true,
          keywords: String(keywords || "").trim(),
          excerpt: String(excerpt || "").slice(0, 1200),
          fileSize: Number(fileSize || 0),
          uploadedAt: new Date().toISOString()
        };

        items.unshift(newDoc);
        await writeCatalog(items);
        return res.status(200).json({ ok: true, item: newDoc });
      }
    }

    return res.status(400).json({ ok: false, error: "Action non reconnue." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Erreur serveur R2." });
  }
}

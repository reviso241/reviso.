import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ACCOUNT_ENDPOINT = "https://f7e5cd54a87349d05caa39ea3e891a26.r2.cloudflarestorage.com";
const R2_ENDPOINT = process.env.R2_ENDPOINT ||
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : ACCOUNT_ENDPOINT);
const BUCKET = process.env.R2_BUCKET_NAME || "reviso-bibliotheque";
const ROOT_PREFIX = "reviso-tiroirs/";
const INDEX_KEY = "_catalog/bibliotheque-index.json";
const ALLOWED_FOLDERS = new Set([
  "reviso-tiroirs/college/cours",
  "reviso-tiroirs/college/livres",
  "reviso-tiroirs/college/annales",
  "reviso-tiroirs/scientifique-c-d",
  "reviso-tiroirs/litteraire-a1-a2",
  "reviso-tiroirs/economie-b",
  "reviso-tiroirs/stt-gestion",
  "reviso-tiroirs/sti-industriel",
  "reviso-tiroirs/gestion-management",
  "reviso-tiroirs/genie-ingenierie",
  "reviso-tiroirs/droit-juridique",
  "reviso-tiroirs/sante/maieutique",
  "reviso-tiroirs/sante/medecine",
  "reviso-tiroirs/sante/pharmacie",
  "reviso-tiroirs/sante/soins-infirmiers",
  "reviso-tiroirs/sante/biologie-imagerie",
  "reviso-tiroirs/lettres-sciences"
]);
const CATEGORIES = new Set(["cours", "livres", "recherche", "annales", "rapports-stage"]);

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeCategory(value) {
  const category = normalizeText(value).replace(/[\s_]+/g, "-");
  if (category === "cours" || category === "course") return "cours";
  if (category === "livre" || category === "livres" || category === "book" || category === "books") return "livres";
  if (category === "annale" || category === "annales" || category === "examen") return "annales";
  if (category === "recherche" || category === "research") return "recherche";
  if (category === "rapport-stage" || category === "rapport-de-stage" || category === "rapports-stage") return "rapports-stage";
  return "";
}

function isSafeR2Path(path) {
  return path.startsWith(ROOT_PREFIX) &&
    !path.includes("\\") &&
    !path.split("/").some(part => part === "." || part === "..");
}

function resolveFolderPath(body) {
  const requested = String(body.folderPath || "").replace(/^\/+|\/+$/g, "");
  if (requested) {
    if (!ALLOWED_FOLDERS.has(requested)) throw new Error("Rayon ou filière non autorisé.");
    return requested;
  }

  const field = String(body.field || body.filiere || "").replace(/^\/+|\/+$/g, "");
  const fieldPath = field.startsWith(ROOT_PREFIX) ? field : `${ROOT_PREFIX}${field}`;
  if (ALLOWED_FOLDERS.has(fieldPath)) return fieldPath;

  const level = normalizeText(body.level || body.rayon);
  const category = normalizeCategory(body.category);
  if (level.includes("college") || level.includes("colleg")) {
    const subfolder = category === "livres" ? "livres" : category === "annales" ? "annales" : "cours";
    return `${ROOT_PREFIX}college/${subfolder}`;
  }
  return `${ROOT_PREFIX}college/cours`;
}

function documentRayon(item) {
  const key = String(item.key || "");
  if (key.includes("/college/")) return "college";
  if (/\/(scientifique-c-d|litteraire-a1-a2|economie-b)\//.test(key)) return "lycee-general";
  if (/\/(stt-gestion|sti-industriel)\//.test(key)) return "lycee-technique";
  if (/\/(gestion-management|genie-ingenierie|droit-juridique|sante\/|lettres-sciences)/.test(key)) {
    return "universites-grandes-ecoles";
  }
  return normalizeText(item.rayon);
}

function matchesFilters(item, query) {
  const category = normalizeCategory(item.category || item.type);
  const requestedCategory = normalizeCategory(query.category || query.type);
  if (requestedCategory && category !== requestedCategory) return false;

  const levelFilter = normalizeText(query.level).replace(/[\s_]+/g, "-");
  if (levelFilter && !normalizeText(item.level || item.niveau).replace(/[\s_]+/g, "-").includes(levelFilter)) return false;

  const rayonFilter = normalizeText(query.rayon).replace(/[\s_]+/g, "-");
  if (rayonFilter) {
    const rayonValues = [
      normalizeText(item.rayon).replace(/[\s_]+/g, "-"),
      documentRayon(item)
    ].filter(Boolean);
    if (!rayonValues.some(value => value.includes(rayonFilter) || rayonFilter.includes(value))) return false;
  }

  const fieldFilter = normalizeText(query.field || query.filiere);
  if (fieldFilter && ![
    normalizeText(item.field),
    normalizeText(item.filiere),
    normalizeText(item.key)
  ].some(value => value.includes(fieldFilter))) return false;

  const domainFilter = normalizeText(query.domain);
  if (domainFilter) {
    const domainFolders = {
      sante: ["sante/", "maieutique", "medecine", "pharmacie", "soins-infirmiers", "biologie-imagerie"],
      gestion: ["gestion-management", "economie"],
      genie: ["genie-ingenierie", "sti-industriel", "scientifique-c-d"],
      droit: ["droit-juridique"],
      lettres: ["lettres-sciences", "litteraire-a1-a2"]
    };
    const aliases = domainFolders[domainFilter] || [domainFilter];
    const searchable = normalizeText([
      item.domain, item.field, item.filiere, item.key
    ].join(" "));
    if (!aliases.some(alias => searchable.includes(normalizeText(alias)))) return false;
  }

  const prefix = String(query.prefix || query.folderPath || "");
  if (prefix && !String(item.key || "").startsWith(prefix)) return false;

  const search = normalizeText(query.q || query.search || query.query);
  if (search) {
    const searchable = normalizeText([
      item.title, item.subject, item.authorName, item.institution, item.keywords,
      item.excerpt, item.level, item.field, item.category, item.key
    ].join(" "));
    const terms = search.split(/\s+/).filter(term => term.length >= 3);
    if (terms.length && !terms.some(term => searchable.includes(term))) return false;
  }
  return true;
}

async function readCatalog() {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: INDEX_KEY }));
    const text = await response.Body.transformToString("utf-8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return [];
    throw error;
  }
}

async function writeCatalog(items) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: INDEX_KEY,
    Body: JSON.stringify(items, null, 2),
    ContentType: "application/json; charset=utf-8"
  }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const action = req.query.action || "list";

      if (action === "list") {
        const items = await readCatalog();
        const filtered = items.filter(item => matchesFilters(item, req.query));
        return res.status(200).json({ ok: true, items: filtered, totalCount: items.length });
      }

      if (action === "browse") {
        const prefix = String(req.query.prefix || ROOT_PREFIX);
        if (!isSafeR2Path(prefix) || !prefix.startsWith(ROOT_PREFIX)) {
          return res.status(400).json({ ok: false, error: "Chemin de rayon invalide." });
        }
        const data = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          Delimiter: "/"
        }));
        const folders = (data.CommonPrefixes || []).map(item => item.Prefix);
        const files = (data.Contents || []).filter(item => !item.Key.endsWith(".keep"));
        return res.status(200).json({ ok: true, folders, files });
      }

      if (action === "download") {
        const key = String(req.query.key || "");
        if (!isSafeR2Path(key) || !key.startsWith(ROOT_PREFIX)) {
          return res.status(400).json({ ok: false, error: "Clé de document invalide." });
        }
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET, Key: key }),
          { expiresIn: 3600 }
        );
        return res.status(200).json({ ok: true, url });
      }

      return res.status(400).json({ ok: false, error: "Action GET non reconnue." });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const action = body.action;

      if (action === "presign-upload") {
        const fileName = String(body.fileName || "").trim();
        const contentType = String(body.contentType || "");
        const category = normalizeCategory(body.category || "cours");
        if (!fileName || !fileName.toLowerCase().endsWith(".pdf") || contentType !== "application/pdf") {
          return res.status(400).json({ ok: false, error: "Un fichier PDF valide est requis." });
        }
        if (!CATEGORIES.has(category)) {
          return res.status(400).json({ ok: false, error: "Catégorie invalide." });
        }
        const folderPath = resolveFolderPath(body);
        const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
        const key = `${folderPath}/${Date.now()}-${cleanName}`;
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentType
          }),
          { expiresIn: 900 }
        );
        return res.status(200).json({ ok: true, uploadUrl, key, folderPath });
      }

      if (action === "register-document") {
        const key = String(body.key || "");
        const title = String(body.title || "").trim();
        const authorName = String(body.authorName || body.author || "").trim();
        const authorAttested = body.authorAttested === true;
        const category = normalizeCategory(body.category);
        const folderPath = resolveFolderPath(body);
        if (!title || !authorName || !authorAttested) {
          return res.status(400).json({
            ok: false,
            error: "Titre, nom de l’auteur et attestation des droits obligatoires."
          });
        }
        if (!CATEGORIES.has(category) || !isSafeR2Path(key) || !key.startsWith(`${folderPath}/`)) {
          return res.status(400).json({ ok: false, error: "Catégorie ou clé de document invalide." });
        }

        const object = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        if (object.ContentType && object.ContentType !== "application/pdf") {
          return res.status(400).json({ ok: false, error: "Le fichier téléversé doit être un PDF." });
        }
        const items = await readCatalog();
        const newDocument = {
          id: `doc_${Date.now()}`,
          key,
          folderPath: `${folderPath}/`,
          rayon: String(body.rayon || ""),
          category,
          level: String(body.level || body.rayon || ""),
          field: String(body.field || body.filiere || ""),
          filiere: String(body.filiere || body.field || ""),
          title: title.slice(0, 180),
          subject: String(body.subject || "").trim().slice(0, 120),
          authorName: authorName.slice(0, 120),
          authorAttested: true,
          authorVerified: true,
          institution: String(body.institution || "").trim().slice(0, 160),
          year: String(body.year || new Date().getFullYear()).trim().slice(0, 4),
          keywords: Array.isArray(body.keywords)
            ? body.keywords.map(value => String(value).trim()).filter(Boolean).join(", ").slice(0, 300)
            : String(body.keywords || "").trim().slice(0, 300),
          excerpt: String(body.excerpt || body.summary || "").slice(0, 1000),
          fileName: String(body.fileName || "").slice(0, 255),
          fileSize: Number(object.ContentLength || 0),
          uploadedAt: new Date().toISOString()
        };
        items.unshift(newDocument);
        await writeCatalog(items);
        return res.status(200).json({ ok: true, item: newDocument });
      }
      return res.status(400).json({ ok: false, error: "Action POST non reconnue." });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Méthode non autorisée." });
  } catch (error) {
    console.error("Erreur API Cloudflare R2 :", error);
    return res.status(500).json({ ok: false, error: error.message || "Erreur serveur R2." });
  }
}

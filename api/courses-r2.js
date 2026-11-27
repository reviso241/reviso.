import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ACCOUNT_ENDPOINT = "https://f7e5cd54a87349d05caa39ea3e891a26.r2.cloudflarestorage.com";
const R2_ENDPOINT = process.env.R2_COURSES_ENDPOINT ||
  process.env.R2_ENDPOINT ||
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : ACCOUNT_ENDPOINT);

const BUCKET = process.env.R2_COURSES_BUCKET_NAME || "reviso-courses";
const PUBLIC_URL = (process.env.R2_COURSES_PUBLIC_URL || "https://pub-b1513b27beb44c69901d5c5e3a755f51.r2.dev").replace(/\/+$/, "");

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_COURSES_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_COURSES_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY
  }
});

function sanitizeSegment(value, fallback = "guest") {
  const clean = String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 120);
  return clean || fallback;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const action = req.query.action || "list-courses";
      const userId = sanitizeSegment(req.query.userId, "guest");

      if (action === "list-courses") {
        const prefix = `courses/${userId}/`;
        const listed = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix
        }));
        const jsonKeys = (listed.Contents || [])
          .map(obj => obj.Key)
          .filter(key => key && key.endsWith(".json"));

        const courses = [];
        for (const key of jsonKeys) {
          try {
            const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
            const raw = await obj.Body.transformToString("utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.id) {
              courses.push({
                id: parsed.id,
                title: parsed.title || "Cours sans titre",
                subject: parsed.subject || "",
                fileName: parsed.fileName || "",
                fileUrl: parsed.fileUrl || "",
                updatedAt: parsed.updatedAt || parsed.createdAt || new Date().toISOString(),
                charCount: parsed.fullText ? parsed.fullText.length : 0,
                r2Key: key
              });
            }
          } catch (_) {
            // Ignorer un objet corrompu
          }
        }
        courses.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        return res.status(200).json({ ok: true, courses });
      }

      if (action === "get-course") {
        const courseId = sanitizeSegment(req.query.courseId, "");
        if (!courseId) return res.status(400).json({ ok: false, error: "courseId requis." });
        const key = `courses/${userId}/${courseId}.json`;
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const raw = await obj.Body.transformToString("utf-8");
        const course = JSON.parse(raw);
        return res.status(200).json({ ok: true, course, r2Key: key });
      }

      return res.status(400).json({ ok: false, error: "Action GET inconnue." });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const action = body.action;
      const userId = sanitizeSegment(body.userId, "guest");

      if (action === "save-course") {
        const course = body.course;
        if (!course || !course.id) {
          return res.status(400).json({ ok: false, error: "Objet course avec id requis." });
        }
        const courseId = sanitizeSegment(course.id);
        const key = `courses/${userId}/${courseId}.json`;
        const payload = {
          ...course,
          id: courseId,
          userId,
          updatedAt: new Date().toISOString()
        };

        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: JSON.stringify(payload),
          ContentType: "application/json; charset=utf-8"
        }));

        return res.status(200).json({
          ok: true,
          r2Key: key,
          publicUrl: `${PUBLIC_URL}/${key}`
        });
      }

      if (action === "presign-file") {
        const courseId = sanitizeSegment(body.courseId || `course_${Date.now()}`);
        const fileName = sanitizeSegment(body.fileName || "document.pdf");
        const contentType = String(body.contentType || "application/octet-stream");
        const key = `files/${userId}/${courseId}-${fileName}`;

        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            ContentType: contentType
          }),
          { expiresIn: 900 }
        );

        return res.status(200).json({
          ok: true,
          uploadUrl,
          key,
          fileUrl: `${PUBLIC_URL}/${key}`
        });
      }

      if (action === "delete-course") {
        const courseId = sanitizeSegment(body.courseId, "");
        if (!courseId) return res.status(400).json({ ok: false, error: "courseId requis." });
        const key = `courses/${userId}/${courseId}.json`;
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: "Action POST inconnue." });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Méthode non autorisée." });
  } catch (error) {
    console.error("Erreur API R2 Courses :", error);
    return res.status(500).json({ ok: false, error: error.message || "Erreur serveur R2 Courses." });
  }
}

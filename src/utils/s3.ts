import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { randomUUID } from "crypto";

const REGION = process.env.AWS_REGION as string;
const BUCKET = process.env.AWS_BUCKET_NAME as string;

export const s3Client = new S3Client({ region: REGION });

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

interface PresignParams {
  folder: "products" | "blog";
  entityId: string | number;
  contentType: string;
}

export const buildProductImageKey = (folder: string, entityId: string | number, contentType: string) => {
  const ext = EXTENSION_BY_TYPE[contentType];
  return `${folder}/${entityId}/${randomUUID()}.${ext}`;
};

// Generates a presigned POST so the admin browser uploads directly to S3 —
// the backend never touches the file bytes and AWS credentials never leave the server.
export const generatePresignedUpload = async ({ folder, entityId, contentType }: PresignParams) => {
  if (!ALLOWED_IMAGE_TYPES.includes(contentType as any)) {
    throw Object.assign(new Error("Unsupported content type"), { status: 422 });
  }

  const key = buildProductImageKey(folder, entityId, contentType);

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: BUCKET,
    Key: key,
    Conditions: [
      ["content-length-range", 1, MAX_IMAGE_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: {
      "Content-Type": contentType,
    },
    Expires: 60, // seconds
  });

  return { url, fields, key, publicUrl: buildPublicUrl(key) };
};

export const buildPublicUrl = (key: string) => {
  const cdn = process.env.AWS_CLOUDFRONT_DOMAIN;
  if (cdn) return `https://${cdn}/${key}`;
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
};

export const deleteS3Object = async (key: string) => {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};

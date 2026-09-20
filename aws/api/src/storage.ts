import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object-storage helpers shared by route handlers.
 *
 * This lives in its own module rather than in index.ts so handlers can use it
 * without importing the router they are mounted on (which would be a cycle).
 */

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

/**
 * Short-lived presigned GET for an object the caller owns.
 *
 * Used to hand meeting audio to the transcription provider without making the
 * bucket public — the URL expires, and the key must sit under the caller's own
 * `${userId}/` prefix, so one user can never read (or transcribe) another's
 * recording by guessing a key. Returns null when that check fails.
 */
export async function presignUserAudio(
  userId: string,
  key: string,
  expiresIn = 3600
): Promise<string | null> {
  if (!key.startsWith(`${userId}/`)) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn });
}

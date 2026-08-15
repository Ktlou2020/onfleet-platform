'use strict';

// Thin S3-compatible storage client for Cloudflare R2. Inactive until
// R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET are all set —
// isConfigured() gates every call site so local-disk uploads (today's only
// behavior) are completely unaffected until those env vars exist.
//
// Deliberately never issues a public R2 URL. app.js's /uploads/:path route
// proxies bytes through the backend for both disk- and R2-stored files, so
// access stays exactly as it is today (an unguessable generated filename,
// no separate authorization check) regardless of which backend a given file
// lives on — pointing at a public bucket instead would have made that same
// weak-by-obscurity posture reachable without even the random filename.

const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function isConfigured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

let client = null;
function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

async function putObject(key, buffer, contentType) {
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

// Returns { stream, contentType, contentLength } or null if the key doesn't exist.
async function getObjectStream(key) {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return { stream: res.Body, contentType: res.ContentType, contentLength: res.ContentLength };
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;
    throw e;
  }
}

// Returns { contentType, contentLength } or null if the key doesn't exist — for HEAD requests.
async function headObject(key) {
  try {
    const res = await getClient().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return { contentType: res.ContentType, contentLength: res.ContentLength };
  } catch (e) {
    if (e.name === 'NotFound') return null;
    throw e;
  }
}

async function deleteObject(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

module.exports = { isConfigured, putObject, getObjectStream, headObject, deleteObject };

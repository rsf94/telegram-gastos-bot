import crypto from "crypto";

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function createLinkToken({ secret, now = new Date(), ttlMinutes = 15 }) {
  const safeSecret = String(secret || "");
  if (!safeSecret) {
    throw new Error("LINK_TOKEN_SECRET is required");
  }

  const randomPart = base64UrlEncode(crypto.randomBytes(24));
  const signature = crypto
    .createHmac("sha256", safeSecret)
    .update(randomPart)
    .digest("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  return {
    linkToken: `${randomPart}.${signature}`,
    expiresAt
  };
}

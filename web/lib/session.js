const E2E_FAKE_USER = {
  email: "rafasf94@gmail.com",
  user_id: "e2e-user",
  chat_id: "e2e-chat"
};

export function isE2EBypassEnabled(env = process.env) {
  return env.E2E_AUTH_BYPASS === "1" && env.NODE_ENV !== "production";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function parseAllowedEmails(env = process.env) {
  const raw = String(env.AUTH_ALLOWED_EMAILS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => normalizeEmail(value))
    .filter(Boolean);
}

function getRequestEmail(request) {
  const headerEmail =
    request?.headers?.get("x-user-email") ||
    request?.headers?.get("x-goog-authenticated-user-email") ||
    "";

  if (!headerEmail) return "";
  const value = headerEmail.includes(":") ? headerEmail.split(":").at(-1) : headerEmail;
  return normalizeEmail(value);
}

export function getSessionUserFromRequest(request, env = process.env) {
  if (isE2EBypassEnabled(env)) {
    return { ...E2E_FAKE_USER };
  }

  const email = getRequestEmail(request);
  if (!email) return null;

  const allowedEmails = parseAllowedEmails(env);
  if (allowedEmails.length > 0 && !allowedEmails.includes(email)) {
    return null;
  }

  return { email };
}

export async function readSession(request, env = process.env) {
  const user = getSessionUserFromRequest(request, env);
  if (!user) return null;
  return { user };
}

export function assertAuthenticated(session) {
  return Boolean(session?.user?.email);
}

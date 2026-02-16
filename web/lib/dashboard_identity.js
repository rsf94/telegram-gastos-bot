import crypto from "crypto";

export function normalizeEmail(email) {
  if (!email) return "";
  return String(email).trim().toLowerCase();
}

function isMissingTableError(error) {
  const message = String(error?.message || "");
  if (message.includes("Not found: Table")) return true;
  const reason = error?.errors?.[0]?.reason || error?.response?.errors?.[0]?.reason;
  return reason === "notFound";
}

function buildMissingTableError({ projectId, dataset, table }) {
  return new Error(
    `Missing required table ${projectId}.${dataset}.${table}. Run docs/migrations for identity linking.`
  );
}

async function queryRows(bq, options, { projectId, dataset, table }) {
  try {
    const [rows] = await bq.query(options);
    return rows;
  } catch (error) {
    if (isMissingTableError(error)) {
      throw buildMissingTableError({ projectId, dataset, table });
    }
    throw error;
  }
}

export async function ensureUserExists({ bq, projectId, dataset, email, now = new Date() }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Authenticated email is required");
  }

  const existingRows = await queryRows(
    bq,
    {
      query: `
        SELECT user_id
        FROM \`${projectId}.${dataset}.users\`
        WHERE email = @email
        ORDER BY created_at ASC
        LIMIT 1
      `,
      params: { email: normalizedEmail },
      parameterMode: "NAMED"
    },
    { projectId, dataset, table: "users" }
  );

  if (existingRows.length > 0) {
    return {
      userId: String(existingRows[0].user_id),
      email: normalizedEmail,
      created: false
    };
  }

  const userId = crypto.randomUUID();
  const row = {
    user_id: userId,
    email: normalizedEmail,
    created_at: now.toISOString(),
    last_seen_at: null,
    metadata: null
  };

  try {
    await bq.dataset(dataset).table("users").insert([row]);
  } catch (error) {
    if (isMissingTableError(error)) {
      throw buildMissingTableError({ projectId, dataset, table: "users" });
    }
    throw error;
  }

  return { userId, email: normalizedEmail, created: true };
}

export async function resolveLinkedChatId({ bq, projectId, dataset, userId }) {
  const rows = await queryRows(
    bq,
    {
      query: `
        SELECT chat_id
        FROM \`${projectId}.${dataset}.chat_links\`
        WHERE user_id = @user_id
          AND status = 'LINKED'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      params: { user_id: String(userId) },
      parameterMode: "NAMED"
    },
    { projectId, dataset, table: "chat_links" }
  );

  if (rows.length === 0) return null;
  return String(rows[0].chat_id);
}

export async function consumeLinkToken({
  bq,
  projectId,
  dataset,
  linkToken,
  userId,
  email,
  now = new Date()
}) {
  const token = String(linkToken || "");
  if (!token) return null;

  const pendingRows = await queryRows(
    bq,
    {
      query: `
        SELECT chat_id
        FROM \`${projectId}.${dataset}.user_links\`
        WHERE link_token = @link_token
          AND status = 'PENDING'
          AND (expires_at IS NULL OR expires_at >= CURRENT_TIMESTAMP())
        ORDER BY created_at DESC
        LIMIT 1
      `,
      params: { link_token: token },
      parameterMode: "NAMED"
    },
    { projectId, dataset, table: "user_links" }
  );

  if (pendingRows.length === 0) {
    throw new Error("Invalid or expired link_token");
  }

  const createdAt = now.toISOString();
  const chatId = String(pendingRows[0].chat_id);

  try {
    await bq.dataset(dataset).table("chat_links").insert([
      {
        chat_id: chatId,
        user_id: String(userId),
        provider: "google",
        status: "LINKED",
        created_at: createdAt,
        last_seen_at: null,
        metadata: JSON.stringify({ source: "dashboard_link_token" })
      }
    ]);
  } catch (error) {
    if (isMissingTableError(error)) {
      throw buildMissingTableError({ projectId, dataset, table: "chat_links" });
    }
    throw error;
  }

  // Append-only audit row in legacy table.
  await bq.dataset(dataset).table("user_links").insert([
    {
      link_token: token,
      chat_id: chatId,
      status: "LINKED",
      created_at: createdAt,
      expires_at: null,
      email: normalizeEmail(email),
      provider: "google",
      linked_at: createdAt,
      last_seen_at: null,
      metadata: JSON.stringify({ user_id: String(userId), source: "chat_links" })
    }
  ]);

  return chatId;
}

export function getAuthenticatedEmail(request) {
  const headerEmail =
    request.headers.get("x-user-email") ||
    request.headers.get("x-goog-authenticated-user-email") ||
    "";

  if (!headerEmail) return "";

  // IAP can send accounts.google.com:user@example.com
  const value = headerEmail.includes(":") ? headerEmail.split(":").at(-1) : headerEmail;
  return normalizeEmail(value);
}

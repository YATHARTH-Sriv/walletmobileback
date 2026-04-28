import { neon } from "@neondatabase/serverless";
import { PrivyClient } from "@privy-io/node";
import cors from "cors";
import dotenv from "dotenv";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NEON_DB_URL: z.string().min(1),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  PORT: z.string().optional(),
});

const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  console.error(
    "Missing required environment variables",
    envResult.error.flatten().fieldErrors,
  );
  process.exit(1);
}

const env = envResult.data;

const sql = neon(env.NEON_DB_URL);

const privy = new PrivyClient({
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
});

const app = express();

app.use(cors());
app.use(express.json());

type DbUserRow = {
  id: number;
  privy_did: string;
  email: string | null;
  wallet_address: string | null;
  username: string | null;
  user_number: number | null;
};

type PublicUserRow = {
  id: number;
  username: string | null;
  email: string | null;
  wallet_address: string | null;
  user_number: number | null;
};

type SupportedSendAsset = "ETH" | "USDC";

type LinkedAccount = {
  type?: string;
  address?: string;
  id?: string;
  wallet_client_type?: string;
  walletClientType?: string;
};

type AuthenticatedRequest = Request & {
  auth: {
    authToken: string;
    dbUser: DbUserRow;
    privyUser: {
      id: string;
      linkedAccounts?: LinkedAccount[];
      linked_accounts?: LinkedAccount[];
    };
  };
};

const completeProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers, underscore"),
});

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_CAIP2 = "eip155:84532";
const BASE_SEPOLIA_CHAIN_ID = 84532;
const USDC_DECIMALS = 6;
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const POSITIVE_DECIMAL_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

function encodeERC20Transfer(toAddress: string, amount: bigint): string {
  const paddedTo = toAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const paddedAmount = amount.toString(16).padStart(64, "0");
  return ERC20_TRANSFER_SELECTOR + paddedTo + paddedAmount;
}

class BadRequestError extends Error { }

function isValidEvmAddress(address: string) {
  return EVM_ADDRESS_REGEX.test(address);
}

function normalizeAddress(address: string) {
  return `0x${address.slice(2).toLowerCase()}`;
}

function toHexQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function parseAmountToUnits(rawAmount: string, decimals: number) {
  const amount = rawAmount.trim();

  if (!POSITIVE_DECIMAL_REGEX.test(amount)) {
    throw new BadRequestError("Amount must be a valid positive number");
  }

  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new BadRequestError(`Amount supports up to ${decimals} decimals`);
  }

  const normalizedFraction = fraction.padEnd(decimals, "0");
  const asIntegerString =
    `${whole}${normalizedFraction}`.replace(/^0+/, "") || "0";
  const units = BigInt(asIntegerString);

  if (units <= 0n) {
    throw new BadRequestError("Amount must be greater than zero");
  }

  return units;
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      privy_did TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      username TEXT UNIQUE,
      user_number INTEGER UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_address TEXT;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id) NOT NULL,
      receiver_id INTEGER REFERENCES users(id),
      receiver_address TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset_symbol TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}


function parsePrimaryEmail(privyUser: {
  linkedAccounts?: LinkedAccount[];
  linked_accounts?: LinkedAccount[];
}) {
  const linkedAccounts = Array.isArray(privyUser?.linkedAccounts)
    ? privyUser.linkedAccounts
    : Array.isArray(privyUser?.linked_accounts)
      ? privyUser.linked_accounts
      : [];

  const emailAccount = linkedAccounts.find(
    (account) => account.type === "email",
  );

  return emailAccount?.address ?? null;
}

function parsePrimaryWalletAddress(privyUser: {
  linkedAccounts?: LinkedAccount[];
  linked_accounts?: LinkedAccount[];
}) {
  const linkedAccounts = Array.isArray(privyUser?.linkedAccounts)
    ? privyUser.linkedAccounts
    : Array.isArray(privyUser?.linked_accounts)
      ? privyUser.linked_accounts
      : [];

  const embeddedWalletAccount = linkedAccounts.find(
    (account) =>
      account.type === "wallet" &&
      (account.wallet_client_type === "privy" ||
        account.walletClientType === "privy") &&
      typeof account.address === "string" &&
      account.address.length > 0,
  );

  if (embeddedWalletAccount?.address) {
    return embeddedWalletAccount.address;
  }

  const walletAccount = linkedAccounts.find(
    (account) =>
      (account.type === "wallet" || account.type === "smart_wallet") &&
      typeof account.address === "string" &&
      account.address.length > 0,
  );

  return walletAccount?.address ?? null;
}

function findEmbeddedWalletId(
  privyUser: {
    linkedAccounts?: LinkedAccount[];
    linked_accounts?: LinkedAccount[];
  },
  preferredAddress?: string,
): string | null {
  const linkedAccounts = Array.isArray(privyUser?.linkedAccounts)
    ? privyUser.linkedAccounts
    : Array.isArray(privyUser?.linked_accounts)
      ? privyUser.linked_accounts
      : [];

  const normalizedPreferredAddress =
    preferredAddress && isValidEvmAddress(preferredAddress)
      ? normalizeAddress(preferredAddress)
      : null;

  if (normalizedPreferredAddress) {
    const exactMatchWallet = linkedAccounts.find(
      (account: any) =>
        account.type === "wallet" &&
        (account.wallet_client_type === "privy" ||
          account.walletClientType === "privy") &&
        typeof account.address === "string" &&
        normalizeAddress(account.address) === normalizedPreferredAddress,
    );

    if ((exactMatchWallet as any)?.id) {
      return (exactMatchWallet as any).id;
    }
  }

  const walletAccount = linkedAccounts.find(
    (account: any) =>
      account.type === "wallet" &&
      (account.wallet_client_type === "privy" ||
        account.walletClientType === "privy"),
  );

  return (walletAccount as any)?.id ?? null;
}

function normalizeUserRow(row: DbUserRow) {
  return {
    id: row.id,
    privyDid: row.privy_did,
    email: row.email,
    walletAddress: row.wallet_address,
    username: row.username,
    userNumber: row.user_number,
    needsUsernameSetup: !row.username || !row.user_number,
  };
}

function normalizePublicUser(row: PublicUserRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    walletAddress: row.wallet_address,
    userNumber: row.user_number,
  };
}

function extractBearerToken(req: Request) {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
}


async function verifyAccessToken(authToken: string) {
  let privyUser: any;
  let isIdentityToken = false;

  try {
    privyUser = await privy.users().get({
      id_token: authToken,
    });
    isIdentityToken = true;
  } catch {
    const claims = await privy.utils().auth().verifyAuthToken(authToken);
    privyUser = await getUserFromPrivy(claims.user_id);
  }

  const email = parsePrimaryEmail(privyUser);
  const walletAddress = parsePrimaryWalletAddress(privyUser);

  const rows = await sql`
    INSERT INTO users (privy_did, email, wallet_address)
    VALUES (${privyUser.id}, ${email}, ${walletAddress})
    ON CONFLICT (privy_did)
    DO UPDATE SET
      email = EXCLUDED.email,
      wallet_address = EXCLUDED.wallet_address,
      updated_at = NOW()
    RETURNING *;
  `;

  const dbUser = rows[0] as DbUserRow;

  return { dbUser, privyUser, isIdentityToken };
}

async function getUserFromPrivy(userId: string) {
  const usersResource = privy.users() as any;
  if (typeof usersResource._get === "function") {
    return await usersResource._get(userId);
  }
  throw new Error("Cannot get user by ID with current SDK version");
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Missing authorization token" });
    }

    const { dbUser, privyUser, isIdentityToken } = await verifyAccessToken(token);

    (req as AuthenticatedRequest).auth = {
      authToken: isIdentityToken ? token : "", // 🔥 CRITICAL
      dbUser,
      privyUser,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "Invalid authorization token" });
  }
}


app.get("/", (_, res) => {
  res.send("SERVER UP AND RUNNING");
});

app.get("/health", async (_, res) => {
  await sql`SELECT 1;`;
  res.json({ ok: true });
});

app.post("/auth/session", async (req, res) => {
  const parsed = z
    .object({
      authToken: z.string().min(1).optional(),
      idToken: z.string().min(1).optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "authToken is required" });
  }

  const token = parsed.data.authToken ?? parsed.data.idToken ?? "";

  if (!token) {
    return res.status(400).json({ error: "authToken is required" });
  }

  try {
    const { dbUser } = await verifyAccessToken(token);
    return res.json({ user: normalizeUserRow(dbUser) });
  } catch {
    return res
      .status(401)
      .json({ error: "Failed to verify authorization token" });
  }
});

app.get("/users/me", authMiddleware, async (req, res) => {
  const authedReq = req as AuthenticatedRequest;
  return res.json({ user: normalizeUserRow(authedReq.auth.dbUser) });
});

app.post("/users/complete-profile", authMiddleware, async (req, res) => {
  try {
    const parsed = completeProfileSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Username must be 3-24 chars (letters, numbers, underscore)",
      });
    }

    const username = parsed.data.username;
    const authedReq = req as AuthenticatedRequest;
    const currentUser = authedReq.auth.dbUser;

    if (currentUser.username && currentUser.user_number) {
      return res.json({ user: normalizeUserRow(currentUser) });
    }

    const usernameTaken = (await sql`
      SELECT id FROM users WHERE username = ${username} LIMIT 1;
    `) as { id: number }[];

    if (usernameTaken.length > 0) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const nextNumberRows = (await sql`
      SELECT COALESCE(MAX(user_number), 0) + 1 AS next_number FROM users;
    `) as { next_number: number }[];

    const nextNumber = Number(nextNumberRows[0].next_number);

    const updatedRows = await sql`
      UPDATE users
      SET username = ${username},
          user_number = ${nextNumber},
          updated_at = NOW()
      WHERE id = ${currentUser.id}
      RETURNING *;
    `;

    const updatedUser = updatedRows[0] as DbUserRow;

    return res.json({ user: normalizeUserRow(updatedUser) });
  } catch (err) {
    console.error("Complete profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/users/search", authMiddleware, async (req, res) => {
  try {
    const rawQuery = String(req.query.q ?? "").trim();
    const usernameQuery = rawQuery.replace(/^@+/, "");

    if (usernameQuery.length < 2 && rawQuery.length < 2) {
      return res.json({ users: [] });
    }

    const usernameSearchQuery = `%${usernameQuery}%`;
    const emailSearchQuery = `%${rawQuery}%`;
    const authedReq = req as AuthenticatedRequest;

    const users = (await sql`
      SELECT id, username, email, wallet_address, user_number
      FROM users
      WHERE (username ILIKE ${usernameSearchQuery} OR email ILIKE ${emailSearchQuery})
        AND id != ${authedReq.auth.dbUser.id}
        AND wallet_address IS NOT NULL
      LIMIT 10;
    `) as PublicUserRow[];

    return res.json({ users: users.map(normalizePublicUser) });
  } catch (err) {
    console.error("Search users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});



app.post("/transactions", authMiddleware, async (req, res) => {
  try {
    const parsed = z
      .object({
        receiver_id: z.number().optional(),
        receiver_address: z.string().min(1),
        amount: z.string().min(1),
        asset_symbol: z.string().min(1),
        tx_hash: z.string().min(1),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid transaction data" });
    }

    const authedReq = req as AuthenticatedRequest;
    const { receiver_id, receiver_address, amount, asset_symbol, tx_hash } =
      parsed.data;

    const newTx = await sql`
      INSERT INTO transactions (sender_id, receiver_id, receiver_address, amount, asset_symbol, tx_hash)
      VALUES (${authedReq.auth.dbUser.id}, ${receiver_id ?? null}, ${receiver_address}, ${amount}, ${asset_symbol}, ${tx_hash})
      RETURNING *;
    `;

    return res.json({ transaction: newTx[0] });
  } catch (err) {
    console.error("Create transaction error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/transactions/contacts", authMiddleware, async (req, res) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    const currentUserId = authedReq.auth.dbUser.id;

    const contacts = (await sql`
      SELECT DISTINCT u.id, u.username, u.email, u.wallet_address, u.user_number
      FROM users u
      JOIN transactions t ON (u.id = t.receiver_id OR u.id = t.sender_id)
      WHERE (t.sender_id = ${currentUserId} OR t.receiver_id = ${currentUserId})
        AND u.id != ${currentUserId}
      LIMIT 20;
    `) as PublicUserRow[];

    return res.json({ contacts: contacts.map(normalizePublicUser) });
  } catch (err) {
    console.error("Get contacts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get(
  "/transactions/history/:otherUserId",
  authMiddleware,
  async (req, res) => {
    try {
      const authedReq = req as AuthenticatedRequest;
      const currentUserId = authedReq.auth.dbUser.id;
      const otherUserId = Number(req.params.otherUserId);

      if (!otherUserId || isNaN(otherUserId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const history = await sql`
      SELECT *
      FROM transactions
      WHERE (sender_id = ${currentUserId} AND receiver_id = ${otherUserId})
         OR (sender_id = ${otherUserId} AND receiver_id = ${currentUserId})
      ORDER BY created_at DESC
      LIMIT 50;
    `;

      return res.json({ history });
    } catch (err) {
      console.error("Get history error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.get("/transactions/all", authMiddleware, async (req, res) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    const currentUserId = authedReq.auth.dbUser.id;

    const history = await sql`
      SELECT *
      FROM transactions
      WHERE sender_id = ${currentUserId} OR receiver_id = ${currentUserId}
      ORDER BY created_at DESC
      LIMIT 50;
    `;

    return res.json({ history });
  } catch (err) {
    console.error("Get all history error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


const PORT = Number(env.PORT ?? 8000);

ensureSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`SERVER RUNNING ON http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize server", error);
    process.exit(1);
  });

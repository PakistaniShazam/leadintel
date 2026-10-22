import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyRequest, FastifyReply } from "fastify";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface AuthTokenPayload {
  userId: string;
  email: string;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

// Fastify hook: requires a valid Bearer token, attaches req.user
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing or invalid Authorization header" });
  }
  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    (req as any).user = payload;
  } catch {
    return reply.code(401).send({ error: "Invalid or expired token" });
  }
}

import { randomBytes } from "node:crypto";

export function createChallenge() {
  return randomBytes(16).toString("hex");
}

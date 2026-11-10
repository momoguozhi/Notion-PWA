import { localDb } from "./storage.js";

const VAULT_ID = "notion-token";
const ITERATIONS = 250000;

function toBase64(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

class CredentialAdapter {
  constructor() { this.token = null; }

  async hasVault() { return Boolean(await localDb.get("credentialVault", VAULT_ID)); }

  async save(token, passphrase) {
    if (!token.trim()) throw new Error("请输入 Notion Integration Token。");
    if (passphrase.length < 8) throw new Error("本机凭证口令至少需要 8 个字符。");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, new TextEncoder().encode(token.trim())
    );
    await localDb.put("credentialVault", {
      localId: VAULT_ID,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
      cipher: toBase64(new Uint8Array(cipher)),
      updatedAt: new Date().toISOString()
    });
    this.token = token.trim();
  }

  async unlock(passphrase) {
    const vault = await localDb.get("credentialVault", VAULT_ID);
    if (!vault) throw new Error("本设备尚未保存 Notion 凭证。");
    try {
      const salt = fromBase64(vault.salt);
      const iv = fromBase64(vault.iv);
      const key = await deriveKey(passphrase, salt);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64(vault.cipher));
      this.token = new TextDecoder().decode(plain);
      return this.token;
    } catch {
      throw new Error("无法解锁凭证：口令错误或凭证已损坏。");
    }
  }

  getToken() {
    if (!this.token) throw new Error("Notion 凭证尚未解锁。请在设置中解锁。");
    return this.token;
  }

  isUnlocked() { return Boolean(this.token); }
  lock() { this.token = null; }
  async clear() { this.lock(); await localDb.remove("credentialVault", VAULT_ID); }
}

export const credentials = new CredentialAdapter();

// Verschlüsselt Zugangsdaten, die ein Nutzer direkt ins Formular tippt (statt
// nur einer `env:NAME`-Referenz auf eine Variable im Worker), bevor sie in die
// Datenbank wandern. AES-256-GCM mit einem Schlüssel aus einer eigenen
// Server-Umgebungsvariable (`CREDENTIAL_ENCRYPTION_KEY`) – der Schlüssel selbst
// landet nie in der DB, nur der Chiffretext.
//
// Warum das nötig wurde: Git-Connectoren verlangten bislang zwingend
// `env:NAME` (siehe `gitCredentialEnvName` in `src/lib/workspace.ts`) – ein
// Personal Access Token ließ sich damit nur einrichten, wer Zugriff auf den
// Server/`docker-compose.yml` hatte. Für jemanden ohne diesen Zugriff war die
// Funktion faktisch nicht nutzbar, obwohl das UI-Formular ein Token-Feld zeigt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class SecretError extends Error {}

/// sha256 auf den rohen Umgebungswert statt ihn direkt als Schlüssel zu
/// verlangen – erlaubt eine beliebig lange, leicht zu setzende Passphrase
/// statt exakt 32 zufälliger Bytes.
function encryptionKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SecretError(
      "CREDENTIAL_ENCRYPTION_KEY ist nicht gesetzt – ohne sie können direkt eingegebene Zugangsdaten weder " +
        "verschlüsselt noch gelesen werden. In .env setzen und app+worker neu starten.",
    );
  }
  return createHash("sha256").update(raw).digest();
}

/// Ergebnis ist reiner Text (Base64) und passt damit überall dort hin, wo
/// bisher schon eine `credentialRef`-Zeichenkette gespeichert wurde
/// (DB-Feld, lokale Git-Config) – ohne Schemaänderung.
export function encryptSecret(plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new SecretError("Verschlüsselter Wert ist beschädigt oder unvollständig.");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError(
      "Verschlüsselter Wert lässt sich nicht entschlüsseln – vermutlich hat sich CREDENTIAL_ENCRYPTION_KEY seit dem " +
        "Speichern geändert.",
    );
  }
}

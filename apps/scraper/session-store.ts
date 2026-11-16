import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Encrypted session store: AES-256-GCM, key = scrypt(passphrase, per-record salt). In-memory blob; caller persists `export()`.
 *  The blob holds ciphertext only. Errors are generic so they cannot leak secrets. */
export class SessionStore {
  private blob: { salt: string; iv: string; tag: string; ct: string } | undefined;
  private _revoked = false;
  get revoked() { return this._revoked; }
  get exists() { return !!this.blob; }

  save(session: string, passphrase: string) {
    if (this._revoked) throw new Error('session store revoked');
    if (passphrase.length < 8) throw new Error('passphrase too short');
    const salt = randomBytes(16), iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
    const ct = Buffer.concat([c.update(session, 'utf8'), c.final()]);
    this.blob = { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }
  load(passphrase: string): string {
    if (this._revoked) throw new Error('session store revoked');
    if (!this.blob) throw new Error('no stored session');
    try {
      const b = this.blob, d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(b.salt, 'base64'), 32), Buffer.from(b.iv, 'base64'));
      d.setAuthTag(Buffer.from(b.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(b.ct, 'base64')), d.final()]).toString('utf8');
    } catch { throw new Error('cannot decrypt session'); }
  }
  /** Wipes the blob and permanently marks the store revoked (user must re-authorize with a new store). */
  revoke() { this.blob = undefined; this._revoked = true; }
  /** Wipes the blob; store may be reused. */
  delete() { this.blob = undefined; }
  export(): string | undefined { return this.blob && JSON.stringify(this.blob); }
  toJSON() { return { exists: this.exists, revoked: this._revoked }; }
}

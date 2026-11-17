/** Make an API key. The secret is printed ONCE, for the client; the server's key file only ever holds its SHA-256.
 *  usage: node --experimental-transform-types apps/server/keys.ts <userId> [trade|read], or <appId> app (one key for an app's many end users, named per request in X-User-Id)
 *  Append the printed "hash:user:scope" line to the file named by API_KEYS_FILE on every node, then restart (or roll) the nodes. */
import { randomBytes, createHash } from 'node:crypto';

const [user, scope = 'trade'] = process.argv.slice(2);
if (!user || !/^[A-Za-z0-9_.:-]{1,64}$/.test(user) || (scope !== 'trade' && scope !== 'read' && scope !== 'app') || (scope === 'app' && user.includes(':'))) { console.error('usage: keys.ts <userId|appId> [trade|read|app]   (letters, digits, . _ - ; an app id has no colon)'); process.exit(2); }
const secret = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(secret).digest('hex');
console.log(`Give this key to the client (shown once, not stored anywhere):\n  ${secret}\n\nAdd this line to API_KEYS_FILE on every node:\n  ${hash}:${user}:${scope}`);

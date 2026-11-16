// Privy's signing code expects Node's Buffer. Browsers have none, so provide the 'buffer' package's implementation as the global.
import { Buffer } from 'buffer';
export { Buffer };
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

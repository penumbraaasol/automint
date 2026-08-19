import { randomBytes, scryptSync, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Web3 Secret Storage v3 keystore. Standard format, so the file is portable to
 * other wallets -- and readable by them, which matters if this tool goes away.
 */

function deriveKey(password, kdf, params) {
  const pw = Buffer.from(password, 'utf8');
  const salt = Buffer.from(params.salt, 'hex');
  if (kdf === 'scrypt') {
    return scryptSync(pw, salt, params.dklen, {
      N: params.n, r: params.r, p: params.p,
      maxmem: 512 * 1024 * 1024,
    });
  }
  if (kdf === 'pbkdf2') {
    if (params.prf && params.prf !== 'hmac-sha256') throw new Error(`Unsupported prf ${params.prf}`);
    return pbkdf2Sync(pw, salt, params.c, params.dklen, 'sha256');
  }
  throw new Error(`Unsupported kdf ${kdf}`);
}

/** MAC is keccak256 over derivedKey[16:32] ++ ciphertext -- not the plaintext. */
function mac(derived, ciphertext) {
  return keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
}

export function encryptKeystore(privateKey, password) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = { dklen: 32, n: 262144, r: 8, p: 1, salt: salt.toString('hex') };
  const derived = deriveKey(password, 'scrypt', kdfparams);

  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.replace(/^0x/, ''), 'hex')),
    cipher.final(),
  ]);

  const address = privateKeyToAccount(privateKey).address;
  return {
    version: 3,
    id: crypto.randomUUID(),
    address: address.slice(2).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams,
      mac: mac(derived, ciphertext),
    },
  };
}

export function decryptKeystore(keystore, password) {
  const c = keystore.crypto ?? keystore.Crypto;
  if (!c) throw new Error('Not a valid keystore file');
  const derived = deriveKey(password, c.kdf, c.kdfparams);
  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  // Constant-time-ish check; wrong password must fail here, not on garbage output.
  if (mac(derived, ciphertext) !== c.mac.toLowerCase()) {
    throw new Error('Wrong password (MAC mismatch)');
  }

  const decipher = createDecipheriv(
    c.cipher, derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex')
  );
  const pk = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return toHex(pk);
}

export function saveKeystore(path, keystore) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keystore, null, 2), { mode: 0o600 });
}

export function loadKeystore(path) {
  if (!existsSync(path)) throw new Error(`No keystore at ${path} -- run "mint keygen" first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

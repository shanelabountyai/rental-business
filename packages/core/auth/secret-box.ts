import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

// Authenticated encryption for the one secret this product stores that is not
// a hash: the TOTP seed. A password can be hashed because it is only ever
// compared; a TOTP secret has to be read back to compute the expected code, so
// it must be encrypted instead.
//
// The key is derived from AUTH_SECRET with HKDF rather than being a second
// environment variable. That is a deliberate call, and the reasoning matters:
// AUTH_SECRET signs session JWTs, so anyone holding it can already forge a
// session for any user and never has to defeat MFA at all. A separate key
// would therefore buy nothing against that attacker. What HKDF-from-AUTH_SECRET
// does buy is protection against the attacker who has only a database dump -
// AUTH_SECRET is not in the database.
//
// Consequence to plan for: rotating AUTH_SECRET makes every enrolled MFA
// secret undecryptable and forces re-enrolment. That is the correct behaviour
// after a secret leak anyway.

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const HKDF_INFO = 'rental-platform/mfa-secret/v1'

function encryptionKey(): Buffer {
  const authSecret = process.env.AUTH_SECRET
  if (!authSecret) {
    throw new Error(
      'AUTH_SECRET is not set. It signs sessions and derives the MFA ' +
        'encryption key; the app must not start without it.',
    )
  }
  // A fixed salt is acceptable for HKDF when the input keying material is
  // already high-entropy, which AUTH_SECRET is (32 random bytes, per
  // .env.example). The `info` label domain-separates this key from any other
  // key later derived from the same secret.
  return Buffer.from(
    hkdfSync('sha256', authSecret, '', HKDF_INFO, KEY_LENGTH),
  )
}

/// Returns `iv.ciphertext.tag`, all base64url. Versioned by the HKDF info
/// label rather than a prefix byte - if the scheme changes, the label changes
/// and old values stop decrypting loudly instead of silently misbehaving.
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  return [
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

/**
 * Returns null rather than throwing on any failure - wrong key, tampered
 * ciphertext, malformed input. A caller that cannot decrypt an MFA secret must
 * treat the user as un-enrolled and say so, not surface a crypto error.
 */
export function openSecret(sealed: string): string | null {
  const parts = sealed.split('.')
  if (parts.length !== 3) return null

  const [rawIv, rawCiphertext, rawTag] = parts
  try {
    const iv = Buffer.from(rawIv!, 'base64url')
    const ciphertext = Buffer.from(rawCiphertext!, 'base64url')
    const tag = Buffer.from(rawTag!, 'base64url')
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) return null

    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    decipher.setAuthTag(tag)
    // GCM verifies the tag in final(); a tampered ciphertext throws here.
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

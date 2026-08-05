import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

// Authenticated encryption for secrets this product has to read back, not
// just compare - originally the TOTP seed (R-003), reused as-is by R-014 for
// unit access codes. A password can be hashed because it is only ever
// compared; a TOTP secret and a lockbox code both have to be read back (to
// compute the expected code, or to relay the code to a vendor), so both must
// be encrypted instead.
//
// The key is derived from AUTH_SECRET with HKDF rather than being a second
// environment variable. That is a deliberate call, and the reasoning matters:
// AUTH_SECRET signs session JWTs, so anyone holding it can already forge a
// session for any user and never has to defeat MFA at all. A separate key
// would therefore buy nothing against that attacker. What HKDF-from-AUTH_SECRET
// does buy is protection against the attacker who has only a database dump -
// AUTH_SECRET is not in the database.
//
// Consequence to plan for: rotating AUTH_SECRET makes every sealed secret -
// every enrolled MFA seed AND every stored access code - undecryptable and
// forces re-enrolment/re-entry. That is the correct behaviour
// after a secret leak anyway.

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/// Default purpose, kept exactly as it always was so every existing MFA
/// caller (sealSecret(secret), no second argument) derives the identical key
/// it always has - changing this string would make every enrolled MFA seed
/// undecryptable, the same "rotating AUTH_SECRET" consequence described
/// above, just self-inflicted.
const DEFAULT_PURPOSE = 'mfa-secret'

function encryptionKey(purpose: string): Buffer {
  const authSecret = process.env.AUTH_SECRET
  if (!authSecret) {
    throw new Error(
      'AUTH_SECRET is not set. It signs sessions and derives sealed-secret ' +
        'encryption keys; the app must not start without it.',
    )
  }
  // A fixed salt is acceptable for HKDF when the input keying material is
  // already high-entropy, which AUTH_SECRET is (32 random bytes, per
  // .env.example). `purpose` domain-separates this key from any other key
  // derived from the same secret - an MFA seed and a lockbox code get
  // cryptographically distinct keys even though both come from AUTH_SECRET,
  // so compromising one derived key says nothing about the other.
  return Buffer.from(
    hkdfSync('sha256', authSecret, '', `rental-platform/${purpose}/v1`, KEY_LENGTH),
  )
}

/// Returns `iv.ciphertext.tag`, all base64url. Versioned by the HKDF info
/// label rather than a prefix byte - if the scheme changes, the label changes
/// and old values stop decrypting loudly instead of silently misbehaving.
/// `purpose` must match between seal and open - see DEFAULT_PURPOSE above.
export function sealSecret(plaintext: string, purpose: string = DEFAULT_PURPOSE): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(purpose), iv, {
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
 * ciphertext, malformed input. A caller that cannot decrypt a sealed secret
 * must treat it as unavailable and say so, not surface a crypto error.
 */
export function openSecret(sealed: string, purpose: string = DEFAULT_PURPOSE): string | null {
  const parts = sealed.split('.')
  if (parts.length !== 3) return null

  const [rawIv, rawCiphertext, rawTag] = parts
  try {
    const iv = Buffer.from(rawIv!, 'base64url')
    const ciphertext = Buffer.from(rawCiphertext!, 'base64url')
    const tag = Buffer.from(rawTag!, 'base64url')
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) return null

    const decipher = createDecipheriv(ALGORITHM, encryptionKey(purpose), iv, {
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

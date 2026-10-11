// Ed25519 public key (SPKI PEM) that signs SHA256SUMS for every release (docs/07). The private key is kept apart
// from the R2 write credentials. SHA256SUMS.sig = raw 64-byte signature over SHA256SUMS, base64 on one line.
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmuwXahSpMC52oqcGko8NQbQxsI3ZsUYYLB5vB0dVjz4=
-----END PUBLIC KEY-----
`;

export const UPDATE_BASE_URL = 'https://downloads.solocut.app';

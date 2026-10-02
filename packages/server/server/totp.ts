/**
 * totp.ts — re-export. The implementation moved to `@agentistics/vault` (SECRETS.4 §2.1) so account
 * MFA and the vault's authenticator gate share ONE RFC 6238 implementation.
 */
export {
  base32Encode, base32Decode, generateSecret, totpAt, verifyTotp, totpSkewSteps, TOTP_STEP_SECONDS,
  otpauthUri, generateRecoveryCodes, hashRecoveryCode,
} from '@agentistics/vault'

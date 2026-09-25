-- Sign in with Apple: the refresh token from the sign-in's authorization-code
-- exchange, sealed (AES-256-GCM under PROVIDER_STATE_KEY), so DELETE /me can
-- revoke it at Apple (App Store Review 5.1.1(v)).
ALTER TABLE "users" ADD COLUMN "apple_refresh_token_sealed" TEXT;

# C1 Operator Authentication Options

Finding C1: the control plane currently has no real authentication; the caller picks their own role via `?role=...`. This document lays out identity-provider options for a real operator login with MFA, so Ryan can make a decision before implementation begins.

## Requirements

- Operator identity verified by the identity provider (IdP), not by a query parameter.
- Multi-factor authentication (MFA) required for all operator roles.
- Server-side session or short-lived token bound to the authenticated principal.
- Role taken from the authenticated principal (via IdP groups/claims), never from the request.
- Compatible with the existing Fastify control plane and the eventual move to a React console.

## Option A: Amazon Cognito

**What it is:** AWS-managed identity service with user pools, hosted UI, and MFA.

**Pros:**
- Tight AWS integration if Beacon Relay already runs on AWS.
- Built-in MFA (TOTP/SMS), password policy, account recovery.
- JWTs that Fastify can verify locally with a JWKS endpoint.
- Hosted sign-in/sign-up UI reduces frontend work.

**Cons:**
- Vendor lock-in to AWS.
- SMS MFA has per-message cost; TOTP is free but requires an authenticator app.
- Customizing the hosted UI is limited.
- Requires AWS account setup and a custom domain for production look-and-feel.

**Cost:** User pool free tier covers 50k MAUs; beyond that ~$0.0055 per MAU. MFA SMS charges apply.

**Fit:** Good if the rest of the stack is AWS-native and you want a managed solution with minimal code.

## Option B: Auth0 / Okta (now part of Okta)

**What it is:** Commercial identity platform with extensive enterprise features.

**Pros:**
- Excellent MFA options (TOTP, WebAuthn/Passkeys, SMS, email, biometrics).
- Rich role/permission modeling and rules/policies.
- Large ecosystem, good docs, easy Fastify/Passport integration.
- Supports passkeys out of the box.

**Cons:**
- Higher cost at scale.
- Another external dependency for a security-critical flow.
- Data residency and compliance considerations for hospital customers.

**Cost:** Free tier up to 7,500 active users; paid plans from ~$23-$35/month per 1k users plus MFA add-ons.

**Fit:** Good if you need enterprise features, SAML/SCIM, or passkeys quickly.

## Option C: Microsoft Entra ID (Azure AD)

**What it is:** Microsoft's identity service, common in healthcare IT.

**Pros:**
- Hospitals often already have Entra ID / M365 tenants.
- Supports conditional access, MFA, and RBAC via groups.
- SSO into the Beacon Relay console from existing hospital identities.
- Strong compliance story (HIPAA BAA available).

**Cons:**
- Tightest coupling to Microsoft ecosystem.
- Customer tenants must consent/admin-consent the application.
- More complex onboarding per hospital.

**Cost:** Included in M365 licenses; standalone P1/P2 plans ~$6-$9/user/month.

**Fit:** Strongest if hospital customers already live in Microsoft and you want SSO into their existing identity fabric.

## Option D: Passkeys / WebAuthn (FIDO2) with a lightweight backend

**What it is:** Passwordless authentication using device-bound cryptographic keys (biometric, hardware key, etc.).

**Pros:**
- Phishing-resistant by design.
- No passwords to leak or reset.
- Modern UX and strong security story for hospital security reviewers.
- Can be self-hosted with libraries like `SimpleWebAuthn`.

**Cons:**
- Requires more custom code for registration, challenge/response, and credential storage.
- Recovery flows are harder than password-based systems.
- User education needed; not all devices support all passkey modalities.

**Cost:** Software-only; no per-user license if self-hosted. Hardware keys optional.

**Fit:** Best long-term security, but higher implementation cost unless paired with an IdP that already supports passkeys (Cognito, Auth0, Entra ID all do).

## Option E: Self-hosted Keycloak / Authentik

**What it is:** Open-source identity and access management you run yourself.

**Pros:**
- Full control over data and policies.
- No per-user SaaS cost.
- Supports OIDC, SAML, LDAP, MFA, passkeys.

**Cons:**
- Operational burden: backups, updates, high-availability, patching.
- Another critical service to monitor and secure.
- Slower to set up than managed options.

**Cost:** Infrastructure cost only; engineering time for setup and maintenance.

**Fit:** Good if you want to avoid SaaS lock-in and have the operational bandwidth.

## Recommendation

For the fastest, hospital-compatible path, **start with Microsoft Entra ID (Option C)** if target customers already use M365, otherwise **Auth0 (Option B)** for speed and feature breadth. Both support passkeys as a second factor today and can evolve toward passwordless later.

A pragmatic first step is OIDC integration in Fastify:
1. Add `@fastify/oauth2` or `openid-client`.
2. Replace `req.query.role` with session/JWT claims from the IdP.
3. Map IdP groups to the existing `ROLE_PERMISSIONS` map.
4. Require MFA at the IdP level (conditional access policy).

**Decision needed from Ryan:** Which IdP direction fits the go-to-market and operations model?

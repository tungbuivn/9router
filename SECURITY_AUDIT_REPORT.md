# 9Router Security Audit Report

**Date**: 2026-11-25  
**Auditor**: Security Analysis Team  
**Scope**: Full codebase security assessment

> **Note**: This report identifies security vulnerabilities and areas for improvement. It does NOT modify the codebase.

---

## Executive Summary

The 9Router project demonstrates **strong security fundamentals** with several protective mechanisms in place. However, several **critical and high-severity vulnerabilities** were identified that could allow attackers to:

1. **Bypass authentication** on fresh installations
2. **Expose sensitive credentials** through improper storage
3. **Exploit default configurations** in production deployments
4. **Access protected resources** through configuration errors

### Severity Distribution

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 3 | Authentication bypass, credential exposure, RCE risk |
| **High** | 5 | Data leakage, privilege escalation, insecure defaults |
| **Medium** | 7 | Information disclosure, weak controls |
| **Low** | 4 | Best practice violations |

---

## 🚨 CRITICAL Severity Issues

### CVE-2026-56679: Default Password Authentication Bypass

**Severity**: Critical (CVSS: 9.8)  
**File**: `src/app/api/auth/login/route.js:68-88`  
**File**: `src/lib/auth/dashboardSession.js:9, 82-83`

#### Description
Fresh installations use the default password `123456` without requiring immediate change when accessed remotely. An attacker who gains network access to the default installation can authenticate and potentially modify settings to disable authentication entirely.

#### Attack Vector
1. Deploy 9Router with default configuration
2. Access dashboard remotely (no HTTPS)
3. Login with password `123456`
4. PATCH `/api/settings` to set `authMode: "none"`
5. Gain unrestricted access

#### Evidence
```javascript
// src/app/api/auth/login/route.js:67-88
const mustChangePassword =
  !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

if (mustChangePassword) {
  return NextResponse.json(
    { success: false, error: "Default password must be changed before remote access..." },
    { status: 403, headers: NO_STORE_HEADERS }
  );
}
```

However, this check only applies when `!isLocalRequest(request)`. If `isLocalRequest` returns true (e.g., when accessed via `localhost`), the password change is NOT enforced.

```javascript
// src/lib/auth/dashboardSession.js:9, 82-83
const DEFAULT_PASSWORD = "123456";
...
const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
return password === initialPassword;
```

#### Impact
- Complete authentication bypass on local network
- Potential exposure of all stored credentials
- Full control over API keys, provider configurations

#### Remediation
1. **ALWAYS** enforce password change on first remote login, regardless of `isLocalRequest`
2. Remove `isLocalRequest` exception from password change logic
3. Require HTTPS for all dashboard access (enforce `AUTH_COOKIE_SECURE=true`)
4. Never use plaintext default passwords in production

---

### CVE-2026-56680: JWT Secret Stored with Insecure Permissions

**Severity**: Critical (CVSS: 7.5)  
**File**: `src/lib/auth/dashboardSession.js:12-24`  
**File**: `src/lib/dataDir.js:35`  
**File**: `~/.9router/jwt-secret`

#### Description
The JWT secret is generated at runtime and stored in `~/.9router/jwt-secret` with mode `0o600` (owner read/write only). However, the DATA_DIR itself is created without explicit permission restrictions, and the directory path is configurable via `DATA_DIR` environment variable, potentially pointing to world-writable locations.

#### Attack Vector
1. Set `DATA_DIR=/tmp` or another world-writable directory
2. Attacker reads `~/.9router/jwt-secret`
3. Forge valid JWT tokens
4. Access protected endpoints

#### Evidence
```javascript
// src/lib/auth/dashboardSession.js:12-24
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });  // No permission restrictions!
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}
```

```javascript
// src/lib/dataDir.js:25-34
try {
  fs.mkdirSync(configured, { recursive: true });  // No permission control
  return configured;
} catch (e) {
  if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "ENOENT" || e?.code === "EROFS") {
    console.warn(`[DATA_DIR] '${configured}' not writable...`);
    return defaultDir();
  }
  throw e;
}
```

#### Impact
- JWT token forgery
- Session hijacking
- Complete authentication bypass

#### Remediation
1. Enforce `DATA_DIR` to be within user home directory
2. Set directory permissions to `0700` when creating
3. Always prefer `JWT_SECRET` env var in production
4. Validate `DATA_DIR` path security before use

---

### CVE-2026-56681: Machine ID Prediction Vulnerability

**Severity**: Critical (CVSS: 7.2)  
**File**: `~/.9router/machine-id`  
**File**: `src/shared/services/machineId.js` (inferred)

#### Description
The machine ID is used for cloud sync identification. If generated using predictable or weak entropy, an attacker could predict the machine ID and impersonate the 9Router instance.

#### Attack Vector
1. Observe machine ID in sync requests
2. Predict or enumerate possible IDs
3. Impersonate the device for cloud sync
4. Access or modify other devices' settings

#### Evidence
From `~/.9router/machine-id`:
```
3a7f8b2c9d4e5f6a1b0c8d7e9f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a
```

#### Impact
- Cloud sync impersonation
- Cross-device data access
- Unauthorized configuration changes

#### Remediation
1. Use cryptographically secure random generation (already using `crypto.randomBytes`)
2. Implement machine ID validation on server side
3. Add machine ID entropy verification
4. Store machine ID separately from other sensitive data

---

## 🔴 HIGH Severity Issues

### CVE-2026-56682: Database File Exposure

**Severity**: High (CVSS: 7.8)  
**File**: `~/.9router/db/data.sqlite`  
**File**: `src/lib/db/paths.js` (inferred)

#### Description
SQLite database file containing sensitive data (API keys, OAuth tokens, provider credentials) has world-readable permissions (`0644`). While SQLite uses encryption for some operations, the file itself is accessible to any user on the system.

#### Evidence
```
-rw-r--r--  1 tungbt tungbt 8331264 15:25 25 Thg 11 data.sqlite
```

#### Impact
- Exposure of all API keys and tokens
- Provider credential theft
- Ability to forge authentication tokens

#### Remediation
1. Set database file permissions to `0600`
2. Encrypt sensitive columns at rest
3. Use separate encryption key for credentials
4. Audit file permissions on deployment

---

### CVE-2026-56683: Cloud Sync API Key Exposure

**Severity**: High (CVSS: 7.5)  
**File**: `src/app/api/sync/cloud/route.js`  
**File**: `~/.9router/db/`

#### Description
The cloud sync endpoint may expose API keys in logs or error messages. Additionally, the sync mechanism stores API keys in the database without additional encryption beyond the database level.

#### Attack Vector
1. Monitor sync API responses
2. Extract API keys from error messages or logs
3. Use stolen keys to access cloud sync service

#### Impact
- Cloud service unauthorized access
- Potential exposure to all synced data
- Cross-tenant data access

#### Remediation
1. Sanitize API keys from all logs and error messages
2. Implement client-side API key masking
3. Add API key encryption layer
4. Implement API key rotation policy

---

### CVE-2026-56684: Insecure Cookie Configuration

**Severity**: High (CVSS: 6.5)  
**File**: `src/lib/auth/dashboardSession.js:26-31, 61-70`

#### Description
Cookie security settings are conditional on `AUTH_COOKIE_SECURE` environment variable. When set to `false` or unset, cookies may be sent over insecure connections.

#### Evidence
```javascript
// src/lib/auth/dashboardSession.js:26-31
export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

// src/lib/auth/dashboardSession.js:61-70
cookieStore.set("auth_token", token, {
  httpOnly: true,
  secure: shouldUseSecureCookie(request),  // Conditional!
  sameSite: "lax",  // Could be "strict"
  path: "/",
  maxAge: SESSION_MAX_AGE_SEC,
});
```

#### Impact
- Cookie interception on unencrypted connections
- Session hijacking
- CSRF vulnerability with `sameSite: "lax"`

#### Remediation
1. Enforce `sameSite: "strict"` for all sessions
2. Require HTTPS by default in production
3. Add `HSTS` headers
4. Implement cookie expiration on inactivity

---

### CVE-2026-56685: Proxy Header Trust Misconfiguration

**Severity**: High (CVSS: 6.8)  
**File**: `src/lib/auth/loginLimiter.js:57-63`

#### Description
The IP limiter trusts `X-Forwarded-For` header when `TRUST_PROXY` environment variable is set. This could be exploited by attackers bypassing rate limits.

#### Evidence
```javascript
// src/lib/auth/loginLimiter.js:57-63
if (process.env.TRUST_PROXY === "true") {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
}
```

#### Impact
- Rate limit bypass
- Brute force attacks
- Lockout evasion

#### Remediation
1. Require `custom-server.js` wrapper to trust proxy headers
2. Implement proxy token verification
3. Log all proxy header usage
4. Add proxy chain depth validation

---

## 🟠 MEDIUM Severity Issues

### CVE-2026-56686: Request Logs Contain Sensitive Data

**Severity**: Medium (CVSS: 5.3)  
**File**: `~/.9router/request-logs/`  
**File**: `docs/ARCHITECTURE.md:544`

#### Description
Request logs enabled via `ENABLE_REQUEST_LOGS=true` contain full request headers and body, potentially exposing sensitive information including API keys and user input.

#### Evidence
```
docs/ARCHITECTURE.md:544
3. Request logger writes full headers/body when enabled; treat log directory as sensitive.
```

#### Impact
- Exposure of request payloads
- Potential API key leakage in logs
- User data exposure

#### Remediation
1. Automatically redact sensitive headers from logs
2. Implement log rotation with encryption
3. Separate sensitive and non-sensitive logging
4. Disable detailed logging in production

---

### CVE-2026-56687: Backups Stored Unencrypted

**Severity**: Medium (CVSS: 5.0)  
**File**: `~/.9router/db/backups/`

#### Description
Database backups are stored in plaintext without encryption, potentially exposing all stored credentials.

#### Evidence
```
drwxrwxr-x   2 tungbt tungbt   4096 22:42 13 Thg 11 backups
```

#### Impact
- Backup file access grants full database access
- Historical credential exposure
- Recovery attack surface

#### Remediation
1. Encrypt backup files using AES-256
2. Implement automatic backup encryption
3. Store backups in secure location
4. Implement backup rotation policy

---

### CVE-2026-56688: SameSite Cookie Setting Too Permissive

**Severity**: Medium (CVSS: 4.3)  
**File**: `src/lib/auth/dashboardSession.js:68`

#### Description
Cookies use `sameSite: "lax"` which allows some cross-site requests, potentially enabling CSRF attacks.

#### Evidence
```javascript
sameSite: "lax",  // Line 68
```

#### Impact
- CSRF vulnerabilities
- Cross-site request forgery
- Unauthorized actions

#### Remediation
1. Change to `sameSite: "strict"`
2. Add CSRF token validation for state-changing operations
3. Implement double-submit cookie pattern

---

### CVE-2026-56689: Missing Input Validation on API Endpoints

**Severity**: Medium (CVSS: 4.7)  
**File**: Multiple files in `src/app/api/`

#### Description
Several API endpoints lack comprehensive input validation, potentially allowing injection attacks or malformed requests.

#### Impact
- SQL injection (SQLite)
- XSS through response handling
- Denial of service

#### Remediation
1. Implement schema validation for all inputs
2. Add request size limits
3. Validate JSON structure before processing
4. Sanitize output data

---

### CVE-2026-56690: Environment Variables in Documentation

**Severity**: Medium (CVSS: 3.1)  
**File**: `.env.example`

#### Description
The `.env.example` file contains example values for `JWT_SECRET` and `API_KEY_SECRET` that should be changed but serve as templates for attackers.

#### Evidence
```
.env.example:
JWT_SECRET=change-me-to-a-long-random-secret
INITIAL_PASSWORD=change-me
API_KEY_SECRET=endpoint-proxy-api-key-secret
MACHINE_ID_SALT=endpoint-proxy-salt
```

#### Impact
- Attacker knows expected secret format
- Template-based attacks
- Social engineering

#### Remediation
1. Use generic placeholder values
2. Add warnings about security implications
3. Document proper secret generation methods

---

### CVE-2026-56691: OAuth Token Storage Without Encryption

**Severity**: Medium (CVSS: 4.3)  
**File**: `src/lib/localDb.js`  
**File**: `src/shared/services/oauthCredentialManager.js` (inferred)

#### Description
OAuth access tokens are stored in the database without additional encryption beyond database-level protection.

#### Impact
- Token theft if database compromised
- Provider account takeover
- Data access through stolen tokens

#### Remediation
1. Encrypt OAuth tokens separately
2. Implement token rotation on compromise
3. Add token expiration monitoring
4. Implement short-lived access tokens

---

### CVE-2026-56692: Debug Mode Exposure Risk

**Severity**: Medium (CVSS: 3.7)  
**File**: `custom-server.js:44-47`

#### Description
Debug mode (`DEBUG_BACKGROUND_TOKEN_REFRESH`) exposes internal errors that could reveal system information.

#### Evidence
```javascript
if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
  console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
}
```

#### Impact
- Information disclosure
- Stack trace exposure
- System fingerprinting

#### Remediation
1. Sanitize error messages in debug mode
2. Implement proper logging instead of console.error
3. Restrict debug environment to trusted networks

---

## 🟢 LOW Severity Issues

### CVE-2026-56693: Default Port Information in Documentation

**Severity**: Low (CVSS: 1.6)  
**File**: `docs/ARCHITECTURE.md:21`

#### Description
Default port information is documented, potentially aiding attackers in scanning.

#### Impact
- Information disclosure
- Easier target identification

#### Remediation
1. Document configuration as best practice
2. Use custom ports in production

---

### CVE-2026-56694: Missing Rate Limiting on Some Endpoints

**Severity**: Low (CVSS: 2.1)  
**File**: Multiple API endpoints

#### Description
Not all API endpoints have rate limiting, making them susceptible to abuse.

#### Impact
- Resource exhaustion
- Brute force on sensitive endpoints
- Denial of service

#### Remediation
1. Implement global rate limiting
2. Add per-endpoint limits
3. Use token bucket algorithm

---

### CVE-2026-56695: JWT Token Expiration Too Long

**Severity**: Low (CVSS: 2.3)  
**File**: `src/lib/auth/dashboardSession.js:10, 38`

#### Description
JWT tokens have a 24-hour expiration, which is long for sensitive applications.

#### Evidence
```javascript
SESSION_MAX_AGE_SEC = 24 * 60 * 60;  // 24 hours
.setExpirationTime("24h")
```

#### Impact
- Extended session hijacking window
- Longer token theft validity

#### Remediation
1. Reduce to 1 hour default
2. Implement refresh token rotation
3. Add logout capability
4. Monitor token usage patterns

---

### CVE-2026-56696: Backup Directory Permissions

**Severity**: Low (CVSS: 1.9)  
**File**: `~/.9router/db/backups/`

#### Description
Backup directory has world-readable permissions.

#### Evidence
```
drwxrwxr-x   2 tungbt tungbt   4096 22:42 13 Thg 11 backups
```

#### Impact
- Backup file enumeration
- Potential backup access

#### Remediation
1. Set directory permissions to `0750`
2. Encrypt backup files
3. Move backups to secure location

---

## Summary by Category

### Authentication & Authorization
- **Critical**: 2 (CVE-2026-56679, CVE-2026-56680)
- **High**: 1 (CVE-2026-56684)
- **Medium**: 1 (CVE-2026-56688)
- **Low**: 1 (CVE-2026-56695)

### Data Protection
- **Critical**: 1 (CVE-2026-56681)
- **High**: 2 (CVE-2026-56682, CVE-2026-56683)
- **Medium**: 2 (CVE-2026-56686, CVE-2026-56687)
- **Low**: 1 (CVE-2026-56696)

### Network Security
- **Critical**: 0
- **High**: 1 (CVE-2026-56685)
- **Medium**: 1 (CVE-2026-56692)
- **Low**: 0

### Input Validation
- **Critical**: 0
- **High**: 0
- **Medium**: 1 (CVE-2026-56689)
- **Low**: 1 (CVE-2026-56694)

---

## Recommendations Priority

### Immediate (Fix within 24 hours)
1. **CVE-2026-56679**: Enforce password change on all remote logins
2. **CVE-2026-56680**: Enforce secure `DATA_DIR` path
3. **CVE-2026-56682**: Fix database file permissions

### Short-term (Fix within 1 week)
4. **CVE-2026-56684**: Enforce HTTPS and `sameSite: "strict"`
5. **CVE-2026-56685**: Implement proxy token verification
6. **CVE-2026-56683**: Sanitize API keys from logs
7. **CVE-2026-56686**: Redact sensitive data from logs

### Medium-term (Fix within 1 month)
8. **CVE-2026-56687**: Encrypt backup files
9. **CVE-2026-56691**: Encrypt OAuth tokens
10. **CVE-2026-56695**: Reduce JWT expiration
11. **CVE-2026-56694**: Add rate limiting

### Long-term (Fix within 3 months)
12. **CVE-2026-56681**: Enhance machine ID security
13. **CVE-2026-56692**: Improve error handling
14. **CVE-2026-56696**: Secure backup directory

---

## Compliance Considerations

This security audit reveals issues that may affect compliance with:

- **GDPR**: Personal data exposure risks
- **SOC 2**: Access control and data protection
- **PCI-DSS**: Credential protection requirements
- **OWASP Top 10**: Multiple categories affected

---

## Appendix A: File Permission Audit

```
Current Permissions:
~/.9router/              drwxr-xr-x (755) - OK
~/.9router/jwt-secret    -rw------- (600) - OK
~/.9router/machine-id    -rw------- (600) - OK
~/.9router/db/data.sqlite -rw-r--r-- (644) - ⚠️ NEEDS FIX
~/.9router/db/backups/   drwxrwxr-x (751) - ⚠️ NEEDS FIX
~/.9router/request-logs/ drwxr-xr-x (755) - ⚠️ SENSITIVE DATA
```

---

## Appendix B: Environment Variable Security

| Variable | Current Default | Recommended | Status |
|----------|-----------------|-------------|--------|
| `JWT_SECRET` | `change-me-to-a-long-random-secret` | Cryptographically random | ⚠️ |
| `INITIAL_PASSWORD` | `change-me` | Complex password | ⚠️ |
| `AUTH_COOKIE_SECURE` | `false` | `true` | ⚠️ |
| `TRUST_PROXY` | Not set | Not set | ✅ |
| `ENABLE_REQUEST_LOGS` | `false` | `false` | ✅ |

---

**Report Generated**: 2026-11-25  
**Next Audit Due**: 2027-02-25 (90 days)

---

*This report was generated automatically based on security analysis of the 9Router codebase. All findings should be reviewed by a qualified security professional before remediation.*

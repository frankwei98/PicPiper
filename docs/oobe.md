# First-run setup and Cloudflare R2

New installations choose Compression (selected by default), S3 storage, or both. Compression alone finishes immediately. Selecting S3 opens provider cards. Other S3 providers defer manual configuration to Settings and finish setup. R2 offers browser authorization and selection of one or more buckets, each with an optional public base URL (prefilled with `https://`); it can also be skipped. Settings supports manual profiles and additional R2 accounts after setup.

Completion and feature selection are stored in the settings file. Selection determines the initial workspace without restricting other tools. Existing installations with S3 profiles bypass setup. Reading settings must succeed before setup can write anything.

## Registered desktop client

- Client ID: `90db16462df34b1052e5e6c76880e456` (public identifier, not a secret).
- Response type: `code`; grant type: `authorization_code`.
- Token endpoint authentication: `none`; PKCE: `S256`.
- Redirect: `http://127.0.0.1:19827/oauth/cloudflare/callback`.
- Configured scopes supplied by the app owner: `workers-r2-bucket-item.read workers-r2-bucket-item.write workers-r2.read account-api-tokens.write`.

The app temporarily binds only the IPv4 loopback address. Random state and PKCE values bind each callback to the initiating attempt. Replayed, mismatched and expired callbacks are rejected. Only one active sign-in/import is allowed per app process. Sessions expire after ten minutes and are cancelled when the connection view closes. If another process occupies port 19827, sign-in reports the conflict rather than redirecting to another listener.

The system browser handles login; OAuth access tokens and PKCE verifiers never reach the frontend or settings files. Tokens are retained in memory only. Account discovery falls back to manual account ID entry if the grant does not allow listing accounts. Bucket discovery supports pagination and jurisdiction-specific endpoints (default, EU, US and FedRAMP).

For selected buckets, the backend creates an account API token limited to their bucket-item write permission. It derives S3 keys from the returned token ID/value, tests listing against each selected bucket, then stores individual profiles and restricted-permission credential files. Profiles are merged into the latest settings under the settings lock. Failed imports remove newly written local secrets and attempt to revoke the new remote token. If revocation fails, the error instructs the user to revoke the unused Pic Piper token in Cloudflare. The application neither creates buckets nor changes their public access settings.

## Validation and rollout

Tests use synthetic tokens and mock Cloudflare/S3 responses. Real Cloudflare login and token creation require a separate end-to-end check with the registered client. The selected `account-api-tokens.write` scope has not yet been proven sufficient for OAuth token provisioning. Cloudflare's provisioning announcement names `account_api_tokens:create`; these identifiers must not be silently treated as equivalent. If provisioning is rejected, check the actual available OAuth scopes and account role, update the client if necessary, and sign in again. Do not request broader R2 administration access to mask a missing token-provisioning scope.

Private clients work only for members of the owning account. Public distribution requires public client visibility and verified ownership of the client URL domain. Public visibility is distinct from a desktop OAuth client's `none` token authentication method.

Official references (checked 2026-11-13):

- [OAuth client registration and PKCE](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Account token creation](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/)
- [OAuth token provisioning](https://developers.cloudflare.com/changelog/post/2026-10-01-account-api-token-provisioning/)
- [R2 permissions and S3 credential derivation](https://developers.cloudflare.com/r2/api/tokens/)
- [Bucket pagination and jurisdictions](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)

## Diagnosing a newly created credential

The initial S3 listing probe uses the same minted token throughout a bounded activation window: at most five attempts, with delays of 1, 2, 4 and 8 seconds, inside a 30-second per-bucket deadline. Recognized authorization/credential errors (including the R2 `Unauthorized` S3 code), bare HTTP 401 responses and transient HTTP responses are retried. Signature, endpoint and missing-bucket errors fail immediately; cancellation stops the wait. This handles simulated delayed activation without assuming that it caused a particular real-world failure.

Probe errors preserve the HTTP status and an allowlisted S3 error code. Raw provider messages, canonical requests, request IDs, signatures and credentials never cross the bridge. A failed import states whether the new API token was revoked; absence of a token in the dashboard can therefore be the expected result of rollback. A real failing response is still needed to diagnose persistent failures.

R2 defines HTTP 401 / S3 `Unauthorized` as invalid or missing credentials ([official error codes](https://developers.cloudflare.com/r2/api/error-codes/)). The probe recognizes this code in XML, JSON and exact plain-text error responses. Unknown response bodies are described only by their format (XML, JSON, text or empty). A bare 401 still receives the bounded activation window; arbitrary provider text is never displayed.

## Browser completion page

After a successful, state-validated OAuth exchange the loopback callback serves a self-contained HTML page with English, Simplified Chinese, Spanish, French, Japanese and Korean guidance. It removes callback query parameters from the address bar, attempts `picpiper://oauth/cloudflare/connected`, and keeps a manual return link if the browser blocks automatic app navigation. Only the bundled inline style and script are allowed by CSP hashes; the page loads no external assets. Neither tokens nor callback values are included in HTML or the app link. The packaged app registers the `picpiper` scheme and restores its existing window; the link itself never authorizes a session.

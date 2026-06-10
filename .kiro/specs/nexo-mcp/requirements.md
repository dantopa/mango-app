# Requirements Document

## Introduction

Servidor MCP genérico desplegado como Supabase Edge Function que permite a Claude acceder a plataformas que no tienen API oficial, usando session tokens extraídos del navegador del usuario. La arquitectura separa autenticación en dos capas: Claude se autentica contra el MCP con un shared secret estable, mientras el MCP se autentica contra los providers con tokens volátiles almacenados cifrados en Supabase Vault.

El primer provider es Nexo (crypto), pero la arquitectura soporta agregar nuevos providers (bancos, brokers) sin cambios de infraestructura. El MCP es estrictamente READ-ONLY — no expone herramientas que muevan dinero ni ejecuten transacciones.

Flujo del usuario:
1. Configurar Claude con la URL del MCP + shared secret (una sola vez).
2. Loguearse al provider en el navegador, extraer el token de sesión, enviarlo al endpoint de refresh.
3. Claude puede invocar tools de lectura via MCP.
4. Cuando el token expira, Claude recibe un error claro; el usuario re-loguea y pushea un nuevo token.

## Glossary

- **Edge_Function**: Función serverless de Supabase que corre en Deno Runtime y actúa como MCP server.
- **MCP_Server**: Servidor que implementa el Model Context Protocol, exponiendo tools que un cliente (Claude) puede invocar vía JSON-RPC 2.0.
- **MCP_Client**: Claude u otro agente que consume las tools expuestas por el MCP_Server.
- **Shared_Secret**: Token estable compartido entre el MCP_Client y el MCP_Server para autenticar requests entrantes (env: `BROWSER_MCP_SECRET`).
- **Refresh_Secret**: Token separado que autentica las llamadas al endpoint de refresh de tokens de provider (env: `BROWSER_MCP_REFRESH_SECRET`).
- **Provider**: Plataforma externa (ej. Nexo, un banco, un broker) a la que el MCP accede en nombre del usuario usando un session token.
- **Provider_Module**: Módulo de código que encapsula la lógica de autenticación y llamadas HTTP específicas de un Provider.
- **Session_Token**: Token volátil (cookie, bearer token, etc.) extraído del navegador del usuario que autentica requests hacia un Provider.
- **Vault**: Supabase Vault, sistema de almacenamiento cifrado at-rest para secretos, accesible solo desde Edge Functions.
- **Vault_Slot**: Entrada en Vault con key pattern `provider:{name}:token` que almacena el Session_Token de un Provider específico.
- **Token_Extractor**: Mecanismo del lado del usuario (bookmarklet, extensión de Chrome, o script) que extrae el Session_Token del navegador y lo envía al endpoint de refresh.
- **Nexo_Provider**: Provider_Module específico para la plataforma Nexo (app.nexo.io), primer provider implementado.

## Requirements

### Requirement 1: MCP Server Transport

**User Story:** As a developer, I want the Edge Function to implement the MCP Streamable HTTP transport, so that Claude can connect to it as a standard MCP server.

#### Acceptance Criteria

1. THE Edge_Function SHALL accept HTTP POST requests containing JSON-RPC 2.0 messages with Content-Type `application/json` and respond with valid JSON-RPC 2.0 responses (containing `jsonrpc: "2.0"`, a matching `id`, and either a `result` or `error` field) with Content-Type `application/json`.
2. WHEN an `initialize` request is received, THE MCP_Server SHALL respond with `serverInfo` containing name `"browser-token-mcp"` and version, `protocolVersion` set to `"2024-11-05"`, and `capabilities` declaring `tools` support.
3. WHEN a `tools/list` request is received, THE MCP_Server SHALL respond with the complete list of available tools from all registered Provider_Modules, each including its `name`, `description`, and `inputSchema`.
4. WHEN a `tools/call` request is received with a valid tool name, THE MCP_Server SHALL dispatch to the corresponding Provider_Module, execute the tool, and return the result as an MCP tool result object with `content` containing at least one item of type `"text"`.
5. IF a `tools/call` request is received with a tool name that does not match any registered tool across any Provider_Module, THEN THE MCP_Server SHALL return a tool result with `isError: true` and a message indicating the tool name was not found.
6. THE Edge_Function SHALL include CORS headers `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type, Authorization` on all responses.
7. WHEN an HTTP OPTIONS request is received, THE Edge_Function SHALL respond with HTTP 204 and the CORS headers specified in criterion 6, without processing a JSON-RPC message.
8. IF an HTTP request is received with a method other than POST or OPTIONS, THEN THE Edge_Function SHALL respond with HTTP 405 (Method Not Allowed).

### Requirement 2: MCP Client Authentication (Claude → MCP)

**User Story:** As the system owner, I want incoming MCP requests to be authenticated with a stable shared secret, so that only my Claude instance can invoke tools.

#### Acceptance Criteria

1. IF a request arrives without a valid Shared_Secret, THEN THE MCP_Server SHALL reject it with HTTP 401 and a JSON-RPC error response indicating unauthorized access.
2. THE MCP_Server SHALL accept the Shared_Secret via the `Authorization: Bearer <token>` header or the `key` query parameter; IF both are provided, THEN THE MCP_Server SHALL use the header value and ignore the query parameter.
3. THE MCP_Server SHALL read the expected Shared_Secret from the `BROWSER_MCP_SECRET` environment variable.
4. IF the `BROWSER_MCP_SECRET` environment variable is unset or empty at startup, THEN THE MCP_Server SHALL refuse to handle requests and return HTTP 500 with a JSON-RPC error response indicating a server configuration error.
5. THE MCP_Server SHALL perform a constant-time string comparison when validating the Shared_Secret to prevent timing attacks.

### Requirement 3: Token Refresh Endpoint

**User Story:** As a user, I want to push new session tokens to the MCP server when I re-login to a provider, so that the MCP can continue accessing the provider on my behalf.

#### Acceptance Criteria

1. THE Edge_Function SHALL expose a dedicated refresh path (POST to the Edge Function URL with a JSON body containing `provider` and `token` fields) separate from the MCP JSON-RPC interface, and SHALL reject requests whose `Content-Type` header is not `application/json` with HTTP 415 and a JSON body indicating the expected content type.
2. WHEN a valid refresh request is received, THE Edge_Function SHALL store the provided Session_Token in the Vault_Slot corresponding to the specified Provider name, overwriting any previously stored token for that Provider, within 5 seconds of receiving the request.
3. THE Edge_Function SHALL authenticate refresh requests using the Refresh_Secret read from the `BROWSER_MCP_REFRESH_SECRET` environment variable, accepted via the `Authorization: Bearer <token>` header, where the secret is compared using a constant-time comparison.
4. IF a refresh request arrives without a valid Refresh_Secret, THEN THE Edge_Function SHALL reject it with HTTP 401 and a JSON body indicating unauthorized access.
5. IF the `provider` field in the refresh request does not match any registered Provider_Module name (case-sensitive comparison), THEN THE Edge_Function SHALL reject it with HTTP 400 and a JSON body listing the valid provider names.
6. IF the `token` field in the refresh request is missing, empty, or contains only whitespace characters, or exceeds 8192 characters in length, THEN THE Edge_Function SHALL reject it with HTTP 400 and a JSON body indicating the token is required and its maximum allowed length.
7. WHEN the token is stored successfully, THE Edge_Function SHALL respond with HTTP 200 and a JSON body confirming the provider name and an ISO 8601 UTC timestamp of the update.
8. THE Refresh_Secret SHALL be distinct from the Shared_Secret, and the refresh endpoint SHALL NOT accept the Shared_Secret as authentication.
9. IF the Vault_Slot write operation fails during a refresh request, THEN THE Edge_Function SHALL respond with HTTP 502 and a JSON body indicating that token storage failed, without revealing internal error details.
10. IF the request body exceeds 10 KB or is not parseable as valid JSON, THEN THE Edge_Function SHALL reject it with HTTP 400 and a JSON body indicating a malformed request.

### Requirement 4: Token Storage in Vault

**User Story:** As the system owner, I want session tokens stored encrypted at rest in Supabase Vault, so that tokens are protected even if the database is compromised.

#### Acceptance Criteria

1. WHEN the Edge_Function receives a valid Session_Token from a Provider (via the refresh endpoint), THE Edge_Function SHALL store the Session_Token in Supabase Vault using the key pattern `provider:{name}:token` where `{name}` is the lowercase Provider_Module name (matching the pattern `^[a-z][a-z0-9_]{1,62}$`), overwriting any previously stored token for that Provider.
2. WHEN a tool invocation requires a Provider's Session_Token, THE Edge_Function SHALL retrieve the Session_Token from Vault at the time of invocation rather than caching it in memory across requests, failing the request if retrieval does not complete within 5 seconds.
3. IF the Vault write operation fails when storing a Session_Token, THEN THE Edge_Function SHALL return `isError: true` with a message indicating the token could not be persisted, and SHALL NOT proceed with any operation that depends on the token being stored.
4. IF the Vault_Slot for a requested Provider is empty (no token has been stored), THEN THE MCP_Server SHALL return `isError: true` with a message indicating that no token is configured for the Provider and instructing the user to push a token via the refresh endpoint.
5. IF the Vault read operation fails due to a service error (as distinct from an empty slot), THEN THE Edge_Function SHALL return `isError: true` with a message indicating a vault connectivity failure, without exposing internal error details.
6. THE Edge_Function SHALL interact with Vault exclusively through the `vault.secrets` Supabase schema using SQL queries from the Edge Function's service role connection.

### Requirement 5: Provider Module Architecture

**User Story:** As a developer, I want a modular provider system, so that adding new providers requires only a new module and tool definitions without infrastructure changes.

#### Acceptance Criteria

1. THE MCP_Server SHALL maintain a registry of Provider_Modules, where each module declares its provider name, the list of tools it exposes (each with name, description, and input schema), and a handler function for each tool, conforming to a single shared interface that accepts a tool name, input parameters, and a Session_Token, and returns a structured result.
2. WHEN a `tools/call` request is received with a tool name that matches a registered Provider_Module prefix (e.g., `nexo_` routes to the Nexo_Provider), THE MCP_Server SHALL delegate execution to that module's handler, passing the validated input parameters and the Session_Token retrieved from Vault as arguments to the handler function.
3. IF a `tools/call` request is received with a tool name whose prefix does not match any registered Provider_Module, THEN THE MCP_Server SHALL return an error response indicating that the requested tool is not found, without invoking any handler.
4. IF a Provider_Module handler returns an error or throws an exception during execution, THEN THE MCP_Server SHALL return an error response to the caller indicating the tool execution failed, including the provider name and tool name that failed.
5. WHEN a new Provider_Module is registered, THE MCP_Server SHALL include all of that module's declared tools in subsequent `tools/list` responses without requiring modifications to the dispatch logic or server restart.
6. Each Provider_Module SHALL encapsulate all provider-specific HTTP request construction (including headers, cookies, base URL, and response parsing) such that no provider-specific HTTP details appear in the MCP_Server core code or in other Provider_Modules.
7. THE MCP_Server SHALL pass the Session_Token to the Provider_Module handler solely as a parameter of the handler interface, without exposing Vault connection details, retrieval logic, or configuration to the module.

### Requirement 6: Token Expiry Detection and User Communication

**User Story:** As a user, I want Claude to clearly inform me when a provider token has expired, so that I know to re-login and push a fresh token.

#### Acceptance Criteria

1. IF a Provider returns an HTTP 401 or 403 response when the MCP_Server makes a request on behalf of a tool invocation, THEN THE MCP_Server SHALL return `isError: true` with a message indicating that the session token for the specified Provider has expired or is invalid, and instructing the user to re-login to the Provider and push a new token via the refresh endpoint.
2. IF a Provider returns an HTTP 401 or 403, THEN THE MCP_Server SHALL NOT retry the request with the same token.
3. THE error message returned to the MCP_Client for expired tokens SHALL include the Provider name and a human-readable instruction for re-authentication, distinct from other error types.

### Requirement 7: Nexo Provider — Get Balances Tool

**User Story:** As a user, I want to query my Nexo account balances via Claude, so that I can see my crypto holdings without logging into the Nexo app.

#### Acceptance Criteria

1. THE Nexo_Provider SHALL expose a tool named `nexo_get_balances` with no required parameters.
2. WHEN the `nexo_get_balances` tool is called, THE Nexo_Provider SHALL send an authenticated HTTP request to the Nexo internal API endpoint using the Session_Token retrieved from Vault, with a response timeout of 15 seconds.
3. WHEN the Nexo API returns an HTTP 2xx response, THE Nexo_Provider SHALL return a structured list where each entry contains the asset currency name, available balance, and total balance as presented by the API. IF the account holds zero assets, the returned list SHALL be empty.
4. IF the Nexo API returns an HTTP 401 or 403 response, THEN THE Nexo_Provider SHALL return `isError: true` with an error message indicating that the session token is invalid or expired and that re-authentication is required.
5. IF the Nexo API returns a non-2xx response other than 401/403, THEN THE Nexo_Provider SHALL return `isError: true` with the HTTP status code and any error detail from the response body.
6. IF the Session_Token is not found in Vault or the HTTP request fails due to a network error or exceeds the 15-second timeout, THEN THE Nexo_Provider SHALL return `isError: true` with an error message indicating the nature of the failure without exposing internal credentials.
7. THE `nexo_get_balances` tool description SHALL indicate that it is a read-only operation that retrieves account balance information.

### Requirement 8: Read-Only Safety Constraint

**User Story:** As the system owner, I want the MCP to be strictly read-only, so that no tool can accidentally move money or execute transactions.

#### Acceptance Criteria

1. THE MCP_Server SHALL expose only tools that perform read operations (HTTP GET or equivalent queries); no tool SHALL perform write operations (HTTP POST/PUT/DELETE that create orders, initiate transfers, or modify account state) against any Provider.
2. Each Provider_Module SHALL document in its tool descriptions that all exposed operations are read-only.
3. IF a future Provider_Module attempts to register a tool that performs a write operation, THE MCP_Server architecture SHALL require explicit opt-in configuration (a separate environment variable per provider) before the tool is included in the `tools/list` response.

### Requirement 9: Error Handling and Resilience

**User Story:** As a developer, I want consistent error handling across all tools and providers, so that Claude receives actionable error messages regardless of which provider fails.

#### Acceptance Criteria

1. IF a network error occurs or a Provider does not respond within 30 seconds, THEN THE MCP_Server SHALL return `isError: true` with a message indicating the connectivity failure, the Provider name, and the HTTP status code if one was received.
2. IF a Provider returns a non-2xx response with a JSON body, THEN THE MCP_Server SHALL extract any error message field and include it in the MCP error result along with the HTTP status code.
3. IF an unexpected runtime error occurs during tool execution, THEN THE MCP_Server SHALL catch it and return `isError: true` with a sanitized error message that excludes stack traces and internal file paths, limited to 500 characters.
4. WHEN a request with invalid JSON is received on the MCP endpoint, THE MCP_Server SHALL respond with JSON-RPC error code -32700 (Parse error).
5. WHEN a request with an unsupported JSON-RPC method is received, THE MCP_Server SHALL respond with JSON-RPC error code -32601 (Method not found).
6. THE MCP_Server SHALL return all error responses in a consistent structure containing the fields `isError` (boolean) and `content` (array with a text entry describing the error).
7. IF the Vault is unreachable or returns an error when retrieving a token, THEN THE MCP_Server SHALL return `isError: true` with a message indicating an internal storage error without exposing Vault implementation details.

### Requirement 10: Security Isolation

**User Story:** As the system owner, I want provider session tokens to never be exposed to Claude, so that a compromised MCP client cannot exfiltrate credentials for my financial accounts.

#### Acceptance Criteria

1. THE MCP_Server SHALL ensure that Session_Tokens retrieved from Vault are used exclusively within HTTP requests to the corresponding Provider and are never included in any tool result, error message, log output, or protocol-level metadata returned to the MCP_Client.
2. THE MCP_Server SHALL NOT include raw Provider API response headers (which may contain tokens or session identifiers) in tool results returned to the MCP_Client.
3. IF a Provider's error response body contains the Session_Token or any substring of 4 or more consecutive characters from the token (including base64-encoded or URL-encoded representations), THEN THE MCP_Server SHALL redact the matching value before returning the error to the MCP_Client.
4. THE Edge_Function SHALL NOT log Session_Tokens to standard output or any logging system.
5. WHEN an HTTP request to a Provider completes (whether successfully or with an error), THE MCP_Server SHALL release the Session_Token from memory within 5 seconds and SHALL NOT retain the token in any in-memory cache or variable beyond that request's lifecycle.
6. IF redaction of a Provider error response fails or cannot be confirmed complete, THEN THE MCP_Server SHALL suppress the entire error response body and return a generic error indication to the MCP_Client that does not contain any Provider response content.

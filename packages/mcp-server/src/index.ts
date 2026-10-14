/**
 * @mediator/mcp-server — Public API (Sprint S16)
 *
 * Read-only Model Context Protocol (MCP) server for Mediator.
 * Exposes task brief, relevant context, capability information, and staged diffs.
 * Strictly read-only; denies file mutation, shell commands, policy edits, and approval resolutions.
 */

export * from './mcpProtocolTypes.js';
export * from './mcpSecurityFilter.js';
export * from './mcpResourceHandlers.js';
export * from './mcpToolHandlers.js';
export * from './mcpServer.js';
export * from './mcpTransport.js';

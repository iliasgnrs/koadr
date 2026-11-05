/**
 * Feature flag for the Extensions / Plugins settings surface.
 *
 * When `false` the plugin tab is hidden from Settings and the chat route stops
 * advertising plugin tools. The plugin code, `/api/mcp-*` routes and the plugin
 * store stay intact so flipping this back to `true` restores everything.
 */
export const PLUGINS_ENABLED = false;

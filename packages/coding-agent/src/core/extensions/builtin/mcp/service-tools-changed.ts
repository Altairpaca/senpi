import type { ExtensionAPI } from "../../types.ts";
import { collectToolCatalog, mcpToolListingIdentity } from "./catalog.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import { mapMcpCatalogNames } from "./expose/register.ts";
import { buildMcpTombstoneDefinition, diffMcpToolNames, formatMcpListChangedDelta } from "./notifications.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { SharedMcpLease } from "./shared-lease.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

/**
 * Re-list a server on a coalesced tools-changed signal and re-register: added
 * tools enter INACTIVE (registerToolsPreservingActiveSet keeps the active set),
 * and removed tools are tombstoned so a stale call fails cleanly. Every connect
 * raises the same signal, so a listing identical to the one this session last
 * registered is left alone (#2177).
 */
export async function refreshMcpToolsOnListChanged(
	entry: McpConnectionEntry,
	pi: McpToolRegistrar,
	config: ResolvedMcpConfig,
	registerDirectTools: (pi: McpToolRegistrar) => Promise<void>,
): Promise<void> {
	const server = config.servers[entry.name];
	if (server?.config === undefined || entry.connection.state !== "connected") return;
	// A startup connect that still owns registration registers its refreshed catalog itself.
	if (entry.startupCatalogClaim?.ownsRegistration() === true) return;
	if (entry.connection instanceof SharedMcpLease) {
		entry.cachedCatalog = await entry.connection.catalog();
	}
	const catalog = await collectToolCatalog(entry.name, entry.connection, server.config, {
		agentDir: entry.agentDir,
		outputGuard: config.settings.outputGuard,
	});
	const newNames = mapMcpCatalogNames(catalog).map(({ name }) => name);
	const diff = diffMcpToolNames(entry.knownToolNames ?? newNames, newNames);
	if (mcpToolListingIdentity(catalog) !== entry.registeredToolListing) {
		// Tombstone removed tools BEFORE re-registration so the subsequent
		// setActiveTools (which excludes them) leaves the tombstones inactive.
		for (const removed of diff.removed) pi.registerTool(buildMcpTombstoneDefinition(removed, entry.name));
		await registerDirectTools(pi);
	}
	entry.knownToolNames = newNames;
	entry.lastListChangedDelta = formatMcpListChangedDelta(diff);
}

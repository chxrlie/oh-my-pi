/**
 * Check for and install updates.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import type { OverlayConfig } from "../cli/update-overlay";
import { Settings, settings } from "../config/settings";
import { initTheme } from "../modes/theme/theme";

/**
 * Overlay config from settings, or undefined when overlay updates are off.
 *
 * `update.overlayRepo` is the switch: with no checkout to rebase there is
 * nothing to carry onto the release, so the stock download path applies.
 */
export function resolveOverlayConfig(read: (key: string) => unknown): OverlayConfig | undefined {
	const repoPath = String(read("update.overlayRepo") ?? "").trim();
	if (repoPath.length === 0) return undefined;
	const branch = String(read("update.overlayBranch") ?? "").trim();
	const remote = String(read("update.overlayRemote") ?? "").trim();
	return {
		repoPath,
		...(branch.length > 0 ? { branch } : {}),
		...(remote.length > 0 ? { remote } : {}),
	};
}

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		"no-overlay": Flags.boolean({
			description: "Ignore update.overlayRepo and install the stock release binary",
			default: false,
		}),
	};

	static examples = [
		"omp update",
		"omp update --check",
		"omp update --no-overlay",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
			return;
		}
		await Settings.init({ cwd: getProjectDir() });
		const overlay = flags["no-overlay"] ? undefined : resolveOverlayConfig(key => settings.get(key as never));
		await updateCli.runUpdateCommand({ force: flags.force, check: flags.check, overlay });
	}
}

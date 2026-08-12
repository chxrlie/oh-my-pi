import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";
import { initTheme } from "../../src/modes/theme/theme";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

/**
 * The overlay gate sits between the version comparison and the "already up to
 * date" short-circuit, so it can only be exercised end-to-end: `overlayNeedsRebuild`
 * is unit-tested on its own, but nothing else proves `runUpdateCommand` consults
 * it before returning early.
 *
 * Every case runs in check mode. The install path calls `process.exit(1)` on
 * failure, which would take the test runner down with it.
 */
describe("runUpdateCommand overlay staleness", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Serve the npm registry a fixed version so the comparison is deterministic. */
	function stubRelease(version: string): void {
		const fetchStub = Object.assign(async (_input: FetchInput, _init?: FetchInit) => Response.json({ version }), {
			preconnect: globalThis.fetch.preconnect,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	}

	function captureLogs(): string[] {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(arg => String(arg)).join(" "));
		});
		return lines;
	}

	it("rebuilds an unstamped overlay even when the release version is unchanged", async () => {
		const lines = captureLogs();
		stubRelease(VERSION);

		// The installed binary carries no overlay stamp, so nothing proves it was
		// built from the current overlay HEAD: the update must proceed.
		await runUpdateCommand({ force: false, check: true, overlay: { repoPath: process.cwd() } });

		expect(lines.some(line => line.includes("Already up to date"))).toBe(false);
		expect(lines.some(line => line.includes("Overlay patches changed"))).toBe(true);
		expect(lines.some(line => line.includes("Overlay update plan:"))).toBe(true);
	});

	it("short-circuits on an unchanged release version when no overlay is configured", async () => {
		const lines = captureLogs();
		stubRelease(VERSION);

		await runUpdateCommand({ force: false, check: true });

		expect(lines.some(line => line.includes("Already up to date"))).toBe(true);
		expect(lines.some(line => line.includes("Overlay update plan:"))).toBe(false);
	});

	it("treats an unreadable overlay checkout as stale instead of failing the run", async () => {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-"));
		try {
			const lines = captureLogs();
			stubRelease(VERSION);

			// `git rev-parse HEAD` cannot resolve here, so HEAD is unknown. That is a
			// reason to rebuild and report the real error later, never to crash the check.
			await runUpdateCommand({ force: false, check: true, overlay: { repoPath } });

			expect(lines.some(line => line.includes("Already up to date"))).toBe(false);
			expect(lines.some(line => line.includes("Overlay update plan:"))).toBe(true);
			expect(lines.some(line => line.includes(`overlay checkout: ${repoPath}`))).toBe(true);
		} finally {
			fs.rmSync(repoPath, { recursive: true, force: true });
		}
	});
});

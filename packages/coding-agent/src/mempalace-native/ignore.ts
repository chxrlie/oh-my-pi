/**
 * Gitignore-aware skip rules for the native palace mine.
 *
 * The mine walks a project tree, so it inherits the project's own opinion about
 * which files are noise: a `.gitignore` already lists the build output, the
 * generated clients and the local scratch files nobody wants surfaced as a
 * memory. Honouring it is both cheaper than mining junk and less surprising
 * than a second, private exclusion list.
 *
 * On top of that sit two non-negotiable sets. Some directories are never worth
 * descending into even when a repo commits them (`node_modules`, `vendor`,
 * `dist`), and some files are machine-written text that would flood the palace
 * with high-volume, zero-signal drawers (lockfiles, minified bundles). Those
 * are hard skips, unaffected by a `!negation`.
 *
 * Nested `.gitignore` files are loaded lazily: the matcher reads a directory's
 * file the first time it is asked about something inside that directory, and
 * caches the parsed rules. A walk that never descends into a subtree never
 * pays for its ignore file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** Returns `true` when the path should be skipped by the mine. */
export type IgnoreMatcher = (absPath: string, isDir: boolean) => boolean;

/** Characters that must be escaped when a glob's literal text is spliced into a regex. */
const REGEX_METACHAR_RE = /[.+^${}()|[\]\\]/;

/**
 * Directories the mine never descends into, whatever the project's own ignore
 * rules say. Dependency trees, build output and caches: high file counts, no
 * authored content.
 */
export const ALWAYS_SKIP_DIRS: Readonly<Record<string, true>> = {
	node_modules: true,
	".git": true,
	dist: true,
	build: true,
	out: true,
	target: true,
	".next": true,
	".cache": true,
	coverage: true,
	vendor: true,
	__pycache__: true,
	".venv": true,
};

/**
 * Filename globs for machine-written text. Lockfiles and minified bundles pass
 * the source-extension allowlist (`package-lock.json` is `.json`, `app.min.js`
 * is `.js`) yet contain nothing a human wrote, so they are excluded by name.
 */
export const LOCKFILE_PATTERNS: readonly string[] = [
	"*.lock",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"*.min.js",
];

const LOCKFILE_MATCHERS: readonly RegExp[] = LOCKFILE_PATTERNS.map(pattern => new RegExp(`^${globSource(pattern)}$`));

/** `true` when a file is machine-written noise the mine always skips. */
export function isAlwaysSkippedFile(name: string): boolean {
	for (const matcher of LOCKFILE_MATCHERS) {
		if (matcher.test(name)) return true;
	}
	return false;
}

interface IgnoreRule {
	/** A `!` rule; it un-ignores a path that an earlier rule matched. */
	negated: boolean;
	/** A trailing-slash rule; it only applies to directories. */
	dirOnly: boolean;
	/** Matched against the path relative to the directory holding the rule's `.gitignore`. */
	regex: RegExp;
}

/** Shared empty layer, so a directory without a `.gitignore` costs no allocation. */
const NO_RULES: readonly IgnoreRule[] = [];

/**
 * Build a skip predicate rooted at `dir`. The returned function is safe to call
 * with any path: anything outside the root, or any unreadable ignore file, is
 * simply not a reason to skip.
 */
export function createIgnoreMatcher(dir: string): IgnoreMatcher {
	const root = path.resolve(dir);
	const layers = new Map<string, readonly IgnoreRule[]>();

	const layerFor = (directory: string): readonly IgnoreRule[] => {
		const cached = layers.get(directory);
		if (cached !== undefined) return cached;
		const rules = loadIgnoreFile(directory);
		layers.set(directory, rules);
		return rules;
	};

	return (absPath, isDir) => {
		try {
			return shouldSkip(root, layerFor, path.resolve(absPath), isDir);
		} catch (error) {
			// A misconfigured ignore file must never abort a mine; the worst
			// outcome of a bad match is that one extra file gets read.
			logger.debug("mempalace-native: ignore match failed", { path: absPath, error: String(error) });
			return false;
		}
	};
}

function shouldSkip(
	root: string,
	layerFor: (directory: string) => readonly IgnoreRule[],
	absPath: string,
	isDir: boolean,
): boolean {
	const relative = path.relative(root, absPath);
	// The root itself, or something outside it: no rule of ours applies.
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return false;

	const segments = relative.split(path.sep);
	// `dirs[k]` is the directory containing `segments[k]`, and therefore the
	// base of the k-th `.gitignore` that can speak about it.
	const dirs: string[] = [root];
	for (let i = 0; i < segments.length - 1; i++) dirs.push(path.join(dirs[i], segments[i]));

	let ignored = false;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const last = i === segments.length - 1;
		const segmentIsDir = last ? isDir : true;

		if (segmentIsDir ? ALWAYS_SKIP_DIRS[segment] === true : isAlwaysSkippedFile(segment)) return true;

		// Outer ignore files first, inner last: a deeper `.gitignore` overrides
		// a shallower one, and within one file the last match wins.
		let decided: boolean | undefined;
		for (let k = 0; k <= i; k++) {
			const rules = layerFor(dirs[k]);
			if (rules.length === 0) continue;
			const candidate = k === i ? segment : segments.slice(k, i + 1).join("/");
			for (const rule of rules) {
				if (rule.dirOnly && !segmentIsDir) continue;
				if (rule.regex.test(candidate)) decided = !rule.negated;
			}
		}
		if (decided !== undefined) ignored = decided;
		// Git semantics: once a parent directory is excluded, nothing beneath it
		// can be re-included, so stop walking down.
		if (ignored && !last) return true;
	}
	return ignored;
}

function loadIgnoreFile(directory: string): readonly IgnoreRule[] {
	let text: string;
	try {
		text = fs.readFileSync(path.join(directory, ".gitignore"), "utf8");
	} catch {
		// Absent (the overwhelmingly common case) or unreadable — both mean
		// "this directory adds no rules".
		return NO_RULES;
	}
	const rules: IgnoreRule[] = [];
	for (const line of text.split("\n")) {
		const rule = parseRule(line.endsWith("\r") ? line.slice(0, -1) : line);
		if (rule !== null) rules.push(rule);
	}
	return rules.length === 0 ? NO_RULES : rules;
}

function parseRule(line: string): IgnoreRule | null {
	// Unescaped trailing whitespace is not part of a gitignore pattern.
	let pattern = line.replace(/(?<!\\)\s+$/, "");
	if (pattern.length === 0 || pattern.startsWith("#")) return null;

	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	let dirOnly = false;
	if (pattern.endsWith("/")) {
		dirOnly = true;
		pattern = pattern.slice(0, -1);
	}
	if (pattern.length === 0) return null;

	// A slash anywhere but the (already stripped) trailing position anchors the
	// pattern to the directory holding the ignore file; otherwise it matches at
	// any depth beneath it.
	const anchored = pattern.includes("/");
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	if (pattern.length === 0) return null;

	try {
		const prefix = anchored ? "" : "(?:.*/)?";
		return { negated, dirOnly, regex: new RegExp(`^${prefix}${globSource(pattern)}$`) };
	} catch (error) {
		logger.debug("mempalace-native: unusable gitignore pattern", { pattern: line, error: String(error) });
		return null;
	}
}

/**
 * Translate a gitignore-flavoured glob into a regex source. `*` and `?` stop at
 * a separator, `**` spans them, and a `**/ ` or `; /**` run absorbs its adjacent
 * slash so `a/**\/b` still matches `a/b`.
 */
function globSource(glob: string): string {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				while (glob[i + 1] === "*") i++;
				if (glob[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
				continue;
			}
			source += "[^/]*";
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			continue;
		}
		if (ch === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end > i + 1) {
				const body = glob.slice(i + 1, end);
				source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
				i = end;
				continue;
			}
			source += "\\[";
			continue;
		}
		if (ch === "\\") {
			const next = glob[i + 1];
			if (next !== undefined) {
				source += REGEX_METACHAR_RE.test(next) ? `\\${next}` : next;
				i++;
				continue;
			}
			source += "\\\\";
			continue;
		}
		source += REGEX_METACHAR_RE.test(ch) ? `\\${ch}` : ch;
	}
	return source;
}

import zlib from "node:zlib";

export interface MinipackOptions {
	/** Optional file path or extension hint (e.g. 'src/index.ts', '.js') */
	path?: string;
	/** Force compression even if compressed token count is not smaller than original */
	force?: boolean;
}

export interface MinipackCompressResult {
	/** Full output text (minified code + lossless recovery footer) */
	code: string;
	/** Minified code alone */
	minified: string;
	/** Base64-encoded compressed recovery payload */
	recoveryPayload: string;
	/** Original token count estimate */
	originalTokens: number;
	/** Compressed token count estimate (including recovery footer) */
	compressedTokens: number;
	/** Compression ratio (compressedTokens / originalTokens) */
	ratio: number;
	/** Whether compression was applied */
	compressed: boolean;
}

const JS_TS_EXTENSIONS: Record<string, true> = {
	".js": true,
	".mjs": true,
	".cjs": true,
	".jsx": true,
	".ts": true,
	".mts": true,
	".cts": true,
	".tsx": true,
};

export const MINIPACK_RECOVERY_HEADER = "--- MINIPACK LOSSLESS RECOVERY FOOTER ---";
export const MINIPACK_PREFIX = "[MINIPACK:v1:";
export const MINIPACK_SUFFIX = "]";

/** Check if a file path or extension corresponds to JS/TS. */
export function isJSOrTSPath(filePath?: string): boolean {
	if (!filePath) return false;
	const clean = filePath.split(":")[0]?.split("#")[0] ?? filePath;
	const dotIndex = clean.lastIndexOf(".");
	if (dotIndex === -1) return false;
	const ext = clean.slice(dotIndex).toLowerCase();
	return Boolean(JS_TS_EXTENSIONS[ext]);
}

/** Check if text looks like JS/TS source code (heuristic). */
export function isJSOrTSCode(code: string): boolean {
	return /(?:import\s+[\s\S]*?from|export\s+|(?:async\s+)?function\s|\bconst\b|\blet\b|\bvar\b|\btype\b|\binterface\b|\bclass\b|=>)/.test(
		code,
	);
}

/** Simple token estimator (byte length / 4). */
export function estimateMinipackTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

/**
 * Token-aware JS/TS code minifier.
 * Strips single-line and multi-line comments, removes redundant indentation/whitespace,
 * and collapses punctuation spaces.
 */
export function minifyJSTS(code: string): string {
	if (!code) return "";

	let out = "";
	const len = code.length;
	let i = 0;

	// Context state
	let state: "NORMAL" | "STRING_SINGLE" | "STRING_DOUBLE" | "TEMPLATE" | "LINE_COMMENT" | "BLOCK_COMMENT" | "REGEX" =
		"NORMAL";
	let templateBraceDepth = 0;
	let prevTokenChar = "";

	while (i < len) {
		const ch = code[i];
		const nextChar = i + 1 < len ? code[i + 1] : "";

		if (state === "LINE_COMMENT") {
			if (ch === "\n") {
				state = "NORMAL";
				out += "\n";
			}
			i++;
			continue;
		}

		if (state === "BLOCK_COMMENT") {
			if (ch === "*" && nextChar === "/") {
				state = "NORMAL";
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		if (state === "STRING_SINGLE") {
			out += ch;
			if (ch === "\\" && i + 1 < len) {
				out += code[i + 1];
				i += 2;
				continue;
			}
			if (ch === "'") {
				state = "NORMAL";
				prevTokenChar = "'";
			}
			i++;
			continue;
		}

		if (state === "STRING_DOUBLE") {
			out += ch;
			if (ch === "\\" && i + 1 < len) {
				out += code[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				state = "NORMAL";
				prevTokenChar = '"';
			}
			i++;
			continue;
		}

		if (state === "TEMPLATE") {
			out += ch;
			if (ch === "\\" && i + 1 < len) {
				out += code[i + 1];
				i += 2;
				continue;
			}
			if (ch === "$" && nextChar === "{") {
				out += "{";
				i += 2;
				templateBraceDepth++;
				state = "NORMAL";
				continue;
			}
			if (ch === "`") {
				state = "NORMAL";
				prevTokenChar = "`";
			}
			i++;
			continue;
		}

		if (state === "REGEX") {
			out += ch;
			if (ch === "\\" && i + 1 < len) {
				out += code[i + 1];
				i += 2;
				continue;
			}
			if (ch === "/") {
				state = "NORMAL";
				prevTokenChar = "/";
			}
			i++;
			continue;
		}

		// state === "NORMAL"
		if (ch === "/" && nextChar === "/") {
			state = "LINE_COMMENT";
			i += 2;
			continue;
		}

		if (ch === "/" && nextChar === "*") {
			state = "BLOCK_COMMENT";
			i += 2;
			continue;
		}

		// Regex literal detection check
		if (ch === "/") {
			const canBeRegex = /[\(=:,;!&|\?\{\}\[\]=>\n^~]/.test(prevTokenChar) || out.trimEnd().endsWith("return");
			if (canBeRegex) {
				state = "REGEX";
				out += ch;
				i++;
				continue;
			}
		}

		if (ch === "'") {
			state = "STRING_SINGLE";
			out += ch;
			i++;
			continue;
		}

		if (ch === '"') {
			state = "STRING_DOUBLE";
			out += ch;
			i++;
			continue;
		}

		if (ch === "`") {
			state = "TEMPLATE";
			out += ch;
			i++;
			continue;
		}

		if (ch === "}" && templateBraceDepth > 0) {
			templateBraceDepth--;
			out += ch;
			state = "TEMPLATE";
			i++;
			continue;
		}

		if (/\s/.test(ch)) {
			// Keep linebreaks, collapse horizontal spaces
			let j = i;
			let hasNewline = false;
			while (j < len && /\s/.test(code[j])) {
				if (code[j] === "\n") hasNewline = true;
				j++;
			}
			i = j;

			if (hasNewline) {
				if (out.length > 0 && !out.endsWith("\n")) {
					out += "\n";
				}
			} else {
				// Add single space only if between identifier/keyword characters
				const lastChar = out.length > 0 ? out[out.length - 1] : "";
				const nextCodeChar = i < len ? code[i] : "";
				if (/[a-zA-Z0-9_$]/.test(lastChar) && /[a-zA-Z0-9_$]/.test(nextCodeChar)) {
					out += " ";
				}
			}
			continue;
		}

		// Non-whitespace character
		const isPunctuation = /[\{\}\(\)\[\];,:=+\-*\/%><?!&|^~]/.test(ch);
		if (isPunctuation) {
			// Trim space before punctuation if present
			if (out.endsWith(" ") && !/[a-zA-Z0-9_$]/.test(ch)) {
				// keep as is, punctuation handles space
			}
		}

		out += ch;
		if (!/\s/.test(ch)) {
			prevTokenChar = ch;
		}
		i++;
	}

	let lines = out
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);

	return lines.join("\n");
}

/**
 * Compress JS/TS source code using minipack (minification + lossless zlib recovery footer).
 */
export function minipackCompress(code: string, options?: MinipackOptions): MinipackCompressResult {
	const pathHint = options?.path;
	const isTarget = isJSOrTSPath(pathHint) || isJSOrTSCode(code);
	const originalTokens = estimateMinipackTokens(code);

	if (!isTarget && !options?.force) {
		return {
			code,
			minified: code,
			recoveryPayload: "",
			originalTokens,
			compressedTokens: originalTokens,
			ratio: 1,
			compressed: false,
		};
	}

	const minified = minifyJSTS(code);
	const compressedBuffer = zlib.deflateSync(Buffer.from(code, "utf-8"));
	const recoveryPayload = compressedBuffer.toString("base64");
	const compressedCode = `${minified}\n\n${MINIPACK_RECOVERY_HEADER}\n${MINIPACK_PREFIX}${recoveryPayload}${MINIPACK_SUFFIX}`;
	const compressedTokens = estimateMinipackTokens(compressedCode);
	const ratio = originalTokens > 0 ? compressedTokens / originalTokens : 1;

	const shouldCompress = options?.force || compressedTokens < originalTokens;

	if (!shouldCompress) {
		return {
			code,
			minified,
			recoveryPayload: "",
			originalTokens,
			compressedTokens: originalTokens,
			ratio: 1,
			compressed: false,
		};
	}

	return {
		code: compressedCode,
		minified,
		recoveryPayload,
		originalTokens,
		compressedTokens,
		ratio,
		compressed: true,
	};
}

/**
 * Check if text contains a minipack lossless recovery footer.
 */
export function isMinipackCompressed(text: string): boolean {
	if (!text) return false;
	return text.includes(MINIPACK_PREFIX);
}

/**
 * Decompress a minipack-compressed payload back to the exact original text verbatim.
 */
export function minipackDecompress(compressedCode: string): string {
	if (!compressedCode) return compressedCode;

	const prefixIndex = compressedCode.indexOf(MINIPACK_PREFIX);
	if (prefixIndex === -1) return compressedCode;

	const payloadStart = prefixIndex + MINIPACK_PREFIX.length;
	const suffixIndex = compressedCode.indexOf(MINIPACK_SUFFIX, payloadStart);
	if (suffixIndex === -1) return compressedCode;

	const recoveryPayload = compressedCode.slice(payloadStart, suffixIndex).trim();
	try {
		const buf = Buffer.from(recoveryPayload, "base64");
		const decompressed = zlib.inflateSync(buf).toString("utf-8");
		return decompressed;
	} catch {
		return compressedCode;
	}
}

/**
 * Paragraph-aware text chunking for the native palace.
 *
 * A drawer is a retrieval unit, not a file, so a mined file has to be cut into
 * pieces small enough to embed and to quote back into a prompt. The cut points
 * are chosen structurally rather than by character arithmetic: prose and source
 * both use blank lines as their coarsest boundary, so packing whole paragraphs
 * up to a budget keeps a function, a heading section, or a config block intact
 * far more often than a fixed-width slice would.
 *
 * Fallbacks degrade one boundary at a time — paragraph, then line, then a hard
 * character cut — so a minified blob or a 200 KiB single-line JSON file still
 * produces usable chunks instead of one unbounded body.
 *
 * Pure and synchronous: no filesystem, no logging, no configuration lookups. It
 * runs inside the mine subprocess on every changed file, and it is exercised
 * directly by tests.
 */

/** One unit of chunked text, ready to become a drawer. */
export interface TextChunk {
	title: string;
	body: string;
}

export interface ChunkOptions {
	/** Hard ceiling on a chunk body, in characters. Default 1800. */
	maxChars?: number;
	/**
	 * Characters of the previous chunk carried into the next, so a passage
	 * straddling a boundary is still retrievable from one side. Default 150,
	 * clamped to half of `maxChars` — beyond that a chunk would be mostly
	 * carried-over text and the packer would barely advance.
	 */
	overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 150;
/** Below this a "chunk" carries no usable context, so smaller budgets are clamped up. */
const MIN_MAX_CHARS = 16;
const MAX_TITLE_CHARS = 80;

/**
 * A blank line, tolerating trailing spaces or tabs on the blank one — editors
 * and generators leave those behind constantly and they are not a reason to
 * fuse two paragraphs into one chunk.
 */
const PARAGRAPH_SPLIT_RE = /\n(?:[ \t]*\n)+/;

/**
 * Decoration that opens a line without carrying meaning: markdown headings and
 * bullets, block and line comments in the C/shell/SQL families, docstring
 * fences, setext rules.
 */
const TITLE_PREFIX_RE = /^(?:#{1,6}|\/{2,}|\/\*+|\*+\/|\*+|<!--|-{2,}|={2,}|[-*+>]|;+|"{3}|'{3})[ \t]*/;
/** The closing halves of the same decorations, plus a closed-ATX heading's trailing hashes. */
const TITLE_SUFFIX_RE = /[ \t]*(?:\*+\/|-->|"{3}|'{3}|#+|={2,})$/;
/** Enough passes to peel a nested opener such as `/** # Heading`; more is decoration, not a title. */
const TITLE_STRIP_PASSES = 3;

/**
 * Split `text` into chunks no longer than `maxChars`, preferring paragraph
 * boundaries, then line boundaries, then a hard cut. Never returns an empty or
 * whitespace-only body, and never throws — a caller feeding it a decoded file
 * gets chunks or an empty array.
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const maxChars = normalizeMaxChars(options?.maxChars);
	const overlapChars = normalizeOverlap(options?.overlapChars, maxChars);

	// Normalize line endings once so every boundary rule below can assume `\n`.
	const normalized = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
	if (normalized.trim().length === 0) return [];

	const units = splitUnits(normalized, maxChars);
	if (units.length === 0) return [];

	const bodies: string[] = [];
	let current = "";
	for (const unit of units) {
		if (current.length === 0) {
			current = unit;
			continue;
		}
		const candidate = `${current}\n\n${unit}`;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		bodies.push(current);
		// Seed the next chunk with the tail of this one, but only when the
		// overlap plus the incoming unit still fit; correctness of the budget
		// outranks the convenience of the carried context.
		const overlap = overlapTail(current, overlapChars);
		current = overlap.length > 0 && overlap.length + 2 + unit.length <= maxChars ? `${overlap}\n\n${unit}` : unit;
	}
	if (current.length > 0) bodies.push(current);

	const chunks: TextChunk[] = [];
	for (const raw of bodies) {
		const body = raw.trim();
		if (body.length === 0) continue;
		chunks.push({ title: deriveTitle(body, chunks.length), body });
	}
	return chunks;
}

function normalizeMaxChars(value: number | undefined): number {
	const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_CHARS;
	return raw < MIN_MAX_CHARS ? MIN_MAX_CHARS : raw;
}

function normalizeOverlap(value: number | undefined, maxChars: number): number {
	const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_OVERLAP_CHARS;
	if (raw <= 0) return 0;
	return Math.min(raw, Math.floor(maxChars / 2));
}

/**
 * Flatten `text` into packable units, each guaranteed to be non-empty and no
 * longer than `maxChars`. That guarantee is what lets the packer above assume
 * a fresh chunk seeded with one unit is always within budget.
 */
function splitUnits(text: string, maxChars: number): string[] {
	const units: string[] = [];
	for (const paragraph of text.split(PARAGRAPH_SPLIT_RE)) {
		const trimmed = paragraph.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length <= maxChars) {
			units.push(trimmed);
			continue;
		}
		for (const piece of splitOversizedParagraph(trimmed, maxChars)) units.push(piece);
	}
	return units;
}

/** Second boundary: pack whole lines, hard-cutting only a line that is itself oversized. */
function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
	const pieces: string[] = [];
	let buffer = "";
	const flush = (): void => {
		if (buffer.trim().length > 0) pieces.push(buffer.trim());
		buffer = "";
	};

	for (const rawLine of paragraph.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.length > maxChars) {
			flush();
			for (const slice of hardCut(line, maxChars)) pieces.push(slice);
			continue;
		}
		const candidate = buffer.length === 0 ? line : `${buffer}\n${line}`;
		if (candidate.length > maxChars) {
			flush();
			buffer = line;
			continue;
		}
		buffer = candidate;
	}
	flush();
	return pieces;
}

/** Last resort: a line with no interior boundary left to respect. */
function hardCut(line: string, maxChars: number): string[] {
	const slices: string[] = [];
	for (let start = 0; start < line.length; start += maxChars) {
		const slice = line.slice(start, start + maxChars);
		if (slice.trim().length > 0) slices.push(slice);
	}
	return slices;
}

/**
 * Tail of `body` to carry into the next chunk, advanced to the first whitespace
 * so the overlap starts on a whole token rather than mid-word.
 */
function overlapTail(body: string, overlapChars: number): string {
	if (overlapChars <= 0 || body.length <= overlapChars) return "";
	const tail = body.slice(body.length - overlapChars);
	const boundary = tail.search(/\s/);
	return (boundary >= 0 ? tail.slice(boundary + 1) : tail).trim();
}

/**
 * Title for a chunk: its first non-empty line with heading and comment
 * punctuation peeled off, capped at 80 characters. Falls back to a positional
 * label so a drawer is never titled with the empty string.
 */
function deriveTitle(body: string, index: number): string {
	let title = firstNonEmptyLine(body);
	for (let pass = 0; pass < TITLE_STRIP_PASSES; pass++) {
		const stripped = title.replace(TITLE_PREFIX_RE, "").replace(TITLE_SUFFIX_RE, "").trim();
		if (stripped === title) break;
		title = stripped;
	}
	if (title.length === 0) return `chunk ${index + 1}`;
	return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trim() : title;
}

function firstNonEmptyLine(body: string): string {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return "";
}

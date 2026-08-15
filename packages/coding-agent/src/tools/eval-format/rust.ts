import type { EvalLanguage } from "../../eval/types";

/** Identity pass-through — Rust formatting is not yet implemented. */
export function formatRustForDisplay(source: string): string {
	return source;
}

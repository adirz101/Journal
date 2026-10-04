// Types for the renderer, which imports retrieval.mjs (no Node built-ins) to
// underline task words exactly where core searches them.
export declare const STOPWORDS: Set<string>;
export interface IdentifierPartRange { part: string; start: number; end: number }
export interface QueryTermSpan { term: string; start: number; end: number; whole: boolean }
export declare function identifierPartRanges(value: string, offset?: number): IdentifierPartRange[];
export declare function identifierParts(value: string): string[];
export declare function queryTerms(query: string, limit?: number): string[];
export declare function queryTermSpans(text: string, limit?: number): QueryTermSpan[];

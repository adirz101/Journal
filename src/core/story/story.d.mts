// Types for the renderer, which imports story.mjs (pure, no Node built-ins) to show the Story.
export type StoryStatus = 'passed' | 'failed' | 'unknown' | 'neutral' | 'running' | 'interrupted' | 'done' | 'active' | 'pending' | 'removed';
export interface StoryItem { at: string; label: string; status: string; category: string; command: string | null }
export interface StoryPhase { key: string; kind: string; title: string; status: StoryStatus; meta: string[]; summary: string[]; at: string | null; endAt?: string | null; items: StoryItem[] }
export interface StoryTurn { index: number; at: string | null; endAt: string | null; outcome: string | null; approvals: number; phases: StoryPhase[] }
export interface Story { plan: StoryPhase[] | null; turns: StoryTurn[]; waiting: { tool: string | null; label: string } | null; counts: { events: number; commands: number; hidden: number } }
export interface StoryEvent { id?: number; at: string; kind: string; body: Record<string, unknown> }
export declare function buildStory(events: readonly StoryEvent[]): Story;
export declare function duration(ms: number): string | null;

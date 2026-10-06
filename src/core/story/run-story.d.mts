export interface RunStoryEvent { id: number; at?: string; kind: string; body?: Record<string, unknown> }
export interface RunStoryRow { id: number; at?: string; title: string; claim: boolean; detail: string | null; resultId: string | null; attemptId: string | null }
export declare function buildRunStory(events: readonly RunStoryEvent[], run?: { tasks?: { id: string; title: string }[]; attempts?: { id: string; taskId: string }[] }): RunStoryRow[];

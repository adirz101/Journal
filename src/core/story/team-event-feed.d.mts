export interface EventFeed { refresh(): void; settled(): Promise<void>; dispose(): void }
export declare function createEventFeed<T extends { id: number }>(fetchPage: (after: number) => Promise<T[]>, publish: (rows: T[]) => void, onError: (error: Error) => void): EventFeed;

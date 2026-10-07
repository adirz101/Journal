export interface ConversationMessage { id: string; sender?: string; recipient: string; kind: string; text: string; state: string; inputResolved: boolean; heldReason?: string }
export interface ConversationEvent { id: number; at?: string; kind: string; body: Record<string, unknown> }
export interface ConversationEntry { id: number; at?: string; source: 'user' | 'coordinator'; text: string; message?: ConversationMessage }
export declare function conversationEntries(events: readonly ConversationEvent[], messages: readonly ConversationMessage[]): ConversationEntry[];
export declare function messageDeliveryLabel(state: string): string;
export declare function shortRunTitle(goal: string): string;
export interface CompletionReport { summary: string; status: string; launchId: string; turnId: string }
export declare function currentCompletionReport(attempt: { launchId?: string; turnId?: string | null; reports?: { result?: CompletionReport } }): CompletionReport | null;

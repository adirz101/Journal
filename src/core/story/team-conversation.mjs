// Published reports are distinct from native terminal transcripts and system evidence.
export function conversationEntries(events, messages) {
  const byId = new Map(messages.map(message => [message.id, message]));
  return [...events].sort((a, b) => a.id - b.id).flatMap(event => {
    if (event.kind === 'coordinator.update' && typeof event.body?.summary === 'string')
      return [{ id: event.id, at: event.at, source: 'coordinator', text: event.body.summary }];
    if (event.kind !== 'message.queued') return [];
    const message = byId.get(event.body?.messageId);
    if (!message || message.sender !== 'desktop') return [];
    return [{ id: event.id, at: event.at, source: 'user', text: message.text, message }];
  });
}
export function messageDeliveryLabel(state) {
  return ({ queued: 'Queued', held: 'Waiting for safe delivery', delivering: 'Delivering', staged: 'Input staged; not submitted', submitted: 'Submitted; not acknowledged', acknowledged: 'Receipt acknowledged', uncertain: 'Delivery uncertain', cancelled: 'Cancelled' })[state] ?? 'Delivery status unknown';
}
export function shortRunTitle(goal) {
  const line = goal.trim().split(/\r?\n/)[0] || 'Coordinated work';
  return line.length > 80 ? line.slice(0, 79).trimEnd() + '…' : line;
}


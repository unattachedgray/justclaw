/** SSE (Server-Sent Events) manager for live dashboard refresh. */

type SseClient = {
  controller: ReadableStreamDefaultController<string>;
  closed: boolean;
};

const clients: SseClient[] = [];

export function addClient(controller: ReadableStreamDefaultController<string>): SseClient {
  const client: SseClient = { controller, closed: false };
  clients.push(client);
  return client;
}

export function removeClient(client: SseClient): void {
  client.closed = true;
  const idx = clients.indexOf(client);
  if (idx !== -1) clients.splice(idx, 1);
}

export function pushEvent(event: string, data: string = ''): void {
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  const dead: SseClient[] = [];
  for (const client of clients) {
    if (client.closed) { dead.push(client); continue; }
    try {
      client.controller.enqueue(msg);
    } catch { /* client disconnected, mark for removal */
      client.closed = true;
      dead.push(client);
    }
  }
  // Remove dead clients outside the iteration loop
  for (const client of dead) {
    removeClient(client);
  }
}

/** Periodic heartbeat to keep SSE connections alive. */
export function startHeartbeat(): void {
  setInterval(() => {
    pushEvent('heartbeat', '');
  }, 60_000);
}

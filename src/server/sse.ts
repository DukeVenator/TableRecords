import type { ServerResponse } from "node:http";

interface Client {
  id: number;
  res: ServerResponse;
}

export class SseHub {
  private clients = new Map<number, Client>();
  private nextClientId = 1;
  private nextEventId = 1;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor() {
    this.heartbeat = setInterval(() => this.broadcast("heartbeat", { tsMs: Date.now() }), 15_000);
    this.heartbeat.unref?.();
  }

  add(res: ServerResponse): number {
    const id = this.nextClientId++;
    this.clients.set(id, { id, res });
    res.on("close", () => this.clients.delete(id));
    return id;
  }

  broadcast(event: string, data: unknown): void {
    const payload = `id: ${this.nextEventId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients.values()) {
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

// Minimal stand-in for a websocket server so the relay can be exercised without dependencies.
type Socket = { send(data: string): void; onMessage(cb: (data: string) => void): void; onClose(cb: () => void): void };

export class WebSocketServer {
  readonly port: number;

  constructor(port: number) {
    this.port = port;
  }

  onConnection(_cb: (socket: Socket, boardId: string) => void): void {}
}

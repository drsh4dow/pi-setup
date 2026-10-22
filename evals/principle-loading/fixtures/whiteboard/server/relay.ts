import { WebSocketServer } from "./ws-lite.ts";

// Broadcasts every operation to all other sockets on the same board, in arrival order.
const boards = new Map<string, Set<{ send(data: string): void }>>();

export function start(port = 4000) {
  const server = new WebSocketServer(port);
  server.onConnection((socket, boardId) => {
    const peers = boards.get(boardId) ?? new Set();
    boards.set(boardId, peers);
    peers.add(socket);
    socket.onMessage((data) => {
      for (const peer of peers) if (peer !== socket) peer.send(data);
    });
    socket.onClose(() => peers.delete(socket));
  });
}

import { applyOperation, type Board, type Operation } from "./board.ts";

export class BoardClient {
  readonly board: Board = new Map();
  readonly author: string;
  private readonly send: (op: Operation) => void;

  constructor(author: string, send: (op: Operation) => void) {
    this.author = author;
    this.send = send;
  }

  perform(op: Operation): void {
    applyOperation(this.board, op);
    this.send(op);
  }

  receive(op: Operation): void {
    if (op.author === this.author) return;
    applyOperation(this.board, op);
  }
}

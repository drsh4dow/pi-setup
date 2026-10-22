export type Point = { x: number; y: number };

export type Shape =
  | { id: string; kind: "rect"; at: Point; width: number; height: number; color: string }
  | { id: string; kind: "line"; from: Point; to: Point; color: string }
  | { id: string; kind: "text"; at: Point; text: string; color: string };

export type Operation =
  | { type: "add"; shape: Shape; author: string }
  | { type: "move"; id: string; by: Point; author: string }
  | { type: "recolor"; id: string; color: string; author: string }
  | { type: "delete"; id: string; author: string };

export type Board = Map<string, Shape>;

export function applyOperation(board: Board, op: Operation): void {
  switch (op.type) {
    case "add":
      board.set(op.shape.id, op.shape);
      return;
    case "move": {
      const shape = board.get(op.id);
      if (!shape) return;
      if (shape.kind === "line") {
        board.set(op.id, { ...shape, from: shift(shape.from, op.by), to: shift(shape.to, op.by) });
      } else {
        board.set(op.id, { ...shape, at: shift(shape.at, op.by) });
      }
      return;
    }
    case "recolor": {
      const shape = board.get(op.id);
      if (shape) board.set(op.id, { ...shape, color: op.color });
      return;
    }
    case "delete":
      board.delete(op.id);
      return;
  }
}

function shift(point: Point, by: Point): Point {
  return { x: point.x + by.x, y: point.y + by.y };
}

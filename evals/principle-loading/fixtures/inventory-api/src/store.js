export const items = Array.from({ length: 57 }, (_, i) => ({
  id: `it_${i + 1}`,
  name: `Item ${i + 1}`,
  category: i % 3 === 0 ? "tools" : "garden",
  stock: (i * 7) % 40,
}));

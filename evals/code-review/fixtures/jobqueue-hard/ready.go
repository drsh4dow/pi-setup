package jobqueue

import "container/heap"

// readyHeap holds one queue's pending jobs, earliest runAt first and then in
// enqueue order. See docs/design.md for the invariant Lease relies on.
type readyHeap []*Job

func (h readyHeap) Len() int { return len(h) }

func (h readyHeap) Less(a, b int) bool {
	if !h[a].RunAt.Equal(h[b].RunAt) {
		return h[a].RunAt.Before(h[b].RunAt)
	}
	return h[a].Seq < h[b].Seq
}

func (h readyHeap) Swap(a, b int) { h[a], h[b] = h[b], h[a] }

func (h *readyHeap) Push(x any) { *h = append(*h, x.(*Job)) }

func (h *readyHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	old[len(old)-1] = nil
	*h = old[:len(old)-1]
	return last
}

// peek returns the job Lease would take next, or nil if the heap is empty.
func (h readyHeap) peek() *Job {
	if len(h) == 0 {
		return nil
	}
	return h[0]
}

func (s *Store) push(j *Job) {
	ready := s.ready[j.Queue]
	if ready == nil {
		ready = &readyHeap{}
		s.ready[j.Queue] = ready
	}
	heap.Push(ready, j)
}

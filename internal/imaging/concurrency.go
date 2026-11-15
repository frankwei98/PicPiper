package imaging

import (
	"context"
	"runtime"
	"sync"
)

// ProcessingLimits describes the shared budget for image operations.
type ProcessingLimits struct {
	CPUCount           int `json:"cpuCount"`
	DefaultConcurrency int `json:"defaultConcurrency"`
	Concurrency        int `json:"concurrency"`
}

func defaultConcurrency(cpus int) int { return max(1, (max(1, cpus)+1)/2) }

// operationLimit can shrink without cancelling work already in progress.
type operationLimit struct {
	mu            sync.Mutex
	limit, active int
	closed        bool
	changed       chan struct{}
}

func newOperationLimit(limit int) *operationLimit {
	return &operationLimit{limit: limit, changed: make(chan struct{})}
}
func (l *operationLimit) notifyLocked() { close(l.changed); l.changed = make(chan struct{}) }
func (l *operationLimit) set(limit int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.limit = limit
	l.notifyLocked()
}
func (l *operationLimit) current() int { l.mu.Lock(); defer l.mu.Unlock(); return l.limit }
func (l *operationLimit) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		l.notifyLocked()
	}
}
func (l *operationLimit) acquire(ctx context.Context) error {
	for {
		l.mu.Lock()
		if err := ctx.Err(); err != nil {
			l.mu.Unlock()
			return err
		}
		if l.closed {
			l.mu.Unlock()
			return context.Canceled
		}
		if l.active < l.limit {
			l.active++
			l.mu.Unlock()
			return nil
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
func (l *operationLimit) release() { l.mu.Lock(); defer l.mu.Unlock(); l.active--; l.notifyLocked() }
func (l *operationLimit) wait() {
	for {
		l.mu.Lock()
		if l.active == 0 {
			l.mu.Unlock()
			return
		}
		changed := l.changed
		l.mu.Unlock()
		<-changed
	}
}

func (s *Service) ProcessingLimits() ProcessingLimits {
	cpus := max(1, runtime.NumCPU())
	return ProcessingLimits{CPUCount: cpus, DefaultConcurrency: defaultConcurrency(cpus), Concurrency: s.workers.current()}
}

// SetConcurrency applies a saved preference. Zero follows the CPU-based default.
// Running tasks finish normally; new tasks wait for the new budget.
func (s *Service) SetConcurrency(configured int) {
	cpus := max(1, runtime.NumCPU())
	limit := configured
	if limit <= 0 {
		limit = defaultConcurrency(cpus)
	}
	limit = min(limit, cpus)
	s.workers.set(limit)
	s.trimIdleWorkers()
}

func (s *Service) trimIdleWorkers() {
	s.workerMu.Lock()
	keep := min(len(s.idleWorkers), s.workers.current())
	extra := append([]*imageWorker(nil), s.idleWorkers[keep:]...)
	s.idleWorkers = s.idleWorkers[:keep]
	s.workerMu.Unlock()
	for _, worker := range extra {
		worker.close()
	}
}

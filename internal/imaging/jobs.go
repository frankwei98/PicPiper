package imaging

import (
	"context"
	"sync"
	"time"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type imageJob struct {
	cancelled bool
	updated   time.Time
	active    map[uint64]context.CancelFunc
}

type imageJobs struct {
	mu       sync.Mutex
	sequence uint64
	entries  map[string]*imageJob
}

func (jobs *imageJobs) start(ctx context.Context, id string) (context.Context, func(), error) {
	if id == "" {
		return ctx, func() {}, nil
	}
	if len(id) > 128 {
		return nil, nil, apperror.New("invalidRequest", "The image task identifier is too long.")
	}
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	jobs.prune()
	job := jobs.entries[id]
	if job == nil {
		job = &imageJob{active: make(map[uint64]context.CancelFunc)}
		jobs.entries[id] = job
	}
	if job.cancelled {
		return nil, nil, context.Canceled
	}
	job.updated = time.Now()
	jobs.sequence++
	sequence := jobs.sequence
	ctx, cancel := context.WithCancel(ctx)
	job.active[sequence] = cancel
	return ctx, func() {
		cancel()
		jobs.mu.Lock()
		delete(job.active, sequence)
		job.updated = time.Now()
		jobs.mu.Unlock()
	}, nil
}

func (jobs *imageJobs) cancel(id string) error {
	if id == "" || len(id) > 128 {
		return apperror.New("invalidRequest", "Choose a valid image task to cancel.")
	}
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	jobs.prune()
	job := jobs.entries[id]
	if job == nil {
		job = &imageJob{active: make(map[uint64]context.CancelFunc)}
		jobs.entries[id] = job
	}
	job.cancelled = true
	job.updated = time.Now()
	for _, cancel := range job.active {
		cancel()
	}
	return nil
}

// Retain cancellation briefly so a late bridge request cannot restart a task.
func (jobs *imageJobs) prune() {
	if jobs.entries == nil {
		jobs.entries = make(map[string]*imageJob)
	}
	for id, job := range jobs.entries {
		if len(job.active) == 0 && time.Since(job.updated) > 5*time.Minute {
			delete(jobs.entries, id)
		}
	}
	if len(jobs.entries) < 4096 {
		return
	}
	var oldest string
	var timestamp time.Time
	for id, job := range jobs.entries {
		if len(job.active) == 0 && (oldest == "" || job.updated.Before(timestamp)) {
			oldest, timestamp = id, job.updated
		}
	}
	if oldest != "" {
		delete(jobs.entries, oldest)
	}
}

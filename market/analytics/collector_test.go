package analytics

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCollectorStartIdempotent(t *testing.T) {
	c := NewCollector()

	c.Start(context.Background())
	c.Start(context.Background()) // Should not spawn duplicate goroutine

	time.Sleep(50 * time.Millisecond)

	stats := c.Stats()
	if stats.FlushedSamples < 0 {
		t.Errorf("unexpected negative flushed samples: %d", stats.FlushedSamples)
	}

	c.Stop()
}

func TestCollectorConcurrentStart(t *testing.T) {
	c := NewCollector()
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Start(context.Background())
		}()
	}

	wg.Wait()
	time.Sleep(50 * time.Millisecond)

	c.Stop()
}

func TestCollectorStopAndRestart(t *testing.T) {
	c := NewCollector()

	c.Start(context.Background())
	time.Sleep(50 * time.Millisecond)
	c.Stop()
	time.Sleep(50 * time.Millisecond)

	// Should be able to restart cleanly
	c.Start(context.Background())
	time.Sleep(50 * time.Millisecond)

	c.Stop()
}

func TestCollectorStopIsNonBlocking(t *testing.T) {
	c := NewCollector()

	// Stop before start should not block
	done := make(chan struct{})
	go func() {
		c.Stop()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop blocked when collector was not started")
	}
}

func TestCollectorStopWithoutStart(t *testing.T) {
	c := NewCollector()

	// Stop without start should not panic
	c.Stop()
}

func TestCollectorContextCancel(t *testing.T) {
	c := NewCollector()
	ctx, cancel := context.WithCancel(context.Background())

	var flushCount int64
	c.enricher = func(s *MetricSample) {
		atomic.AddInt64(&flushCount, 1)
	}

	c.Start(ctx)
	time.Sleep(50 * time.Millisecond)

	cancel()
	time.Sleep(50 * time.Millisecond)

	// After context cancel, started should be false
	c.mu.RLock()
	started := c.started
	c.mu.RUnlock()

	if started {
		t.Error("expected started to be false after context cancel")
	}
}

package analytics

import (
	"context"
	"sync"
	"testing"
	"time"
)

func waitForStop(t *testing.T, c *Collector) {
	t.Helper()
	c.mu.RLock()
	doneCh := c.doneCh
	c.mu.RUnlock()

	select {
	case <-doneCh:
	case <-time.After(time.Second):
		t.Fatal("collector flush loop did not stop")
	}
}

func TestCollectorStartIsIdempotent(t *testing.T) {
	c := NewCollector()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c.Start(ctx)
	c.mu.RLock()
	firstDone := c.doneCh
	c.mu.RUnlock()

	c.Start(ctx)
	c.Start(ctx)

	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.running {
		t.Fatal("collector should be running")
	}
	if c.doneCh != firstDone {
		t.Fatal("repeated Start replaced the active flush loop")
	}
}

func TestCollectorConcurrentStartIsRaceSafeAndSingleLoop(t *testing.T) {
	c := NewCollector()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Start(ctx)
		}()
	}
	wg.Wait()

	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.running {
		t.Fatal("collector should be running after concurrent Start")
	}
	if c.stopCh == nil || c.doneCh == nil {
		t.Fatal("collector should have active lifecycle channels")
	}
}

func TestCollectorStopTransitionsToStoppedWithoutBlocking(t *testing.T) {
	c := NewCollector()
	ctx := context.Background()
	c.Start(ctx)

	stopped := make(chan struct{})
	go func() {
		c.Stop()
		close(stopped)
	}()

	select {
	case <-stopped:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Stop blocked")
	}

	waitForStop(t, c)
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.running {
		t.Fatal("collector should not be running after Stop")
	}
}

func TestCollectorCanRestartAfterStop(t *testing.T) {
	c := NewCollector()
	ctx := context.Background()
	c.Start(ctx)
	c.Stop()
	waitForStop(t, c)

	c.mu.RLock()
	oldDone := c.doneCh
	c.mu.RUnlock()

	c.Start(ctx)
	c.mu.RLock()
	newDone := c.doneCh
	running := c.running
	c.mu.RUnlock()

	if !running {
		t.Fatal("collector should be running after restart")
	}
	if newDone == oldDone {
		t.Fatal("restart should create a new flush loop")
	}
	c.Stop()
	waitForStop(t, c)
}
